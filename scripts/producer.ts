/**
 * scripts/producer.ts
 *
 * Demo event producer for the drone-telemetry-pipeline.
 *
 * Publishes a configurable mix of valid and intentionally broken telemetry
 * records to the Redis stream that the worker consumes.
 *
 * Usage:
 *   tsx scripts/producer.ts [options]
 *
 * Options:
 *   --rate       Messages per second to publish (default: 10)
 *   --duration   How long to run in seconds; 0 = run until Ctrl-C (default: 30)
 *   --corruption Fraction of messages to corrupt, 0–1 (default: 0.2)
 *   --drones     Number of distinct drone IDs to simulate (default: 5)
 *   --stream     Redis stream key (default: drone:telemetry)
 *   --redis      Redis URL (default: $REDIS_URL or redis://localhost:6379)
 */

import "dotenv/config";
import process from "node:process";
import { parseArgs } from "node:util";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    rate:        { type: "string", default: "10" },
    duration:    { type: "string", default: "30" },
    corruption:  { type: "string", default: "0.2" },
    drones:      { type: "string", default: "5" },
    stream:      { type: "string", default: "drone:telemetry" },
    redis:       { type: "string", default: process.env.REDIS_URL ?? "redis://localhost:6379" },
    maxlen:      { type: "string", default: "100000" },
  },
  strict: true,
});

const RATE         = Math.max(1, Number(args.rate));
const DURATION_S   = Math.max(0, Number(args.duration));
const CORRUPTION   = Math.min(1, Math.max(0, Number(args.corruption)));
const DRONE_COUNT  = Math.max(1, Number(args.drones));
const STREAM_KEY   = args.stream as string;
const REDIS_URL    = args.redis as string;
const STREAM_MAXLEN = Math.max(1_000, Number(args.maxlen));

const INTERVAL_MS = 1_000 / RATE;

// ---------------------------------------------------------------------------
// Drone fleet
// ---------------------------------------------------------------------------

const DRONE_IDS: string[] = Array.from(
  { length: DRONE_COUNT },
  (_, i) => `drone-${String(i + 1).padStart(3, "0")}`,
);

