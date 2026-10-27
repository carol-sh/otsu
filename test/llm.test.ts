import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DateTime } from "luxon";
import type { RuntimeConfig } from "../src/config.ts";
import { installInitialMemory } from "../src/memory.ts";
import { buildTurnMessages, renderEventBlock } from "../src/llm/context.ts";
import { createExecutor, type CallSpec } from "../src/llm/executor.ts";
import { parseTurnOutput, type TurnOutput } from "../src/llm/output.ts";
import { TURN_TOOLS } from "../src/llm/tools.ts";
import { openStore, type Store } from "../src/store.ts";
import { fakeChat, textReply, toolReply, type ScriptedReply } from "./support/fake-chat.ts";

const NOW = DateTime.fromISO("2026-10-27T21:00:00+09:00", { setZone: true });
const VALID = JSON.stringify({
  messages: ["산책 다녀와"],
  flow: "continue",
  next: { at: "2026-10-27T22:00:00+09:00", type: "followup", memo: "산책 확인" },
});

const CONFIG = {
  timezone: "Asia/Seoul",
  blackout: [{ start: 0, end: 480 }],
  minIntervalMin: 1,
  maxDelayHours: 48,
  llmModel: "gpt-6-luna",
  reasoningEffort: "none",
  memoryFileMaxChars: 8000,
  memoryMaxFiles: 8,
} as RuntimeConfig;

describe("executor", () => {
  let store: Store;
  const toolCalls: string[] = [];

  beforeEach(() => {
    store = openStore(":memory:");
    toolCalls.length = 0;
  });

  afterEach(() => {
    store.close();
  });

  function setup(script: ScriptedReply[], maxToolRounds = 3) {
    const chat = fakeChat(script);
    const executor = createExecutor({
      client: chat,
      provider: "openai",
      store,
      clock: { now: () => NOW },
    });
    const spec: CallSpec<TurnOutput> = {
      kind: "turn",
      flowId: null,
      config: CONFIG,
      messages: [{ role: "user", content: "시작" }],
      tools: TURN_TOOLS,
      maxToolRounds,
      runTool: (name, args) => {
        toolCalls.push(`${name} ${JSON.stringify(args)}`);
        return "기억 내용";
      },
      parse: parseTurnOutput,
    };
    return { chat, run: () => executor.run(spec) };
  }

  it("runs tool rounds, then returns the parsed final answer", async () => {
    const { chat, run } = setup([
      toolReply({ name: "memory_read", args: { name: "journal.md" } }),
      textReply(VALID),
    ]);
    const result = await run();

    assert.ok(result.ok);
    assert.equal(result.value.next.memo, "산책 확인");
    assert.equal(result.raw, VALID);
    assert.deepEqual(toolCalls, ['memory_read {"name":"journal.md"}']);
    const toolResult = chat.requests[1]?.messages.at(-1);
    assert.deepEqual(toolResult, { role: "tool", tool_call_id: "call_0", content: "기억 내용" });
    assert.equal(chat.requests[0]?.response_format?.type, "json_object");
    assert.equal(chat.requests[0]?.reasoning_effort, "none");
    assert.equal(store.dailyCalls("2026-10-27"), 2);
  });

  it("forces a final answer after the tool round limit, keeping the tools", async () => {
    const read = { name: "memory_read", args: { name: "journal.md" } };
    const { chat, run } = setup([toolReply(read), toolReply(read), textReply(VALID)], 2);
    const result = await run();

    assert.ok(result.ok);
    assert.deepEqual(
      chat.requests.map((request) => request.tool_choice),
      [undefined, undefined, "none"],
    );
    assert.equal(chat.requests[2]?.tools?.length, TURN_TOOLS.length);
  });

  it("retries once with a forced request when the answer does not parse", async () => {
    const { chat, run } = setup([textReply("not json"), textReply(VALID)]);
    const result = await run();

    assert.ok(result.ok);
    assert.equal(chat.requests[1]?.tool_choice, "none");
    assert.equal(store.dailyCalls("2026-10-27"), 2);
  });

  it("fails after the retry also does not parse", async () => {
    const noOffset = VALID.replace("+09:00", "");
    const { run } = setup([textReply("{}"), textReply(noOffset)]);
    const result = await run();

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /offset/);
  });

  it("fails on an API error without retrying", async () => {
    const { chat, run } = setup([new Error("503 overloaded")]);
    const result = await run();

    assert.deepEqual(result, { ok: false, error: "api: 503 overloaded" });
    assert.equal(chat.requests.length, 1);
    assert.equal(store.dailyCalls("2026-10-27"), 1);
  });
});

describe("turn context", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "otsu-context-"));
    installInitialMemory(join(dataDir, "memory"));
    writeFileSync(join(dataDir, "prompt.md"), "너는 주인이다.");
    writeFileSync(join(dataDir, "tasks.md"), "- 산책");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("puts stable blocks first and merges the event block into the last user message", () => {
    const at = (minute: number) => NOW.plus({ minutes: minute });
    const message = (
      id: number,
      role: "user" | "assistant" | "event",
      content: string,
      minute: number,
    ) => ({
      id,
      flowId: 1,
      role,
      content,
      ts: at(minute),
      ignoredReason: null,
    });
    const messages = buildTurnMessages({
      dataDir,
      config: CONFIG,
      flow: {
        id: 1,
        startedAt: NOW,
        endedAt: null,
        endReason: null,
        summary: "아침에 물을 마시기로 했다.",
        compactedUntil: NOW,
        cleanupStatus: null,
      },
      history: [
        message(1, "event", "[이벤트] 예약 도달", 1),
        message(2, "assistant", VALID, 2),
        message(3, "user", "다녀왔어", 3),
        message(4, "user", "[사진]", 4),
      ],
      eventBlock: renderEventBlock({ kind: "reply" }, at(5), CONFIG, 1),
    });

    assert.deepEqual(
      messages.map((entry) => entry.role),
      ["system", "system", "system", "system", "user", "assistant", "user"],
    );
    assert.equal(messages[0]?.content, "너는 주인이다.");
    assert.match(String(messages[2]?.content), /오프셋.*2026-01-01T21:30:00\+09:00/s);
    assert.match(String(messages[3]?.content), /- journal\.md:/);
    assert.match(
      String(messages[4]?.content),
      /^\[이전 대화 요약\]\n아침에 물을[\s\S]*\[이벤트\] 예약 도달$/,
    );
    assert.equal(
      messages[6]?.content,
      [
        "[10-27 21:03] 다녀왔어",
        "[10-27 21:04] [사진]",
        "[이벤트]\n현재 시각: 2026-10-27T21:05:00+09:00 (화)\n종류: 사용자 답장\n랜덤 이벤트 대기: 1건",
      ].join("\n\n"),
    );
  });
});
