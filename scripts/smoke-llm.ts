import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { DateTime } from "luxon";
import { createRuntimeConfigSource, resolveDataDir } from "../src/config.ts";
import { installInitialMemory, openMemoryTx } from "../src/memory.ts";
import { createChatClient } from "../src/llm/client.ts";
import { buildCleanupMessages, buildTurnMessages, renderEventBlock } from "../src/llm/context.ts";
import { createExecutor } from "../src/llm/executor.ts";
import { parseCleanupOutput, parseTurnOutput } from "../src/llm/output.ts";
import { CLEANUP_TOOLS, TURN_TOOLS, memoryToolRunner } from "../src/llm/tools.ts";
import { openStore } from "../src/store.ts";
import { systemClock } from "../src/time.ts";

/**
 * Runs one real turn call and one cleanup call against a throwaway data dir,
 * using the LLM settings from `data/.env`. Prints the results and the memory files written.
 */
async function main(): Promise<void> {
  const sourceDir = resolveDataDir();
  const env = parseEnv(readFileSync(join(sourceDir, ".env"), "utf8"));
  const config = createRuntimeConfigSource(sourceDir).current();

  const dataDir = mkdtempSync(join(tmpdir(), "otsu-smoke-"));
  installInitialMemory(join(dataDir, "memory"));
  writeFileSync(
    join(dataDir, "prompt.md"),
    "너는 사용자를 도구로 부리는 주인이다. 짧고 단호한 반말로 말한다.",
  );
  writeFileSync(
    join(dataDir, "tasks.md"),
    "- 10분 산책하고 본 것 한 가지 보고하기\n- 물 한 컵 마시기",
  );

  const store = openStore(":memory:");
  const executor = createExecutor({
    client: createChatClient({
      llmApiKey: env.LLM_API_KEY ?? "",
      llmBaseUrl: env.LLM_BASE_URL || "https://api.openai.com/v1",
    }),
    provider: env.LLM_PROVIDER === "deepseek" ? "deepseek" : "openai",
    store,
    clock: systemClock,
  });

  const flow = store.openFlow(DateTime.now());
  const now = DateTime.now();
  const event = renderEventBlock({ kind: "schedule", type: "task", memo: "" }, now, config, 0);
  const turnTx = openMemoryTx(join(dataDir, "memory"), {
    maxFileChars: config.memoryFileMaxChars,
    maxFiles: config.memoryMaxFiles,
  });
  const turn = await executor.run({
    kind: "turn",
    flowId: flow.id,
    config,
    messages: buildTurnMessages({ dataDir, config, flow, history: [], eventBlock: event }),
    tools: TURN_TOOLS,
    maxToolRounds: config.maxToolRounds,
    runTool: memoryToolRunner(turnTx, false),
    parse: parseTurnOutput,
  });
  console.log("turn:", turn.ok ? turn.raw : turn.error);
  if (!turn.ok) return;

  store.recordMessage({
    flowId: flow.id,
    role: "event",
    content: event,
    ts: store.issueMessageTs(now),
  });
  store.recordMessage({
    flowId: flow.id,
    role: "assistant",
    content: turn.raw,
    ts: store.issueMessageTs(now),
  });
  store.recordMessage({
    flowId: flow.id,
    role: "user",
    content: "다녀왔어. 고양이 봤어",
    ts: store.issueMessageTs(DateTime.now()),
  });

  const cleanupTx = openMemoryTx(join(dataDir, "memory"), {
    maxFileChars: config.memoryFileMaxChars,
    maxFiles: config.memoryMaxFiles,
  });
  const cleanup = await executor.run({
    kind: "cleanup",
    flowId: flow.id,
    config,
    messages: buildCleanupMessages({
      dataDir,
      config,
      flow,
      history: store.flowMessages(flow.id),
      now: DateTime.now(),
    }),
    tools: CLEANUP_TOOLS,
    maxToolRounds: config.maxCleanupToolRounds,
    runTool: memoryToolRunner(cleanupTx, true),
    parse: parseCleanupOutput,
  });
  console.log("cleanup:", cleanup.ok ? cleanup.raw : cleanup.error);
  if (cleanup.ok) cleanupTx.commit();
  console.log("journal.md:\n" + readFileSync(join(dataDir, "memory", "journal.md"), "utf8"));
  console.log("requests today:", store.dailyCalls(now.setZone(config.timezone).toISODate()!));
}

await main();
