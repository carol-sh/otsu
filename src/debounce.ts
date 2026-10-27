import type { Message } from "./store.ts";

/** Holds valid user messages until no new one has arrived for the debounce delay. */
export interface DebounceBuffer {
  /** Adds a message and restarts the timer, which calls `onExpire` after `delayMs` of quiet. */
  add(message: Message, delayMs: number): void;
  /** Empties the buffer, stops the timer, and returns the messages it held. */
  take(): Message[];
  isEmpty(): boolean;
}

export function createDebounceBuffer(onExpire: () => void): DebounceBuffer {
  let messages: Message[] = [];
  let timer: NodeJS.Timeout | undefined;

  return {
    add(message, delayMs) {
      messages.push(message);
      clearTimeout(timer);
      timer = setTimeout(onExpire, delayMs);
      timer.unref();
    },

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
