import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool } from "pg";

/**
 * Integration tests require a real Postgres instance.
 * Start one with: docker compose up -d postgres
 *
 * Connection defaults match docker-compose.yml. Override via env:
 *   DATABASE_URL=postgresql://... npx vitest run tests/integration
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://telemetry:telemetry@localhost:5433/telemetry_test";

const MIGRATIONS_DIR = resolve("migrations");

function readMigration(filename: string): string {
  return readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
}

/**
 * Creates a Pool connected to the test database. Callers must call pool.end()
 * in afterAll.
 */
export function createTestPool(): Pool {
  return new Pool({ connectionString: DATABASE_URL, max: 2 });
}

/**
 * Applies both migrations inside a transaction so the schema is always
 * consistent. Safe to call in beforeAll — idempotent via DROP … IF EXISTS.
 */
export async function applySchema(pool: Pool): Promise<void> {
  const migration1 = readMigration("001_telemetry_events.sql");
  const migration2 = readMigration("002_dead_letters.sql");

  await pool.query(`
    DROP TABLE IF EXISTS dead_letters CASCADE;
    DROP TABLE IF EXISTS telemetry_events CASCADE;
    ${migration1}
    ${migration2}
  `);
}

/**
 * Truncates both tables between tests for isolation without the cost of
 * re-applying the full schema each time.
 */
export async function truncateTables(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE telemetry_events, dead_letters RESTART IDENTITY CASCADE");
}
