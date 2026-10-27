import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import type { StartupConfig } from "../config.ts";

/** The one API call the harness makes. Tests swap in a scripted fake. */
export interface ChatClient {
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
}

export interface TokenUsage {
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
}

/** Creates a Chat Completions client with SDK retries off, since the harness does its own backoff. */
export function createChatClient(
  config: Pick<StartupConfig, "llmApiKey" | "llmBaseUrl">,
): ChatClient {
  const client = new OpenAI({
    apiKey: config.llmApiKey,
    baseURL: config.llmBaseUrl,
    maxRetries: 0,
  });
  return { create: (params) => client.chat.completions.create(params) };
}

/** Reads cache and output token counts from the provider-specific usage fields. */
export function readUsage(
  provider: StartupConfig["llmProvider"],
  usage: ChatCompletion["usage"],
): TokenUsage {
  if (!usage) {
    return {
      cacheHitTokens: null,
      cacheMissTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
    };
  }
  const raw = usage as unknown as Record<string, unknown>;
  if (provider === "deepseek") {
    return {
      cacheHitTokens: numberOrNull(raw.prompt_cache_hit_tokens),
      cacheMissTokens: numberOrNull(raw.prompt_cache_miss_tokens),
      cacheWriteTokens: null,
      outputTokens: usage.completion_tokens,
    };
  }
  const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cached = numberOrNull(details.cached_tokens) ?? 0;
  return {
    cacheHitTokens: cached,
    cacheMissTokens: usage.prompt_tokens - cached,
    cacheWriteTokens: numberOrNull(details.cache_write_tokens),
    outputTokens: usage.completion_tokens,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
