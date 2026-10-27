import { join } from "node:path";
import type { DateTime } from "luxon";
import type { RuntimeConfig } from "./config.ts";
import { createDebounceBuffer, debounceDelayMs } from "./debounce.ts";
import type { HarnessEvent } from "./events.ts";
import { openMemoryTx, type MemoryLimits } from "./memory.ts";
import {
  buildCleanupMessages,
  buildTurnMessages,
  renderEventBlock,
  type TurnEvent,
} from "./llm/context.ts";
import type { Executor } from "./llm/executor.ts";
import { parseCleanupOutput, parseTurnOutput, type TurnOutput } from "./llm/output.ts";
import { CLEANUP_TOOLS, TURN_TOOLS, memoryToolRunner } from "./llm/tools.ts";
import type { EndReason, IgnoredReason, Mode, Slot, Store } from "./store.ts";
import { blackoutEnd, clampNextAt, inBlackout, type Clock } from "./time.ts";

/** Delivers one message to the user. */
export interface Sender {
  send(text: string): Promise<void>;
}

export interface WorkerDeps {
  dataDir: string;
  store: Store;
  clock: Clock;
  /** Returns the current settings; called on every event so `.env` edits apply. */
  config: () => RuntimeConfig;
  executor: Executor;
  sender: Sender;
  /** Called after the slot or the mode changes, so the scheduler re-arms its timers. */
  onScheduleChange: () => void;
}

export interface Worker {
  /** Records a user message on arrival and, when it is valid, buffers it and restarts the debounce timer. */
  receive(text: string): void;
  /** Queues an event. Events are handled one at a time, in arrival order. */
  enqueue(event: HarnessEvent): void;
  /** Resolves once the queue is empty and no event is being handled. */
  idle(): Promise<void>;
}

/** The result of a successful turn call, with the timestamps fixed when its input was taken. */
interface TurnResult {
  flowId: number | null;
  trigger: TurnEvent;
  output: TurnOutput;
  raw: string;
  eventBlock: string;
  eventTs: DateTime;
  cutoffTs: DateTime;
}

const NOTICE = {
  paused: "[하네스] 정지했다. /resume을 보내면 다시 시작한다.",
  alreadyPaused: "[하네스] 이미 정지 상태다.",
  resumed: "[하네스] 다시 시작했다.",
  notPaused: "[하네스] 정지 상태가 아니라서 무시했다.",
} as const;