function pickDrone(): string {
  return DRONE_IDS[Math.floor(Math.random() * DRONE_IDS.length)]!;
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function rng(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function rngInt(min: number, max: number): number {
  return Math.floor(rng(min, max + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function iso(date = new Date()): string {
  return date.toISOString();
}

function nowIso(): string {
  return iso(new Date());
}

// ---------------------------------------------------------------------------
// Valid record builders
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function validBatteryLow(droneId = pickDrone()): AnyRecord {
  return {
    droneId,
    timestamp: nowIso(),
    statusCode: rngInt(200, 299),
    eventType: "BATTERY_LOW",
    telemetryData: { batteryLevel: rng(5, 20) },
  };
}

function validRouteAdjusted(droneId = pickDrone()): AnyRecord {
  return {
    droneId,
    timestamp: nowIso(),
    statusCode: rngInt(200, 299),
    eventType: "ROUTE_ADJUSTED",
    telemetryData: { lat: rng(-90, 90), lng: rng(-180, 180) },
  };
}

function validDeliveryCompleted(droneId = pickDrone()): AnyRecord {
  return {
    droneId,
    timestamp: nowIso(),
    statusCode: rngInt(200, 299),
    eventType: "DELIVERY_COMPLETED",
    telemetryData: {
      deliveryId: `dlv-${Math.random().toString(36).slice(2, 10)}`,
      location: { lat: rng(-90, 90), lng: rng(-180, 180) },
    },
  };
}

function validSensorReading(droneId = pickDrone()): AnyRecord {
  return {
    droneId,
    timestamp: nowIso(),
    statusCode: rngInt(200, 299),
    eventType: "SENSOR_READING",
    telemetryData: {
      temperature: rng(-20, 60),
      pressure:    rng(900, 1100),
      humidity:    rng(0, 100),
      altitude:    rng(0, 500),
    },
  };
}

function validError(droneId = pickDrone()): AnyRecord {
  const codes = ["E_GPS_LOST", "E_MOTOR_FAULT", "E_COMMS_TIMEOUT", "E_OBSTACLE", "E_WIND_LIMIT"];
  return {
    droneId,
    timestamp: nowIso(),
    statusCode: rngInt(400, 599),
    eventType: "ERROR",
    telemetryData: {
      errorCode: pick(codes),
      message:   `Fault detected at ${nowIso()}`,
    },
  };
}

const VALID_BUILDERS = [
  validBatteryLow,
  validRouteAdjusted,
  validDeliveryCompleted,
  validSensorReading,
  validError,
];

function buildValid(): AnyRecord {
  return pick(VALID_BUILDERS)();
}

// ---------------------------------------------------------------------------
// Corruption variants — each one breaks a specific validation rule
// ---------------------------------------------------------------------------

type CorruptVariant = {
  label: string;
  build: () => AnyRecord | string | null;
};

const CORRUPT_VARIANTS: CorruptVariant[] = [
  {
    label: "bad-drone-id",
    // droneId must match /^drone-[a-z0-9]+$/ — uppercase + underscore breaks it
    build: () => ({ ...validBatteryLow("DRONE_001"), droneId: "DRONE_001" }),
  },
  {
    label: "future-timestamp",
    // MAX_CLOCK_SKEW_MS = 5 minutes; send 10 minutes ahead
    build: () => ({
      ...buildValid(),
      timestamp: iso(new Date(Date.now() + 10 * 60 * 1_000)),
    }),
  },
  {
    label: "ancient-timestamp",
    // MIN_TIMESTAMP = 2020-01-01; send a date from 2019
    build: () => ({
      ...buildValid(),
      timestamp: "2019-06-15T08:30:00.000Z",
    }),
  },
  {
    label: "status-out-of-range",
    // statusCode must be 0–999
    build: () => ({ ...buildValid(), statusCode: rngInt(1000, 9999) }),
  },
  {
    label: "unknown-event-type",
    // not in the discriminated union
    build: () => ({
      droneId:       pickDrone(),
      timestamp:     nowIso(),
      statusCode:    200,
      eventType:     "FIRMWARE_UPDATE",
      telemetryData: { version: "2.4.1" },
    }),
  },
  {
    label: "missing-required-field",
    // omit droneId entirely
    build: () => {
      const { droneId: _omit, ...rest } = validSensorReading() as { droneId: unknown } & AnyRecord;
      return rest;
    },
  },
  {
    label: "battery-level-out-of-range",
    // batteryLevel must be 0–100; send 150
    build: () => ({
      ...validBatteryLow(),
      telemetryData: { batteryLevel: rng(101, 200) },
    }),
  },
  {
    label: "extra-unknown-field",
    // strict() mode rejects unknown top-level keys
    build: () => ({
      ...buildValid(),
      _internal: "should-not-be-here",
      firmwareVersion: "3.1.4",
    }),
  },
  {
    label: "wrong-telemetry-shape",
    // ROUTE_ADJUSTED expects { lat, lng } — send strings instead
    build: () => ({
      ...validRouteAdjusted(),
      telemetryData: { lat: "51.5074N", lng: "0.1278W" },
    }),
  },
  {
    label: "not-json",
    // raw non-JSON string — streamFieldsToBody will pass it through as a string,
    // which will fail every downstream schema check
    build: () => "this is not json at all ¯\\_(ツ)_/¯",
  },
  {
    label: "null-payload",
    build: () => null,
  },
  {
    label: "empty-object",
    build: () => ({}),
  },
  {
    label: "wrong-status-code-type",
    // statusCode should be a number, not a string
    build: () => ({ ...buildValid(), statusCode: "two-hundred" }),
  },
  {
    label: "delivery-missing-location",
    // DeliveryCompleted requires telemetryData.location
    build: () => ({
      ...validDeliveryCompleted(),
      telemetryData: { deliveryId: "dlv-abc123" /* no location */ },
    }),
  },
];

function buildCorrupt(): { payload: AnyRecord | string | null; label: string } {
  const variant = pick(CORRUPT_VARIANTS);
  return { payload: variant.build(), label: variant.label };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

type Stats = {
  published: number;
  valid: number;
  corrupt: number;
  errors: number;
  byVariant: Map<string, number>;
};

function makeStats(): Stats {
  return { published: 0, valid: 0, corrupt: 0, errors: 0, byVariant: new Map() };
}

function printStats(stats: Stats, elapsed: number): void {
  const rate = elapsed > 0 ? (stats.published / elapsed).toFixed(1) : "0.0";
  const corruptPct = stats.published > 0
    ? ((stats.corrupt / stats.published) * 100).toFixed(1)
    : "0.0";

  process.stdout.write(
    `\r[${elapsed.toFixed(0).padStart(4)}s] ` +
    `published=${stats.published} ` +
    `valid=${stats.valid} ` +
    `corrupt=${stats.corrupt} (${corruptPct}%) ` +
    `errors=${stats.errors} ` +
    `rate=${rate}/s   `,
  );
}

function printVariantBreakdown(stats: Stats): void {
  console.log("\n\nCorruption variant breakdown:");
  const sorted = [...stats.byVariant.entries()].sort((a, b) => b[1] - a[1]);
  for (const [label, count] of sorted) {
    console.log(`  ${label.padEnd(30)} ${count}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Drone Telemetry Producer`);
  console.log(`  Redis:      ${REDIS_URL}`);
  console.log(`  Stream:     ${STREAM_KEY}`);
  console.log(`  Rate:       ${RATE} msg/s`);
  console.log(`  Duration:   ${DURATION_S === 0 ? "∞ (until Ctrl-C)" : `${DURATION_S}s`}`);
  console.log(`  Corruption: ${(CORRUPTION * 100).toFixed(0)}%`);
  console.log(`  Drones:     ${DRONE_COUNT} (${DRONE_IDS.slice(0, 3).join(", ")}${DRONE_COUNT > 3 ? ", …" : ""})`);
  console.log(`  Max len:    ~${STREAM_MAXLEN.toLocaleString()} entries`);
  console.log("");

  const redis = new Redis(REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  redis.on("error", (err: unknown) => {
    process.stderr.write(`\nRedis error: ${String(err)}\n`);
  });

  await redis.connect();
  console.log("Connected to Redis.\n");

  const stats = makeStats();
  const startedAt = Date.now();

  async function publishOne(): Promise<void> {
    const isCorrupt = Math.random() < CORRUPTION;

    let payload: unknown;
    let variantLabel: string | undefined;

    if (isCorrupt) {
      const { payload: p, label } = buildCorrupt();
      payload = p;
      variantLabel = label;
    } else {
      payload = buildValid();
    }

    const serialised =
      typeof payload === "string"
        ? payload
        : payload === null
        ? "null"
        : JSON.stringify(payload);

    try {
      // MAXLEN ~ N keeps the stream bounded. ioredis passes args verbatim to Redis so the full
      // XADD key MAXLEN ~ N * field value syntax works even though the TypeScript overload
      // doesn't expose it.
      // @ts-expect-error — ioredis types don't expose the MAXLEN overload; Redis accepts this form
      await redis.xadd(STREAM_KEY, "MAXLEN", "~", String(STREAM_MAXLEN), "*", "payload", serialised);
      stats.published++;
      if (isCorrupt) {
        stats.corrupt++;
        if (variantLabel) {
          stats.byVariant.set(variantLabel, (stats.byVariant.get(variantLabel) ?? 0) + 1);
        }
      } else {
        stats.valid++;
      }
    } catch (err) {
      stats.errors++;
      process.stderr.write(`\nXADD error: ${String(err)}\n`);
    }
  }

  // Controlled interval: schedule next tick only after the current one
  // completes to avoid runaway queuing under back-pressure.
  let running = true;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let statsIntervalId: ReturnType<typeof setInterval> | undefined;

  async function tick(): Promise<void> {
    if (!running) return;
    await publishOne();
  }

  intervalId = setInterval(() => void tick(), INTERVAL_MS);

  // Print stats every second regardless of rate
  statsIntervalId = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1_000;
    printStats(stats, elapsed);
  }, 1_000);

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;
    clearInterval(intervalId);
    clearInterval(statsIntervalId);

    const elapsed = (Date.now() - startedAt) / 1_000;
    printStats(stats, elapsed);
    printVariantBreakdown(stats);
    console.log("\nDone. Closing Redis connection…");
    await redis.quit();
  }

  process.once("SIGINT",  () => void stop());
  process.once("SIGTERM", () => void stop());

  if (DURATION_S > 0) {
    setTimeout(() => void stop(), DURATION_S * 1_000);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
