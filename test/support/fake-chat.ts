import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import type { ChatClient } from "../../src/llm/client.ts";

export type ScriptedReply = ChatCompletion | Error;

/** A chat client that answers from a script and keeps every request it got. */
export interface FakeChat extends ChatClient {
  requests: ChatCompletionCreateParamsNonStreaming[];
}

export function fakeChat(script: ScriptedReply[]): FakeChat {
  const queue = [...script];
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const next = queue.shift();
      if (!next) throw new Error("fake chat script ran out");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export function textReply(content: string): ChatCompletion {
  return completion({ role: "assistant", content, refusal: null }, "stop");
}

export function toolReply(...calls: { name: string; args: unknown }[]): ChatCompletion {
  return completion(
    {
      role: "assistant",
      content: null,
      refusal: null,
      tool_calls: calls.map((call, index) => ({
        id: `call_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    "tool_calls",
  );
}

function completion(
  message: ChatCompletion.Choice["message"],
  finishReason: ChatCompletion.Choice["finish_reason"],
): ChatCompletion {
  return {
    id: "fake",
    object: "chat.completion",
    created: 0,
    model: "fake",
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  };
}
