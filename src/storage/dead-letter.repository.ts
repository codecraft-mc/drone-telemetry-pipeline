import type { TransientError, PermanentError } from "../domain/errors.js";
import type { Result } from "../lib/result.js";

/**
 * Insert shape aligned with `dead_letters` (see migrations/002_dead_letters.sql).
 * Forensic payload and optional failure metadata for replay and debugging.
 */
export type DeadLetterInsert = {
  readonly payload: unknown;
  readonly failurePhase?: string;
  readonly errorMessage?: string;
  readonly errors?: unknown;
  readonly retryCount?: number;
};

export interface DeadLetterRepository {
  enqueue(
    entry: DeadLetterInsert,
  ): Promise<Result<void, TransientError | PermanentError>>;
}
