/**
 * Read-side contract for bringing raw telemetry into the pipeline. Implementations
 * may wrap queues, Redis streams, HTTP, etc.; this surface stays transport-agnostic.
 */

export type RawMessage = {
  /**
   * Opaque message identifier for the transport. For Redis stream sources this is the
   * stream entry ID from `XREADGROUP` / `XAUTOCLAIM`; callers must pass the same IDs to
   * {@link MessageSource.ack} after durable processing so entries leave the PEL.
   */
  readonly id: string;
  readonly body: unknown;
  readonly receivedAt: Date;
  /**
   * How many times this message has been delivered across all consumers and process restarts,
   * as tracked by the Redis PEL. Populated for reclaimed messages (XAUTOCLAIM path); `undefined`
   * for freshly delivered messages where delivery count is implicitly 1.
   */
  readonly deliveryCount?: number;
};

export interface IngestionSource {
  subscribe(signal?: AbortSignal): AsyncIterable<RawMessage>;
}

/**
 * Pull-based ingestion: blocking reads and explicit acknowledgements. Unlike
 * {@link IngestionSource.subscribe}, this contract fits consumer groups (read/ack) rather
 * than push-style iteration.
 */
export interface MessageSource {
  /**
   * Blocks up to the source-configured cap, then returns zero or more messages (new reads
   * and/or reclaimed pending).
   */
  read(signal?: AbortSignal): Promise<RawMessage[]>;
  /** Acknowledges processed entries by transport id (same as {@link RawMessage.id}). */
  ack(messageIds: readonly string[]): Promise<number>;
}
