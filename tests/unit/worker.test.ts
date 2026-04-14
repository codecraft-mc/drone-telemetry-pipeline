import { describe, it, expect } from "vitest";
import { Worker } from "../../src/worker/worker.js";
import type { MessageSource, RawMessage } from "../../src/ingestion/source.js";
import type { TelemetryRepository, TelemetryInsertOutcome } from "../../src/storage/repository.js";
import type { DeadLetterRepository, DeadLetterInsert } from "../../src/storage/dead-letter.repository.js";
import type { Logger, LogFields } from "../../src/lib/logger.js";
import type { TransientError, PermanentError } from "../../src/domain/errors.js";
import type { TelemetryRecord } from "../../src/domain/types.js";
import type { Result } from "../../src/lib/result.js";
import { ok, err } from "../../src/lib/result.js";
import { batteryLowRecord } from "../fixtures/records.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeLogger implements Logger {
  readonly messages: Array<{ level: string; msg: string; fields?: LogFields }> = [];
  debug(msg: string, fields?: LogFields) { this.messages.push({ level: "debug", msg, ...(fields !== undefined && { fields }) }); }
  info(msg: string, fields?: LogFields)  { this.messages.push({ level: "info",  msg, ...(fields !== undefined && { fields }) }); }
  warn(msg: string, fields?: LogFields)  { this.messages.push({ level: "warn",  msg, ...(fields !== undefined && { fields }) }); }
  error(msg: string, fields?: LogFields) { this.messages.push({ level: "error", msg, ...(fields !== undefined && { fields }) }); }
  child(_bindings: LogFields): Logger    { return this; }
}

class FakeMessageSource implements MessageSource {
  private readonly queue: RawMessage[];
  readonly ackedIds: string[] = [];

  constructor(messages: RawMessage[]) {
    this.queue = [...messages];
  }

  async read(_signal?: AbortSignal): Promise<RawMessage[]> {
    const batch = this.queue.splice(0);
    if (batch.length === 0) {
      throw new DOMException("no more messages", "AbortError");
    }
    return batch;
  }

  async ack(ids: readonly string[]): Promise<number> {
    this.ackedIds.push(...ids);
    return ids.length;
  }
}

class FakeTelemetryRepository implements TelemetryRepository {
  private readonly response: Result<TelemetryInsertOutcome, TransientError | PermanentError>;
  readonly insertedRecords: TelemetryRecord[] = [];

  constructor(response: Result<TelemetryInsertOutcome, TransientError | PermanentError>) {
    this.response = response;
  }

  async insert(record: TelemetryRecord): Promise<Result<TelemetryInsertOutcome, TransientError | PermanentError>> {
    this.insertedRecords.push(record);
    return this.response;
  }
}

class FakeDeadLetterRepository implements DeadLetterRepository {
  private readonly response: Result<void, TransientError | PermanentError>;
  readonly enqueuedEntries: DeadLetterInsert[] = [];

  constructor(response: Result<void, TransientError | PermanentError> = ok(undefined)) {
    this.response = response;
  }

