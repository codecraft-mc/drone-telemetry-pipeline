/**
 * Domain-level failure shapes for the pipeline. Transport-agnostic; no `Error`
 * subclass coupling so callers can switch exhaustively on `kind`.
 */

import type { ZodIssue } from "zod";

export type ParseError = {
  readonly kind: "ParseError";
  readonly message: string;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
};

export type ValidationError = {
  readonly kind: "ValidationError";
  readonly message: string;
  readonly issues: readonly ZodIssue[];
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
};

export type TransientError = {
  readonly kind: "TransientError";
  readonly message: string;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
};

export type PermanentError = {
  readonly kind: "PermanentError";
  readonly message: string;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
};

export type DomainError =
  | ParseError
  | ValidationError
  | TransientError
  | PermanentError;
