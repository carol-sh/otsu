import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { DateTime } from "luxon";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { createRuntimeConfigSource } from "../src/config.ts";
import { createExecutor } from "../src/llm/executor.ts";
import { installInitialMemory } from "../src/memory.ts";
import { createScheduler, type Scheduler } from "../src/scheduler.ts";
import { openStore, type Store } from "../src/store.ts";
import { systemClock } from "../src/time.ts";
import { createWorker, type Worker } from "../src/worker.ts";
import { fakeChat, textReply, type FakeChat, type ScriptedReply } from "./support/fake-chat.ts";

const START = DateTime.fromISO("2026-10-27T12:00:00+09:00");
const CLEANUP_DONE = textReply('{"done":true}');

function turnReply(flow: "continue" | "end", at: string, messages: string[] = []): ChatCompletion {
  return textReply(JSON.stringify({ messages, flow, next: { at, type: "followup", memo: "" } }));
}

function seconds(count: number): void {
  mock.timers.tick(count * 1000);
}

/** Lets queued microtasks run, so a call the worker just started is in flight. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function lastUserContent(chat: FakeChat): string {
  return String(chat.requests.at(-1)?.messages.at(-1)?.content);
}

/** Sends `/resume`; the slot it makes fires at once and the first script reply opens a flow. */
async function resume(worker: Worker): Promise<void> {
  worker.enqueue({ kind: "resume" });
  await worker.idle();
}

