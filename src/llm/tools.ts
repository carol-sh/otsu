import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { MemoryTx } from "../memory.ts";

/** Runs one tool call and returns the text handed back to the model. */
export type ToolRunner = (name: string, args: unknown) => string;

const MEMORY_READ: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "memory_read",
    description:
      "Read a memory file from the memory directory. Use it when the file will sharpen the current response — vulnerabilities to press, tactics that have worked, the current state of the relationship. The INDEX is usually enough to decide whether to open a file.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
};

const MEMORY_WRITE: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "memory_write",
    description:
      "Replace a memory file's entire content. This overwrites the whole file, so read it first with memory_read. Writes are collected during the call and committed only if the call succeeds. If the content exceeds the size limit, the write is rejected; compress and retry.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, content: { type: "string" } },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
};

const MEMORY_CREATE: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "memory_create",
    description:
      "Create a new memory file. Use only when the content fits none of the five existing files. Rejected if the file count limit is reached. The description becomes the file's line in the INDEX, so keep it short and specific.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        content: { type: "string" },
      },
      required: ["name", "description", "content"],
      additionalProperties: false,
    },
  },
};

export const TURN_TOOLS: ChatCompletionFunctionTool[] = [MEMORY_READ];
export const CLEANUP_TOOLS: ChatCompletionFunctionTool[] = [
  MEMORY_READ,
  MEMORY_WRITE,
  MEMORY_CREATE,
];

/** Routes the memory tools to a transaction. Turn calls only get `memory_read`. */
export function memoryToolRunner(tx: MemoryTx, allowWrites: boolean): ToolRunner {
  return (name, args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const text = (key: string): string => (typeof input[key] === "string" ? input[key] : "");
    switch (name) {
      case "memory_read":
        return tx.read(text("name"));
      case "memory_write":
        return allowWrites ? tx.write(text("name"), text("content")) : notAllowed(name);
      case "memory_create":
        return allowWrites
          ? tx.create(text("name"), text("description"), text("content"))
          : notAllowed(name);
      default:
        return `${name} 도구는 없다.`;
    }
  };
}

function notAllowed(name: string): string {
  return `${name}은 정리 호출에서만 쓸 수 있다. 이번 호출에서는 아무것도 쓰이지 않았다.`;
}
