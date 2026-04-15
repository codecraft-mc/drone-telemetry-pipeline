import type { Pool } from "pg";
import { DatabaseError } from "pg";
import type { PermanentError, TransientError } from "../domain/errors.js";
import type { TelemetryRecord } from "../domain/types.js";
import { err, ok, type Result } from "../lib/result.js";
import { toRow } from "../processing/transformer.js";
import type {
  TelemetryInsertOutcome,
  TelemetryRepository,
} from "./repository.js";
import { mapDatabaseError } from "./pg-error.js";

const INSERT_SQL = `
INSERT INTO telemetry_events (drone_id, event_time, event_type, status_code, payload, message_id)
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
ON CONFLICT (drone_id, event_time, event_type) DO NOTHING
RETURNING id;
`;

export class PostgresTelemetryRepository implements TelemetryRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    record: TelemetryRecord,
    messageId: string,
  ): Promise<Result<TelemetryInsertOutcome, TransientError | PermanentError>> {
    try {
      const row = toRow(record, messageId);
      const result = await this.pool.query(INSERT_SQL, [
        row.drone_id,
        row.event_time,
        row.event_type,
        row.status_code,
        JSON.stringify(row.payload),
        row.message_id,
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