export function createWorker(deps: WorkerDeps): Worker {
  const { store, clock } = deps;
  const memoryDir = join(deps.dataDir, "memory");
  const queue: HarnessEvent[] = [];
  const buffer = createDebounceBuffer(() => enqueue({ kind: "debounce" }));
  let draining: Promise<void> | undefined;

  function enqueue(event: HarnessEvent): void {
    queue.push(event);
    kick();
  }

  /** Starts draining on a later microtask, so an event queued while handling another waits its turn. */
  function kick(): void {
    if (draining || queue.length === 0) return;
    draining = Promise.resolve()
      .then(drain)
      .finally(() => {
        draining = undefined;
        kick();
      });
  }

  /** Waits out the current drain and any drain it starts on its way out. */
  async function idle(): Promise<void> {
    if (!draining) return;
    await draining;
    return idle();
  }

  async function drain(): Promise<void> {
    for (let event = queue.shift(); event; event = queue.shift()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- events are handled strictly one at a time
        await handle(event);
      } catch (error) {
        console.error(`failed to handle ${event.kind} event:`, error);
      }
    }
  }

  function handle(event: HarnessEvent): Promise<void> {
    switch (event.kind) {
      case "debounce":
        return onDebounce();
      case "schedule":
        return onSchedule(event.slotId);
      case "cleanup":
        return runCleanup(event.flowId);
      case "pause":
        return pause();
      case "resume":
        return resume();
    }
  }

  /** Calls with the buffered messages, or holds them until blackout ends when it has started meanwhile. */
  async function onDebounce(): Promise<void> {
    const state = store.state();
    if (buffer.isEmpty() || state.mode !== "active" || state.currentFlowId === null) return;
    const config = deps.config();
    const now = clock.now();
    if (inBlackout(now, config)) {
      buffer.arm(blackoutEnd(now, config).diff(now).toMillis());
      return;
    }
    await runTurn({ kind: "reply" }, state.currentFlowId);
  }

  /**
   * Drops the event when the slot was replaced after it fired, and pushes the slot past a blackout
   * that started meanwhile. Buffered replies take the place of the slot; an ended state starts a new flow.
   */
  async function onSchedule(slotId: number): Promise<void> {
    const slot = store.slot();
    const state = store.state();
    if (!slot || slot.id !== slotId || state.mode === "paused") return;
    const config = deps.config();
    const now = clock.now();
    if (inBlackout(now, config)) {
      pushSlotPastBlackout(slot, now, config);
    } else if (!buffer.isEmpty() && state.currentFlowId !== null) {
      await runTurn({ kind: "reply" }, state.currentFlowId);
    } else {
      const trigger: TurnEvent = { kind: "schedule", type: slot.type, memo: slot.memo };
      await runTurn(trigger, state.mode === "active" ? state.currentFlowId : null);
    }
  }

  function pushSlotPastBlackout(slot: Slot, now: DateTime, config: RuntimeConfig): void {
    store.replaceSlot({ at: blackoutEnd(now, config), type: slot.type, memo: slot.memo }, now);
    deps.onScheduleChange();
  }

  /** Takes the buffered messages as this call's input, calls the LLM, and applies the result. */
  async function runTurn(trigger: TurnEvent, flowId: number | null): Promise<void> {
    const config = deps.config();
    const now = clock.now();
    buffer.take();
    const flow = flowId === null ? undefined : store.flow(flowId);
    const eventBlock = renderEventBlock(trigger, now, config, store.state().randomDue);
    const eventTs = store.issueMessageTs(now);
    const cutoffTs = store.issueMessageTs(now);
    const result = await deps.executor.run({
      kind: "turn",
      flowId,
      config,
      messages: buildTurnMessages({
        dataDir: deps.dataDir,
        config,
        flow,
        history: flow ? store.flowMessages(flow.id, flow.compactedUntil) : [],
        eventBlock,
      }),
      tools: TURN_TOOLS,
      maxToolRounds: config.maxToolRounds,
      runTool: memoryToolRunner(openMemoryTx(memoryDir, memoryLimits(config)), false),
      parse: parseTurnOutput,
    });
    if (!result.ok) {
      recordFailure(result.error);
      return;
    }
    await applyTurn({
      flowId,
      trigger,
      output: result.value,
      raw: result.raw,
      eventBlock,
      eventTs,
      cutoffTs,
    });
  }

  /** Applies a turn in the designed order: record, send, close the flow if asked, replace the slot. */
  async function applyTurn(turn: TurnResult): Promise<void> {
    const flowId = recordTurn(turn);
    for (const text of turn.output.messages) {
      // oxlint-disable-next-line no-await-in-loop -- messages must arrive in order
      await deps.sender.send(text);
    }
    if (turn.output.flow === "end") {
      closeFlow(flowId, "agent");
      store.updateState({ mode: "ended", currentFlowId: null });
    }
    scheduleNext(turn.output.next);
  }

  /** Opens the flow when the turn started one, stores the event and the answer, and settles the counters. */
  function recordTurn(turn: TurnResult): number {
    return store.transaction(() => {
      const flowId = turn.flowId ?? openFlow();
      store.recordMessage({ flowId, role: "event", content: turn.eventBlock, ts: turn.eventTs });
      store.recordMessage({ flowId, role: "assistant", content: turn.raw, ts: turn.cutoffTs });
      const { randomDue } = store.state();
      const usedRandom = turn.trigger.kind === "schedule" && turn.trigger.type === "random";
      store.updateState({
        consecutiveFailures: 0,
        ...(usedRandom ? { randomDue: Math.max(randomDue - 1, 0) } : {}),
      });
      return flowId;
    });
  }

  function openFlow(): number {
    const flow = store.openFlow(clock.now());
    store.updateState({ mode: "active", currentFlowId: flow.id });
    return flow.id;
  }

  /** Closes a flow, drops the buffered messages as `late`, and queues its cleanup call. */
  function closeFlow(flowId: number, reason: EndReason): void {
    store.transaction(() => {
      store.closeFlow(flowId, reason, clock.now());
      store.ignoreMessages(
        buffer.take().map((message) => message.id),
        "late",
      );
    });
    enqueue({ kind: "cleanup", flowId });
  }

  function scheduleNext(next: TurnOutput["next"]): void {
    const now = clock.now();
    const { at, notes } = clampNextAt(next.at, now, deps.config());
    const memo = [next.memo, ...notes].filter((line) => line !== "").join("\n");
    store.replaceSlot({ at, type: next.type, memo }, now);
    deps.onScheduleChange();
  }

  function recordFailure(error: string): void {
    const failures = store.state().consecutiveFailures + 1;
    store.updateState({ consecutiveFailures: failures });
    console.error(`turn call failed (${failures} in a row): ${error}`);
  }

  /** Writes the ended flow into long-term memory, retrying up to `cleanup_retry` times. */
  async function runCleanup(flowId: number): Promise<void> {
    const flow = store.flow(flowId);
    if (flow?.cleanupStatus !== "pending") return;
    const config = deps.config();
    for (let attempt = 0; attempt <= config.cleanupRetry; attempt++) {
      const tx = openMemoryTx(memoryDir, memoryLimits(config));
      // oxlint-disable-next-line no-await-in-loop -- a retry only follows a failed attempt
      const result = await deps.executor.run({
        kind: "cleanup",
        flowId,
        config,
        messages: buildCleanupMessages({
          dataDir: deps.dataDir,
          config,
          flow,
          history: store.flowMessages(flow.id, flow.compactedUntil),
          now: clock.now(),
        }),
        tools: CLEANUP_TOOLS,
        maxToolRounds: config.maxCleanupToolRounds,
        runTool: memoryToolRunner(tx, true),
        parse: parseCleanupOutput,
      });
      if (result.ok) {
        tx.commit();
        store.setCleanupStatus(flowId, "done");
        return;
      }
      console.error(`cleanup call for flow ${flowId} failed: ${result.error}`);
    }
    store.setCleanupStatus(flowId, "failed");
  }

  async function pause(): Promise<void> {
    const state = store.state();
    if (state.mode === "paused") {
      await deps.sender.send(NOTICE.alreadyPaused);
      return;
    }
    if (state.mode === "active" && state.currentFlowId !== null) {
      closeFlow(state.currentFlowId, "paused");
    }
    store.transaction(() => {
      store.updateState({ mode: "paused", currentFlowId: null });
      store.clearSlot();
    });
    deps.onScheduleChange();
    await deps.sender.send(NOTICE.paused);
  }

  /** Moves to the ended state with a memo-less task slot at the current time, pushed out of blackout. */
  async function resume(): Promise<void> {
    if (store.state().mode !== "paused") {
      await deps.sender.send(NOTICE.notPaused);
      return;
    }
    const now = clock.now();
    store.transaction(() => {
      store.updateState({ mode: "ended", lastRollAt: now });
      store.replaceSlot({ at: blackoutEnd(now, deps.config()), type: "task", memo: "" }, now);
    });
    deps.onScheduleChange();
    await deps.sender.send(NOTICE.resumed);
  }

  return {
    receive(text) {
      const config = deps.config();
      const state = store.state();
      const now = clock.now();
      const reason = intakeIgnoreReason(state.mode, now, config);
      const message = store.recordMessage({
        flowId: state.mode === "active" ? state.currentFlowId : null,
        role: "user",
        content: text,
        ts: store.issueMessageTs(now),
        ...(reason ? { ignoredReason: reason } : {}),
      });
      if (!reason) buffer.add(message, debounceDelayMs(now, config));
    },

    enqueue,

    idle,
  };
}

/** Names why a user message arriving now is only recorded, or `undefined` when it is valid. */
function intakeIgnoreReason(
  mode: Mode,
  now: DateTime,
  config: RuntimeConfig,
): IgnoredReason | undefined {
  if (mode === "paused") return "paused";
  if (mode === "ended") return "ended";
  return inBlackout(now, config) ? "blackout" : undefined;
}

function memoryLimits(config: RuntimeConfig): MemoryLimits {
  return { maxFileChars: config.memoryFileMaxChars, maxFiles: config.memoryMaxFiles };
}
