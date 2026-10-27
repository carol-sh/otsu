import { GrammyError, type Api, type Bot } from "grammy";
import type { Message } from "grammy/types";
import type { RuntimeConfig } from "./config.ts";
import type { Sender } from "./sender.ts";
import type { Worker } from "./worker.ts";

/** Telegram's limit on one text message. */
export const MESSAGE_LIMIT = 4096;
const SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface TelegramSenderDeps {
  api: Pick<Api, "sendMessage">;
  chatId: number;
  config: () => Pick<RuntimeConfig, "sendIntervalMs">;
  /** Called once when the user has blocked the bot; it should pause the harness. */
  onBlocked: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A sender that also learns when the user can be reached again. */
export interface TelegramSender extends Sender {
  /** Marks the user reachable after a block, because a message from them just arrived. */
  reachable(): void;
}

/**
 * Sends plain text, split at line breaks to fit Telegram's limit, spaced by `send_interval_ms`.
 * Waits out 429s, retries other errors a few times and then only logs. On 403 it reports the block
 * once and drops messages until the user writes again, so the pause notice cannot loop.
 */
export function createTelegramSender(deps: TelegramSenderDeps): TelegramSender {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let blocked = false;
  let lastSentAt: number | undefined;

  async function waitForInterval(): Promise<void> {
    if (lastSentAt === undefined) return;
    const remaining = lastSentAt + deps.config().sendIntervalMs - now();
    if (remaining > 0) await sleep(remaining);
  }

  /** Sends one part. Returns `false` when the user turned out to have blocked the bot. */
  async function sendPart(text: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt waits for the previous one
      await waitForInterval();
      try {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await deps.api.sendMessage(deps.chatId, text);
        lastSentAt = now();
        return true;
      } catch (error) {
        lastSentAt = now();
        if (error instanceof GrammyError && error.error_code === 403) return false;
        const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
        if (retryAfter === undefined && attempt >= SEND_ATTEMPTS) {
          console.error(`telegram send failed after ${attempt} attempts:`, error);
          return true;
        }
        // oxlint-disable-next-line no-await-in-loop -- backing off before the next attempt
        await sleep(retryAfter === undefined ? RETRY_DELAY_MS : retryAfter * 1000);
      }
    }
  }

  return {
    async send(text) {
      if (blocked) {
        console.error("telegram send skipped: the user has blocked the bot");
        return;
      }
      for (const part of splitMessage(text)) {
        // oxlint-disable-next-line no-await-in-loop -- parts must arrive in order
        if (await sendPart(part)) continue;
        blocked = true;
        deps.onBlocked();
        return;
      }
    },

    reachable() {
      blocked = false;
    },
  };
}

/** Splits text into parts of at most `limit` characters, at the last line break before the limit when there is one. */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const lineBreak = rest.lastIndexOf("\n", limit);
    if (lineBreak > 0) {
      parts.push(rest.slice(0, lineBreak));
      rest = rest.slice(lineBreak + 1);
    } else {
      const cut = isHighSurrogate(rest.charCodeAt(limit - 1)) ? limit - 1 : limit;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
  }
  parts.push(rest);
  return parts.filter((part) => part.trim() !== "");
}

export interface BotHandlerDeps {
  ownerChatId: number;
  worker: Worker;
  sender: TelegramSender;
}

/**
 * Routes the owner's messages: `/pause` and `/resume` become queued events, everything else is
 * taken in as a user message. Updates from any other chat are dropped without a log.
 */
export function attachBotHandlers(bot: Bot, deps: BotHandlerDeps): void {
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== deps.ownerChatId) return;
    deps.sender.reachable();
    await next();
  });
  bot.command("pause", () => deps.worker.enqueue({ kind: "pause" }));
  bot.command("resume", () => deps.worker.enqueue({ kind: "resume" }));
  bot.on("message", (ctx) => deps.worker.receive(messageText(ctx.message)));
  bot.catch((error) => console.error("telegram update failed:", error.error));
}

/** Keeps the text and caption, and replaces a photo with `[사진]` and any other attachment with `[파일]`. */
export function messageText(message: Message): string {
  if (message.text !== undefined) return message.text;
  const mark = message.photo ? "[사진]" : "[파일]";
  return message.caption ? `${mark} ${message.caption}` : mark;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
