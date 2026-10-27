import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GrammyError } from "grammy";
import { createTelegramSender, splitMessage } from "../src/telegram.ts";

function apiError(code: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    "call failed",
    {
      ok: false,
      error_code: code,
      description: "error",
      ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
    },
    "sendMessage",
    {},
  );
}

/** A sender over a scripted API, with a fake clock that sleeping moves forward. */
function scriptedSender(outcomes: (GrammyError | undefined)[], intervalMs = 1000) {
  let clock = 0;
  const sent: string[] = [];
  const sleeps: number[] = [];
  let blockedCalls = 0;
  const sender = createTelegramSender({
    api: {
      async sendMessage(_chatId, text) {
        const outcome = outcomes.shift();
        if (outcome) throw outcome;
        sent.push(text);
        return {} as never;
      },
    },
    chatId: 1,
    config: () => ({ sendIntervalMs: intervalMs }),
    onBlocked: () => blockedCalls++,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { sender, sent, sleeps, blocked: () => blockedCalls };
}

describe("splitMessage", () => {
  it("splits a 5000-character message in two at a line break", () => {
    const text = `${"가".repeat(3000)}\n${"나".repeat(1999)}`;
    assert.deepEqual(splitMessage(text), ["가".repeat(3000), "나".repeat(1999)]);
  });

  it("cuts a line with no break at the limit without splitting a surrogate pair", () => {
    const parts = splitMessage(`${"a".repeat(4095)}😀b`);
    assert.deepEqual(parts, ["a".repeat(4095), "😀b"]);
  });
});

describe("telegram sender", () => {
  it("spaces messages by the send interval", async () => {
    const { sender, sent, sleeps } = scriptedSender([]);
    await sender.send("하나");
    await sender.send("둘");

    assert.deepEqual(sent, ["하나", "둘"]);
    assert.deepEqual(sleeps, [1000]);
  });

  it("waits retry_after on 429 and sends again", async () => {
    const { sender, sent, sleeps } = scriptedSender([apiError(429, 7)]);
    await sender.send("하나");

    assert.deepEqual(sent, ["하나"]);
    assert.deepEqual(sleeps, [7000]);
  });

  it("gives up on other errors after a few attempts without throwing", async () => {
    const { sender, sent } = scriptedSender([apiError(500), apiError(500), apiError(500)]);
    await sender.send("하나");
    await sender.send("둘");

    assert.deepEqual(sent, ["둘"]);
  });

  it("reports a block once and drops messages until the user writes again", async () => {
    const { sender, sent, blocked } = scriptedSender([apiError(403)]);
    await sender.send("하나");
    await sender.send("[하네스] 정지했다.");
    assert.equal(blocked(), 1);
    assert.deepEqual(sent, []);

    sender.reachable();
    await sender.send("다시");
    assert.deepEqual(sent, ["다시"]);
  });
});
