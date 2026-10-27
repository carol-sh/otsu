import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import type { BlackoutWindow } from "../src/config.ts";
import {
  blackoutEnd,
  clampNextAt,
  inBlackout,
  nextBlackoutStart,
  type BlackoutPolicy,
  type NextAtPolicy,
} from "../src/time.ts";

const SEOUL = "Asia/Seoul";
const NEW_YORK = "America/New_York";

function windows(...specs: [string, string][]): BlackoutWindow[] {
  return specs.map(([start, end]) => ({ start: minutes(start), end: minutes(end) }));
}

function minutes(clock: string): number {
  const [hours, mins] = clock.split(":").map(Number);
  return hours! * 60 + mins!;
}

function local(iso: string, zone = SEOUL): DateTime {
  return DateTime.fromISO(iso, { zone });
}

function assertSameInstant(actual: DateTime | undefined, expected: DateTime): void {
  assert.ok(actual, "expected a time");
  assert.equal(actual.toMillis(), expected.toMillis(), `${actual.toISO()} != ${expected.toISO()}`);
}

describe("inBlackout", () => {
  const policy: BlackoutPolicy = { timezone: SEOUL, blackout: windows(["00:00", "08:00"]) };

  it("includes the start and excludes the end", () => {
    assert.equal(inBlackout(local("2026-10-27T00:00"), policy), true);
    assert.equal(inBlackout(local("2026-10-27T07:59"), policy), true);
    assert.equal(inBlackout(local("2026-10-27T08:00"), policy), false);
    assert.equal(inBlackout(local("2026-10-26T23:59"), policy), false);
  });

  it("judges by the configured timezone whatever zone the input is in", () => {
    assert.equal(inBlackout(DateTime.fromISO("2026-10-27T22:30Z"), policy), true);
    assert.equal(inBlackout(DateTime.fromISO("2026-10-27T23:00Z"), policy), false);
  });

  it("handles windows that cross midnight", () => {
    const night: BlackoutPolicy = { timezone: SEOUL, blackout: windows(["23:00", "07:00"]) };
    assert.equal(inBlackout(local("2026-10-27T22:59"), night), false);
    assert.equal(inBlackout(local("2026-10-27T23:00"), night), true);
    assert.equal(inBlackout(local("2026-10-28T06:59"), night), true);
    assert.equal(inBlackout(local("2026-10-28T07:00"), night), false);
  });

  it("is never true without windows", () => {
    assert.equal(inBlackout(local("2026-10-27T03:00"), { timezone: SEOUL, blackout: [] }), false);
  });
});

describe("blackoutEnd", () => {
  it("returns the input outside blackout", () => {
    const policy: BlackoutPolicy = { timezone: SEOUL, blackout: windows(["00:00", "08:00"]) };
    assertSameInstant(blackoutEnd(local("2026-10-27T12:00"), policy), local("2026-10-27T12:00"));
  });

  it("follows back-to-back windows to the last end", () => {
    const policy: BlackoutPolicy = {
      timezone: SEOUL,
      blackout: windows(["22:00", "00:00"], ["00:00", "08:00"]),
    };
    assertSameInstant(blackoutEnd(local("2026-10-27T23:00"), policy), local("2026-10-28T08:00"));
  });

  it("uses the later end of overlapping windows", () => {
    const policy: BlackoutPolicy = {
      timezone: SEOUL,
      blackout: windows(["01:00", "05:00"], ["03:00", "09:00"]),
    };
    assertSameInstant(blackoutEnd(local("2026-10-27T02:00"), policy), local("2026-10-27T09:00"));
  });

  it("keeps wall-clock ends across a spring-forward DST change", () => {
    const policy: BlackoutPolicy = { timezone: NEW_YORK, blackout: windows(["01:00", "03:00"]) };
    const end = blackoutEnd(local("2026-03-08T01:30", NEW_YORK), policy);
    assertSameInstant(end, local("2026-03-08T03:00", NEW_YORK));
    assert.equal(end.diff(local("2026-03-08T01:30", NEW_YORK), "minutes").minutes, 30);
  });

  it("keeps wall-clock ends across a fall-back DST change", () => {
    const policy: BlackoutPolicy = { timezone: NEW_YORK, blackout: windows(["00:00", "08:00"]) };
    const start = local("2026-11-01T00:00", NEW_YORK);
    const end = blackoutEnd(start, policy);
    assertSameInstant(end, local("2026-11-01T08:00", NEW_YORK));
    assert.equal(end.diff(start, "hours").hours, 9);
  });
});

describe("nextBlackoutStart", () => {
  const policy: BlackoutPolicy = { timezone: SEOUL, blackout: windows(["23:00", "07:00"]) };

  it("finds the start later the same day", () => {
    assertSameInstant(
      nextBlackoutStart(local("2026-10-27T21:00"), policy),
      local("2026-10-27T23:00"),
    );
  });

  it("skips the window already in progress", () => {
    assertSameInstant(
      nextBlackoutStart(local("2026-10-27T23:00"), policy),
      local("2026-10-28T23:00"),
    );
  });

  it("returns undefined without windows", () => {
    assert.equal(
      nextBlackoutStart(local("2026-10-27T21:00"), { timezone: SEOUL, blackout: [] }),
      undefined,
    );
  });
});

describe("clampNextAt", () => {
  const policy: NextAtPolicy = {
    timezone: SEOUL,
    blackout: windows(["00:00", "08:00"]),
    minIntervalMin: 1,
    maxDelayHours: 48,
  };
  const now = local("2026-10-27T12:00");

  it("keeps a valid time without notes", () => {
    const result = clampNextAt(local("2026-10-27T15:00"), now, policy);
    assertSameInstant(result.at, local("2026-10-27T15:00"));
    assert.deepEqual(result.notes, []);
  });

  it("raises past and too-early times to the minimum interval without notes", () => {
    for (const at of [local("2026-10-27T09:00"), now]) {
      const result = clampNextAt(at, now, policy);
      assertSameInstant(result.at, local("2026-10-27T12:01"));
      assert.deepEqual(result.notes, []);
    }
  });

  it("pulls times beyond the maximum delay back and notes it", () => {
    const result = clampNextAt(local("2026-10-30T12:00"), now, policy);
    assertSameInstant(result.at, local("2026-10-29T12:00"));
    assert.equal(result.notes.length, 1);
  });

  it("pushes blackout times to the end and notes it", () => {
    const result = clampNextAt(local("2026-10-28T03:00"), now, policy);
    assertSameInstant(result.at, local("2026-10-28T08:00"));
    assert.equal(result.notes.length, 1);
  });

  it("pushes out of blackout even after pulling back to the maximum delay", () => {
    const result = clampNextAt(local("2026-11-05T12:00"), local("2026-10-27T02:00"), policy);
    assertSameInstant(result.at, local("2026-10-29T08:00"));
    assert.equal(result.notes.length, 2);
  });
});
