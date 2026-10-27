import { join } from "node:path";
import { Bot } from "grammy";
import { createDeepSeekBalanceReader } from "./balance.ts";
import { createRuntimeConfigSource, loadStartupConfig, resolveDataDir } from "./config.ts";
import { createChatClient } from "./llm/client.ts";
import { createExecutor } from "./llm/executor.ts";
import { installInitialMemory } from "./memory.ts";
import { recover } from "./recovery.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { openStore } from "./store.ts";
import { attachBotHandlers, createTelegramSender } from "./telegram.ts";
import { systemClock } from "./time.ts";
import { createWorker } from "./worker.ts";

/**
 * Wires the harness together, recovers from the database, and long-polls Telegram until SIGTERM or
 * SIGINT. Shutdown stops polling and the timers, then lets the event in progress finish.
 */
async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const startup = loadStartupConfig(dataDir);
  const configSource = createRuntimeConfigSource(dataDir);
  const config = () => configSource.current();
  installInitialMemory(join(dataDir, "memory"));
  const store = openStore(join(dataDir, "otsu.db"));
  const clock = systemClock;

  const bot = new Bot(startup.botToken);
  let scheduler: Scheduler | undefined;
  const sender = createTelegramSender({
    api: bot.api,
    chatId: startup.ownerChatId,
    config,
    onBlocked: () => worker.enqueue({ kind: "pause" }),
  });
  const worker = createWorker({
    dataDir,
    store,
    clock,
    config,
    executor: createExecutor({
      client: createChatClient(startup),
      provider: startup.llmProvider,
      store,
      clock,
    }),
    sender,
    ...(startup.llmProvider === "deepseek"
      ? { balance: createDeepSeekBalanceReader(startup) }
      : {}),
    onScheduleChange: () => scheduler?.refresh(),
  });
  scheduler = createScheduler({
    store,
    clock,
    config,
    onFire: (slotId) => worker.enqueue({ kind: "schedule", slotId }),
  });

  attachBotHandlers(bot, { ownerChatId: startup.ownerChatId, worker, sender });
  recover({ store, worker, scheduler });

  const shutdown = async (): Promise<void> => {
    await bot.stop();
    scheduler?.stop();
    await worker.idle();
    store.close();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await bot.start({
    allowed_updates: ["message"],
    onStart: (me) => console.log(`otsu is polling as @${me.username}`),
  });
}

await main();
