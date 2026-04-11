import { describe, expect, it } from "vitest";
import type { TelemetryRecord } from "../../src/domain/schema.js";
import {
  batteryLowRecord,
  deliveryCompletedRecord,
  isoNearNow,
  sensorReadingRecord,
} from "../fixtures/records.js";
import { validate } from "../../src/processing/validator.js";
import { toRow } from "../../src/processing/transformer.js";

describe("toRow", () => {
  it("maps core fields and message_id on happy path", () => {
    const parsed = validate(batteryLowRecord());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid record");
    const messageId = "msg-123";
    const row = toRow(parsed.value, messageId);

    expect(row.drone_id).toBe(parsed.value.droneId);
    expect(row.event_type).toBe("BATTERY_LOW");
    expect(row.status_code).toBe(parsed.value.statusCode);
    expect(row.message_id).toBe(messageId);
    expect(row.event_time).toBeInstanceOf(Date);
    expect(row.event_time.getTime()).toBe(parsed.value.timestamp.getTime());
  });

  it("snake_cases telemetry keys including camelCase segments", () => {
    const parsed = validate(
      sensorReadingRecord({
        telemetryData: { batteryLevel: 42, nestedCamelKey: 1 },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid record");

    const row = toRow(parsed.value, "mid");
    expect(row.payload).toEqual({
      battery_level: 42,
      nested_camel_key: 1,
    });
  });

  it("snake_cases nested DELIVERY_COMPLETED telemetry keys", () => {
    const parsed = validate(deliveryCompletedRecord());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid record");

    const row = toRow(parsed.value, "mid-2");
    expect(row.payload).toEqual({
      delivery_id: "del-001",
      location: { lat: 51.5074, lng: -0.1278 },
    });
  });

  it("coerces timestamp from ISO string via non-Date branch", () => {
    const iso = isoNearNow(0);
    const parsed = validate(batteryLowRecord());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid record");

    const recordWithStringTimestamp = {
      ...parsed.value,
      timestamp: iso,
    } as unknown as TelemetryRecord;

    const row = toRow(recordWithStringTimestamp, "coerce-test");
    expect(row.event_time.toISOString()).toBe(iso);
  });
});
