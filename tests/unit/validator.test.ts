import { describe, expect, it } from "vitest";
import type { ValidationError } from "../../src/domain/errors.js";
import {
  MAX_CLOCK_SKEW_MS,
  MIN_TIMESTAMP,
  batteryLowRecord,
  deliveryCompletedRecord,
  isoNearNow,
  omitKey,
  routeAdjustedRecord,
  withTimestamp,
} from "../fixtures/records.js";
import { validate } from "../../src/processing/validator.js";

function assertValidationFailure(
  result: ReturnType<typeof validate>,
): asserts result is { ok: false; error: ValidationError } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected validation failure");
  expect(result.error.kind).toBe("ValidationError");
  expect(result.error.message.length).toBeGreaterThan(0);
  expect(Array.isArray(result.error.issues)).toBe(true);
  expect(result.error.issues.length).toBeGreaterThan(0);
}

describe("validate", () => {
  describe("valid records", () => {
    it("accepts default BATTERY_LOW from factory", () => {
      const result = validate(batteryLowRecord());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.eventType).toBe("BATTERY_LOW");
      expect(result.value.timestamp instanceof Date).toBe(true);
    });

    it("accepts DELIVERY_COMPLETED variant", () => {
      const result = validate(deliveryCompletedRecord());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.eventType).toBe("DELIVERY_COMPLETED");
      expect(result.value.timestamp instanceof Date).toBe(true);
    });
  });

  describe("missing required fields", () => {
    it("rejects when droneId is missing", () => {
      assertValidationFailure(validate(omitKey(batteryLowRecord(), "droneId")));
    });

    it("rejects when timestamp is missing", () => {
      assertValidationFailure(validate(omitKey(batteryLowRecord(), "timestamp")));
    });

    it("rejects when statusCode is missing", () => {
      assertValidationFailure(validate(omitKey(batteryLowRecord(), "statusCode")));
    });

    it("rejects when eventType is missing", () => {
      assertValidationFailure(validate(omitKey(batteryLowRecord(), "eventType")));
    });

    it("rejects when telemetryData is missing", () => {
      assertValidationFailure(validate(omitKey(batteryLowRecord(), "telemetryData")));
    });
  });

  describe("wrong top-level types", () => {
    it("rejects when droneId is a number", () => {
      assertValidationFailure(validate(batteryLowRecord({ droneId: 123 as unknown })));
    });

    it("rejects when timestamp is a number", () => {
      assertValidationFailure(validate(batteryLowRecord({ timestamp: 1_700_000_000_000 as unknown })));
    });

    it("rejects when statusCode is a string", () => {
      assertValidationFailure(validate(batteryLowRecord({ statusCode: "200" as unknown })));
    });

    it("rejects when eventType is not a string", () => {
      assertValidationFailure(validate(batteryLowRecord({ eventType: 99 as unknown })));
    });

    it("rejects when telemetryData is a string", () => {
      assertValidationFailure(
        validate(batteryLowRecord({ telemetryData: "not-an-object" as unknown })),
      );
    });
  });

  describe("batteryLevel range", () => {
    it("rejects -1 and 101 for BATTERY_LOW", () => {
      assertValidationFailure(
        validate(batteryLowRecord({ telemetryData: { batteryLevel: -1 } })),
      );
      assertValidationFailure(
        validate(batteryLowRecord({ telemetryData: { batteryLevel: 101 } })),
      );
    });
  });

  describe("ROUTE_ADJUSTED coordinates", () => {
    it("rejects lat > 90 and lng > 180", () => {
      assertValidationFailure(
        validate(routeAdjustedRecord({ telemetryData: { lat: 91, lng: 0 } })),
      );
      assertValidationFailure(
        validate(routeAdjustedRecord({ telemetryData: { lat: 0, lng: 181 } })),
      );
    });
  });

  describe("timestamp bounds", () => {
    it("rejects timestamps beyond now + MAX_CLOCK_SKEW_MS", () => {
      const tooFarFuture = isoNearNow(MAX_CLOCK_SKEW_MS + 10_000);
      assertValidationFailure(validate(batteryLowRecord(withTimestamp(tooFarFuture))));
    });

    it("rejects timestamps before MIN_TIMESTAMP", () => {
      const tooOld = new Date(MIN_TIMESTAMP.getTime() - 1).toISOString();
      assertValidationFailure(validate(batteryLowRecord(withTimestamp(tooOld))));
    });
  });

  describe("unknown eventType", () => {
    it("rejects unknown eventType string", () => {
      assertValidationFailure(
        validate(
          batteryLowRecord({
            eventType: "TAKEOFF",
            telemetryData: { foo: "bar" },
          }),
        ),
      );
    });
  });

  describe("telemetryData null", () => {
    it("rejects null telemetryData", () => {
      assertValidationFailure(validate(batteryLowRecord({ telemetryData: null })));
    });
  });

  describe("union / shape mismatch", () => {
    it("rejects BATTERY_LOW with ROUTE_ADJUSTED-shaped telemetry", () => {
      assertValidationFailure(
        validate(
          batteryLowRecord({
            telemetryData: { lat: 1, lng: 2 },
          }),
        ),
      );
    });

    it("rejects ROUTE_ADJUSTED with BATTERY_LOW-shaped telemetry", () => {
      assertValidationFailure(
        validate(
          routeAdjustedRecord({
            telemetryData: { batteryLevel: 50 },
          }),
        ),
      );
    });
  });
});
