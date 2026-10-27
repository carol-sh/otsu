import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DateTime } from "luxon";
import { openStore, type Store } from "../src/store.ts";

const NOW = DateTime.fromISO("2026-10-27T21:00:00+09:00");

describe("store", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("starts paused with no slot", () => {
    assert.deepEqual(store.state(), {
      mode: "paused",
      currentFlowId: null,
      randomDue: 0,
      lastRollAt: null,
      consecutiveFailures: 0,
      holdReason: null,
    });
    assert.equal(store.slot(), undefined);
  });

  it("round-trips state patches including times and nulls", () => {
    const flow = store.openFlow(NOW);
    store.updateState({
      mode: "active",
      currentFlowId: flow.id,
      lastRollAt: NOW,
      holdReason: "balance",
    });
    store.updateState({ holdReason: null });
    const state = store.state();
    assert.equal(state.mode, "active");
    assert.equal(state.currentFlowId, flow.id);
    assert.equal(state.lastRollAt?.toMillis(), NOW.toMillis());
    assert.equal(state.holdReason, null);
  });

  it("never reuses a slot id, even after clearing", () => {
    const first = store.replaceSlot({ at: NOW, type: "task", memo: "" }, NOW);
    const second = store.replaceSlot(
      { at: NOW.plus({ hours: 1 }), type: "followup", memo: "재촉" },
      NOW,
    );
    store.clearSlot();
    const third = store.replaceSlot({ at: NOW, type: "task", memo: "" }, NOW);
    assert.ok(first.id < second.id && second.id < third.id);
    assert.equal(store.slot()?.id, third.id);
  });

  it("issues strictly increasing message timestamps", () => {
    const first = store.issueMessageTs(NOW);
    const second = store.issueMessageTs(NOW);
    const third = store.issueMessageTs(NOW.minus({ seconds: 5 }));
    assert.ok(first < second && second < third);
  });

  it("finds user messages after the last assistant cutoff, including ones that arrived mid-call", () => {
    const flow = store.openFlow(NOW);
    const answered = store.recordMessage({
      flowId: flow.id,
      role: "user",
      content: "했어",
      ts: store.issueMessageTs(NOW),
    });
    const cutoff = store.issueMessageTs(NOW);
    const midCall = store.recordMessage({
      flowId: flow.id,
      role: "user",
      content: "그리고",
      ts: store.issueMessageTs(NOW),
    });
    store.recordMessage({
      flowId: flow.id,
      role: "user",
      content: "새벽",
      ts: store.issueMessageTs(NOW),
      ignoredReason: "blackout",
    });
    const reply = store.recordMessage({
      flowId: flow.id,
      role: "assistant",
      content: "{}",
      ts: cutoff,
    });

    assert.deepEqual(
      store.unansweredUserMessages(flow.id).map((message) => message.id),
      [midCall.id],
    );
    assert.deepEqual(
      store.flowMessages(flow.id).map((message) => message.id),
      [answered.id, reply.id, midCall.id],
    );
  });

  it("drops late messages from the flow", () => {
    const flow = store.openFlow(NOW);
    const message = store.recordMessage({
      flowId: flow.id,
      role: "user",
      content: "늦음",
      ts: store.issueMessageTs(NOW),
    });
    store.ignoreMessages([message.id], "late");
    assert.deepEqual(store.flowMessages(flow.id), []);
    assert.deepEqual(store.unansweredUserMessages(flow.id), []);
  });

  it("counts daily calls per local date", () => {
    assert.equal(store.countDailyCall("2026-10-27"), 1);
    assert.equal(store.countDailyCall("2026-10-27"), 2);
    assert.equal(store.dailyCalls("2026-10-27"), 2);
    assert.equal(store.dailyCalls("2026-10-28"), 0);
    assert.equal(store.countDailyCall("2026-10-28"), 1);
  });

  it("rolls back a failed transaction", () => {
    assert.throws(() =>
      store.transaction(() => {
        store.updateState({ mode: "ended" });
        throw new Error("boom");
      }),
    );
    assert.equal(store.state().mode, "paused");
  });
});

describe("store on disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otsu-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps data and timestamp order across reopening", () => {
    const path = join(dir, "otsu.db");
    const first = openStore(path);
    const flow = first.openFlow(NOW);
    first.closeFlow(flow.id, "agent", NOW);
    const before = first.issueMessageTs(NOW);
    first.recordMessage({ flowId: flow.id, role: "user", content: "안녕", ts: before });
    first.close();

    const second = openStore(path);
    assert.deepEqual(
      second.flowsPendingCleanup().map((pending) => pending.id),
      [flow.id],
    );
    assert.ok(second.issueMessageTs(NOW) > before);
    second.close();
  });
});
