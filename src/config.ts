import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { IANAZone } from "luxon";
import { z } from "zod";

/** A daily blackout window in minutes since local midnight. `end < start` means it crosses midnight. */
export interface BlackoutWindow {
  start: number;
  end: number;
}

export type StartupConfig = z.output<typeof startupSchema>;
export type RuntimeConfig = z.output<typeof runtimeSchema>;

export interface RuntimeConfigSource {
  /** Re-reads `.env` and returns its values, or the last valid values if the file is now broken. */
  current(): RuntimeConfig;
}

const positiveInt = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().positive();

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const startupSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string(),
    TELEGRAM_OWNER_CHAT_ID: z.coerce.number().int(),
    LLM_PROVIDER: z.enum(["openai", "deepseek"]).default("openai"),
    LLM_BASE_URL: z.url().default("https://api.openai.com/v1"),
    LLM_API_KEY: z.string(),
  })
  .transform((env) => ({
    botToken: env.TELEGRAM_BOT_TOKEN,
    ownerChatId: env.TELEGRAM_OWNER_CHAT_ID,
    llmProvider: env.LLM_PROVIDER,
    llmBaseUrl: env.LLM_BASE_URL,
    llmApiKey: env.LLM_API_KEY,
  }));

const runtimeSchema = z
  .object({
    TIMEZONE: z
      .string()
      .refine((zone) => IANAZone.isValidZone(zone), "unknown IANA timezone")
      .default("Asia/Seoul"),
    BLACKOUT: z.string().default("00:00-08:00").transform(parseBlackoutList),
    MIN_INTERVAL_MIN: positiveInt.default(1),
    MAX_DELAY_HOURS: positiveInt.default(48),
    RANDOM_UNIT_MIN: positiveInt.default(60),
    RANDOM_TRIALS: z.coerce.number().int().nonnegative().default(1),
    RANDOM_PROB: z.coerce.number().min(0).max(1).default(0.15),
    RANDOM_MAX_DUE: positiveInt.default(3),
    DEBOUNCE_SEC: positiveInt.default(20),
    SEND_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1000),
    LLM_MODEL: z.string().default("gpt-6-luna"),
    LLM_REASONING_EFFORT: z.enum(REASONING_EFFORTS).optional(),
    MAX_TOOL_ROUNDS: positiveInt.default(3),
    MAX_CLEANUP_TOOL_ROUNDS: positiveInt.default(5),
    FALLBACK_DELAY_MIN: positiveInt.default(10),
    FALLBACK_MAX_DELAY_MIN: positiveInt.default(120),
    ALERT_AFTER: positiveInt.default(3),
    DAILY_CALL_LIMIT: positiveInt.default(800),
    BALANCE_THRESHOLD: positiveNumber.default(1),
    BALANCE_RETRY_MIN: positiveInt.default(30),
    FLOW_COMPACT_TOKENS: positiveInt.default(12_000),
    MEMORY_FILE_MAX_CHARS: positiveInt.default(8000),
    MEMORY_MAX_FILES: positiveInt.default(8),
    CLEANUP_RETRY: z.coerce.number().int().nonnegative().default(2),
  })
  .transform((env) => ({
    timezone: env.TIMEZONE,
    blackout: env.BLACKOUT,
    minIntervalMin: env.MIN_INTERVAL_MIN,
    maxDelayHours: env.MAX_DELAY_HOURS,
    random: {
      unitMin: env.RANDOM_UNIT_MIN,
      trials: env.RANDOM_TRIALS,
      prob: env.RANDOM_PROB,
      maxDue: env.RANDOM_MAX_DUE,
    },
    debounceSec: env.DEBOUNCE_SEC,
    sendIntervalMs: env.SEND_INTERVAL_MS,
    llmModel: env.LLM_MODEL,
    reasoningEffort: env.LLM_REASONING_EFFORT,
    maxToolRounds: env.MAX_TOOL_ROUNDS,
    maxCleanupToolRounds: env.MAX_CLEANUP_TOOL_ROUNDS,
    fallbackDelayMin: env.FALLBACK_DELAY_MIN,
    fallbackMaxDelayMin: env.FALLBACK_MAX_DELAY_MIN,
    alertAfter: env.ALERT_AFTER,
    dailyCallLimit: env.DAILY_CALL_LIMIT,
    balanceThreshold: env.BALANCE_THRESHOLD,
    balanceRetryMin: env.BALANCE_RETRY_MIN,
    flowCompactTokens: env.FLOW_COMPACT_TOKENS,
    memoryFileMaxChars: env.MEMORY_FILE_MAX_CHARS,
    memoryMaxFiles: env.MEMORY_MAX_FILES,
    cleanupRetry: env.CLEANUP_RETRY,
  }));

/** Returns `DATA_DIR` from the process environment, defaulting to `./data`. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR || "./data";
}

/** Reads the values that need a restart to change. Throws when `.env` is missing or invalid. */
export function loadStartupConfig(dataDir: string): StartupConfig {
  return parseOrThrow(startupSchema, readEnvFile(dataDir));
}

/**
 * Creates a source that re-reads `.env` on every `current()` call.
 * Throws at creation when the file is invalid; later failures are reported and the last valid values are kept.
 */
export function createRuntimeConfigSource(
  dataDir: string,
  onReloadError: (error: Error) => void = (error) => console.error(error.message),
): RuntimeConfigSource {
  let lastValid = parseOrThrow(runtimeSchema, readEnvFile(dataDir));
  return {
    current() {
      try {
        lastValid = parseOrThrow(runtimeSchema, readEnvFile(dataDir));
      } catch (error) {
        onReloadError(error as Error);
      }
      return lastValid;
    },
  };
}

/** Reads `DATA_DIR/.env` into key-value pairs, dropping empty values so they count as unset. */
function readEnvFile(dataDir: string): Record<string, string> {
  const parsed = parseEnv(readFileSync(join(dataDir, ".env"), "utf8"));
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function parseOrThrow<T extends z.ZodType>(schema: T, env: Record<string, string>): z.output<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`invalid .env\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Parses `BLACKOUT`, a comma-separated list of `HH:MM-HH:MM` windows. An empty list means no blackout. */
function parseBlackoutList(text: string, ctx: z.RefinementCtx): BlackoutWindow[] {
  const windows: BlackoutWindow[] = [];
  for (const part of text.split(",").map((item) => item.trim())) {
    if (part === "") continue;
    const window = parseBlackoutWindow(part);
    if (!window) {
      ctx.addIssue({ code: "custom", message: `invalid blackout window "${part}"` });
      return z.NEVER;
    }
    windows.push(window);
  }
  return windows;
}

function parseBlackoutWindow(text: string): BlackoutWindow | undefined {
  const [startText, endText, ...rest] = text.split("-");
  if (startText === undefined || endText === undefined || rest.length > 0) return undefined;
  const start = parseClockMinutes(startText.trim());
  const end = parseClockMinutes(endText.trim());
  if (start === undefined || end === undefined || start === end) return undefined;
  return { start, end };
}

/** Converts `HH:MM` to minutes since midnight. `24:00` is not allowed; use `00:00`. */
function parseClockMinutes(text: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}
