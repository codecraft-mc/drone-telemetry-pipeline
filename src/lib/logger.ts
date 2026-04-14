import pino, { type Logger as PinoInstance } from "pino";
import type { DomainError } from "../domain/errors.js";

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured logging contract suitable for a future Pino (or other) adapter.
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

// ---------------------------------------------------------------------------
// Correlation ID
// ---------------------------------------------------------------------------

/**
 * Compose a correlation ID from the Redis stream entry ID and (when available)
 * the drone ID parsed from the message body.
 *
 * Format: `<streamEntryId>` or `<streamEntryId>:<droneId>`
 *
 * The stream entry ID alone is always present and globally orderable; the
 * drone ID scopes it to a device for cross-message tracing.
 */
export function makeCorrelationId(streamEntryId: string, droneId?: string): string {
  return droneId ? `${streamEntryId}:${droneId}` : streamEntryId;
}

// ---------------------------------------------------------------------------
// Pino adapter
// ---------------------------------------------------------------------------

class PinoLogger implements Logger {
  constructor(private readonly pino: PinoInstance) {}

  debug(msg: string, fields?: LogFields): void {
    this.pino.debug(fields ?? {}, msg);
  }

  info(msg: string, fields?: LogFields): void {
    this.pino.info(fields ?? {}, msg);
  }

  warn(msg: string, fields?: LogFields): void {
    this.pino.warn(fields ?? {}, msg);
  }

  error(msg: string, fields?: LogFields): void {
    this.pino.error(fields ?? {}, msg);
  }

  child(bindings: LogFields): Logger {
    return new PinoLogger(this.pino.child(bindings as Record<string, unknown>));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type CreateLoggerOptions = {
  level?: string;
  /** Static fields merged into every log line (e.g. pid, host). */
  base?: Record<string, unknown>;
};

/**
 * Create a {@link Logger} backed by Pino with JSON output.
 *
 * Pass the raw `pino` instance when you need full control (e.g. in `index.ts`),
 * or use the options overload for a zero-boilerplate root logger.
 */
export function createLogger(pinoInstance: PinoInstance): Logger;
export function createLogger(options?: CreateLoggerOptions): Logger;
export function createLogger(arg?: PinoInstance | CreateLoggerOptions): Logger {
  if (arg && "child" in arg && typeof (arg as PinoInstance).child === "function") {
    // Caller passed a fully-configured pino instance.
    return new PinoLogger(arg as PinoInstance);
  }

  const opts = (arg ?? {}) as CreateLoggerOptions;
  const instance = pino({
    level: opts.level ?? "info",
    ...(opts.base !== undefined && { base: opts.base }),
  });

  return new PinoLogger(instance);
}

// ---------------------------------------------------------------------------
// Domain-error logging — four-tier taxonomy & routing policy
// ---------------------------------------------------------------------------

/**
 * Four-tier error taxonomy and log-level routing policy.
 *
 * | Tier            | Log level | Rationale                                              |
 * |-----------------|-----------|--------------------------------------------------------|
 * | ParseError      | warn      | Malformed upstream data — expected at low %; DLQ-bound |
 * | ValidationError | warn      | Schema violation — expected from upstream drift; DLQ   |
 * | TransientError  | warn      | Infrastructure blip — expected to resolve on retry     |
 * | PermanentError  | error     | Unexpected condition that needs operator investigation  |
 *
 * Duplicate-detection hits (e.g. idempotency key already seen) are logged at
 * `debug` by the caller — they are not modelled as domain errors because they
 * represent correct pipeline behaviour, not failure.
 */
export function logDomainError(
  log: Logger,
  error: DomainError,
  extraFields?: LogFields,
): void {
  const base: Record<string, unknown> = {
    errorKind: error.kind,
    errorMessage: error.message,
    ...extraFields,
  };

  if (error.cause !== undefined) {
    base.cause =
      error.cause instanceof Error
        ? { message: error.cause.message, name: error.cause.name }
        : error.cause;
  }

  if (error.context !== undefined) {
    base.context = error.context;
  }

  switch (error.kind) {
    case "ParseError":
      // Malformed bytes from upstream — expected at some non-zero rate.
      // Routed to DLQ; no retry value.
      log.warn("parse error — message routed to DLQ", base);
      break;

    case "ValidationError":
      // Well-formed JSON but fails domain schema — likely upstream schema drift.
      // Routed to DLQ; surfacing issues field helps schema owners diagnose.
      log.warn("validation error — message routed to DLQ", {
        ...base,
        issues: error.issues,
      });
      break;

    case "TransientError":
      // Infrastructure failure (network, DB timeout, etc.) — expected to self-heal.
      // Message is NOT acked; redelivered after PEL idle timeout.
      log.warn("transient error — message will be redelivered", base);
      break;

    case "PermanentError":
      // Unexpected condition (constraint violation, codec bug, etc.).
      // Requires operator attention; routed to DLQ after logging.
      log.error("permanent error — message routed to DLQ", base);
      break;
  }
}
