import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type { RuntimeConfig, StartupConfig } from "../config.ts";
import type { LlmCallKind, Store } from "../store.ts";
import type { Clock } from "../time.ts";
import { readUsage, type ChatClient } from "./client.ts";
import type { OutputParser } from "./output.ts";
import type { ToolRunner } from "./tools.ts";

export interface ExecutorDeps {
  client: ChatClient;
  provider: StartupConfig["llmProvider"];
  store: Store;
  clock: Clock;
}

export interface CallSpec<T> {
  kind: LlmCallKind;
  flowId: number | null;
  config: Pick<RuntimeConfig, "llmModel" | "reasoningEffort" | "timezone">;
  messages: readonly ChatCompletionMessageParam[];
  tools: readonly ChatCompletionFunctionTool[];
  maxToolRounds: number;
  runTool: ToolRunner;
  parse: OutputParser<T>;
}

/** `raw` is the model's final JSON text, stored as the assistant message. */
export type CallResult<T> = { ok: true; value: T; raw: string } | { ok: false; error: string };

type Reply = { ok: true; message: ChatCompletionMessage } | { ok: false; error: string };

export interface Executor {
  /**
   * Runs one LLM call: tool rounds up to the limit, then a forced final answer with tools kept
   * but `tool_choice: "none"`, and one retry when the answer does not parse.
   * Every API request is logged to `llm_calls` and counted toward the daily limit.
   */
  run<T>(spec: CallSpec<T>): Promise<CallResult<T>>;
}

export function createExecutor(deps: ExecutorDeps): Executor {
  /** Sends one request and logs it, with `judge` naming why a reply is unusable. Fails only on API errors. */
  async function send<T>(
    spec: CallSpec<T>,
    messages: readonly ChatCompletionMessageParam[],
    forced: boolean,
    judge: (message: ChatCompletionMessage) => string | undefined,
  ): Promise<Reply> {
    const params = requestParams(spec, messages, forced);
    const startedAt = deps.clock.now();
    deps.store.countDailyCall(startedAt.setZone(spec.config.timezone).toISODate()!);
    let completion: ChatCompletion | undefined;
    let error: string | undefined;
    try {
      completion = await deps.client.create(params);
      const message = completion.choices[0]?.message;
      error = message ? judge(message) : "no choices in response";
    } catch (caught) {
      error = `api: ${(caught as Error).message}`;
    }
    deps.store.recordLlmCall({
      kind: spec.kind,
      flowId: spec.flowId,
      startedAt,
      request: JSON.stringify(params),
      response: completion ? JSON.stringify(completion) : null,
      ...readUsage(deps.provider, completion?.usage),
      latencyMs: deps.clock.now().diff(startedAt).toMillis(),
      ok: error === undefined,
      error: error ?? null,
    });
    const message = completion?.choices[0]?.message;
    return message ? { ok: true, message } : { ok: false, error: error ?? "no message" };
  }

  return {
    async run(spec) {
      const messages = [...spec.messages];
      const judge =
        (forced: boolean) =>
        (message: ChatCompletionMessage): string | undefined => {
          if (!forced && message.tool_calls?.length) return undefined;
          const parsed = spec.parse(message.content ?? "");
          return parsed.ok ? undefined : `parse: ${parsed.error}`;
        };

      for (let round = 0; ; round++) {
        const forced = round >= spec.maxToolRounds;
        // oxlint-disable-next-line no-await-in-loop -- each round needs the previous reply
        const reply = await send(spec, messages, forced, judge(forced));
        if (!reply.ok) return reply;
        const toolCalls = reply.message.tool_calls ?? [];
        if (!forced && toolCalls.length > 0) {
          messages.push(
            assistantToolMessage(reply.message),
            ...runTools(reply.message, spec.runTool),
          );
          continue;
        }
        const first = finalResult(spec, reply.message);
        if (first.ok) return first;

        // oxlint-disable-next-line no-await-in-loop -- the loop ends here either way
        const retry = await send(spec, messages, true, judge(true));
        return retry.ok ? finalResult(spec, retry.message) : retry;
      }
    },
  };
}

function requestParams<T>(
  spec: CallSpec<T>,
  messages: readonly ChatCompletionMessageParam[],
  forced: boolean,
): ChatCompletionCreateParamsNonStreaming {
  return {
    model: spec.config.llmModel,
    messages: [...messages],
    response_format: { type: "json_object" },
    ...(spec.config.reasoningEffort ? { reasoning_effort: spec.config.reasoningEffort } : {}),
    ...(spec.tools.length > 0
      ? { tools: [...spec.tools], ...(forced ? { tool_choice: "none" as const } : {}) }
      : {}),
  };
}

function finalResult<T>(spec: CallSpec<T>, message: ChatCompletionMessage): CallResult<T> {
  const raw = message.content ?? "";
  const parsed = spec.parse(raw);
  return parsed.ok ? { ok: true, value: parsed.value, raw } : { ok: false, error: parsed.error };
}

function assistantToolMessage(message: ChatCompletionMessage): ChatCompletionMessageParam {
  return { role: "assistant", content: message.content, tool_calls: message.tool_calls ?? [] };
}

function runTools(
  message: ChatCompletionMessage,
  runTool: ToolRunner,
): ChatCompletionToolMessageParam[] {
  return (message.tool_calls ?? []).map((call) => ({
    role: "tool",
    tool_call_id: call.id,
    content:
      call.type === "function" ? runFunction(call.function, runTool) : "이 형식의 도구는 없다.",
  }));
}

function runFunction(fn: { name: string; arguments: string }, runTool: ToolRunner): string {
  let args: unknown;
  try {
    args = JSON.parse(fn.arguments || "{}");
  } catch {
    return "도구 인자가 json이 아니다.";
  }
  return runTool(fn.name, args);
}
