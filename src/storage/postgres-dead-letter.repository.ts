import type { Pool } from "pg";
import { DatabaseError } from "pg";
import type { PermanentError, TransientError } from "../domain/errors.js";
import { err, ok, type Result } from "../lib/result.js";
import type { DeadLetterInsert, DeadLetterRepository } from "./dead-letter.repository.js";

const INSERT_SQL = `
INSERT INTO dead_letters (failure_phase, error_message, payload, message_id)
VALUES ($1, $2, $3::jsonb, $4);
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
