import type { Pool } from "pg";
import { DatabaseError } from "pg";
import type { PermanentError, TransientError } from "../domain/errors.js";
import { err, ok, type Result } from "../lib/result.js";
import type { DeadLetterInsert, DeadLetterRepository } from "./dead-letter.repository.js";
import { mapDatabaseError } from "./pg-error.js";

const INSERT_SQL = `
INSERT INTO dead_letters (failure_phase, error_message, payload, message_id)
VALUES ($1, $2, $3::jsonb, $4);
`;

export class PostgresDeadLetterRepository implements DeadLetterRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(
    entry: DeadLetterInsert,
  ): Promise<Result<void, TransientError | PermanentError>> {
    try {
      await this.pool.query(INSERT_SQL, [
        entry.errorType,
        entry.errorDetail,
        JSON.stringify(entry.payload),
        entry.messageId,
      ]);
      return ok(undefined);
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
