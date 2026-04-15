import type { Pool, QueryResult } from "pg";
import { DatabaseError } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryRecord } from "../../src/domain/schema.js";
import type { DeadLetterInsert } from "../../src/storage/dead-letter.repository.js";
import { PostgresTelemetryRepository } from "../../src/storage/postgres.repository.js";
import { PostgresDeadLetterRepository } from "../../src/storage/postgres-dead-letter.repository.js";
import { batteryLowRecord } from "../fixtures/records.js";
import { validate } from "../../src/processing/validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRecord(): TelemetryRecord {
  const parsed = validate(batteryLowRecord());
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("expected valid record");
  return parsed.value;
}

function makePoolQuery(
  impl: (text: string, values?: unknown[]) => Promise<QueryResult>,
): Pool["query"] {
  return ((text: string, values?: unknown[]) => impl(text, values)) as Pool["query"];
}

/** Construct a pg DatabaseError with a given 5-char code. */
function dbError(code: string, message = "db error"): DatabaseError {
  const e = new DatabaseError(message, 0, "error");
  (e as { code?: string }).code = code;
  return e;
}

function deadLetterInsert(overrides: Partial<DeadLetterInsert> = {}): DeadLetterInsert {
  return {
    payload: { raw: "data" },
    errorType: "ParseError",
    errorDetail: "invalid JSON",
    messageId: "msg-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PostgresTelemetryRepository
// ---------------------------------------------------------------------------

describe("PostgresTelemetryRepository", () => {
  it("passes INSERT SQL shape and positional parameters to pool.query", async () => {
    const record = validRecord();
    const messageId = "msg-abc";
    const query = vi.fn(
      makePoolQuery(async () => ({ rows: [], rowCount: 1 }) as unknown as QueryResult),
    );
    const pool = { query } as unknown as Pool;
    const repo = new PostgresTelemetryRepository(pool);

    await repo.insert(record, messageId);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(typeof sql).toBe("string");
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("DO NOTHING");
    expect(sql).toContain("RETURNING id");
    expect(sql).toContain("$5::jsonb");
    expect(sql).toContain("$6");
    expect(sql).toContain("message_id");
    // params: drone_id, event_time, event_type, status_code, payload (snake_case telemetryData), message_id
    expect(Array.isArray(params)).toBe(true);
    expect(params).toHaveLength(6);
    expect(params?.[0]).toBe(record.droneId);
    expect(params?.[2]).toBe(record.eventType);
    expect(params?.[3]).toBe(record.statusCode);
    expect(params?.[5]).toBe(messageId);
    // payload should be snake_cased telemetryData only, not the full record
    const payload = JSON.parse(params?.[4] as unknown as string) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("droneId");
    expect(payload).toHaveProperty("battery_level");
  });

  it("returns 'inserted' when rowCount is 1", async () => {
    const query = vi.fn(
      makePoolQuery(async () => ({ rows: [], rowCount: 1 }) as unknown as QueryResult),
    );
    const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);
    const result = await repo.insert(validRecord(), "msg-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("inserted");
  });

  it("returns 'duplicate' when rowCount is 0 (ON CONFLICT DO NOTHING)", async () => {
    const query = vi.fn(
      makePoolQuery(async () => ({ rows: [], rowCount: 0 }) as unknown as QueryResult),
    );
    const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);
    const result = await repo.insert(validRecord(), "msg-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("duplicate");
  });

  it("treats null rowCount as duplicate", async () => {
    const query = vi.fn(
      makePoolQuery(async () => ({ rows: [], rowCount: null }) as unknown as QueryResult),
    );
    const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);
    const result = await repo.insert(validRecord(), "msg-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("duplicate");
  });

  describe("error mapping", () => {
    async function insertWithError(code: string) {
      const query = vi.fn(makePoolQuery(async () => { throw dbError(code); }));
      const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);
      return repo.insert(validRecord(), "msg-1");
    }

    it("maps 42xxx pg code to PermanentError", async () => {
      const result = await insertWithError("42703");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("PermanentError");
    });

    it("maps check-violation (23514) to PermanentError", async () => {
      const result = await insertWithError("23514");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("PermanentError");
    });

    it("maps connection-failure (08xxx) to TransientError", async () => {
      const result = await insertWithError("08006");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("TransientError");
    });

    it("maps serialization failure (40001) to TransientError", async () => {
      const result = await insertWithError("40001");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("TransientError");
    });

    it("maps unknown pg code to TransientError (fail-safe)", async () => {
      const result = await insertWithError("99999");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("TransientError");
    });

    it("maps a non-DatabaseError to TransientError with original message", async () => {
      const query = vi.fn(makePoolQuery(async () => { throw new Error("network timeout"); }));
      const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);
      const result = await repo.insert(validRecord(), "msg-1");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("TransientError");
      expect(result.error.message).toBe("network timeout");
    });
  });
});

// ---------------------------------------------------------------------------
// PostgresDeadLetterRepository
// ---------------------------------------------------------------------------

describe("PostgresDeadLetterRepository", () => {
  it("passes errorType, errorDetail, payload JSON, messageId as positional parameters", async () => {
    const entry = deadLetterInsert({
      errorType: "ValidationError",
      errorDetail: "droneId invalid",
      messageId: "msg-xyz",
      payload: { key: "value" },
    });
    const query = vi.fn(
      makePoolQuery(async () => ({ rows: [], rowCount: 1 }) as unknown as QueryResult),
    );
    const repo = new PostgresDeadLetterRepository({ query } as unknown as Pool);

    await repo.enqueue(entry);

    expect(query).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls[0] ?? [];
    expect(params).toEqual([
      "ValidationError",
      "droneId invalid",
      JSON.stringify({ key: "value" }),
      "msg-xyz",
    ]);
  });

  it("returns ok(undefined) on success", async () => {
    const query = vi.fn(
      makePoolQuery(async () => ({ rows: [], rowCount: 1 }) as unknown as QueryResult),
    );
    const repo = new PostgresDeadLetterRepository({ query } as unknown as Pool);
    const result = await repo.enqueue(deadLetterInsert());
    expect(result).toEqual({ ok: true, value: undefined });
  });

  describe("error mapping", () => {
    async function enqueueWithError(code: string) {
      const query = vi.fn(makePoolQuery(async () => { throw dbError(code); }));
      const repo = new PostgresDeadLetterRepository({ query } as unknown as Pool);
      return repo.enqueue(deadLetterInsert());
    }

    it("maps 42xxx pg code to PermanentError", async () => {
      const result = await enqueueWithError("42P01");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("PermanentError");
    });

    it("maps connection-failure (08xxx) to TransientError", async () => {
      const result = await enqueueWithError("08001");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("TransientError");
    });

    it("maps a non-DatabaseError to TransientError", async () => {
      const query = vi.fn(makePoolQuery(async () => { throw new Error("socket hang up"); }));
      const repo = new PostgresDeadLetterRepository({ query } as unknown as Pool);
      const result = await repo.enqueue(deadLetterInsert());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("TransientError");
      expect(result.error.message).toBe("socket hang up");
    });
  });
});
