import type { DateTime } from "luxon";
import type { RuntimeConfig } from "./config.ts";
import type { Message } from "./store.ts";
import { nextBlackoutStart } from "./time.ts";

/** Holds valid user messages until no new one has arrived for the debounce delay. */
export interface DebounceBuffer {
  /** Adds a message and restarts the timer, which calls `onExpire` after `delayMs` of quiet. */
  add(message: Message, delayMs: number): void;
  /** Restarts the timer without adding a message. */
  arm(delayMs: number): void;
  /** Empties the buffer, stops the timer, and returns the messages it held. */
  take(): Message[];
  isEmpty(): boolean;
}

/** How long before a blackout starts a cut-short debounce expires, so the call starts outside it. */
const BLACKOUT_FLUSH_MARGIN_MS = 1000;

export function createDebounceBuffer(onExpire: () => void): DebounceBuffer {
  let messages: Message[] = [];
  let timer: NodeJS.Timeout | undefined;

  function arm(delayMs: number): void {
    clearTimeout(timer);
    timer = setTimeout(onExpire, delayMs);
    timer.unref();
  }

  return {
    add(message, delayMs) {
      messages.push(message);
      arm(delayMs);
    },

    arm,

    take() {
      clearTimeout(timer);
      const taken = messages;
      messages = [];
      return taken;
    },

    isEmpty() {
      return messages.length === 0;
    },
  };
}

/** Returns the quiet period before a call, cut short when the next blackout would start first. */
export function debounceDelayMs(
  now: DateTime,
  config: Pick<RuntimeConfig, "debounceSec" | "timezone" | "blackout">,
): number {
  const quietMs = config.debounceSec * 1000;
  const blackoutStart = nextBlackoutStart(now, config);
  if (!blackoutStart) return quietMs;
  const untilBlackoutMs = blackoutStart.diff(now).toMillis() - BLACKOUT_FLUSH_MARGIN_MS;
  return Math.max(Math.min(quietMs, untilBlackoutMs), 0);
}
