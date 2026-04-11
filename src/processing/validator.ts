import type { ValidationError } from "../domain/errors.js";
import { TelemetryRecordSchema, type TelemetryRecord } from "../domain/schema.js";
import { err, ok, type Result } from "../lib/result.js";

export function validate(input: unknown): Result<TelemetryRecord, ValidationError> {
  const parsed = TelemetryRecordSchema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }

  const { error } = parsed;
  const message = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");

  return err({
    kind: "ValidationError",
    message,
    issues: error.issues,
  });
}
