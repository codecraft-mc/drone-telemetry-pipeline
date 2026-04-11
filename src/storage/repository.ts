import type { TransientError, PermanentError } from "../domain/errors.js";
import type { TelemetryRecord } from "../domain/types.js";
import type { Result } from "../lib/result.js";

export interface TelemetryRepository {
  save(
    record: TelemetryRecord,
  ): Promise<Result<void, TransientError | PermanentError>>;
}
