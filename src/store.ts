import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { DateTime } from "luxon";

export type Mode = "active" | "ended" | "paused";
export type HoldReason = "balance" | "daily_limit";
export type EndReason = "agent" | "paused";
export type CleanupStatus = "pending" | "done" | "failed";
export type MessageRole = "user" | "assistant" | "event";
export type IgnoredReason = "ended" | "paused" | "blackout" | "late";
export type LlmCallKind = "turn" | "cleanup" | "compact";

export interface HarnessState {
  mode: Mode;
  currentFlowId: number | null;
  randomDue: number;
  lastRollAt: DateTime | null;
  consecutiveFailures: number;
  holdReason: HoldReason | null;
}

export interface SlotInput {
  at: DateTime;
  type: string;
  memo: string;
}

export interface Slot extends SlotInput {
  id: number;
  createdAt: DateTime;
}

export interface Flow {
  id: number;
  startedAt: DateTime;
  endedAt: DateTime | null;
  endReason: EndReason | null;
  summary: string | null;
  compactedUntil: DateTime | null;
  cleanupStatus: CleanupStatus | null;
}

export interface MessageInput {
  flowId: number | null;
  role: MessageRole;
  content: string;
  ts: DateTime;
  ignoredReason?: IgnoredReason;
}

export interface Message {
  id: number;
  flowId: number | null;
  role: MessageRole;
  content: string;
  ts: DateTime;
  ignoredReason: IgnoredReason | null;
}

export interface LlmCallRecord {
  kind: LlmCallKind;
  flowId: number | null;
  startedAt: DateTime;
  request: string;
  response: string | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

export interface Store {
  state(): HarnessState;
  updateState(patch: Partial<HarnessState>): void;

  slot(): Slot | undefined;
  /** Replaces the single schedule slot. The new slot always gets an id no earlier slot had. */
  replaceSlot(input: SlotInput, now: DateTime): Slot;
  clearSlot(): void;

  flow(id: number): Flow | undefined;
  openFlow(now: DateTime): Flow;
  /** Closes a flow and marks its cleanup call as pending. */
  closeFlow(id: number, reason: EndReason, now: DateTime): void;
  setCleanupStatus(id: number, status: CleanupStatus): void;
  flowsPendingCleanup(): Flow[];
  saveCompaction(id: number, summary: string, compactedUntil: DateTime): void;

  /**
   * Returns a message timestamp strictly later than every one issued before, so ordering by `ts` is total.
   * Use it for user arrivals and for the input cutoff that becomes the assistant `ts`.
   */
  issueMessageTs(now: DateTime): DateTime;
  recordMessage(input: MessageInput): Message;
  ignoreMessages(ids: readonly number[], reason: IgnoredReason): void;
  /** Lists the flow's valid messages in `ts` order, only those after `after` when given. */
  flowMessages(flowId: number, after?: DateTime | null): Message[];
  /** Lists the flow's valid user messages that came after its last assistant message. */
  unansweredUserMessages(flowId: number): Message[];

  recordLlmCall(record: LlmCallRecord): void;
  /** Returns the API request count for a local date such as `2026-10-27`. */
  dailyCalls(localDate: string): number;
  /** Counts one API request on a local date, starting over when the date changes. Returns the new count. */
  countDailyCall(localDate: string): number;

  transaction<T>(fn: () => T): T;
  close(): void;
}

type Row = Record<string, SQLOutputValue>;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  memo TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE harness_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('active', 'ended', 'paused')),
  current_flow_id INTEGER REFERENCES flows (id),
  random_due INTEGER NOT NULL,
  last_roll_at TEXT,
  consecutive_failures INTEGER NOT NULL,
  hold_reason TEXT CHECK (hold_reason IN ('balance', 'daily_limit')),
  daily_calls INTEGER NOT NULL,
  daily_calls_date TEXT
);

CREATE TABLE flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('agent', 'paused')),
  summary TEXT,
  compacted_until TEXT,
  cleanup_status TEXT CHECK (cleanup_status IN ('pending', 'done', 'failed'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER REFERENCES flows (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'event')),
  content TEXT NOT NULL,
  ts TEXT NOT NULL,
  ignored INTEGER NOT NULL DEFAULT 0,
  ignored_reason TEXT CHECK (ignored_reason IN ('ended', 'paused', 'blackout', 'late'))
);
CREATE INDEX messages_flow_ts ON messages (flow_id, ts);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'cleanup', 'compact')),
  flow_id INTEGER REFERENCES flows (id),
  started_at TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT,
  cache_hit_tokens INTEGER,
  cache_miss_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);

