import type Redis from "ioredis";
import type { MessageSource, RawMessage } from "./source.js";
import type { Logger } from "../lib/logger.js";

/** Upper bound for `XREADGROUP BLOCK` so waits never exceed this many milliseconds. */
export const REDIS_MESSAGE_SOURCE_MAX_BLOCK_MS = 10_000;

const DEFAULT_READ_COUNT = 10;
const DEFAULT_GROUP_START_ID = "$";

export type RedisMessageSourceOptions = {
  redis: Redis;
  streamKey: string;
  groupName: string;
  consumerName: string;
  /** Requested block time; clamped to {@link REDIS_MESSAGE_SOURCE_MAX_BLOCK_MS}. */
  readBlockMs: number;
  /** `COUNT` for `XREADGROUP` / `XAUTOCLAIM` (default {@link DEFAULT_READ_COUNT}). */
  readCount?: number;
  /** Minimum time between full `XAUTOCLAIM` scan cycles. */
  claimIntervalMs: number;
  /** `XAUTOCLAIM` minimum idle time for stale pending entries. */
  claimMinIdleMs: number;
  /**
   * First-id argument for `XGROUP CREATE` when the group is created (default only-new
   * messages: `'$'`). Use `'0'` to read the full backlog from the start of the stream.
   */
  startId?: string;
  /** Optional logger. When omitted all instrumentation is silently skipped. */
  logger?: Logger;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  return Promise.race([promise, abortPromise(signal)]);
}

function isBusyGroupError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("BUSYGROUP");
}

function clampBlockMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    return 0;
  }
  return Math.min(ms, REDIS_MESSAGE_SOURCE_MAX_BLOCK_MS);
}

function flattenPairsToObject(fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k !== undefined && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function streamFieldsToBody(obj: Record<string, string>): unknown {
  const payload = obj.payload;
  if (payload !== undefined) {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      /* use full field map */
    }
  }
  return obj;
}

function entryToRawMessage(id: string, fieldValues: readonly string[]): RawMessage {
  const obj = flattenPairsToObject(fieldValues);
  return {
    id,
    receivedAt: new Date(),
    body: streamFieldsToBody(obj),
  };
}

type StreamEntryRow = readonly [id: string, fields: readonly string[]];

function parseStreamEntryRows(raw: unknown): StreamEntryRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: StreamEntryRow[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) {
      continue;
    }
    const id = item[0];
    const fields = item[1];
    if (typeof id !== "string" || !Array.isArray(fields)) {
      continue;
    }
    const stringFields: string[] = [];
    for (const f of fields) {
      if (typeof f !== "string") {
        continue;
      }
      stringFields.push(f);
    }
    if (stringFields.length === fields.length) {
      rows.push([id, stringFields]);
    }
  }
  return rows;
}

function parseXautoclaimReply(raw: unknown): [string, StreamEntryRow[]] {
  if (!Array.isArray(raw) || raw.length < 2) {
    return ["0-0", []];
  }
  const next = raw[0];
  const entriesRaw = raw[1];
  if (typeof next !== "string") {
    return ["0-0", []];
  }
  return [next, parseStreamEntryRows(entriesRaw)];
}

