import type { RuntimeConfig } from "./config.ts";
import { buildCompactMessages, estimateTokens } from "./llm/context.ts";
import type { Executor } from "./llm/executor.ts";
import { parseCompactOutput } from "./llm/output.ts";
import type { Message, Store } from "./store.ts";

export interface CompactorDeps {
  dataDir: string;
  store: Store;
  config: () => RuntimeConfig;
  executor: Executor;
}

/** How many of the latest answers, with the messages around them, stay verbatim after compaction. */
const KEEP_RECENT_ANSWERS = 2;

/**
 * Folds a flow's older messages into `flows.summary` once its conversation passes `flow_compact_tokens`.
 * The cut falls right after an answer, so the kept part starts with what the user said next.
 * A failed call leaves the flow as it was; the next turn tries again.
 */
export async function compactIfLarge(deps: CompactorDeps, flowId: number): Promise<void> {
  const { store } = deps;
  const config = deps.config();
  const flow = store.flow(flowId);
  if (!flow) return;
  const history = store.flowMessages(flow.id, flow.compactedUntil);
  const size = estimateTokens([flow.summary ?? "", ...history.map((m) => m.content)].join(""));
  if (size <= config.flowCompactTokens) return;
  const cut = compactionCut(history);
  if (cut === undefined) return;

  const older = history.slice(0, cut);
  const result = await deps.executor.run({
    kind: "compact",
    flowId,
    config,
    messages: buildCompactMessages({ dataDir: deps.dataDir, config, flow, history: older }),
    tools: [],
    maxToolRounds: 0,
    runTool: () => "도구는 없다.",
    parse: parseCompactOutput,
  });
  if (!result.ok) {
    console.error(`compaction of flow ${flowId} failed: ${result.error}`);
    return;
  }
  store.saveCompaction(flow.id, result.value.summary, older.at(-1)!.ts);
}

/** Returns how many leading messages to fold, or `undefined` when too few answers exist to keep any verbatim. */
function compactionCut(history: readonly Message[]): number | undefined {
  const answers = history.flatMap((message, index) =>
    message.role === "assistant" ? [index] : [],
  );
  const lastFolded = answers.at(-(KEEP_RECENT_ANSWERS + 1));
  return lastFolded === undefined ? undefined : lastFolded + 1;
}
