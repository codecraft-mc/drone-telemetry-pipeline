import process from "node:process";
import { hostname } from "node:os";
import { Pool } from "pg";
import Redis from "ioredis";
import pino from "pino";
import { parseEnv } from "./config.js";
import { RedisMessageSource } from "./ingestion/redis-source.js";
import { PostgresTelemetryRepository } from "./storage/postgres.repository.js";
import { PostgresDeadLetterRepository } from "./storage/postgres-dead-letter.repository.js";
import { Worker } from "./worker/worker.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const env = parseEnv();

const log = pino({
  level: env.LOG_LEVEL,
  base: { pid: process.pid, host: hostname() },
});

log.info({ nodeEnv: env.NODE_ENV }, "starting drone-telemetry-pipeline");

// ---------------------------------------------------------------------------
// Infrastructure clients
// ---------------------------------------------------------------------------

const pgPool = new Pool({ connectionString: env.DATABASE_URL });

// Surface pool-level errors so they don't become unhandled rejections.
pgPool.on("error", (err) => {
  log.error({ err }, "idle postgres client error");
});

const redis = new Redis(env.REDIS_URL, {
  // Fail fast on first connect rather than blocking the process indefinitely.
  enableOfflineQueue: false,
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

redis.on("error", (err: unknown) => {
  log.warn({ err }, "redis connection error");
});

// ---------------------------------------------------------------------------
// Domain services
// ---------------------------------------------------------------------------

const STREAM_KEY = "drone:telemetry";
const GROUP_NAME = "telemetry-pipeline";
// Each pod gets its own consumer name so the PEL is per-instance.
const CONSUMER_NAME = `worker-${hostname()}-${process.pid}`;

const source = new RedisMessageSource({
  redis,
  streamKey: STREAM_KEY,
  groupName: GROUP_NAME,
  consumerName: CONSUMER_NAME,
  readBlockMs: 5_000,
  readCount: 20,
  claimIntervalMs: 30_000,
  claimMinIdleMs: 60_000,
  startId: "$",
});

const telemetryRepo = new PostgresTelemetryRepository(pgPool);
const deadLetterRepo = new PostgresDeadLetterRepository(pgPool);

const worker = new Worker({
  source,
  telemetryRepo,
  deadLetterRepo,
  logger: {
    debug: (msg, fields) => log.debug(fields ?? {}, msg),
    info:  (msg, fields) => log.info(fields ?? {}, msg),
    warn:  (msg, fields) => log.warn(fields ?? {}, msg),
    error: (msg, fields) => log.error(fields ?? {}, msg),
    child: (bindings) => ({
      debug: (msg, fields) => log.child(bindings).debug(fields ?? {}, msg),
      info:  (msg, fields) => log.child(bindings).info(fields ?? {}, msg),
      warn:  (msg, fields) => log.child(bindings).warn(fields ?? {}, msg),
      error: (msg, fields) => log.child(bindings).error(fields ?? {}, msg),
      child: (b) => log.child({ ...bindings, ...b }) as never,
    }),
  },
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

const abortController = new AbortController();
let shuttingDown = false;

/**
 * Orderly shutdown sequence:
 *   1. Signal the worker loop to stop accepting new batches (AbortController).
 *   2. Wait for the current in-flight batch to finish processing + ack.
 *   3. Close infrastructure connections.
 *   4. Exit 0.
 *
 * A second SIGTERM (or SIGINT) escalates to an immediate exit so that the
 * container runtime is never stuck waiting on a hung shutdown.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn({ signal }, "second termination signal received — forcing exit");
    process.exit(1);
  }

  shuttingDown = true;
  log.info({ signal }, "shutdown initiated — draining in-flight messages");

  // Stop the read loop; the current batch runs to completion before the
  // AbortError surfaces from worker.run().
  abortController.abort();

  // Give the drain a generous but bounded window before we force-close.
  const DRAIN_TIMEOUT_MS = 30_000;
  const drainTimeout = setTimeout(() => {
    log.error("drain timeout exceeded — forcing exit");
    process.exit(1);
  }, DRAIN_TIMEOUT_MS).unref();

  try {
    await workerDone;
  } catch (err: unknown) {
    // AbortError is the expected clean exit path — anything else is notable.
    const isAbortError =
      err instanceof Error && err.name === "AbortError";
    if (!isAbortError) {
      log.error({ err }, "worker exited with unexpected error during shutdown");
    }
  }

  clearTimeout(drainTimeout);

  log.info("worker drained — closing connections");

  await Promise.allSettled([
    redis.quit().catch((e: unknown) => log.warn({ err: e }, "redis quit error")),
    pgPool.end().catch((e: unknown) => log.warn({ err: e }, "pg pool end error")),
  ]);

  log.info("shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT",  () => void shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Connect eagerly so startup errors surface immediately.
try {
  await redis.connect();
  log.info("redis connected");

  const pgClient = await pgPool.connect();
  pgClient.release();
  log.info("postgres connected");
} catch (err) {
  log.fatal({ err }, "failed to connect to infrastructure — aborting");
  process.exit(1);
}

// workerDone is referenced by shutdown(); must be assigned before any signal
// could fire (signals are delivered asynchronously so this is safe).
const workerDone: Promise<void> = worker.run(abortController.signal);

log.info({ streamKey: STREAM_KEY, group: GROUP_NAME, consumer: CONSUMER_NAME }, "worker running");

// Await the worker so the process stays alive.  Under normal operation this
// never resolves — it only returns after abort.
try {
  await workerDone;
} catch (err: unknown) {
  const isAbortError = err instanceof Error && err.name === "AbortError";
  if (!isAbortError) {
    log.fatal({ err }, "worker crashed — initiating emergency shutdown");
    await shutdown("crash");
  }
  // AbortError here means shutdown() already handled things — nothing to do.
}