function parseXreadgroupReply(raw: unknown): StreamEntryRow[] {
  if (raw == null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const streamBlock = raw[0];
  if (!Array.isArray(streamBlock) || streamBlock.length < 2) {
    return [];
  }
  const entriesRaw = streamBlock[1];
  return parseStreamEntryRows(entriesRaw);
}

export class RedisMessageSource implements MessageSource {
  private readonly redis: Redis;
  private readonly streamKey: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly readBlockMs: number;
  private readonly readCount: number;
  private readonly claimIntervalMs: number;
  private readonly claimMinIdleMs: number;
  private readonly groupStartId: string;
  private readonly log: Logger | undefined;

  private groupReady = false;
  private claimCursor = "0-0";
  private lastClaimAt = 0;
  private reclaimCycleActive = false;

  constructor(options: RedisMessageSourceOptions) {
    this.redis = options.redis;
    this.streamKey = options.streamKey;
    this.groupName = options.groupName;
    this.consumerName = options.consumerName;
    this.readBlockMs = clampBlockMs(options.readBlockMs);
    this.readCount = Math.max(1, options.readCount ?? DEFAULT_READ_COUNT);
    this.claimIntervalMs = options.claimIntervalMs;
    this.claimMinIdleMs = options.claimMinIdleMs;
    this.groupStartId = options.startId ?? DEFAULT_GROUP_START_ID;
    this.log = options.logger?.child({
      component: "RedisMessageSource",
      streamKey: options.streamKey,
      groupName: options.groupName,
      consumerName: options.consumerName,
    });
  }

  private async ensureGroup(signal?: AbortSignal): Promise<void> {
    if (this.groupReady) {
      return;
    }
    throwIfAborted(signal);
    let created = true;
    try {
      await this.redis.xgroup("CREATE", this.streamKey, this.groupName, this.groupStartId, "MKSTREAM");
    } catch (err) {
      if (!isBusyGroupError(err)) {
        throw err;
      }
      created = false;
    }
    this.groupReady = true;
    if (created) {
      this.log?.info("consumer group created", { startId: this.groupStartId });
    } else {
      this.log?.debug("consumer group already exists");
    }
  }

  async read(signal?: AbortSignal): Promise<RawMessage[]> {
    throwIfAborted(signal);
    await this.ensureGroup(signal);

    const out: RawMessage[] = [];
    const now = Date.now();
    const dueClaim =
      this.reclaimCycleActive || now - this.lastClaimAt >= this.claimIntervalMs || this.lastClaimAt === 0;

    if (dueClaim) {
      if (!this.reclaimCycleActive) {
        this.log?.debug("reclaim cycle starting", { cursor: this.claimCursor, claimMinIdleMs: this.claimMinIdleMs });
      }
      this.reclaimCycleActive = true;
      let cycleClaimed = 0;
      while (out.length < this.readCount) {
        throwIfAborted(signal);
        const remaining = this.readCount - out.length;
        const count = Math.min(this.readCount, remaining);
        const reply = await raceAbort(
          this.redis.xautoclaim(
            this.streamKey,
            this.groupName,
            this.consumerName,
            this.claimMinIdleMs,
            this.claimCursor,
            "COUNT",
            count,
          ),
          signal,
        );
        const [nextCursor, rows] = parseXautoclaimReply(reply);
        this.claimCursor = nextCursor;
        for (const [id, fields] of rows) {
          out.push(entryToRawMessage(id, fields));
          cycleClaimed++;
          if (out.length >= this.readCount) {
            break;
          }
        }
        if (nextCursor === "0-0") {
          this.lastClaimAt = Date.now();
          this.reclaimCycleActive = false;
          this.claimCursor = "0-0";
          this.log?.debug("reclaim cycle complete", { claimed: cycleClaimed });
          break;
        }
        if (rows.length === 0) {
          /* cursor advanced with no claims; continue scan */
          continue;
        }
        if (out.length >= this.readCount) {
          break;
        }
      }
    }

    if (out.length < this.readCount) {
      throwIfAborted(signal);
      const blockMs = out.length > 0 ? 0 : this.readBlockMs;
      const count = this.readCount - out.length;
      const reply = await raceAbort(
        this.redis.xreadgroup(
          "GROUP",
          this.groupName,
          this.consumerName,
          "COUNT",
          count,
          "BLOCK",
          blockMs,
          "STREAMS",
          this.streamKey,
          ">",
        ),
        signal,
      );
      for (const [id, fields] of parseXreadgroupReply(reply)) {
        out.push(entryToRawMessage(id, fields));
        if (out.length >= this.readCount) {
          break;
        }
      }
    }

    return out;
  }

  async ack(messageIds: readonly string[]): Promise<number> {
    if (messageIds.length === 0) {
      return 0;
    }
    return this.redis.xack(this.streamKey, this.groupName, ...messageIds);
  }
}

/**
 * Yields messages from a {@link MessageSource} until {@link AbortSignal} aborts (then
 * {@link MessageSource.read} rejects) or the caller stops the iterator.
 */
export async function* iterateMessages(
  source: MessageSource,
  signal?: AbortSignal,
): AsyncGenerator<RawMessage, void, undefined> {
  for (;;) {
    const batch = await source.read(signal);
    for (const m of batch) {
      yield m;
    }
  }
}
