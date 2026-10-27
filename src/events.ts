/**
 * What the worker takes off its queue. User messages are not here: intake records and buffers them
 * on arrival, and only the debounce expiry is queued.
 */
export type HarnessEvent =
  | { kind: "debounce" }
  /** `slotId` is the slot that fired, so a slot replaced since then is recognized as stale. */
  | { kind: "schedule"; slotId: number }
  | { kind: "cleanup"; flowId: number }
  | { kind: "pause" }
  | { kind: "resume" };
