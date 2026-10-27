import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { BlackoutWindow, RuntimeConfig } from "../config.ts";
import { memoryIndex } from "../memory.ts";
import type { Flow, Message } from "../store.ts";

/** What woke the harness up for a turn call. */
export type TurnEvent = { kind: "reply" } | { kind: "schedule"; type: string; memo: string };

export interface TurnContextInput {
  dataDir: string;
  config: RuntimeConfig;
  flow: Flow | undefined;
  history: readonly Message[];
  eventBlock: string;
}

export interface CleanupContextInput {
  dataDir: string;
  config: RuntimeConfig;
  flow: Flow;
  history: readonly Message[];
  now: DateTime;
}

const TEMPLATE_DIR = new URL("../templates/", import.meta.url);

/**
 * Assembles a turn call, most stable part first so the provider can cache the prefix:
 * prompt, task pool, harness rules, memory INDEX, flow conversation, then the event block
 * merged into the last user message.
 */
export function buildTurnMessages(input: TurnContextInput): ChatCompletionMessageParam[] {
  const { dataDir, config } = input;
  return [
    ...systemMessages([
      readDataFile(dataDir, "prompt.md"),
      readDataFile(dataDir, "tasks.md"),
      renderTemplate("turn-rules.md", turnRuleValues(config)),
      indexBlock(dataDir),
    ]),
    ...conversation(input.flow, input.history, config.timezone, input.eventBlock),
  ];
}

/** Assembles the memory cleanup call for a flow that just ended. */
export function buildCleanupMessages(input: CleanupContextInput): ChatCompletionMessageParam[] {
  const { dataDir, config } = input;
  const instruction = `[정리 호출]\n현재 시각: ${formatNow(input.now, config.timezone)}\n위 흐름이 끝났다. 정리 규칙대로 기억을 갱신한다.`;
  return [
    ...systemMessages([
      readDataFile(dataDir, "prompt.md"),
      renderTemplate("cleanup-rules.md", {
        max_chars: String(config.memoryFileMaxChars),
        max_files: String(config.memoryMaxFiles),
      }),
      indexBlock(dataDir),
    ]),
    ...conversation(input.flow, input.history, config.timezone, instruction),
  ];
}

/** Writes the event block: current time, what happened, the slot memo, and pending random events. */
export function renderEventBlock(
  event: TurnEvent,
  now: DateTime,
  config: Pick<RuntimeConfig, "timezone">,
  randomDue: number,
): string {
  const lines = ["[이벤트]", `현재 시각: ${formatNow(now, config.timezone)}`];
  if (event.kind === "reply") {
    lines.push("종류: 사용자 답장");
  } else {
    lines.push(`종류: 예약 도달 (type=${event.type})`);
    if (event.memo) lines.push(`memo: ${event.memo}`);
  }
  lines.push(`랜덤 이벤트 대기: ${randomDue}건`);
  return lines.join("\n");
}

function systemMessages(blocks: string[]): ChatCompletionMessageParam[] {
  return blocks
    .filter((block) => block.trim() !== "")
    .map((content) => ({ role: "system", content }));
}

/**
 * Turns the flow's summary and messages into alternating user and assistant messages.
 * Consecutive user and event rows become one user message, and `tail` joins the last one.
 */
function conversation(
  flow: Flow | undefined,
  history: readonly Message[],
  timezone: string,
  tail: string,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  let userParts: string[] = flow?.summary ? [`[이전 대화 요약]\n${flow.summary}`] : [];
  for (const message of history) {
    if (message.role === "assistant") {
      if (userParts.length > 0) messages.push({ role: "user", content: userParts.join("\n\n") });
      messages.push({ role: "assistant", content: message.content });
      userParts = [];
    } else {
      userParts.push(
        message.role === "user"
          ? `[${formatShort(message.ts, timezone)}] ${message.content}`
          : message.content,
      );
    }
  }
  messages.push({ role: "user", content: [...userParts, tail].join("\n\n") });
  return messages;
}

function turnRuleValues(config: RuntimeConfig): Record<string, string> {
  return {
    example_at: exampleAt(config.timezone),
    min_interval: String(config.minIntervalMin),
    max_delay: String(config.maxDelayHours),
    blackout: formatBlackout(config.blackout),
    timezone: config.timezone,
  };
}

/** A fixed example time, so the rules block stays byte-identical between calls and keeps the cache. */
function exampleAt(timezone: string): string {
  return DateTime.fromObject(
    { year: 2026, month: 1, day: 1, hour: 21, minute: 30 },
    { zone: timezone },
  ).toISO({
    suppressMilliseconds: true,
  })!;
}

function indexBlock(dataDir: string): string {
  return `# 기억 INDEX\n\n${memoryIndex(join(dataDir, "memory"))}`;
}

function readDataFile(dataDir: string, name: string): string {
  const path = join(dataDir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function renderTemplate(name: string, values: Record<string, string>): string {
  const template = readFileSync(new URL(name, TEMPLATE_DIR), "utf8");
  return template.replaceAll(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function formatBlackout(windows: readonly BlackoutWindow[]): string {
  if (windows.length === 0) return "없음";
  return windows
    .map((window) => `${formatClock(window.start)}-${formatClock(window.end)}`)
    .join(", ");
}

function formatClock(minuteOfDay: number): string {
  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfDay % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatNow(now: DateTime, timezone: string): string {
  return now.setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ (ccc)", { locale: "ko" });
}

function formatShort(ts: DateTime, timezone: string): string {
  return ts.setZone(timezone).toFormat("MM-dd HH:mm");
}
