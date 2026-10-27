import { existsSync, readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

type Provider = "deepseek" | "openai";

interface Target {
  provider: Provider;
  model: string;
  effort: ReasoningEffort | undefined;
  client: OpenAI;
}

const PROVIDERS: Record<Provider, { baseURL: string; keyVar: string; defaultModel: string }> = {
  deepseek: {
    baseURL: "https://api.deepseek.com",
    keyVar: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-flash",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    defaultModel: "gpt-6-luna",
  },
};

const MEMORY_READ_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory_read",
    description: "Read one of your memory files by name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

const FAKE_MEMORY = "---\ndescription: the tool's habits\n---\nThe tool works best in the morning.";

/** Long enough to cross every provider's minimum cacheable prefix (OpenAI needs 1024 tokens). */
const CACHE_PREFIX = Array.from(
  { length: 120 },
  (_, i) => `Rule ${i + 1}: keep messages short, plain, and in Korean.`,
).join("\n");

const SYSTEM_PROMPT = [
  "You are the master. Reply only with a json object of the shape",
  '{"messages": string[], "flow": "continue" | "end", "next": {"at": string, "type": string, "memo": string}}.',
  "Your memory index lists one file: tool_habits.",
  CACHE_PREFIX,
].join("\n");

/** Loads `data/.env` without overriding variables already set in the shell. */
function loadDataEnv(): void {
  const path = "data/.env";
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] ??= value;
  }
}

function readTarget(): Target {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
    },
  });
  const provider = values.provider;
  if (provider !== "deepseek" && provider !== "openai") {
    throw new Error("--provider must be deepseek or openai");
  }
  const spec = PROVIDERS[provider];
  const configured = configuredLlm(provider);
  const apiKey = process.env[spec.keyVar] ?? configured.apiKey;
  if (!apiKey) {
    throw new Error(`${spec.keyVar}, or LLM_API_KEY with LLM_PROVIDER=${provider}, is not set`);
  }
  const client = new OpenAI({ apiKey, baseURL: spec.baseURL, maxRetries: 0 });
  return {
    provider,
    model: values.model ?? configured.model ?? spec.defaultModel,
    effort: (values.effort ?? configured.effort) as ReasoningEffort | undefined,
    client,
  };
}

/** Returns the app's own LLM_* settings when they are configured for this provider. */
function configuredLlm(provider: Provider): { apiKey?: string; model?: string; effort?: string } {
  if (process.env.LLM_PROVIDER !== provider) return {};
  const { LLM_API_KEY, LLM_MODEL, LLM_REASONING_EFFORT } = process.env;
  return {
    ...(LLM_API_KEY ? { apiKey: LLM_API_KEY } : {}),
    ...(LLM_MODEL ? { model: LLM_MODEL } : {}),
    ...(LLM_REASONING_EFFORT ? { effort: LLM_REASONING_EFFORT } : {}),
  };
}

/** Builds a JSON-mode request for the target model with the given messages. */
function jsonRequest(
  target: Target,
  messages: ChatCompletionMessageParam[],
): ChatCompletionCreateParamsNonStreaming {
  return {
    model: target.model,
    messages,
    response_format: { type: "json_object" },
    ...(target.effort ? { reasoning_effort: target.effort } : {}),
  };
}

function report(label: string, data: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

function summarize(completion: ChatCompletion): unknown {
  const choice = completion.choices[0];
  return {
    finish_reason: choice?.finish_reason,
    content: choice?.message.content,
    tool_calls: choice?.message.tool_calls,
    usage: completion.usage,
  };
}

function isJsonObject(text: string | null | undefined): boolean {
  try {
    const value: unknown = JSON.parse(text ?? "");
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

function toolResults(completion: ChatCompletion): ChatCompletionMessageParam[] {
  const calls = completion.choices[0]?.message.tool_calls ?? [];
  return calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: FAKE_MEMORY }));
}

/** Sends tools and json_object together and follows tool calls until a final answer arrives. */
async function probeToolsWithJsonMode(target: Target): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: "Read tool_habits with memory_read first, then decide the next json response.",
    },
  ];
  for (let round = 1; round <= 3; round++) {
    const completion = await target.client.chat.completions.create({
      ...jsonRequest(target, messages),
      tools: [MEMORY_READ_TOOL],
    });
    const message = completion.choices[0]?.message;
    report(`tools+json round ${round}`, summarize(completion));
    if (!message?.tool_calls?.length) {
      report("tools+json verdict", {
        rounds: round,
        final_is_json: isJsonObject(message?.content),
      });
      return;
    }
    messages.push(message, ...toolResults(completion));
  }
  report("tools+json verdict", { rounds: "exceeded 3", final_is_json: false });
}

/**
 * Forces a final answer the way the executor will after max_tool_rounds:
 * the tools stay in the request so the cached prefix matches, but `tool_choice: "none"` blocks them.
 */
async function probeForcedJson(target: Target): Promise<void> {
  const completion = await target.client.chat.completions.create({
    ...jsonRequest(target, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: "Read tool_habits with memory_read, then decide the next json response.",
      },
    ]),
    tools: [MEMORY_READ_TOOL],
    tool_choice: "none",
  });
  const message = completion.choices[0]?.message;
  report("forced json", summarize(completion));
  report("forced json verdict", {
    is_json: isJsonObject(message?.content),
    tool_calls_blocked: !message?.tool_calls?.length,
  });
}

/** Calls twice with the same prefix and prints the raw usage so cache fields can be read. */
async function probeCacheUsage(target: Target): Promise<void> {
  for (const attempt of [1, 2]) {
    const completion = await target.client.chat.completions.create(
      jsonRequest(target, [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Cache probe ${attempt}. Decide the next json response.` },
      ]),
    );
    report(`cache usage ${attempt}`, completion.usage);
  }
}

async function main(): Promise<void> {
  loadDataEnv();
  const target = readTarget();
  report("target", { provider: target.provider, model: target.model, effort: target.effort });
  await probeToolsWithJsonMode(target);
  await probeForcedJson(target);
  await probeCacheUsage(target);
}

await main();
