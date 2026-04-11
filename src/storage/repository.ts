import type { TransientError, PermanentError } from "../domain/errors.js";
import type { TelemetryRecord } from "../domain/types.js";
import type { Result } from "../lib/result.js";

export type TelemetryInsertOutcome = "inserted" | "duplicate";

export interface TelemetryRepository {
  insert(
    record: TelemetryRecord,
  ): Promise<Result<TelemetryInsertOutcome, TransientError | PermanentError>>;
}
