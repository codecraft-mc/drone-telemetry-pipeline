import type { TelemetryRecord } from "../domain/schema.js";

export type TelemetryRow = {
  drone_id: string;
  event_time: Date;
  event_type: TelemetryRecord["eventType"];
  status_code: number;
  payload: Record<string, unknown>;
  message_id: string;
};

export function toRow(record: TelemetryRecord, messageId: string): TelemetryRow {
  const eventTime =
    record.timestamp instanceof Date ? record.timestamp : new Date(record.timestamp as string);
  const payload = Object.fromEntries(
    Object.entries(record.telemetryData as Record<string, unknown>).map(([k, v]) => [
      k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      v,
    ]),
  );
  return {
    drone_id: record.droneId,
    event_time: eventTime,
    event_type: record.eventType,
    status_code: record.statusCode,
    payload,
    message_id: messageId,
  };
}
