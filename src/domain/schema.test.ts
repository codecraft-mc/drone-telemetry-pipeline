import { describe, expect, it } from "vitest";
import {
  MAX_CLOCK_SKEW_MS,
  MIN_TIMESTAMP,
  TelemetryRecordSchema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_ISO = new Date().toISOString();

/** Build a valid top-level record, optionally overriding fields.
 *  Defaults to a BATTERY_LOW record — the simplest variant. */
function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    droneId: "drone-abc123",
    timestamp: NOW_ISO,
    statusCode: 0,
    eventType: "BATTERY_LOW",
    telemetryData: { batteryLevel: 80 },
    ...overrides,
  };
}

/** Assert a value parses successfully and return the output. */
function expectValid(input: unknown) {
  const result = TelemetryRecordSchema.safeParse(input);
  expect(result.success, JSON.stringify(result)).toBe(true);
  return (result as { success: true; data: unknown }).data;
}

/** Assert a value fails to parse. */
function expectInvalid(input: unknown) {
  const result = TelemetryRecordSchema.safeParse(input);
  expect(result.success, "Expected parse failure but got success").toBe(false);
}

// ---------------------------------------------------------------------------
// Valid records — one for each event type
// ---------------------------------------------------------------------------

describe("valid records", () => {
  it("accepts BATTERY_LOW", () => {
    const data = expectValid(
      validRecord({ eventType: "BATTERY_LOW", telemetryData: { batteryLevel: 50 } }),
    );
    expect((data as { telemetryData: { batteryLevel: number } }).telemetryData.batteryLevel).toBe(50);
  });

  it("accepts ROUTE_ADJUSTED", () => {
    expectValid(
      validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { lat: 48.8566, lng: 2.3522 } }),
    );
  });

  it("accepts DELIVERY_COMPLETED", () => {
    expectValid(
      validRecord({
        eventType: "DELIVERY_COMPLETED",
        telemetryData: {
          deliveryId: "del-001",
          location: { lat: 51.5074, lng: -0.1278 },
        },
      }),
    );
  });

  it("accepts SENSOR_READING", () => {
    expectValid(
      validRecord({
        eventType: "SENSOR_READING",
        telemetryData: { temperature: 22.5, humidity: 60 },
      }),
    );
  });

  it("accepts ERROR", () => {
    expectValid(
      validRecord({
        eventType: "ERROR",
        telemetryData: { errorCode: "E001", message: "motor fault" },
      }),
    );
  });

  it("coerces timestamp string to a Date instance", () => {
    const out = expectValid(validRecord()) as { timestamp: unknown };
    expect(out.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Missing required top-level fields
// ---------------------------------------------------------------------------

describe("missing top-level fields", () => {
  it("rejects missing droneId", () => {
    const { droneId: _, ...rest } = validRecord();
    expectInvalid(rest);
  });

  it("rejects missing timestamp", () => {
    const { timestamp: _, ...rest } = validRecord();
    expectInvalid(rest);
  });

  it("rejects missing statusCode", () => {
    const { statusCode: _, ...rest } = validRecord();
    expectInvalid(rest);
  });

  it("rejects missing eventType", () => {
    const { eventType: _, ...rest } = validRecord();
    expectInvalid(rest);
  });

  it("rejects missing telemetryData", () => {
    const { telemetryData: _, ...rest } = validRecord();
    expectInvalid(rest);
  });
});

// ---------------------------------------------------------------------------
// Wrong types on top-level fields
// ---------------------------------------------------------------------------

describe("wrong field types", () => {
  it("rejects numeric droneId", () => expectInvalid(validRecord({ droneId: 123 })));
  it("rejects numeric timestamp", () => expectInvalid(validRecord({ timestamp: 1_700_000_000 })));
  it("rejects string statusCode", () => expectInvalid(validRecord({ statusCode: "200" })));
  it("rejects null telemetryData", () => expectInvalid(validRecord({ telemetryData: null })));
  it("rejects undefined required fields", () => {
    expectInvalid(validRecord({ droneId: undefined }));
    expectInvalid(validRecord({ statusCode: undefined }));
  });
});

// ---------------------------------------------------------------------------
// droneId format
// ---------------------------------------------------------------------------

describe("droneId validation", () => {
  it("rejects empty string", () => expectInvalid(validRecord({ droneId: "" })));
  it("rejects uppercase letters", () => expectInvalid(validRecord({ droneId: "drone-ABC" })));
  it("rejects missing prefix", () => expectInvalid(validRecord({ droneId: "abc123" })));
  it("rejects special characters", () => expectInvalid(validRecord({ droneId: "drone-ab_cd" })));
  it("accepts lowercase hex-like id", () => expectValid(validRecord({ droneId: "drone-00ff99" })));
});

// ---------------------------------------------------------------------------
// timestamp guards
// ---------------------------------------------------------------------------

describe("timestamp validation", () => {
  it("rejects a non-date string", () => expectInvalid(validRecord({ timestamp: "not-a-date" })));

  it("rejects a timestamp beyond clock-skew limit", () => {
    const future = new Date(Date.now() + MAX_CLOCK_SKEW_MS + 60_000).toISOString();
    expectInvalid(validRecord({ timestamp: future }));
  });

  it("accepts a timestamp right at the clock-skew boundary", () => {
    // One second inside the allowed window — should pass.
    const nearFuture = new Date(Date.now() + MAX_CLOCK_SKEW_MS - 1_000).toISOString();
    expectValid(validRecord({ timestamp: nearFuture }));
  });

  it("rejects a timestamp before MIN_TIMESTAMP", () => {
    const ancient = new Date(MIN_TIMESTAMP.getTime() - 1).toISOString();
    expectInvalid(validRecord({ timestamp: ancient }));
  });

  it("accepts a timestamp equal to MIN_TIMESTAMP", () => {
    expectValid(validRecord({ timestamp: MIN_TIMESTAMP.toISOString() }));
  });
});

// ---------------------------------------------------------------------------
// statusCode range
// ---------------------------------------------------------------------------

describe("statusCode validation", () => {
  it("rejects negative values", () => expectInvalid(validRecord({ statusCode: -1 })));
  it("rejects values above 999", () => expectInvalid(validRecord({ statusCode: 1000 })));
  it("rejects floats", () => expectInvalid(validRecord({ statusCode: 1.5 })));
  it("accepts boundary values 0 and 999", () => {
    expectValid(validRecord({ statusCode: 0 }));
    expectValid(validRecord({ statusCode: 999 }));
  });
});

// ---------------------------------------------------------------------------
// Unknown / unrecognised eventType
// ---------------------------------------------------------------------------

describe("unknown eventType", () => {
  it("rejects an unrecognised eventType string", () => {
    expectInvalid(validRecord({ eventType: "TAKEOFF", telemetryData: { altitude: 50 } }));
  });

  it("rejects null eventType", () => {
    expectInvalid(validRecord({ eventType: null }));
  });
});

// ---------------------------------------------------------------------------
// telemetryData shape mismatched to eventType (discriminated union earns keep)
// ---------------------------------------------------------------------------

describe("telemetryData shape mismatch", () => {
  it("rejects BATTERY_LOW telemetryData with lat/lng instead of batteryLevel", () => {
    expectInvalid(
      validRecord({ eventType: "BATTERY_LOW", telemetryData: { lat: 10, lng: 20 } }),
    );
  });

  it("rejects ROUTE_ADJUSTED telemetryData with batteryLevel instead of lat/lng", () => {
    expectInvalid(
      validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { batteryLevel: 50 } }),
    );
  });

  it("rejects DELIVERY_COMPLETED telemetryData missing deliveryId", () => {
    expectInvalid(
      validRecord({
        eventType: "DELIVERY_COMPLETED",
        telemetryData: { location: { lat: 10, lng: 20 } },
      }),
    );
  });

  it("rejects ERROR telemetryData missing errorCode", () => {
    expectInvalid(
      validRecord({ eventType: "ERROR", telemetryData: { message: "oops" } }),
    );
  });
});

// ---------------------------------------------------------------------------
// batteryLevel range
// ---------------------------------------------------------------------------

describe("batteryLevel range", () => {
  it("rejects negative batteryLevel", () => {
    expectInvalid(validRecord({ eventType: "BATTERY_LOW", telemetryData: { batteryLevel: -1 } }));
  });

  it("rejects batteryLevel above 100", () => {
    expectInvalid(validRecord({ eventType: "BATTERY_LOW", telemetryData: { batteryLevel: 101 } }));
  });

  it("accepts boundary values 0 and 100", () => {
    expectValid(validRecord({ eventType: "BATTERY_LOW", telemetryData: { batteryLevel: 0 } }));
    expectValid(validRecord({ eventType: "BATTERY_LOW", telemetryData: { batteryLevel: 100 } }));
  });
});

// ---------------------------------------------------------------------------
// lat/lng out-of-bounds (ROUTE_ADJUSTED)
// ---------------------------------------------------------------------------

describe("lat/lng bounds", () => {
  it("rejects lat above 90", () => {
    expectInvalid(validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { lat: 91, lng: 0 } }));
  });

  it("rejects lat below -90", () => {
    expectInvalid(validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { lat: -91, lng: 0 } }));
  });

  it("rejects lng above 180", () => {
    expectInvalid(validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { lat: 0, lng: 181 } }));
  });

  it("rejects lng below -180", () => {
    expectInvalid(validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { lat: 0, lng: -181 } }));
  });

  it("accepts boundary values", () => {
    expectValid(validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { lat: 90, lng: 180 } }));
    expectValid(validRecord({ eventType: "ROUTE_ADJUSTED", telemetryData: { lat: -90, lng: -180 } }));
  });
});

// ---------------------------------------------------------------------------
// Extra / unknown fields — strict mode
// ---------------------------------------------------------------------------

describe("unknown fields rejected (strict mode)", () => {
  it("rejects an extra field at top level", () => {
    expectInvalid(validRecord({ unexpectedField: "surprise" }));
  });

  it("rejects an extra field inside BATTERY_LOW telemetryData", () => {
    expectInvalid(
      validRecord({ eventType: "BATTERY_LOW", telemetryData: { batteryLevel: 80, extra: true } }),
    );
  });

  it("rejects an extra field inside DELIVERY_COMPLETED location", () => {
    expectInvalid(
      validRecord({
        eventType: "DELIVERY_COMPLETED",
        telemetryData: {
          deliveryId: "del-1",
          location: { lat: 10, lng: 20, altitude: 500 },
        },
      }),
    );
  });
});
