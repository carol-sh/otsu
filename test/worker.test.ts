import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ChatCompletion } from "openai/resources/chat/completions";
import {
  CLEANUP_DONE,
  START,
  lastUserContent,
  openWorkerHarness,
  resume,
  seconds,
  settle,
  turnReply,
  type WorkerHarness,
} from "./support/worker-harness.ts";

describe("worker", () => {
  let h: WorkerHarness;

  beforeEach(() => {
    h = openWorkerHarness();
  });

  afterEach(() => {
    h.close();
  });

  it("only records a message that arrives while paused", async () => {
    const worker = h.start([]);
    worker.receive("안녕");
    seconds(60);
    await worker.idle();

    assert.deepEqual(h.userRows(), [{ content: "안녕", reason: "paused" }]);
    assert.equal(h.chat.requests.length, 0);
  });

  it("resumes with a memo-less task slot that opens a new flow when it fires", async () => {
    const worker = h.start([
      turnReply("continue", "2026-10-27T13:00:00+09:00", { messages: ["산책 가"] }),
    ]);
    await resume(worker);

    const state = h.store.state();
    assert.equal(state.mode, "active");
    assert.ok(state.currentFlowId);
    assert.equal(h.store.flow(state.currentFlowId)?.startedAt.toMillis(), START.toMillis());
    assert.match(lastUserContent(h.chat), /종류: 예약 도달 \(type=task\)\n랜덤 이벤트 대기/);
    assert.deepEqual(h.sent, ["[하네스] 다시 시작했다.", "산책 가"]);
    assert.equal(h.store.slot()?.at.toMillis(), START.plus({ hours: 1 }).toMillis());
  });

  it("drops a schedule event whose slot the in-flight call replaced", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = h.start([turnReply("continue", "2026-10-27T12:30:00+09:00"), reply.promise]);
    await resume(worker);
    worker.receive("다녀왔어");
    seconds(20);
    await settle();
    assert.equal(h.chat.requests.length, 2);

    seconds(30 * 60);
    reply.resolve(turnReply("continue", "2026-10-27T14:00:00+09:00"));
    await worker.idle();

    assert.equal(h.chat.requests.length, 2);
    assert.equal(h.store.slot()?.at.toMillis(), START.plus({ hours: 2 }).toMillis());
  });

  it("marks a reply that arrives during a call as late when the call ends the flow", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = h.start([
      turnReply("continue", "2026-10-27T13:00:00+09:00"),
      reply.promise,
      CLEANUP_DONE,
    ]);
    await resume(worker);
    const flowId = h.store.state().currentFlowId!;
    worker.receive("다녀왔어");
    seconds(20);
    await settle();
    worker.receive("고양이도 봤어");
    reply.resolve(turnReply("end", "2026-10-27T18:00:00+09:00", { messages: ["됐어"] }));
    await worker.idle();
    seconds(60);
    await worker.idle();

    assert.deepEqual(h.userRows(), [
      { content: "다녀왔어", reason: null },
      { content: "고양이도 봤어", reason: "late" },
    ]);
    assert.equal(h.store.state().mode, "ended");
    assert.equal(h.store.flow(flowId)?.endReason, "agent");
    assert.equal(h.store.flow(flowId)?.cleanupStatus, "done");
    assert.equal(h.chat.requests.length, 3);
  });

  it("carries a reply that arrives during a continuing call into the next call", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = h.start([
      turnReply("continue", "2026-10-27T13:00:00+09:00"),
      reply.promise,
      turnReply("continue", "2026-10-27T13:00:00+09:00"),
    ]);
    await resume(worker);
    worker.receive("다녀왔어");
    seconds(20);
    await settle();
    worker.receive("고양이도 봤어");
    const answer = turnReply("continue", "2026-10-27T13:00:00+09:00", { messages: ["사진은?"] });
    reply.resolve(answer);
    await worker.idle();
    seconds(20);
    await worker.idle();

    const messages = h.chat.requests[2]?.messages ?? [];
    assert.equal(messages.at(-2)?.content, answer.choices[0]?.message.content);
    assert.match(String(messages.at(-1)?.content), /^\[10-27 12:00\] 고양이도 봤어\n\n\[이벤트\]/);
  });

  it("ignores messages in the ended state and leaves them out of the next flow", async () => {
    const worker = h.start([
      turnReply("end", "2026-10-27T15:00:00+09:00", { messages: ["오늘은 끝"] }),
      CLEANUP_DONE,
      turnReply("continue", "2026-10-27T16:00:00+09:00"),
    ]);
    await resume(worker);
    worker.receive("벌써 끝?");
    seconds(3 * 60 * 60);
    await worker.idle();

    assert.deepEqual(h.userRows(), [{ content: "벌써 끝?", reason: "ended" }]);
    assert.equal(h.chat.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(h.chat.requests[2]?.messages), /벌써 끝/);
    assert.equal(h.store.state().mode, "active");
  });

  it("pauses an active flow at once, clears the slot, and runs the cleanup call", async () => {
    const worker = h.start([turnReply("continue", "2026-10-27T13:00:00+09:00"), CLEANUP_DONE]);
    await resume(worker);
    const flowId = h.store.state().currentFlowId!;
    worker.receive("잠깐");
    worker.enqueue({ kind: "pause" });
    await worker.idle();
    seconds(2 * 60 * 60);
    await worker.idle();

    assert.equal(h.store.state().mode, "paused");
    assert.equal(h.store.slot(), undefined);
    assert.equal(h.store.flow(flowId)?.endReason, "paused");
    assert.equal(h.store.flow(flowId)?.cleanupStatus, "done");
    assert.deepEqual(h.userRows(), [{ content: "잠깐", reason: "late" }]);
    assert.equal(h.chat.requests.length, 2);
    assert.equal(h.sent.at(-1), "[하네스] 정지했다. /resume을 보내면 다시 시작한다.");
  });

  it("answers buffered replies instead of a slot that comes due during the debounce", async () => {
    const worker = h.start([
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

    assert.equal(h.chat.requests.length, 2);
    assert.match(lastUserContent(h.chat), /거의 다 왔어\n\n\[이벤트\][^]*종류: 사용자 답장/);
  });

  it("only records a reply h.sent during blackout and leaves it out of the next call", async () => {
    const worker = h.start([
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
      turnReply("continue", "2026-10-28T10:00:00+09:00"),
    ]);
    await resume(worker);
    seconds(12.5 * 60 * 60);
    worker.receive("자?");
    seconds(60);
    await worker.idle();
    assert.equal(h.chat.requests.length, 1);

    seconds(9 * 60 * 60);
    await worker.idle();
    assert.deepEqual(h.userRows(), [{ content: "자?", reason: "blackout" }]);
    assert.equal(h.chat.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(h.chat.requests[1]?.messages), /자\?/);
  });

  it("calls just before blackout when the debounce would end inside it", async () => {
    const worker = h.start([
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
      turnReply("continue", "2026-10-28T09:00:00+09:00"),
    ]);
    await resume(worker);
    seconds(12 * 60 * 60 - 10);
    worker.receive("잘게");
    seconds(8);
    await worker.idle();
    assert.equal(h.chat.requests.length, 1);

    seconds(1);
    await worker.idle();
    assert.equal(h.chat.requests.length, 2);
    assert.match(lastUserContent(h.chat), /잘게/);
  });

  it("holds replies whose debounce ends during blackout until blackout is over", async () => {
    const reply = Promise.withResolvers<ChatCompletion>();
    const worker = h.start([
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
    assert.equal(h.chat.requests.length, 2);

    seconds(8 * 60 * 60);
    await worker.idle();
    assert.equal(h.chat.requests.length, 3);
    assert.match(lastUserContent(h.chat), /다 씻었어/);
  });
});
