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
