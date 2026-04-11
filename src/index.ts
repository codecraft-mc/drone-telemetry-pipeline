import "./config.js";
import { TelemetryRecordSchema } from "./domain/schema.js";

const cases = [
  {
    label: "valid BATTERY_LOW",
    input: {
      droneId: "drone-abc123",
      timestamp: new Date().toISOString(),
      eventType: "BATTERY_LOW",
      statusCode: 200,
      telemetryData: { batteryLevel: 15 },
    },
  },
  {
    label: "battery level out of range",
    input: {
      droneId: "drone-abc123",
      timestamp: new Date().toISOString(),
      eventType: "BATTERY_LOW",
      statusCode: 200,
      telemetryData: { batteryLevel: 150 },
    },
  },
  {
    label: "shape mismatch (battery event with lat/lng)",
    input: {
      droneId: "drone-abc123",
      timestamp: new Date().toISOString(),
      eventType: "BATTERY_LOW",
      statusCode: 200,
      telemetryData: { lat: 51.5, lng: -0.12 },
    },
  },
  {
    label: "unknown event type",
    input: {
      droneId: "drone-abc123",
      timestamp: new Date().toISOString(),
      eventType: "UNKNOWN_TYPE",
      statusCode: 200,
      telemetryData: {},
    },
  },
  {
    label: "unparseable timestamp",
    input: {
      droneId: "drone-abc123",
      timestamp: "not-a-date",
      eventType: "BATTERY_LOW",
      statusCode: 200,
      telemetryData: { batteryLevel: 50 },
    },
  },
  {
    label: "future timestamp (clock skew)",
    input: {
      droneId: "drone-abc123",
      timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      eventType: "BATTERY_LOW",
      statusCode: 200,
      telemetryData: { batteryLevel: 50 },
    },
  },
  {
    label: "extra unknown field",
    input: {
      droneId: "drone-abc123",
      timestamp: new Date().toISOString(),
      eventType: "BATTERY_LOW",
      statusCode: 200,
      telemetryData: { batteryLevel: 50 },
      bogus: true,
    },
  },
  {
    label: "missing droneId",
    input: {
      timestamp: new Date().toISOString(),
      eventType: "BATTERY_LOW",
      statusCode: 200,
      telemetryData: { batteryLevel: 50 },
    },
  },
];

for (const { label, input } of cases) {
  const result = TelemetryRecordSchema.safeParse(input);
  if (result.success) {
    console.log(`✓ ${label}: PASSED validation`);
  } else {
    console.log(`✗ ${label}: REJECTED`);
    console.log(`   ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`);
  }
}