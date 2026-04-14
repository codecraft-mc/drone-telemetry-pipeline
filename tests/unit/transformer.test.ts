import { describe, expect, it } from "vitest";
import type { TelemetryRecord } from "../../src/domain/schema.js";
import {
  batteryLowRecord,
  deliveryCompletedRecord,
  errorRecord,
  isoNearNow,
  routeAdjustedRecord,
  sensorReadingRecord,
} from "../fixtures/records.js";
import { validate } from "../../src/processing/validator.js";
import { toRow } from "../../src/processing/transformer.js";

/** Parse a fixture through validate() so toRow receives a real TelemetryRecord. */
function validated(raw: Record<string, unknown>): TelemetryRecord {
  const result = validate(raw);
  expect(result.ok, `validation failed: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error("expected valid record");
  return result.value;
}

describe("toRow — field mapping", () => {
  it("maps core fields and message_id on happy path", () => {
    const record = validated(batteryLowRecord());
    const messageId = "msg-123";
    const row = toRow(record, messageId);

    expect(row.drone_id).toBe(record.droneId);
    expect(row.event_type).toBe("BATTERY_LOW");
    expect(row.status_code).toBe(record.statusCode);
    expect(row.message_id).toBe(messageId);
    expect(row.event_time).toBeInstanceOf(Date);
    expect(row.event_time.getTime()).toBe(record.timestamp.getTime());
  });

  it("coerces timestamp from ISO string via non-Date branch", () => {
    const iso = isoNearNow(0);
    const record = validated(batteryLowRecord());
    const recordWithStringTimestamp = {
      ...record,
      timestamp: iso,
    } as unknown as TelemetryRecord;

    const row = toRow(recordWithStringTimestamp, "coerce-test");
    expect(row.event_time.toISOString()).toBe(iso);
  });
});

describe("toRow — telemetryData camelCase → snake_case", () => {
  it("converts batteryLevel → battery_level", () => {
    const row = toRow(validated(batteryLowRecord()), "msg-1");
    expect(row.payload).toEqual({ battery_level: 80 });
  });

  it("converts multiple camelCase keys in SENSOR_READING", () => {
    const row = toRow(
      validated(sensorReadingRecord({ telemetryData: { batteryLevel: 42, nestedCamelKey: 1 } })),
      "mid",
    );
    expect(row.payload).toEqual({ battery_level: 42, nested_camel_key: 1 });
  });

  it("preserves lowercase keys unchanged (lat/lng in ROUTE_ADJUSTED)", () => {
    const row = toRow(validated(routeAdjustedRecord()), "mid");
    expect(row.payload).toEqual({ lat: 48.8566, lng: 2.3522 });
  });

  it("snake_cases top-level DELIVERY_COMPLETED keys; preserves nested location object verbatim", () => {
    const row = toRow(validated(deliveryCompletedRecord()), "mid-2");
    expect(row.payload).toEqual({
      delivery_id: "del-001",
      location: { lat: 51.5074, lng: -0.1278 },
    });
  });

  it("converts errorCode → error_code in ERROR variant", () => {
    const row = toRow(validated(errorRecord()), "mid-3");
    expect(row.payload).toMatchObject({ error_code: "E001", message: "failure" });
  });
});

describe("toRow — event_type per variant", () => {
  it.each([
    ["BATTERY_LOW",        batteryLowRecord()],
    ["ROUTE_ADJUSTED",     routeAdjustedRecord()],
    ["DELIVERY_COMPLETED", deliveryCompletedRecord()],
    ["SENSOR_READING",     sensorReadingRecord()],
    ["ERROR",              errorRecord()],
  ] as const)("%s sets event_type correctly", (expectedType, raw) => {
    const row = toRow(validated(raw), "msg");
    expect(row.event_type).toBe(expectedType);
  });
});
