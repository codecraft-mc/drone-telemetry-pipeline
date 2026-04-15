/**
 * Integration tests for PostgresTelemetryRepository.
 *
 * Requires a live Postgres instance. Start with:
 *   docker compose up -d postgres
 *
 * Then run:
 *   npx vitest run tests/integration
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresTelemetryRepository } from "../../src/storage/postgres.repository.js";
import { applySchema, createTestPool, truncateTables } from "./helpers.js";
import {
  batteryLowRecord,
  deliveryCompletedRecord,
  errorRecord,
  routeAdjustedRecord,
  sensorReadingRecord,
} from "../fixtures/records.js";
import { validate } from "../../src/processing/validator.js";
import type { TelemetryRecord } from "../../src/domain/types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let pool: Pool;
let repo: PostgresTelemetryRepository;

beforeAll(async () => {
  pool = createTestPool();
  await applySchema(pool);
  repo = new PostgresTelemetryRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateTables(pool);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validated(raw: Record<string, unknown>): TelemetryRecord {
  const result = validate(raw);
  if (!result.ok) throw new Error(`fixture validation failed: ${result.error.message}`);
  return result.value;
}

async function rowCount(): Promise<number> {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM telemetry_events");
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PostgresTelemetryRepository — insert", () => {
  it("returns 'inserted' and persists a BATTERY_LOW record", async () => {
    const record = validated(batteryLowRecord());
    const result = await repo.insert(record, "msg-001");

    expect(result).toEqual({ ok: true, value: "inserted" });
    expect(await rowCount()).toBe(1);
  });

  it("persists correct column values including message_id", async () => {
    const record = validated(batteryLowRecord());
    await repo.insert(record, "msg-col-test");

    const { rows } = await pool.query("SELECT * FROM telemetry_events LIMIT 1");
    const row = rows[0];

    expect(row.drone_id).toBe(record.droneId);
    expect(row.event_type).toBe("BATTERY_LOW");
    expect(row.status_code).toBe(record.statusCode);
    expect(new Date(row.event_time).getTime()).toBe(record.timestamp.getTime());
    expect(row.message_id).toBe("msg-col-test");
    expect(typeof row.payload).toBe("object"); // pg parses JSONB to object
  });

  it("returns 'duplicate' and does not insert a second row on conflict", async () => {
    const record = validated(batteryLowRecord());

    const first = await repo.insert(record, "msg-dup-1");
    const second = await repo.insert(record, "msg-dup-2");

    expect(first).toEqual({ ok: true, value: "inserted" });
    expect(second).toEqual({ ok: true, value: "duplicate" });
    expect(await rowCount()).toBe(1);
  });

  it("treats same droneId+eventType with different timestamp as distinct (no conflict)", async () => {
    const base = batteryLowRecord();
    const r1 = validated({ ...base, timestamp: new Date(Date.now() - 10_000).toISOString() });
    const r2 = validated({ ...base, timestamp: new Date(Date.now() - 5_000).toISOString() });

    await repo.insert(r1, "msg-ts-1");
    await repo.insert(r2, "msg-ts-2");

    expect(await rowCount()).toBe(2);
  });

  it("accepts all five event types", async () => {
    const records = [
      validated(batteryLowRecord()),
      validated(routeAdjustedRecord()),
      validated(deliveryCompletedRecord()),
      validated(sensorReadingRecord()),
      validated(errorRecord()),
    ];

    // Give each a distinct timestamp to avoid UNIQUE conflicts
    for (let i = 0; i < records.length; i++) {
      const r = { ...records[i]!, timestamp: new Date(Date.now() - i * 10_000) } as TelemetryRecord;
      const result = await repo.insert(r, `msg-type-${i}`);
      expect(result).toEqual({ ok: true, value: "inserted" });
    }

    expect(await rowCount()).toBe(5);
  });

  it("stores payload as JSONB with snake_cased telemetryData keys", async () => {
    const record = validated(batteryLowRecord({ telemetryData: { batteryLevel: 73 } }));
    await repo.insert(record, "msg-payload");

    const { rows } = await pool.query("SELECT payload FROM telemetry_events LIMIT 1");
    // toRow() snake_cases telemetryData: batteryLevel → battery_level
    expect(rows[0].payload).toEqual({ battery_level: 73 });
  });

  it("rejects a status_code violating the CHECK constraint (0–999) as PermanentError", async () => {
    // Bypass Zod validation to force an out-of-range value through to Postgres.
    const record = {
      ...validated(batteryLowRecord()),
      statusCode: 1000,
    } as unknown as TelemetryRecord;

    const result = await repo.insert(record, "msg-check");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("PermanentError");
  });
});