  async enqueue(entry: DeadLetterInsert): Promise<Result<void, TransientError | PermanentError>> {
    this.enqueuedEntries.push(entry);
    return this.response;
  }
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeMessage(id: string, body: unknown = batteryLowRecord()): RawMessage {
  return { id, body, receivedAt: new Date() };
}

/** Run the worker until FakeMessageSource exhausts its queue (AbortError = clean exit). */
async function runWorker(worker: Worker): Promise<void> {
  try {
    await worker.run();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    throw e;
  }
}

function makeWorker(
  messages: RawMessage[],
  telemetryRepo: TelemetryRepository,
  deadLetterRepo: DeadLetterRepository,
  opts?: { maxDeliveryCount?: number },
): { worker: Worker; source: FakeMessageSource; log: FakeLogger } {
  const source = new FakeMessageSource(messages);
  const log = new FakeLogger();
  const worker = new Worker({ source, telemetryRepo, deadLetterRepo, logger: log, ...opts });
  return { worker, source, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Worker — happy path", () => {
  it("inserts a valid record and acks the message", async () => {
    const telemetryRepo = new FakeTelemetryRepository(ok("inserted"));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker([makeMessage("msg-1")], telemetryRepo, dlq);

    await runWorker(worker);

    expect(telemetryRepo.insertedRecords).toHaveLength(1);
    expect(source.ackedIds).toEqual(["msg-1"]);
    expect(dlq.enqueuedEntries).toHaveLength(0);
  });

  it("acks a duplicate insert without error and does not write to DLQ", async () => {
    const telemetryRepo = new FakeTelemetryRepository(ok("duplicate"));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker([makeMessage("msg-dup")], telemetryRepo, dlq);

    await runWorker(worker);

    expect(source.ackedIds).toEqual(["msg-dup"]);
    expect(dlq.enqueuedEntries).toHaveLength(0);
  });
});

describe("Worker — parse failure", () => {
  it("routes invalid JSON string body to DLQ and acks", async () => {
    const telemetryRepo = new FakeTelemetryRepository(ok("inserted"));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker(
      [makeMessage("msg-bad-json", "not-json-at-all{{")],
      telemetryRepo,
      dlq,
    );

    await runWorker(worker);

    expect(source.ackedIds).toEqual(["msg-bad-json"]);
    expect(dlq.enqueuedEntries).toHaveLength(1);
    expect(dlq.enqueuedEntries[0]!.errorType).toBe("ParseError");
    expect(dlq.enqueuedEntries[0]!.messageId).toBe("msg-bad-json");
    expect(telemetryRepo.insertedRecords).toHaveLength(0);
  });

  it("routes empty-string body to DLQ and acks", async () => {
    const telemetryRepo = new FakeTelemetryRepository(ok("inserted"));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker([makeMessage("msg-empty", "   ")], telemetryRepo, dlq);

    await runWorker(worker);

    expect(source.ackedIds).toEqual(["msg-empty"]);
    expect(dlq.enqueuedEntries[0]!.errorType).toBe("ParseError");
  });
});

describe("Worker — validation failure", () => {
  it("routes a structurally invalid object to DLQ and acks", async () => {
    const telemetryRepo = new FakeTelemetryRepository(ok("inserted"));
    const dlq = new FakeDeadLetterRepository();
    const badBody = { droneId: "UPPERCASE-INVALID", eventType: "BATTERY_LOW" };
    const { worker, source } = makeWorker([makeMessage("msg-invalid", badBody)], telemetryRepo, dlq);

    await runWorker(worker);

    expect(source.ackedIds).toEqual(["msg-invalid"]);
    expect(dlq.enqueuedEntries).toHaveLength(1);
    expect(dlq.enqueuedEntries[0]!.errorType).toBe("ValidationError");
    expect(dlq.enqueuedEntries[0]!.messageId).toBe("msg-invalid");
    expect(telemetryRepo.insertedRecords).toHaveLength(0);
  });
});

describe("Worker — transient write error", () => {
  it("does not ack when the repository returns a TransientError", async () => {
    const transient: TransientError = { kind: "TransientError", message: "db timeout" };
    const telemetryRepo = new FakeTelemetryRepository(err(transient));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker([makeMessage("msg-transient")], telemetryRepo, dlq);

    await runWorker(worker);

    expect(source.ackedIds).toHaveLength(0);
    expect(dlq.enqueuedEntries).toHaveLength(0);
  });
});

describe("Worker — permanent write error", () => {
  it("routes to DLQ and acks on PermanentError from repository", async () => {
    const permanent: PermanentError = { kind: "PermanentError", message: "constraint violation" };
    const telemetryRepo = new FakeTelemetryRepository(err(permanent));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker([makeMessage("msg-perm")], telemetryRepo, dlq);

    await runWorker(worker);

    expect(source.ackedIds).toEqual(["msg-perm"]);
    expect(dlq.enqueuedEntries).toHaveLength(1);
    expect(dlq.enqueuedEntries[0]!.errorType).toBe("PermanentError");
    expect(dlq.enqueuedEntries[0]!.messageId).toBe("msg-perm");
  });
});

describe("Worker — transient exhaustion", () => {
  it("routes to DLQ as TRANSIENT_EXHAUSTED and acks after maxDeliveryCount exceeded", async () => {
    const transient: TransientError = { kind: "TransientError", message: "db timeout" };
    const telemetryRepo = new FakeTelemetryRepository(err(transient));
    const dlq = new FakeDeadLetterRepository();
    const maxDeliveryCount = 3;
    const ackedIds: string[] = [];

    // Simulate XAUTOCLAIM redelivery: same message ID, one per read() call.
    let readCalls = 0;
    const source: MessageSource = {
      async read() {
        readCalls++;
        if (readCalls > maxDeliveryCount + 1) throw new DOMException("done", "AbortError");
        return [makeMessage("msg-exhausted")];
      },
      async ack(ids) { ackedIds.push(...ids); return ids.length; },
    };

    const log = new FakeLogger();
    const worker = new Worker({ source, telemetryRepo, deadLetterRepo: dlq, logger: log, maxDeliveryCount });
    await runWorker(worker);

    expect(dlq.enqueuedEntries).toHaveLength(1);
    expect(dlq.enqueuedEntries[0]!.errorType).toBe("TRANSIENT_EXHAUSTED");
    expect(dlq.enqueuedEntries[0]!.messageId).toBe("msg-exhausted");
    expect(ackedIds).toEqual(["msg-exhausted"]);
  });

  it("does not exhaust before maxDeliveryCount is reached", async () => {
    const transient: TransientError = { kind: "TransientError", message: "db timeout" };
    const telemetryRepo = new FakeTelemetryRepository(err(transient));
    const dlq = new FakeDeadLetterRepository();
    const maxDeliveryCount = 3;
    const ackedIds: string[] = [];

    let readCalls = 0;
    const source: MessageSource = {
      async read() {
        readCalls++;
        if (readCalls > maxDeliveryCount) throw new DOMException("done", "AbortError");
        return [makeMessage("msg-not-yet-exhausted")];
      },
      async ack(ids) { ackedIds.push(...ids); return ids.length; },
    };

    const log = new FakeLogger();
    const worker = new Worker({ source, telemetryRepo, deadLetterRepo: dlq, logger: log, maxDeliveryCount });
    await runWorker(worker);

    expect(dlq.enqueuedEntries).toHaveLength(0);
    expect(ackedIds).toHaveLength(0);
  });
});

describe("Worker — DLQ write failure", () => {
  it("acks the message even when the DLQ enqueue itself fails", async () => {
    const permanent: PermanentError = { kind: "PermanentError", message: "write failed" };
    const telemetryRepo = new FakeTelemetryRepository(err(permanent));
    const dlqError: TransientError = { kind: "TransientError", message: "dlq unavailable" };
    const dlq = new FakeDeadLetterRepository(err(dlqError));
    const { worker, source, log } = makeWorker([makeMessage("msg-dlq-fail")], telemetryRepo, dlq);

    await runWorker(worker);

    expect(source.ackedIds).toEqual(["msg-dlq-fail"]);
    expect(log.messages.some((m) => m.level === "error" && /dead letter/i.test(m.msg))).toBe(true);
  });
});

describe("Worker — pre-parsed vs string body", () => {
  it("handles a body that is already an object (Redis pre-parsed path)", async () => {
    const telemetryRepo = new FakeTelemetryRepository(ok("inserted"));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker([makeMessage("msg-obj", batteryLowRecord())], telemetryRepo, dlq);

    await runWorker(worker);

    expect(telemetryRepo.insertedRecords).toHaveLength(1);
    expect(source.ackedIds).toEqual(["msg-obj"]);
  });

  it("handles a body that is a JSON string", async () => {
    const telemetryRepo = new FakeTelemetryRepository(ok("inserted"));
    const dlq = new FakeDeadLetterRepository();
    const { worker, source } = makeWorker(
      [makeMessage("msg-str", JSON.stringify(batteryLowRecord()))],
      telemetryRepo,
      dlq,
    );

    await runWorker(worker);

    expect(telemetryRepo.insertedRecords).toHaveLength(1);
    expect(source.ackedIds).toEqual(["msg-str"]);
  });
});

describe("Worker — multi-message batch", () => {
  it("processes each message in a batch independently", async () => {
    const transient: TransientError = { kind: "TransientError", message: "flaky" };
    let callIndex = 0;
    const responses: Result<TelemetryInsertOutcome, TransientError>[] = [
      ok("inserted"),
      err(transient),
      ok("inserted"),
    ];
    const telemetryRepo: TelemetryRepository = {
      async insert() { return responses[callIndex++]!; },
    };
    const dlq = new FakeDeadLetterRepository();
    const messages = [makeMessage("m1"), makeMessage("m2"), makeMessage("m3")];
    const { worker, source } = makeWorker(messages, telemetryRepo, dlq);

    await runWorker(worker);

    expect(source.ackedIds).toEqual(["m1", "m3"]);
    expect(dlq.enqueuedEntries).toHaveLength(0);
  });
});
