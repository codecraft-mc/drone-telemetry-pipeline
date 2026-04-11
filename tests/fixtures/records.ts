import {
  MAX_CLOCK_SKEW_MS,
  MIN_TIMESTAMP,
} from "../../src/domain/schema.js";

export { MAX_CLOCK_SKEW_MS, MIN_TIMESTAMP };

/** Default valid `droneId` matching `^drone-[a-z0-9]+$`. */
export const DEFAULT_DRONE_ID = "drone-abc123";

/** ISO-8601 timestamp near `Date.now()` for stable clock-skew tests. */
export function isoNearNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function batteryLowRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    droneId: DEFAULT_DRONE_ID,
    timestamp: isoNearNow(),
    statusCode: 0,
    eventType: "BATTERY_LOW",
    telemetryData: { batteryLevel: 80 },
    ...overrides,
  };
}

export function routeAdjustedRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    droneId: DEFAULT_DRONE_ID,
    timestamp: isoNearNow(),
    statusCode: 0,
    eventType: "ROUTE_ADJUSTED",
    telemetryData: { lat: 48.8566, lng: 2.3522 },
    ...overrides,
  };
}

export function deliveryCompletedRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    droneId: DEFAULT_DRONE_ID,
    timestamp: isoNearNow(),
    statusCode: 0,
    eventType: "DELIVERY_COMPLETED",
    telemetryData: {
      deliveryId: "del-001",
      location: { lat: 51.5074, lng: -0.1278 },
    },
    ...overrides,
  };
}

export function sensorReadingRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    droneId: DEFAULT_DRONE_ID,
    timestamp: isoNearNow(),
    statusCode: 0,
    eventType: "SENSOR_READING",
    telemetryData: { temperature: 22.5, humidity: 60 },
    ...overrides,
  };
}

export function errorRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    droneId: DEFAULT_DRONE_ID,
    timestamp: isoNearNow(),
    statusCode: 500,
    eventType: "ERROR",
    telemetryData: { errorCode: "E001", message: "failure" },
    ...overrides,
  };
}

export function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = obj;
  return rest;
}

export function withTimestamp(iso: string): Record<string, string> {
  return { timestamp: iso };
}