INSERT INTO harness_state
  (id, mode, current_flow_id, random_due, last_roll_at, consecutive_failures, hold_reason, daily_calls, daily_calls_date)
VALUES (1, 'paused', NULL, 0, NULL, 0, NULL, 0, NULL);
`;

const STATE_COLUMNS = {
  mode: "mode",
  currentFlowId: "current_flow_id",
  randomDue: "random_due",
  lastRollAt: "last_roll_at",
  consecutiveFailures: "consecutive_failures",
  holdReason: "hold_reason",
} as const satisfies Record<keyof HarnessState, string>;

/** Opens the SQLite database at `path` (`:memory:` for tests) and creates the schema on first use. */
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  let lastMessageTs = latestMessageTs(db);

  const store: Store = {
    state() {
      return toState(db.prepare("SELECT * FROM harness_state WHERE id = 1").get()!);
    },

    updateState(patch) {
      const keys = Object.keys(patch) as (keyof HarnessState)[];
      if (keys.length === 0) return;
      const assignments = keys.map((key) => `${STATE_COLUMNS[key]} = ?`).join(", ");
      db.prepare(`UPDATE harness_state SET ${assignments} WHERE id = 1`).run(
        ...keys.map((key) => toDbValue(patch[key] ?? null)),
      );
    },

    slot() {
      const row = db.prepare("SELECT * FROM schedule").get();
      return row && toSlot(row);
    },

    replaceSlot(input, now) {
      return store.transaction(() => {
        db.exec("DELETE FROM schedule");
        const row = db
          .prepare(
            "INSERT INTO schedule (at, type, memo, created_at) VALUES (?, ?, ?, ?) RETURNING *",
          )
          .get(dbTime(input.at), input.type, input.memo, dbTime(now));
        return toSlot(row!);
      });
    },

    clearSlot() {
      db.exec("DELETE FROM schedule");
    },

    flow(id) {
      const row = db.prepare("SELECT * FROM flows WHERE id = ?").get(id);
      return row && toFlow(row);
    },

    openFlow(now) {
      const row = db
        .prepare("INSERT INTO flows (started_at) VALUES (?) RETURNING *")
        .get(dbTime(now));
      return toFlow(row!);
    },

    closeFlow(id, reason, now) {
      db.prepare(
        "UPDATE flows SET ended_at = ?, end_reason = ?, cleanup_status = 'pending' WHERE id = ?",
      ).run(dbTime(now), reason, id);
    },

    setCleanupStatus(id, status) {
      db.prepare("UPDATE flows SET cleanup_status = ? WHERE id = ?").run(status, id);
    },

    flowsPendingCleanup() {
      return db
        .prepare("SELECT * FROM flows WHERE cleanup_status = 'pending' ORDER BY id")
        .all()
        .map(toFlow);
    },

    saveCompaction(id, summary, compactedUntil) {
      db.prepare("UPDATE flows SET summary = ?, compacted_until = ? WHERE id = ?").run(
        summary,
        dbTime(compactedUntil),
        id,
      );
    },

    issueMessageTs(now) {
      const next = lastMessageTs ? DateTime.max(now, lastMessageTs.plus({ milliseconds: 1 })) : now;
      lastMessageTs = next;
      return next;
    },

    recordMessage(input) {
      const row = db
        .prepare(
          `INSERT INTO messages (flow_id, role, content, ts, ignored, ignored_reason)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          input.flowId,
          input.role,
          input.content,
          dbTime(input.ts),
          input.ignoredReason ? 1 : 0,
          input.ignoredReason ?? null,
        );
      return toMessage(row!);
    },

    ignoreMessages(ids, reason) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(
        `UPDATE messages SET ignored = 1, ignored_reason = ? WHERE id IN (${placeholders})`,
      ).run(reason, ...ids);
    },

    flowMessages(flowId, after) {
      return db
        .prepare("SELECT * FROM messages WHERE flow_id = ? AND ignored = 0 AND ts > ? ORDER BY ts")
        .all(flowId, after ? dbTime(after) : "")
        .map(toMessage);
    },

    unansweredUserMessages(flowId) {
      return db
        .prepare(
          `SELECT * FROM messages
           WHERE flow_id = ? AND role = 'user' AND ignored = 0
             AND ts > COALESCE(
               (SELECT MAX(ts) FROM messages WHERE flow_id = ? AND role = 'assistant'), '')
           ORDER BY ts`,
        )
        .all(flowId, flowId)
        .map(toMessage);
    },

    recordLlmCall(record) {
      db.prepare(
        `INSERT INTO llm_calls
           (kind, flow_id, started_at, request, response, cache_hit_tokens, cache_miss_tokens,
            cache_write_tokens, output_tokens, latency_ms, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.kind,
        record.flowId,
        dbTime(record.startedAt),
        record.request,
        record.response,
        record.cacheHitTokens,
        record.cacheMissTokens,
        record.cacheWriteTokens,
        record.outputTokens,
        record.latencyMs,
        record.ok ? 1 : 0,
        record.error,
      );
    },

    dailyCalls(localDate) {
      const row = db
        .prepare("SELECT daily_calls, daily_calls_date FROM harness_state WHERE id = 1")
        .get()!;
      return row.daily_calls_date === localDate ? Number(row.daily_calls) : 0;
    },

    countDailyCall(localDate) {
      const row = db
        .prepare(
          `UPDATE harness_state
           SET daily_calls = CASE WHEN daily_calls_date = ? THEN daily_calls + 1 ELSE 1 END,
               daily_calls_date = ?
           WHERE id = 1 RETURNING daily_calls`,
        )
        .get(localDate, localDate)!;
      return Number(row.daily_calls);
    },

    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    close() {
      db.close();
    },
  };
  return store;
}

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get()!;
  if (version === SCHEMA_VERSION) return;
  if (version !== 0) {
    throw new Error(`unsupported database schema version ${String(version)}`);
  }
  db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
}

function latestMessageTs(db: DatabaseSync): DateTime | undefined {
  const { ts } = db.prepare("SELECT MAX(ts) AS ts FROM messages").get()!;
  return typeof ts === "string" ? fromDbTime(ts) : undefined;
}

/** Stores times as fixed-width UTC ISO strings so text order is time order. */
function dbTime(t: DateTime): string {
  const iso = t.toUTC().toISO();
  if (!iso) throw new Error(`invalid time: ${t.invalidReason ?? "unknown"}`);
  return iso;
}

function fromDbTime(text: string): DateTime {
  return DateTime.fromISO(text, { zone: "utc" });
}

function optionalTime(value: SQLOutputValue | undefined): DateTime | null {
  return typeof value === "string" ? fromDbTime(value) : null;
}

function toDbValue(value: string | number | DateTime | null): SQLInputValue {
  return DateTime.isDateTime(value) ? dbTime(value) : value;
}

function toState(row: Row): HarnessState {
  return {
    mode: row.mode as Mode,
    currentFlowId: row.current_flow_id as number | null,
    randomDue: Number(row.random_due),
    lastRollAt: optionalTime(row.last_roll_at),
    consecutiveFailures: Number(row.consecutive_failures),
    holdReason: row.hold_reason as HoldReason | null,
  };
}

function toSlot(row: Row): Slot {
  return {
    id: Number(row.id),
    at: fromDbTime(row.at as string),
    type: row.type as string,
    memo: row.memo as string,
    createdAt: fromDbTime(row.created_at as string),
  };
}

function toFlow(row: Row): Flow {
  return {
    id: Number(row.id),
    startedAt: fromDbTime(row.started_at as string),
    endedAt: optionalTime(row.ended_at),
    endReason: row.end_reason as EndReason | null,
    summary: row.summary as string | null,
    compactedUntil: optionalTime(row.compacted_until),
    cleanupStatus: row.cleanup_status as CleanupStatus | null,
  };
}

function toMessage(row: Row): Message {
  return {
    id: Number(row.id),
    flowId: row.flow_id as number | null,
    role: row.role as MessageRole,
    content: row.content as string,
    ts: fromDbTime(row.ts as string),
    ignoredReason: row.ignored_reason as IgnoredReason | null,
  };
}
