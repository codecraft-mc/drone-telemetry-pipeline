/**
 * Integration tests for PostgresDeadLetterRepository.
 *
 * Requires a live Postgres instance. Start with:
 *   docker compose up -d postgres
 *
 * Then run:
 *   npx vitest run tests/integration
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresDeadLetterRepository } from "../../src/storage/postgres-dead-letter.repository.js";
import { applySchema, createTestPool, truncateTables } from "./helpers.js";
import type { DeadLetterInsert } from "../../src/storage/dead-letter.repository.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let pool: Pool;
let repo: PostgresDeadLetterRepository;

beforeAll(async () => {
  pool = createTestPool();
  await applySchema(pool);
  repo = new PostgresDeadLetterRepository(pool);
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

function entry(overrides: Partial<DeadLetterInsert> = {}): DeadLetterInsert {
  return {
    payload: { raw: "{ bad json" },
    errorType: "ParseError",
    errorDetail: "invalid JSON",
    messageId: "msg-001",
    ...overrides,
  };
}

async function rowCount(): Promise<number> {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM dead_letters");
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PostgresDeadLetterRepository — enqueue", () => {
  it("returns ok(undefined) and persists the entry", async () => {
    const result = await repo.enqueue(entry());

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await rowCount()).toBe(1);
  });

  it("persists correct column values", async () => {
    await repo.enqueue(
      entry({
        errorType: "ValidationError",
        errorDetail: "droneId: must match regex",
        messageId: "msg-abc",
        payload: { droneId: "BAD" },
      }),
    );

    const { rows } = await pool.query("SELECT * FROM dead_letters LIMIT 1");
    const row = rows[0];

    expect(row.failure_phase).toBe("ValidationError");
    expect(row.error_message).toBe("droneId: must match regex");
    expect(row.message_id).toBe("msg-abc");
    expect(typeof row.payload).toBe("object"); // pg parses JSONB to object
    expect(row.payload).toEqual({ droneId: "BAD" });
  });

  it("stores payload as JSONB and round-trips nested structures", async () => {
    const payload = { nested: { key: "value", arr: [1, 2, 3] } };
    await repo.enqueue(entry({ payload }));

    const { rows } = await pool.query("SELECT payload FROM dead_letters LIMIT 1");
    expect(rows[0].payload).toEqual(payload);
  });

  it("inserts multiple entries independently", async () => {
    await repo.enqueue(entry({ messageId: "msg-1" }));
    await repo.enqueue(entry({ messageId: "msg-2" }));
    await repo.enqueue(entry({ messageId: "msg-3" }));

    expect(await rowCount()).toBe(3);
  });

  it("accepts all DLQ error types written by the worker", async () => {
    const errorTypes = ["ParseError", "ValidationError", "PermanentError", "TRANSIENT_EXHAUSTED"];

    for (const errorType of errorTypes) {
      const result = await repo.enqueue(entry({ errorType, messageId: `msg-${errorType}` }));
      expect(result).toEqual({ ok: true, value: undefined });
    }

    expect(await rowCount()).toBe(4);
  });

  it("sets DB-defaulted columns (received_at, retry_count) automatically", async () => {
    const before = new Date();
    await repo.enqueue(entry());
    const { rows } = await pool.query("SELECT received_at, retry_count FROM dead_letters LIMIT 1");
    const after = new Date();
    const row = rows[0];

    // Allow ±1 s tolerance for clock skew between Node.js and the Postgres container.
    expect(new Date(row.received_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(new Date(row.received_at).getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    expect(row.retry_count).toBe(0);
  });
});
