import type { DateTime } from "luxon";
import type { RuntimeConfig } from "./config.ts";
import type { HarnessState, Store } from "./store.ts";
import { blackoutEnd, inBlackout, type Clock } from "./time.ts";

export type SchedulerConfig = Pick<RuntimeConfig, "timezone" | "blackout" | "random">;

export interface SchedulerDeps {
  store: Store;
  clock: Clock;
  /** Returns the current settings; called on every wake so `.env` edits apply. */
  config: () => SchedulerConfig;
  /** Receives the slot id when its time comes outside blackout. Each slot fires at most once. */
  onFire: (slotId: number) => void;
  random?: () => number;
}

export interface Scheduler {
  /** Re-reads the slot and the dice state and re-arms both timers. Call after any change to either. */
  refresh(): void;
  stop(): void;
}

export interface RollResult {
  randomDue: number;
  lastRollAt: DateTime;
}

/** Wakes at least this often so a long sleep never drifts far from the wall clock. */
const MAX_SLEEP_MS = 60 * 60 * 1000;

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const random = deps.random ?? Math.random;
  let slotTimer: NodeJS.Timeout | undefined;
  let diceTimer: NodeJS.Timeout | undefined;
  let firedSlotId: number | undefined;

  function armSlot(): void {
    clearTimeout(slotTimer);
    const slot = deps.store.slot();
    if (!slot || slot.id === firedSlotId) return;
    const now = deps.clock.now();
    const config = deps.config();
    if (slot.at > now) {
      sleepUntil(slot.at, now, (timer) => (slotTimer = timer), armSlot);
    } else if (inBlackout(now, config)) {
      sleepUntil(blackoutEnd(now, config), now, (timer) => (slotTimer = timer), armSlot);
    } else {
      firedSlotId = slot.id;
      deps.onFire(slot.id);
    }
  }

  function armDice(): void {
    clearTimeout(diceTimer);
    const state = deps.store.state();
    if (state.mode === "paused") return;
    const now = deps.clock.now();
    const config = deps.config();
    if (!state.lastRollAt) {
      deps.store.updateState({ lastRollAt: now });
    } else {
      const rolled = rollRandomDue(state, now, config.random, random);
      if (rolled) deps.store.updateState(rolled);
    }
    const lastRollAt = deps.store.state().lastRollAt ?? now;
    const nextRoll = lastRollAt.plus({ minutes: config.random.unitMin });
    sleepUntil(nextRoll, now, (timer) => (diceTimer = timer), armDice);
  }

  return {
    refresh() {
      armSlot();
      armDice();
    },
    stop() {
      clearTimeout(slotTimer);
      clearTimeout(diceTimer);
    },
  };
}

/**
 * Rolls the dice for every whole unit since `lastRollAt`, including units missed while the process was down.
 * Each unit runs `trials` trials that add one pending event with probability `prob`, capped at `maxDue`.
 * Returns `undefined` when no whole unit has passed.
 */
export function rollRandomDue(
  state: Pick<HarnessState, "randomDue" | "lastRollAt">,
  now: DateTime,
  config: RuntimeConfig["random"],
  random: () => number,
): RollResult | undefined {
  if (!state.lastRollAt) return undefined;
  const units = Math.floor(now.diff(state.lastRollAt, "minutes").minutes / config.unitMin);
  if (units < 1) return undefined;
  let due = state.randomDue;
  for (let trial = 0; trial < units * config.trials && due < config.maxDue; trial++) {
    if (random() < config.prob) due++;
  }
  return {
    randomDue: Math.min(due, config.maxDue),
    lastRollAt: state.lastRollAt.plus({ minutes: units * config.unitMin }),
  };
}

function sleepUntil(
  target: DateTime,
  now: DateTime,
  keep: (timer: NodeJS.Timeout) => void,
  wake: () => void,
): void {
  const delay = Math.min(Math.max(target.diff(now).toMillis(), 0), MAX_SLEEP_MS);
  const timer = setTimeout(wake, delay);
  timer.unref();
  keep(timer);
}