describe("worker", () => {
  let dataDir: string;
  let store: Store;
  let scheduler: Scheduler | undefined;
  let chat: FakeChat;
  let sent: string[];

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: START.toMillis() });
    dataDir = mkdtempSync(join(tmpdir(), "otsu-worker-"));
    installInitialMemory(join(dataDir, "memory"));
    writeFileSync(join(dataDir, "prompt.md"), "너는 주인이다.");
    writeFileSync(join(dataDir, "tasks.md"), "- 산책");
    writeFileSync(join(dataDir, ".env"), "DEBOUNCE_SEC=20\nBLACKOUT=00:00-08:00\n");
    store = openStore(join(dataDir, "otsu.db"));
    sent = [];
  });

  afterEach(() => {
    scheduler?.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    mock.timers.reset();
  });

  function start(script: ScriptedReply[]): Worker {
    chat = fakeChat(script);
    const source = createRuntimeConfigSource(dataDir);
    const config = () => source.current();
    const worker = createWorker({
      dataDir,
      store,
      clock: systemClock,
      config,
      executor: createExecutor({ client: chat, provider: "openai", store, clock: systemClock }),
      sender: {
        async send(text) {
          sent.push(text);
        },
      },
      onScheduleChange: () => scheduler?.refresh(),
    });
    scheduler = createScheduler({
      store,
      clock: systemClock,
      config,
      onFire: (slotId) => worker.enqueue({ kind: "schedule", slotId }),
      random: () => 1,
    });
    scheduler.refresh();
    return worker;
  }

  function userRows(): { content: string; reason: string | null }[] {
    const db = new DatabaseSync(join(dataDir, "otsu.db"), { readOnly: true });
    const rows = db
      .prepare("SELECT content, ignored_reason FROM messages WHERE role = 'user' ORDER BY ts")
      .all()
      .map((row) => ({
        content: String(row.content),
        reason: row.ignored_reason as string | null,
      }));
    db.close();
    return rows;
  }

  it("only records a message that arrives while paused", async () => {
    const worker = start([]);
    worker.receive("안녕");
    seconds(60);
    await worker.idle();

    assert.deepEqual(userRows(), [{ content: "안녕", reason: "paused" }]);
    assert.equal(chat.requests.length, 0);
  });

  it("resumes with a memo-less task slot that opens a new flow when it fires", async () => {
    const worker = start([turnReply("continue", "2026-10-27T13:00:00+09:00", ["산책 가"])]);
    await resume(worker);

    const state = store.state();
    assert.equal(state.mode, "active");
    assert.ok(state.currentFlowId);
    assert.equal(store.flow(state.currentFlowId)?.startedAt.toMillis(), START.toMillis());
    assert.match(lastUserContent(chat), /종류: 예약 도달 \(type=task\)\n랜덤 이벤트 대기/);
    assert.deepEqual(sent, ["[하네스] 다시 시작했다.", "산책 가"]);
    assert.equal(store.slot()?.at.toMillis(), START.plus({ hours: 1 }).toMillis());
  });

  it("drops a schedule event whose slot the in-flight call replaced", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = start([turnReply("continue", "2026-10-27T12:30:00+09:00"), reply.promise]);
    await resume(worker);
    worker.receive("다녀왔어");
    seconds(20);
    await settle();
    assert.equal(chat.requests.length, 2);

    seconds(30 * 60);
    reply.resolve(turnReply("continue", "2026-10-27T14:00:00+09:00"));
    await worker.idle();

    assert.equal(chat.requests.length, 2);
    assert.equal(store.slot()?.at.toMillis(), START.plus({ hours: 2 }).toMillis());
  });

  it("marks a reply that arrives during a call as late when the call ends the flow", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = start([
      turnReply("continue", "2026-10-27T13:00:00+09:00"),
      reply.promise,
      CLEANUP_DONE,
    ]);
    await resume(worker);
    const flowId = store.state().currentFlowId!;
    worker.receive("다녀왔어");
    seconds(20);
    await settle();
    worker.receive("고양이도 봤어");
    reply.resolve(turnReply("end", "2026-10-27T18:00:00+09:00", ["됐어"]));
    await worker.idle();
    seconds(60);
    await worker.idle();

    assert.deepEqual(userRows(), [
      { content: "다녀왔어", reason: null },
      { content: "고양이도 봤어", reason: "late" },
    ]);
    assert.equal(store.state().mode, "ended");
    assert.equal(store.flow(flowId)?.endReason, "agent");
    assert.equal(store.flow(flowId)?.cleanupStatus, "done");
    assert.equal(chat.requests.length, 3);
  });

  it("carries a reply that arrives during a continuing call into the next call", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = start([
      turnReply("continue", "2026-10-27T13:00:00+09:00"),
      reply.promise,
      turnReply("continue", "2026-10-27T13:00:00+09:00"),
    ]);
    await resume(worker);
    worker.receive("다녀왔어");
    seconds(20);
    await settle();
    worker.receive("고양이도 봤어");
    const answer = turnReply("continue", "2026-10-27T13:00:00+09:00", ["사진은?"]);
    reply.resolve(answer);
    await worker.idle();
    seconds(20);
    await worker.idle();

    const messages = chat.requests[2]?.messages ?? [];
    assert.equal(messages.at(-2)?.content, answer.choices[0]?.message.content);
    assert.match(String(messages.at(-1)?.content), /^\[10-27 12:00\] 고양이도 봤어\n\n\[이벤트\]/);
  });

  it("ignores messages in the ended state and leaves them out of the next flow", async () => {
    const worker = start([
      turnReply("end", "2026-10-27T15:00:00+09:00", ["오늘은 끝"]),
      CLEANUP_DONE,
      turnReply("continue", "2026-10-27T16:00:00+09:00"),
    ]);
    await resume(worker);
    worker.receive("벌써 끝?");
    seconds(3 * 60 * 60);
    await worker.idle();

    assert.deepEqual(userRows(), [{ content: "벌써 끝?", reason: "ended" }]);
    assert.equal(chat.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(chat.requests[2]?.messages), /벌써 끝/);
    assert.equal(store.state().mode, "active");
  });

  it("pauses an active flow at once, clears the slot, and runs the cleanup call", async () => {
    const worker = start([turnReply("continue", "2026-10-27T13:00:00+09:00"), CLEANUP_DONE]);
    await resume(worker);
    const flowId = store.state().currentFlowId!;
    worker.receive("잠깐");
    worker.enqueue({ kind: "pause" });
    await worker.idle();
    seconds(2 * 60 * 60);
    await worker.idle();

    assert.equal(store.state().mode, "paused");
    assert.equal(store.slot(), undefined);
    assert.equal(store.flow(flowId)?.endReason, "paused");
    assert.equal(store.flow(flowId)?.cleanupStatus, "done");
    assert.deepEqual(userRows(), [{ content: "잠깐", reason: "late" }]);
    assert.equal(chat.requests.length, 2);
    assert.equal(sent.at(-1), "[하네스] 정지했다. /resume을 보내면 다시 시작한다.");
  });

  it("answers buffered replies instead of a slot that comes due during the debounce", async () => {
    const worker = start([
      turnReply("continue", "2026-10-27T12:30:00+09:00"),
      turnReply("continue", "2026-10-27T14:00:00+09:00"),
    ]);
    await resume(worker);
    seconds(29 * 60 + 50);
    worker.receive("거의 다 왔어");
    seconds(10);
    await worker.idle();
    seconds(20);
    await worker.idle();

    assert.equal(chat.requests.length, 2);
    assert.match(lastUserContent(chat), /거의 다 왔어\n\n\[이벤트\][^]*종류: 사용자 답장/);
  });

  it("only records a reply sent during blackout and leaves it out of the next call", async () => {
    const worker = start([
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
      turnReply("continue", "2026-10-28T10:00:00+09:00"),
    ]);
    await resume(worker);
    seconds(12.5 * 60 * 60);
    worker.receive("자?");
    seconds(60);
    await worker.idle();
    assert.equal(chat.requests.length, 1);

    seconds(9 * 60 * 60);
    await worker.idle();
    assert.deepEqual(userRows(), [{ content: "자?", reason: "blackout" }]);
    assert.equal(chat.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(chat.requests[1]?.messages), /자\?/);
  });

  it("calls just before blackout when the debounce would end inside it", async () => {
    const worker = start([
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
    ]);
    await resume(worker);
    seconds(12 * 60 * 60 - 10);
    worker.receive("잘게");
    seconds(8);
    await worker.idle();
    assert.equal(chat.requests.length, 1);

    seconds(1);
    await worker.idle();
    assert.equal(chat.requests.length, 2);
    assert.match(lastUserContent(chat), /잘게/);
  });

  it("holds replies whose debounce ends during blackout until blackout is over", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = start([
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
      reply.promise,
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
    ]);
    await resume(worker);
    seconds(12 * 60 * 60 - 60);
    worker.receive("씻고 올게");
    seconds(20);
    await settle();
    seconds(20);
    worker.receive("다 씻었어");
    seconds(60);
    reply.resolve(turnReply("continue", "2026-10-28T09:00:00+09:00"));
    await worker.idle();
    assert.equal(chat.requests.length, 2);

    seconds(8 * 60 * 60);
    await worker.idle();
    assert.equal(chat.requests.length, 3);
    assert.match(lastUserContent(chat), /다 씻었어/);
  });
});
