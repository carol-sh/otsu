import type { Scheduler } from "./scheduler.ts";
import type { Store } from "./store.ts";
import type { Worker } from "./worker.ts";

export interface RecoveryDeps {
  store: Store;
  worker: Worker;
  scheduler: Scheduler;
}

/**
 * Rebuilds what a restart lost from the database: pending cleanup calls, the debounce buffer of the
 * active flow, and the slot timer. Buffered replies are restored before the slot is armed, so a slot
 * that comes due with them gives way to the replies. A hold is checked again by the first event that
 * would call the LLM, since every such event passes the call gate.
 */
export function recover(deps: RecoveryDeps): void {
  const { store, worker } = deps;
  for (const flow of store.flowsPendingCleanup()) {
    worker.enqueue({ kind: "cleanup", flowId: flow.id });
  }
  const state = store.state();
  if (state.mode === "active" && state.currentFlowId !== null) {
    worker.restoreBuffer(store.unansweredUserMessages(state.currentFlowId));
  }
  deps.scheduler.refresh();
}
