-- -----------------------------------------------------------------------------
-- Forensic storage for failed ingest
--
-- The Zod schema in src/domain/schema.ts (TelemetryRecordSchema) is
-- authoritative for what counts as a valid telemetry record. Rows in this
-- table hold raw or invalid payloads that did not (or could not) satisfy that
-- schema. Stored JSON is forensic input for debugging and replay workflows, not
-- guaranteed-valid domain data.
-- -----------------------------------------------------------------------------

CREATE TABLE dead_letters (
  id BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  failure_phase TEXT,
  error_message TEXT,
  errors JSONB,
  payload JSONB NOT NULL,
  message_id TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX dead_letters_created_at_idx
  ON dead_letters (received_at DESC);

CREATE INDEX dead_letters_message_id_idx
  ON dead_letters (message_id);
