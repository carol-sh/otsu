import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  CLEANUP_DONE,
  START,
  lastUserContent,
  minutes,
  openWorkerHarness,
  settle,
  turnReply,
  type WorkerHarness,
} from "./support/worker-harness.ts";

describe("restart recovery", () => {
  let h: WorkerHarness;

  beforeEach(() => {
    h = openWorkerHarness();
  });

  afterEach(() => {
    h.close();
  });

  /** Saves an active flow whose last user message, sent `minutesAgo` before now, got no answer. */
  function saveUnansweredFlow(text: string, minutesAgo: number): number {
    const now = DateTime.now();
    const flow = h.store.openFlow(now.minus({ hours: 1 }));
    h.store.updateState({ mode: "active", currentFlowId: flow.id });
    h.store.recordMessage({
      flowId: flow.id,
      role: "user",
      content: text,
      ts: h.store.issueMessageTs(now.minus({ minutes: minutesAgo })),
    });
    return flow.id;
  }

  it("runs a cleanup call that was still pending, even while paused", async () => {
    const flow = h.store.openFlow(START.minus({ hours: 1 }));
    h.store.closeFlow(flow.id, "paused", START);
    const worker = h.start([CLEANUP_DONE]);
    await settle();
    await worker.idle();

    assert.equal(h.store.flow(flow.id)?.cleanupStatus, "done");
    assert.equal(h.chat.requests.length, 1);
  });

  it("answers a reply that was waiting in the debounce buffer", async () => {
    saveUnansweredFlow("다녀왔어", 1);
    h.store.replaceSlot(
      { at: START.plus({ hours: 1 }), type: "followup", memo: "" },
      START.minus({ hours: 1 }),
    );
    const worker = h.start([turnReply("continue", "2026-10-27T14:00:00+09:00")]);
    await settle();
    await worker.idle();

    assert.equal(h.chat.requests.length, 1);
    assert.match(lastUserContent(h.chat), /다녀왔어\n\n\[이벤트\][^]*종류: 사용자 답장/);
  });

  it("answers a reply left before blackout once blackout ends, in place of the due slot", async () => {
    minutes(14 * 60);
    saveUnansweredFlow("잘 자", 2 * 60 + 1);
    h.store.replaceSlot(
      { at: START.plus({ hours: 12, minutes: 30 }), type: "followup", memo: "" },
      START.plus({ hours: 12 }),
    );
    const worker = h.start([turnReply("continue", "2026-10-28T12:00:00+09:00")]);
    minutes(6 * 60 - 1);
    await worker.idle();
    assert.equal(h.chat.requests.length, 0);

    minutes(1);
    await settle();
    await worker.idle();
    minutes(60);
    await worker.idle();
    assert.equal(h.chat.requests.length, 1);
    assert.match(lastUserContent(h.chat), /잘 자\n\n\[이벤트\][^]*종류: 사용자 답장/);
  });
});
