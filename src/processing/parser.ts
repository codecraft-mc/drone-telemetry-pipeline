import type { ParseError } from "../domain/errors.js";
import { err, ok, type Result } from "../lib/result.js";

function parseFailure(message: string, cause?: unknown): ParseError {
  return cause === undefined
    ? { kind: "ParseError", message }
    : { kind: "ParseError", message, cause };
}

export function parseRecord(raw: string): Result<unknown, ParseError> {
  if (raw.trim() === "") {
    return err(parseFailure("input is empty or whitespace-only"));
  }

  try {
    return ok(JSON.parse(raw) as unknown);
  } catch (cause) {
    return err(parseFailure("invalid JSON", cause));
  }
}
