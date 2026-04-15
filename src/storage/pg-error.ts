import { DatabaseError } from "pg";
import type { PermanentError, TransientError } from "../domain/errors.js";

export function isPermanentPgCode(code: string | undefined): boolean {
  if (!code) return false;
  if (code.startsWith("42")) return true;
  return code === "23514" || code === "22P02";
}

export function isTransientPgCode(code: string | undefined): boolean {
  if (!code) return false;
  if (code.startsWith("08")) return true;
  return code === "57P01" || code === "40001" || code === "40P01";
}

export function mapDatabaseError(e: DatabaseError): TransientError | PermanentError {
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
