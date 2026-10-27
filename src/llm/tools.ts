import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { MemoryTx } from "../memory.ts";

/** Runs one tool call and returns the text handed back to the model. */
export type ToolRunner = (name: string, args: unknown) => string;

const MEMORY_READ: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "memory_read",
    description: "기억 파일 하나를 이름으로 읽는다. INDEX에 있는 이름만 읽을 수 있다.",
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
    description: "기존 기억 파일 전체를 덮어쓴다. frontmatter를 포함한 파일 전체를 넣는다.",
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
    description: "새 기억 파일을 만든다. 기존 분류 어디에도 맞지 않을 때만 쓴다.",
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
  return `${name}은 정리 호출에서만 쓸 수 있다.`;
}
