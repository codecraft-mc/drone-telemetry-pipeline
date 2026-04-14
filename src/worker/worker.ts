import type { MessageSource, RawMessage } from "../ingestion/source.js";
import type { DeadLetterRepository } from "../storage/dead-letter.repository.js";
import type { TelemetryRepository } from "../storage/repository.js";
import type { Logger } from "../lib/logger.js";
import type { ParseError } from "../domain/errors.js";
import type { Result } from "../lib/result.js";
import { ok } from "../lib/result.js";
import { parseRecord } from "../processing/parser.js";
import { validate } from "../processing/validator.js";

export type WorkerOptions = {
  source: MessageSource;
  telemetryRepo: TelemetryRepository;
  deadLetterRepo: DeadLetterRepository;
  logger: Logger;
  /**
   * Maximum number of delivery attempts before a transiently-failing message is
   * routed to the DLQ as TRANSIENT_EXHAUSTED. Defaults to 5.
   */
  maxDeliveryCount?: number;
};

/** Parse a RawMessage body regardless of whether it arrived as a string or pre-parsed object. */
function parseBody(body: unknown): Result<unknown, ParseError> {
  if (typeof body === "string") {
    return parseRecord(body);
  }
  // Already decoded by the transport layer (e.g. RedisMessageSource parses the `payload` field).
  return ok(body);
}

export class Worker {
  private readonly source: MessageSource;
  private readonly telemetryRepo: TelemetryRepository;
  private readonly deadLetterRepo: DeadLetterRepository;
  private readonly log: Logger;
  private readonly maxDeliveryCount: number;

  /** Per-message delivery attempt counter, keyed by transport message id. */
  private readonly deliveryCounts = new Map<string, number>();

  constructor(options: WorkerOptions) {
    this.source = options.source;
    this.telemetryRepo = options.telemetryRepo;
    this.deadLetterRepo = options.deadLetterRepo;
    this.log = options.logger.child({ component: "worker" });
    this.maxDeliveryCount = options.maxDeliveryCount ?? 5;
  }

  /**
   * Reads and processes messages in a loop until the AbortSignal fires.
   * An AbortError from `source.read()` propagates to the caller as the clean shutdown path.
   */
  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const messages = await this.source.read(signal);
      for (const msg of messages) {
        await this.processMessage(msg);
      }
    }
  }

  private async processMessage(msg: RawMessage): Promise<void> {
    const log = this.log.child({ messageId: msg.id });

    // --- Delivery-count tracking ---
    const attempt = (this.deliveryCounts.get(msg.id) ?? 0) + 1;
    this.deliveryCounts.set(msg.id, attempt);

    // Exhaustion check: route to DLQ without retrying further.
    if (attempt > this.maxDeliveryCount) {
      log.warn("message exhausted max delivery attempts; routing to DLQ", {
        attempt,
        maxDeliveryCount: this.maxDeliveryCount,
      });
      await this.sendToDLQ(
        msg,
        "TRANSIENT_EXHAUSTED",
        `Exceeded ${this.maxDeliveryCount} delivery attempts`,
        log,
      );
      this.deliveryCounts.delete(msg.id);
      await this.source.ack([msg.id]);
      return;
    }

    // --- Parse ---
    const parseResult = parseBody(msg.body);
    if (!parseResult.ok) {
      log.warn("parse failure; routing to DLQ", { error: parseResult.error.message });
      await this.sendToDLQ(msg, "ParseError", parseResult.error.message, log);
      this.deliveryCounts.delete(msg.id);
      await this.source.ack([msg.id]);
      return;
    }

    // --- Validate ---
    const validateResult = validate(parseResult.value);
    if (!validateResult.ok) {
      log.warn("validation failure; routing to DLQ", { error: validateResult.error.message });
      await this.sendToDLQ(msg, "ValidationError", validateResult.error.message, log);
      this.deliveryCounts.delete(msg.id);
      await this.source.ack([msg.id]);
      return;
    }

    // --- Write ---
    const record = validateResult.value;
    const insertResult = await this.telemetryRepo.insert(record);

    if (!insertResult.ok) {
      const { error } = insertResult;
      if (error.kind === "TransientError") {
        // Do not ack: leave in the PEL so the source redelivers after the idle timeout.
        log.warn("transient write error; will redeliver", {
          attempt,
          error: error.message,
        });
        return;
      }
      // PermanentError: no point retrying.
      log.error("permanent write error; routing to DLQ", { error: error.message });
      await this.sendToDLQ(msg, "PermanentError", error.message, log);
      this.deliveryCounts.delete(msg.id);
      await this.source.ack([msg.id]);
      return;
    }

    // --- Success ---
    log.debug("record written", { outcome: insertResult.value, attempt });
    this.deliveryCounts.delete(msg.id);
    await this.source.ack([msg.id]);
  }

  /**
   * Attempts to enqueue a dead letter. On DLQ write failure we log and proceed so that
   * a broken DLQ path never creates an infinite redelivery loop.
   */
  private async sendToDLQ(
    msg: RawMessage,
    errorType: string,
    errorDetail: string,
    log: Logger,
  ): Promise<void> {
    const result = await this.deadLetterRepo.enqueue({
      payload: msg.body,
      errorType,
      errorDetail,
      messageId: msg.id,
    });
    if (!result.ok) {
      log.error("failed to enqueue dead letter; message will be acked anyway", {
        dlqError: result.error.message,
        errorType,
      });
    }
  }
}
