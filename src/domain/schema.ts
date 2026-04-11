import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants — exported so tests and validator can import them directly
// ---------------------------------------------------------------------------

export const DRONE_ID_REGEX = /^drone-[a-z0-9]+$/;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000; // 5 minutes into the future
export const MIN_TIMESTAMP = new Date("2020-01-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Event type enum
// ---------------------------------------------------------------------------

export const EventTypeSchema = z.enum([
  "DELIVERY_COMPLETED",
  "BATTERY_LOW",
  "ROUTE_ADJUSTED",
  "SENSOR_READING",
  "ERROR",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

// ---------------------------------------------------------------------------
// Common fields shared by every record variant
// ---------------------------------------------------------------------------

const BaseRecordFields = {
  droneId: z
    .string()
    .min(1)
    .regex(DRONE_ID_REGEX, "droneId must match ^drone-[a-z0-9]+$"),

  // Accept an ISO-8601 string and coerce it to a Date. Reject if the string
  // does not parse, is in the far future (clock skew), or predates 2020.
  timestamp: z
    .string()
    .transform((val, ctx) => {
      const date = new Date(val);
      if (isNaN(date.getTime())) {
        ctx.addIssue({
          code: "custom",
          message: "timestamp is not a valid ISO-8601 date string",
        });
        return z.NEVER;
      }
      const now = Date.now();
      if (date.getTime() > now + MAX_CLOCK_SKEW_MS) {
        ctx.addIssue({
          code: "custom",
          message: `timestamp is more than ${MAX_CLOCK_SKEW_MS / 1_000}s in the future`,
        });
        return z.NEVER;
      }
      if (date < MIN_TIMESTAMP) {
        ctx.addIssue({
          code: "custom",
          message: `timestamp is before the minimum allowed date (${MIN_TIMESTAMP.toISOString()})`,
        });
        return z.NEVER;
      }
      return date;
    }),

  // General status code — kept as an integer range rather than an exhaustive
  // enum to avoid over-constraining schema evolution.
  statusCode: z.number().int().min(0).max(999),
};

// ---------------------------------------------------------------------------
// Record variants — one per event type.
// Each variant spreads the common fields, adds a top-level eventType literal
// (the discriminator), and defines its own telemetryData shape.
// Unknown fields are rejected at every level (.strict()) so upstream schema
// drift surfaces as a hard failure rather than a silent strip.
// ---------------------------------------------------------------------------

export const BatteryLowRecordSchema = z.object({
  ...BaseRecordFields,
  eventType: z.literal("BATTERY_LOW"),
  telemetryData: z.object({
    batteryLevel: z.number().min(0).max(100),
  }).strict(),
}).strict();

export const RouteAdjustedRecordSchema = z.object({
  ...BaseRecordFields,
  eventType: z.literal("ROUTE_ADJUSTED"),
  telemetryData: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }).strict(),
}).strict();

export const DeliveryCompletedRecordSchema = z.object({
  ...BaseRecordFields,
  eventType: z.literal("DELIVERY_COMPLETED"),
  telemetryData: z.object({
    deliveryId: z.string().min(1),
    location: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }).strict(),
  }).strict(),
}).strict();

// Flexible map of named numeric readings — keys are sensor names, values are
// numbers. Additional fields may appear as sensor types evolve.
export const SensorReadingRecordSchema = z.object({
  ...BaseRecordFields,
  eventType: z.literal("SENSOR_READING"),
  telemetryData: z.record(z.string(), z.number()),
}).strict();

export const ErrorRecordSchema = z.object({
  ...BaseRecordFields,
  eventType: z.literal("ERROR"),
  telemetryData: z.object({
    errorCode: z.string().min(1),
    message: z.string(),
  }).strict(),
}).strict();

// ---------------------------------------------------------------------------
// Root schema — discriminated union on the top-level eventType field
// ---------------------------------------------------------------------------

export const TelemetryRecordSchema = z.discriminatedUnion("eventType", [
  BatteryLowRecordSchema,
  RouteAdjustedRecordSchema,
  DeliveryCompletedRecordSchema,
  SensorReadingRecordSchema,
  ErrorRecordSchema,
]);

export type TelemetryRecord = z.infer<typeof TelemetryRecordSchema>;
