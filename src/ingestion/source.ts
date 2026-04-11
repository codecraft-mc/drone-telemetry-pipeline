/**
 * Read-side contract for bringing raw telemetry into the pipeline. Implementations
 * may wrap queues, Redis streams, HTTP, etc.; this surface stays transport-agnostic.
 */

export type RawMessage = {
  readonly id: string;
  readonly body: unknown;
  readonly receivedAt: Date;
};

export interface IngestionSource {
  subscribe(signal?: AbortSignal): AsyncIterable<RawMessage>;
}
