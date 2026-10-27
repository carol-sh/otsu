import type { DateTime } from "luxon";
import type { BalanceReader } from "./balance.ts";
import type { RuntimeConfig } from "./config.ts";
import type { HarnessEvent } from "./events.ts";
import type { HoldReason, Store } from "./store.ts";
import type { Clock } from "./time.ts";
import type { Sender } from "./sender.ts";

export interface CallGateDeps {
  store: Store;
  clock: Clock;
  config: () => RuntimeConfig;
  /** Present only for providers whose balance can be read. */
  balance: BalanceReader | undefined;
  sender: Sender;
  /** Receives the held events when a recheck is due, to queue them again. */
  release: (events: HarnessEvent[]) => void;
}

/** Stops LLM calls while the daily call limit is reached or the balance is low, without losing events. */
export interface CallGate {
  /** Names what stops calls now, or `undefined` when calls may go ahead. */
  blocked(): Promise<HoldReason | undefined>;
  /**
   * Lets the event through, or holds it and returns `false`. Entering a hold tells the operator once;
   * held events are released at the next recheck: `balance_retry_min` later, or local midnight for the daily limit.
   */
  admit(event: HarnessEvent): Promise<boolean>;
}

const HOLD_NOTICE: Record<HoldReason, string> = {
  balance: "[하네스] LLM 잔액이 기준보다 적어 호출을 멈췄다. 충전되면 이어간다.",
  daily_limit: "[하네스] 오늘의 LLM 호출 상한에 도달해 멈췄다. 자정에 이어간다.",
};

export function createCallGate(deps: CallGateDeps): CallGate {
  const held: HarnessEvent[] = [];
  let recheckTimer: NodeJS.Timeout | undefined;

  async function blocked(): Promise<HoldReason | undefined> {
    const config = deps.config();
    const today = deps.clock.now().setZone(config.timezone).toISODate()!;
    if (deps.store.dailyCalls(today) >= config.dailyCallLimit) return "daily_limit";
    const balance = await deps.balance?.();
    if (balance !== undefined && balance < config.balanceThreshold) return "balance";
    return undefined;
  }

  function hold(event: HarnessEvent): void {
    const key = JSON.stringify(event);
    if (!held.some((other) => JSON.stringify(other) === key)) held.push(event);
  }

  function releaseHeld(): void {
    clearTimeout(recheckTimer);
    recheckTimer = undefined;
    deps.release(held.splice(0));
  }

  function armRecheck(reason: HoldReason): void {
    if (recheckTimer) return;
    const now = deps.clock.now();
    const delayMs = recheckAt(reason, now, deps.config()).diff(now).toMillis();
    recheckTimer = setTimeout(releaseHeld, Math.max(delayMs, 0));
    recheckTimer.unref();
  }

  return {
    blocked,

    async admit(event) {
      const reason = await blocked();
      const previous = deps.store.state().holdReason;
      if (!reason) {
        if (previous) {
          deps.store.updateState({ holdReason: null });
          releaseHeld();
        }
        return true;
      }
      hold(event);
      armRecheck(reason);
      if (previous !== reason) {
        deps.store.updateState({ holdReason: reason });
        await deps.sender.send(HOLD_NOTICE[reason]);
      }
      return false;
    },
  };
}

function recheckAt(reason: HoldReason, now: DateTime, config: RuntimeConfig): DateTime {
  return reason === "daily_limit"
    ? now.setZone(config.timezone).startOf("day").plus({ days: 1 })
    : now.plus({ minutes: config.balanceRetryMin });
}
