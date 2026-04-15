-- -----------------------------------------------------------------------------
-- Persistence projection for validated telemetry
--
-- The Zod schema in src/domain/schema.ts (TelemetryRecordSchema and related
-- types) is authoritative for domain shape and validation rules. This DDL is
-- a best-effort database mirror for storage, indexing, and operator inspection;
-- it is not a second validation layer. Application code remains responsible
-- for validating ingested payloads before insert.
-- -----------------------------------------------------------------------------

CREATE TABLE telemetry_events (
  id BIGSERIAL PRIMARY KEY,
  drone_id TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  status_code SMALLINT NOT NULL CHECK (status_code BETWEEN 0 AND 999),
  payload JSONB NOT NULL,
  message_id TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telemetry_events_drone_event_time_event_type_key UNIQUE (drone_id, event_time, event_type),
  CONSTRAINT telemetry_events_message_id_key UNIQUE (message_id)
);

CREATE INDEX telemetry_events_drone_id_event_time_idx
  ON telemetry_events (drone_id, event_time DESC);

CREATE INDEX telemetry_events_event_type_event_time_idx
  ON telemetry_events (event_type, event_time DESC);

CREATE INDEX telemetry_events_payload_gin_idx
  ON telemetry_events USING GIN (payload);
