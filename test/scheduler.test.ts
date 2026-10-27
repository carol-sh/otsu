import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { DateTime } from "luxon";
import { createScheduler, rollRandomDue, type SchedulerConfig } from "../src/scheduler.ts";
import { openStore, type Store } from "../src/store.ts";
import { systemClock } from "../src/time.ts";

const START = DateTime.fromISO("2026-10-27T12:00:00+09:00");
const CONFIG: SchedulerConfig = {
  timezone: "Asia/Seoul",
  blackout: [{ start: 0, end: 8 * 60 }],
  random: { unitMin: 60, trials: 1, prob: 0.5, maxDue: 3 },
};

function minutes(count: number): void {
  mock.timers.tick(count * 60 * 1000);
}

describe("scheduler", () => {
  let store: Store;
  let fired: number[];
  let rolls: number[];

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: START.toMillis() });
    store = openStore(":memory:");
    fired = [];
    rolls = [];
  });

  afterEach(() => {
    store.close();
    mock.timers.reset();
  });

  function start(random: () => number = () => 1) {
    const scheduler = createScheduler({
      store,
      clock: systemClock,
      config: () => CONFIG,
      onFire: (slotId) => fired.push(slotId),
      random: () => {
        const value = random();
        rolls.push(value);
        return value;
      },
    });
    scheduler.refresh();
    return scheduler;
  }

  function slotAt(iso: string): number {
    return store.replaceSlot({ at: DateTime.fromISO(iso), type: "task", memo: "" }, START).id;
  }

  it("fires the slot at its time, not before", () => {
    const id = slotAt("2026-10-27T12:30:00+09:00");
    start();
    minutes(29);
    assert.deepEqual(fired, []);
    minutes(1);
    assert.deepEqual(fired, [id]);
  });

  it("fires a past slot at once", () => {
    const id = slotAt("2026-10-27T11:00:00+09:00");
    start();
    assert.deepEqual(fired, [id]);
  });

  it("fires each slot only once, however often it is refreshed", () => {
    slotAt("2026-10-27T11:00:00+09:00");
    const scheduler = start();
    scheduler.refresh();
    minutes(120);
    assert.equal(fired.length, 1);
  });

  it("follows a replaced slot and drops the old one", () => {
    slotAt("2026-10-27T12:30:00+09:00");
    const scheduler = start();
    const id = slotAt("2026-10-27T13:00:00+09:00");
    scheduler.refresh();
    minutes(60);
    assert.deepEqual(fired, [id]);
  });

  it("holds a slot that comes due in blackout until blackout ends", () => {
    const id = slotAt("2026-10-28T03:00:00+09:00");
    start();
    minutes(15 * 60);
    assert.deepEqual(fired, []);
    minutes(5 * 60 - 1);
    assert.deepEqual(fired, []);
    minutes(1);
    assert.deepEqual(fired, [id]);
  });

  it("fires on time after sleeping longer than the wake cap", () => {
    const id = slotAt("2026-10-28T18:30:00+09:00");
    start();
    minutes(30 * 60 + 29);
    assert.deepEqual(fired, []);
    minutes(1);
    assert.deepEqual(fired, [id]);
  });

  it("does not roll dice while paused", () => {
    start(() => 0);
    minutes(180);
    assert.deepEqual(rolls, []);
    assert.equal(store.state().lastRollAt, null);
  });

  it("rolls once per unit while running and stops at the cap", () => {
    store.updateState({ mode: "ended" });
    start(() => 0);
    minutes(59);
    assert.equal(store.state().randomDue, 0);
    minutes(1);
    assert.equal(store.state().randomDue, 1);
    minutes(5 * 60);
    assert.equal(store.state().randomDue, 3);
    assert.equal(rolls.length, 3);
  });
});

describe("rollRandomDue", () => {
  const random = { unitMin: 60, trials: 2, prob: 0.5, maxDue: 3 };

  it("waits for a whole unit", () => {
    const state = { randomDue: 0, lastRollAt: START };
    assert.equal(
      rollRandomDue(state, START.plus({ minutes: 59 }), random, () => 0),
      undefined,
    );
  });

  it("catches up on missed units and keeps the remainder for the next roll", () => {
    const values = [0.9, 0.1, 0.9, 0.9];
    const result = rollRandomDue(
      { randomDue: 0, lastRollAt: START },
      START.plus({ minutes: 150 }),
      random,
      () => values.shift() ?? 1,
    );
    assert.equal(result?.randomDue, 1);
    assert.equal(result?.lastRollAt.toMillis(), START.plus({ minutes: 120 }).toMillis());
  });
});
