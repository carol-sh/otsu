import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { DateTime } from "luxon";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { BalanceReader } from "../../src/balance.ts";
import { createRuntimeConfigSource } from "../../src/config.ts";
import { createExecutor } from "../../src/llm/executor.ts";
import { installInitialMemory } from "../../src/memory.ts";
import { createScheduler, type Scheduler } from "../../src/scheduler.ts";
import { recover } from "../../src/recovery.ts";
import { openStore, type Store } from "../../src/store.ts";
import { systemClock } from "../../src/time.ts";
import { createWorker, type Worker } from "../../src/worker.ts";
import { fakeChat, textReply, type FakeChat, type ScriptedReply } from "./fake-chat.ts";

export const START = DateTime.fromISO("2026-10-27T12:00:00+09:00");
export const CLEANUP_DONE = textReply('{"done":true}');
const BASE_ENV = "DEBOUNCE_SEC=20\nBLACKOUT=00:00-08:00\n";

export interface TurnReplyOptions {
  messages?: string[];
  type?: string;
  memo?: string;
}

export function turnReply(
  flow: "continue" | "end",
  at: string,
  options: TurnReplyOptions = {},
): ChatCompletion {
  const { messages = [], type = "followup", memo = "" } = options;
  return textReply(JSON.stringify({ messages, flow, next: { at, type, memo } }));
}

export function seconds(count: number): void {
  mock.timers.tick(count * 1000);
}

export function minutes(count: number): void {
  seconds(count * 60);
}

/** Lets queued microtasks run, so a call the worker just started is in flight. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function lastUserContent(chat: FakeChat): string {
  return String(chat.requests.at(-1)?.messages.at(-1)?.content);
}

/** Sends `/resume`; the slot it makes fires at once and the first script reply answers it. */
export async function resume(worker: Worker): Promise<void> {
  worker.enqueue({ kind: "resume" });
  await worker.idle();
}

export interface StartOptions {
  /** Lines appended to the base `.env`. */
  env?: string;
  balance?: BalanceReader;
  /** Dice values for the scheduler; defaults to never adding a random event. */
  random?: () => number;
}

/**
 * A worker wired to a real store, scheduler, and `.env` in a temporary data dir, with mocked time,
 * a scripted chat client, and a sender that keeps what it sent. `start` runs restart recovery,
 * so a test can prepare the database first to start from any saved state.
 */
export interface WorkerHarness {
  readonly dataDir: string;
  readonly store: Store;
  readonly sent: string[];
  readonly chat: FakeChat;
  start(script: ScriptedReply[], options?: StartOptions): Worker;
  userRows(): { content: string; reason: string | null }[];
  readMemory(name: string): string;
  close(): void;
}

export function openWorkerHarness(): WorkerHarness {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: START.toMillis() });
  const dataDir = mkdtempSync(join(tmpdir(), "otsu-worker-"));
  installInitialMemory(join(dataDir, "memory"));
  writeFileSync(join(dataDir, "prompt.md"), "너는 주인이다.");
  writeFileSync(join(dataDir, "tasks.md"), "- 산책");
  const store = openStore(join(dataDir, "otsu.db"));
  const sent: string[] = [];
  let chat: FakeChat | undefined;
  let scheduler: Scheduler | undefined;

  return {
    dataDir,
    store,
    sent,

    get chat() {
      if (!chat) throw new Error("start the worker first");
      return chat;
    },

    start(script, options = {}) {
      writeFileSync(join(dataDir, ".env"), BASE_ENV + (options.env ?? ""));
      chat = fakeChat(script);
      const source = createRuntimeConfigSource(dataDir);
      const config = () => source.current();
      const worker = createWorker({
        dataDir,
        store,
        clock: systemClock,
        config,
        executor: createExecutor({ client: chat, provider: "openai", store, clock: systemClock }),
        sender: {
          async send(text) {
            sent.push(text);
          },
        },
        ...(options.balance ? { balance: options.balance } : {}),
        onScheduleChange: () => scheduler?.refresh(),
      });
      scheduler = createScheduler({
        store,
        clock: systemClock,
        config,
        onFire: (slotId) => worker.enqueue({ kind: "schedule", slotId }),
        random: options.random ?? (() => 1),
      });
      recover({ store, worker, scheduler });
      return worker;
    },

    userRows() {
      const db = new DatabaseSync(join(dataDir, "otsu.db"), { readOnly: true });
      const rows = db
        .prepare("SELECT content, ignored_reason FROM messages WHERE role = 'user' ORDER BY ts")
        .all()
        .map((row) => ({
          content: String(row.content),
          reason: row.ignored_reason as string | null,
        }));
      db.close();
      return rows;
    },

    readMemory(name) {
      return readFileSync(join(dataDir, "memory", name), "utf8");
    },

    close() {
      scheduler?.stop();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
      mock.timers.reset();
    },
  };
}
