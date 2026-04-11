import type { Pool, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryRecord } from "../../src/domain/schema.js";
import { PostgresTelemetryRepository } from "../../src/storage/postgres.repository.js";
import { batteryLowRecord } from "../fixtures/records.js";
import { validate } from "../../src/processing/validator.js";

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

describe("PostgresTelemetryRepository", () => {
  it("passes INSERT SQL shape and positional parameters to pool.query", async () => {
    const record = validRecord();
    const query = vi.fn(makePoolQuery(async () => ({ rows: [], rowCount: 1 })));
    const pool = { query } as unknown as Pool;
    const repo = new PostgresTelemetryRepository(pool);

    await repo.insert(record);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(typeof sql).toBe("string");
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("DO NOTHING");
    expect(sql).toContain("RETURNING id");
    expect(sql).toContain("$5::jsonb");

    expect(params).toEqual([
      record.droneId,
      record.timestamp,
      record.eventType,
      record.statusCode,
      JSON.stringify(record),
    ]);
  });

  it("returns inserted when rowCount is 1", async () => {
    const record = validRecord();
    const query = vi.fn(makePoolQuery(async () => ({ rows: [], rowCount: 1 })));
    const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);

    const result = await repo.insert(record);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("inserted");
  });

  it("returns duplicate when rowCount is 0 (idempotent conflict)", async () => {
    const record = validRecord();
    const query = vi.fn(makePoolQuery(async () => ({ rows: [], rowCount: 0 })));
    const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);

    const result = await repo.insert(record);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("duplicate");
  });

  it("treats missing rowCount as duplicate", async () => {
    const record = validRecord();
    const query = vi.fn(
      makePoolQuery(async () => ({ rows: [], rowCount: undefined })),
    );
    const repo = new PostgresTelemetryRepository({ query } as unknown as Pool);

    const result = await repo.insert(record);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("duplicate");
  });
});
