// Re-exports of inferred TypeScript types for consumer convenience.
// The Zod schemas in schema.ts remain the single source of truth.

export type { EventType, TelemetryRecord } from "./schema.js";

// Per-variant record types — useful for exhaustive switch branches and tests.
import type { z } from "zod";
import type {
  BatteryLowRecordSchema,
  RouteAdjustedRecordSchema,
  DeliveryCompletedRecordSchema,
  SensorReadingRecordSchema,
  ErrorRecordSchema,
} from "./schema.js";

export type BatteryLowRecord = z.infer<typeof BatteryLowRecordSchema>;
export type RouteAdjustedRecord = z.infer<typeof RouteAdjustedRecordSchema>;
export type DeliveryCompletedRecord = z.infer<typeof DeliveryCompletedRecordSchema>;
export type SensorReadingRecord = z.infer<typeof SensorReadingRecordSchema>;
export type ErrorRecord = z.infer<typeof ErrorRecordSchema>;
