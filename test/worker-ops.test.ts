import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { textReply, toolReply } from "./support/fake-chat.ts";
import {
  CLEANUP_DONE,
  START,
  lastUserContent,
  minutes,
  openWorkerHarness,
  resume,
  seconds,
  turnReply,
  type WorkerHarness,
} from "./support/worker-harness.ts";

const BAD = textReply("not json");
const FAILED_MARK = "[이전 호출 실패] ";

function at(minutesFromStart: number): number {
  return START.plus({ minutes: minutesFromStart }).toMillis();
}

describe("worker operations", () => {
  let h: WorkerHarness;

  beforeEach(() => {
    h = openWorkerHarness();
  });

  afterEach(() => {
    h.close();
  });

  it("backs off after each failure and alerts the operator once at the threshold", async () => {
    const worker = h.start([BAD, BAD, BAD, BAD, BAD, BAD]);
    await resume(worker);
    assert.equal(h.store.slot()?.at.toMillis(), at(10));
    minutes(10);
    await worker.idle();
    assert.equal(h.store.slot()?.at.toMillis(), at(30));
    minutes(20);
    await worker.idle();

    const slot = h.store.slot();
    assert.equal(slot?.at.toMillis(), at(70));
    assert.equal(slot?.type, "task");
    assert.equal(slot?.memo, FAILED_MARK);
    const state = h.store.state();
    assert.equal(state.mode, "ended");
    assert.equal(state.currentFlowId, null);
    assert.equal(state.consecutiveFailures, 3);
    assert.equal(h.sent.filter((text) => text.includes("3회 연속 실패")).length, 1);
  });

  it("discards an ending answer without next and keeps the flow open", async () => {
    const endWithoutNext = textReply(JSON.stringify({ messages: ["끝"], flow: "end" }));
    const worker = h.start([
      turnReply("continue", "2026-10-27T13:00:00+09:00", { memo: "산책 확인" }),
      endWithoutNext,
      endWithoutNext,
    ]);
    await resume(worker);
    worker.receive("다녀왔어");
    seconds(20);
    await worker.idle();

    assert.ok(!h.sent.includes("끝"));
    assert.equal(h.store.state().mode, "active");
    const slot = h.store.slot();
    assert.equal(slot?.at.toMillis(), START.plus({ seconds: 20, minutes: 10 }).toMillis());
    assert.equal(slot?.memo, `${FAILED_MARK}산책 확인`);
  });

  it("uses up a pending random event only when the random call succeeds", async () => {
    const worker = h.start([
      turnReply("end", "2026-10-27T13:00:00+09:00", { type: "random" }),
      CLEANUP_DONE,
      BAD,
      BAD,
      turnReply("continue", "2026-10-27T15:00:00+09:00"),
    ]);
    await resume(worker);
    h.store.updateState({ randomDue: 1 });
    minutes(60);
    await worker.idle();
    assert.equal(h.store.state().randomDue, 1);
    assert.equal(h.store.slot()?.type, "random");

    minutes(10);
    await worker.idle();
    assert.equal(h.store.state().randomDue, 0);
    assert.equal(h.store.state().mode, "active");
  });

  it("pulls a next time beyond the maximum delay back to it and notes why", async () => {
    const worker = h.start([turnReply("continue", "2026-11-03T12:00:00+09:00", { memo: "m" })]);
    await resume(worker);

    const slot = h.store.slot();
    assert.equal(slot?.at.toMillis(), START.plus({ hours: 48 }).toMillis());
    assert.match(slot?.memo ?? "", /^m\n.*48시간/);
  });

  it("does not roll the dice for the time spent paused", async () => {
    const worker = h.start([turnReply("continue", "2026-10-27T13:00:00+09:00"), CLEANUP_DONE], {
      random: () => 0,
    });
    await resume(worker);
    worker.enqueue({ kind: "pause" });
    await worker.idle();
    minutes(12 * 60);
    await resume(worker);

    assert.equal(h.store.state().randomDue, 0);
    assert.equal(h.store.state().mode, "ended");
  });

  it("holds replies while the balance is low and answers them once it is topped up", async () => {
    let balance = 5;
    const worker = h.start(
      [
        turnReply("continue", "2026-10-27T15:00:00+09:00"),
        turnReply("continue", "2026-10-27T15:00:00+09:00"),
      ],
      { balance: async () => balance },
    );
    await resume(worker);
    balance = 0.5;
    worker.receive("하나");
    seconds(20);
    await worker.idle();
    worker.receive("둘");
    seconds(20);
    await worker.idle();

    assert.equal(h.chat.requests.length, 1);
    assert.equal(h.store.state().holdReason, "balance");
    assert.equal(h.sent.filter((text) => text.includes("잔액")).length, 1);

    balance = 5;
    minutes(30);
    await worker.idle();
    assert.equal(h.chat.requests.length, 2);
    assert.match(lastUserContent(h.chat), /하나\n\n\[10-27 12:00\] 둘/);
    assert.equal(h.store.state().holdReason, null);
  });

  it("holds calls past the daily limit until midnight, then waits out blackout", async () => {
    const worker = h.start(
      [
        turnReply("continue", "2026-10-28T09:00:00+09:00"),
        turnReply("continue", "2026-10-28T10:00:00+09:00"),
      ],
      { env: "DAILY_CALL_LIMIT=1\n" },
    );
    await resume(worker);
    worker.receive("아직 있어?");
    seconds(20);
    await worker.idle();
    assert.equal(h.store.state().holdReason, "daily_limit");

    minutes(12 * 60);
    await worker.idle();
    assert.equal(h.chat.requests.length, 1);
    assert.equal(h.store.state().holdReason, null);

    minutes(8 * 60);
    await worker.idle();
    assert.equal(h.chat.requests.length, 2);
    assert.match(lastUserContent(h.chat), /아직 있어\?/);
  });

  it("drops a failed cleanup attempt's writes and retries", async () => {
    const journal = h.readMemory("journal.md");
    const worker = h.start(
      [
        turnReply("end", "2026-10-27T18:00:00+09:00"),
        toolReply({ name: "memory_write", args: { name: "journal.md", content: "망친 기록" } }),
        BAD,
        BAD,
        CLEANUP_DONE,
      ],
      { env: "CLEANUP_RETRY=1\n" },
    );
    await resume(worker);

    assert.equal(h.store.flow(1)?.cleanupStatus, "done");
    assert.equal(h.readMemory("journal.md"), journal);
    assert.equal(h.chat.requests.length, 5);
  });

  it("folds older messages into a summary once the flow grows past the threshold", async () => {
    const worker = h.start(
      [
        turnReply("continue", "2026-10-27T15:00:00+09:00", { messages: ["첫 답"] }),
        turnReply("continue", "2026-10-27T15:00:00+09:00"),
        turnReply("continue", "2026-10-27T15:00:00+09:00"),
        textReply('{"summary":"요약본"}'),
        turnReply("continue", "2026-10-27T15:00:00+09:00"),
        textReply('{"summary":"요약본 2"}'),
      ],
      { env: "FLOW_COMPACT_TOKENS=50\n" },
    );
    await resume(worker);
    for (const text of ["하나", "둘", "셋"]) {
      worker.receive(text);
      seconds(20);
      await worker.idle();
    }

    const compaction = h.chat.requests[3];
    assert.equal(compaction?.tools, undefined);
    assert.match(String(compaction?.messages.at(-1)?.content), /\[압축 호출\]/);
    const afterCompaction = JSON.stringify(h.chat.requests[4]?.messages);
    assert.match(afterCompaction, /\[이전 대화 요약\]\\n요약본/);
    assert.doesNotMatch(afterCompaction, /첫 답/);
    assert.match(afterCompaction, /하나/);
    assert.equal(h.chat.requests.length, 6);
  });
});
