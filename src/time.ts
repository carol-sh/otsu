import { DateTime } from "luxon";
import type { BlackoutWindow, RuntimeConfig } from "./config.ts";

export type BlackoutPolicy = Pick<RuntimeConfig, "timezone" | "blackout">;
export type NextAtPolicy = BlackoutPolicy & Pick<RuntimeConfig, "minIntervalMin" | "maxDelayHours">;

export interface Clock {
  now(): DateTime;
}

export interface ClampedNextAt {
  at: DateTime;
  /** Reasons to append to the slot memo, empty when `at` was only raised to the minimum interval or kept. */
  notes: string[];
}

interface Interval {
  start: DateTime;
  end: DateTime;
}

export const systemClock: Clock = { now: () => DateTime.now() };

/** Tells whether `t` falls inside any blackout window, start inclusive and end exclusive. */
export function inBlackout(t: DateTime, policy: BlackoutPolicy): boolean {
  return containingIntervals(t, policy).length > 0;
}

/** Returns when the blackout around `t` ends, following back-to-back windows. Returns `t` itself outside blackout. */
export function blackoutEnd(t: DateTime, policy: BlackoutPolicy): DateTime {
  let end = t;
  for (let step = 0; step <= policy.blackout.length; step++) {
    const intervals = containingIntervals(end, policy);
    if (intervals.length === 0) return end;
    end = intervals.reduce((latest, interval) => DateTime.max(latest, interval.end), end);
  }
  return end;
}

/** Returns the first blackout start strictly after `t`, or `undefined` when there are no windows. */
export function nextBlackoutStart(t: DateTime, policy: BlackoutPolicy): DateTime | undefined {
  const starts = intervalsAround(t, policy)
    .map((interval) => interval.start)
    .filter((start) => start > t);
  return starts.length > 0 ? DateTime.min(...starts) : undefined;
}

/**
 * Moves an LLM-requested `next.at` into the allowed range:
 * no earlier than `now + min_interval`, no later than `now + max_delay`, then out of blackout.
 */
export function clampNextAt(at: DateTime, now: DateTime, policy: NextAtPolicy): ClampedNextAt {
  const notes: string[] = [];
  const earliest = now.plus({ minutes: policy.minIntervalMin });
  const latest = now.plus({ hours: policy.maxDelayHours });
  let clamped: DateTime = DateTime.max(at, earliest);
  if (clamped > latest) {
    notes.push(
      `요청 시각 ${formatLocal(at, policy)}이 최대 ${policy.maxDelayHours}시간을 넘어 당김`,
    );
    clamped = latest;
  }
  if (inBlackout(clamped, policy)) {
    const end = blackoutEnd(clamped, policy);
    notes.push(`${formatLocal(clamped, policy)}은 불가 시간대라 ${formatLocal(end, policy)}로 밂`);
    clamped = end;
  }
  return { at: clamped, notes };
}

function containingIntervals(t: DateTime, policy: BlackoutPolicy): Interval[] {
  return intervalsAround(t, policy).filter((interval) => interval.start <= t && t < interval.end);
}

/** Lists every window occurrence that starts on the local day before, of, or after `t`. */
function intervalsAround(t: DateTime, policy: BlackoutPolicy): Interval[] {
  const today = t.setZone(policy.timezone).startOf("day");
  return [-1, 0, 1].flatMap((offset) => {
    const day = today.plus({ days: offset });
    return policy.blackout.map((window) => windowOn(day, window));
  });
}

/** Places a window on a local day. Wall-clock times that DST skips move forward, as luxon does. */
function windowOn(day: DateTime, window: BlackoutWindow): Interval {
  const endDay = window.end < window.start ? day.plus({ days: 1 }) : day;
  return { start: atMinute(day, window.start), end: atMinute(endDay, window.end) };
}

function atMinute(day: DateTime, minuteOfDay: number): DateTime {
  return DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
    },
    { zone: day.zone },
  );
}

function formatLocal(t: DateTime, policy: BlackoutPolicy): string {
  return t.setZone(policy.timezone).toFormat("yyyy-MM-dd HH:mm");
}
