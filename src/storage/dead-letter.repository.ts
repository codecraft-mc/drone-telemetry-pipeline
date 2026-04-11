import type { TransientError, PermanentError } from "../domain/errors.js";
import type { Result } from "../lib/result.js";

/**
 * Insert shape for `dead_letters` (see migrations/002_dead_letters.sql).
 *
 * Column mapping:
 * - `payload` → `payload` (JSONB forensic copy of the raw message)
 * - `errorType` → `failure_phase` (e.g. ValidationError, PermanentError)
 * - `errorDetail` → `error_message`
 * - `messageId` → `message_id` (first-class id for replay and debugging)
 *
 * Other columns use DB defaults (`errors` NULL, `retry_count` 0).
 */
export type DeadLetterInsert = {
  readonly payload: unknown;
  readonly errorType: string;
  readonly errorDetail: string;
  readonly messageId: string;
};

export interface DeadLetterRepository {
  enqueue(
    entry: DeadLetterInsert,
  ): Promise<Result<void, TransientError | PermanentError>>;
}
