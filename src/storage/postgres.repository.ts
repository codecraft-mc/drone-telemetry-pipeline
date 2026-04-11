import type { Pool } from "pg";
import { DatabaseError } from "pg";
import type { PermanentError, TransientError } from "../domain/errors.js";
import type { TelemetryRecord } from "../domain/types.js";
import { err, ok, type Result } from "../lib/result.js";
import type {
  TelemetryInsertOutcome,
  TelemetryRepository,
} from "./repository.js";

const INSERT_SQL = `
INSERT INTO telemetry_events (drone_id, event_time, event_type, status_code, payload)
VALUES ($1, $2, $3, $4, $5::jsonb)
ON CONFLICT (drone_id, event_time, event_type) DO NOTHING
RETURNING id;
`;

function isPermanentPgCode(code: string | undefined): boolean {
  if (!code) return false;
  if (code.startsWith("42")) return true;
  return code === "23514" || code === "22P02";
}

function isTransientPgCode(code: string | undefined): boolean {
  if (!code) return false;
  if (code.startsWith("08")) return true;
  return code === "57P01" || code === "40001" || code === "40P01";
}

function mapDatabaseError(e: DatabaseError): TransientError | PermanentError {
  const code = e.code;
  const context = {
    code,
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
  };

  if (isPermanentPgCode(code)) {
    return {
      kind: "PermanentError",
      message: e.message,
      cause: e,
      context,
    };
  }

  if (isTransientPgCode(code)) {
    return {
      kind: "TransientError",
      message: e.message,
      cause: e,
      context,
    };
  }

  return {
    kind: "TransientError",
    message: e.message,
    cause: e,
    context,
  };
}

export class PostgresTelemetryRepository implements TelemetryRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    record: TelemetryRecord,
  ): Promise<Result<TelemetryInsertOutcome, TransientError | PermanentError>> {
    try {
      const result = await this.pool.query(INSERT_SQL, [
        record.droneId,
        record.timestamp,
        record.eventType,
        record.statusCode,
        JSON.stringify(record),
      ]);

      const inserted = (result.rowCount ?? 0) === 1;
      const outcome: TelemetryInsertOutcome = inserted
        ? "inserted"
        : "duplicate";
      return ok(outcome);
    } catch (caught) {
      if (caught instanceof DatabaseError) {
        return err(mapDatabaseError(caught));
      }
      return err({
        kind: "TransientError",
        message:
          caught instanceof Error ? caught.message : "Unknown database error",
        cause: caught,
      });
    }
  }
}
