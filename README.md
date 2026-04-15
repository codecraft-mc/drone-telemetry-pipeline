# drone-telemetry-pipeline
A system that automatically ingests drone telemetry data, validates it and stores it for later analysis, monitoring, and alerting. 

## Architecture

Drones (or the drone simulator in [scripts/producer.ts](scripts/producer.ts)) publish JSON payloads to a Redis Stream. A long-running worker process reads from that stream via a consumer group, parses and validates each message against a Zod schema, then writes the record to Postgres. Messages that fail parsing or validation, or that exceed the retry limit, are sent to a dead-letter table so that nothing is lost. The worker shuts down cleanly on `SIGTERM`/`SIGINT`: it finishes the current in-flight batch, empties the acknowledgement queue, and closes both connections before exiting. The worker is containerised via [Dockerfile](Dockerfile) and the full stack: worker, Redis, and Postgres — is orchestrated locally via [docker-compose.yml](docker-compose.yml).

All infrastructure dependencies are injected through interfaces (`MessageSource`, `TelemetryRepository`, and `DeadLetterRepository`). The worker depends on interfaces rather than concrete implementations. The Redis and Postgres specifics are wired in at startup, so the core processing logic is testable without any infrastructure running.

```
  Drones / simulator
        │  XADD
        ▼
  ┌─────────────────────────────────┐
  │  Redis Stream                   │
  │  drone:telemetry                │
  └────────────────┬────────────────┘
                   │  XREADGROUP / XAUTOCLAIM
                   ▼
  ┌─────────────────────────────────┐
  │  RedisMessageSource             │  consumer group · PEL · reclaim cycle
  └────────────────┬────────────────┘
                   │  RawMessage[]
                   ▼
  ┌─────────────────────────────────┐
  │  Worker                         │
  │  1. parseRecord()   (JSON)       │
  │  2. validate()      (Zod)        │──── parse/validate fail ──▶  dead_letters
  │  3. repo.insert()   (Postgres)   │──── permanent / exhausted ──▶ dead_letters
  └────────────────┬────────────────┘
                   │  XACK
                   ▼
  ┌─────────────────────────────────┐
  │  telemetry_events  (Postgres)   │
  └─────────────────────────────────┘
```

### Decisions and tradeoffs

- **Redis Streams over Kafka:** I haven't used Kafka in production, but I understood it would be overkill here. Redis Streams give the delivery guarantees needed and it's one less dependency to run.

- **Zod:** Zod allows for the definition of the validation schema, and facilitates the derivation of TypeScript types automatically.

- **Database-level idempotency:** A unique constraint in the database handles deduplication — if the same record arrives twice, the insert is skipped. This is simpler than tracking message IDs in the application state.

- **Postgres for storage:** A general-purpose database that handles the query patterns, supports JSON columns for the variable telemetry data, and lets the valid records live alongside the dead-letter table. This means investigating failures can be done with a single SQL query rather than switching between two different systems.

- **Docker Compose for local dev:** Docker Compose means the tests run against infrastructure that's fully self-contained, with no shared state and no external dependencies.

### Component walkthrough

**Redis Streams:** The handoff between drones and the pipeline. Messages stay in a pending list until explicitly acknowledged, so if the worker crashes they're automatically reclaimed on restart.

**RedisMessageSource:** ([src/ingestion/redis-source.ts](src/ingestion/redis-source.ts)) Each `read()` does two passes: firstly reclaim any entries from crashed consumers, then secondly fetch fresh ones.

**Interfaces:** ([src/ingestion/source.ts](src/ingestion/source.ts), [src/storage/repository.ts](src/storage/repository.ts), [src/storage/dead-letter.repository.ts](src/storage/dead-letter.repository.ts)) — The worker only knows `read()`, `ack()`, and `insert()`. Keeping infrastructure behind interfaces means the full logic can be tested without impacting a real database or stream.

**Worker:** ([src/worker/worker.ts](src/worker/worker.ts)) Each message goes through parse → validate → write. Each error type has a specific outcome: transient errors stay in the queue for redelivery, everything else goes to the DLQ and gets acked. A delivery counter stops a persistently-failing message from retrying repeatedly. The counter is backed by the Redis PEL via `XPENDING`, so it survives process restarts — a message cannot bypass `maxDeliveryCount` by crashing the worker.

**`Result<T, E>`:** ([src/lib/result.ts](src/lib/result.ts)) Fallible operations return `Result<T, E>` rather than throwing, which keeps the retry vs DLQ branching visible in the type system.

**Zod schema:** ([src/domain/schema.ts](src/domain/schema.ts)) A discriminated union on `eventType`. TypeScript types are inferred from the schema via `z.infer`, so the validator and the types can't diverge. Unknown fields fail explicitly rather than in the background.

**Postgres:** Scalar columns for the common query patterns, plus `payload` as JSONB for ad-hoc field queries. The `payload` column stores the validated `telemetryData` fields with keys converted to snake_case (e.g. `batteryLevel` → `battery_level`). The `message_id` column carries the originating Redis stream entry ID for replay and cross-table correlation. Idempotent inserts via `ON CONFLICT DO NOTHING`. The `dead_letters` table lives in the same database and holds the raw payload and failure metadata for anything the pipeline couldn't persist.

## Testing strategy

### What is unit-tested

**`parseRecord`** ([tests/unit/parser.test.ts](tests/unit/parser.test.ts)): valid and malformed JSON, empty strings, primitives. Checks `ParseError.cause` is populated on broken input.

**`validate`** ([tests/unit/validator.test.ts](tests/unit/validator.test.ts)): all five event types, missing and wrong-typed fields, range checks, timestamp bounds, unknown `eventType`, and cross-variant `telemetryData` mismatches.

**`Worker`** ([tests/unit/worker.test.ts](tests/unit/worker.test.ts)): Covers all possible outcomes: happy path, parse failure, validation failure, transient error (no ack, no DLQ), permanent error, retry exhaustion, DLQ write failure, and mixed-result batches.

**`PostgresTelemetryRepository` / `PostgresDeadLetterRepository`** ([tests/unit/postgres-telemetry-repository.test.ts](tests/unit/postgres-telemetry-repository.test.ts)): A pool double verifies SQL shape and `rowCount` interpretation. SQLSTATE codes are mapped to error types: schema errors → `PermanentError`, connection and serialization errors → `TransientError`.

### What is integration-tested

**`PostgresTelemetryRepository`** ([tests/integration/postgres-telemetry-repository.integration.test.ts](tests/integration/postgres-telemetry-repository.integration.test.ts)): Runs against a real Postgres instance. Covers correct writes, JSONB round-trips, the unique constraint returning `duplicate`, all five event types, and a constraint violation presented as `PermanentError`.

### What is not tested

**`RedisMessageSource`:** Not covered. The Redis-specific consumption logic would be best covered by integration tests against a real Redis instance rather than mocked at this level.

**End-to-end**: No tests put a message onto a real Redis stream and asserts if it lands in the DB. At present this is only done by the demo producer.

**Shutdown**: the graceful drain sequence (abort → finish in-flight batch → close connections) has no test.

## Error handling and observability

### The 4 error types

Every failure in the pipeline resolves to one of four typed errors defined in [src/domain/errors.ts](src/domain/errors.ts). The type tag drives both the log level and the routing decision:

| Tier | Log level | Routing | Rationale |
|---|---|---|---|
| `ParseError` | `warn` | DLQ, ack | Invalid JSON. Retrying won't result in a different outcome. |
| `ValidationError` | `warn` | DLQ, ack | Valid JSON but fails the schema due to wrong shape, a bad ID, or out-of-range value. Almost always an upstream producer issue. Retrying won't result in a different outcome. |
| `TransientError` | `warn` | No ack, redeliver | An infrastructure issue such as a network timeout, database connection issue. The message is left unacked so it gets retried automatically. |
| `PermanentError` | `error` | DLQ, ack | An unexpected condition that retrying can't fix. Logged at `error` because it needs wider attention. ||

`ParseError` and `ValidationError`: The producer intentionally generates ~25% corrupt messages in the demo. A sustained spike in either indicates a problem with upstream behavior, not pipeline health. 

`PermanentError`: Shouldn't occur in theory; if it does then it suggests a mismatch between the domain schema and the database schema requiring investigation.


### Delivery exhaustion

A message that triggers `TransientError` 5 times is sent to the DLQ and tagged as exhausted and acked. This stops a single bad message from continuously looping.

### Correlation IDs

Every message has a correlation ID composed from the Redis stream entry ID and the drone ID once parsed. Both are attached to the logger for tracability.

### Monitoring DLQ in Production

The dead-letter table is the main means of checking system health. Query for this (which could be put on a schedule):

```sql
SELECT failure_phase, count(*) AS n
FROM dead_letters
WHERE received_at > now() - interval '5 minutes'
GROUP BY failure_phase
ORDER BY n DESC;
```

In production we could alert on the result of this query. `ValidationError` metrics could be tracked over time.


## What I'd do next

**Integration tests with Testcontainers:** The biggest gap is testing a message entering a real Redis stream and landing in Postgres or the DLQ. The unit tests cover routing logic and the integration tests cover SQL behaviour, but currently only the Producer simulates the entire process. A library like Testcontainers would let those tests spin up real Redis and Postgres in CI without manual setup.

**CI pipeline:** There's no CI configuration. The minimum useful setup is typecheck, lint, and unit tests on every push, with a second job that runs the integration tests on every PR.

**Per-drone rate limiting:** Nothing currently prevents a defective drone from sending a high volume of messages to the stream. A rate counter keyed on `droneId`, checked after validation and before the repository write, would let the worker drops excess messages to the DLQ rather than processing them. Redis is already in scope so it's a low-cost addition.

**Authentication:** Locally, no authentication is configured. The stack is single-user dev only. In production, the producer-side Redis connection would need AUTH, the worker would need scoped database credentials with only the permissions it needs (insert into telemetry_events and dead_letters, read from the stream), and secrets would be injected from a secret manager rather than a .env file.

## Assumptions and challenges

### What I assumed about the input format

The spec listed the fields a record might contain (`droneId`, `eventType`, `timestamp`, `statusCode`, `telemetryData`) and said data could arrive as JSON messages or batched CSV files. I picked JSON messages over CSV batches because the scenario described drones "constantly sending back" telemetry, which reads as a streaming workload rather than a periodic file drop.

The spec didn't define the shape of `telemetryData`, so I assumed it varies by `eventType`, e.g.: battery readings for `BATTERY_LOW`, coordinates for `ROUTE_ADJUSTED` etc., which drove the discriminated union design. This meant that eventType became the discriminator and Zod would validate the matching `telemetryData` shape automatically, without any if/else branching in the worker code.

I also assumed `droneId` would follow a predictable pattern (`drone-[a-z0-9]+`) rather than being an arbitrary string. That let me add a regex constraint in the Zod schema to catch a class of upstream bugs (wrong field, truncated value) that a plain `string()` would silently accept. If the format ever changes, that constraint needs revisiting.

For timestamps I assumed ISO 8601 strings rather than epoch integers, and I added a `MIN_TIMESTAMP` bound (anything before 2020 is almost certainly a clock reset or a default value, not real telemetry). Both of these are guesses about producer behaviour that I'd want to validate against an actual device spec before treating them as hard rules.


### Where I deliberately simplified

I also simplified the producer: it generates messages on a fixed interval with a fixed corruption rate rather than simulating realistic drone behaviour. That was enough to exercise all the pipeline's error paths, but a more realistic simulator would stress-test the rate-limiting and throughput assumptions more meaningfully.

### Anything that surprised me

**Zod:** Zod was new to me. The feature that sold me on it was the discriminated union which allows the schema to be defined once and both runtime validation and TypeScript types to be available for use, meaning no separate type definition to keep in sync.

**Postgres:** I'm more comfortable with Redis than with Postgres, and the Postgres layer was the part I had to investigate the most. The idempotent insert pattern took a couple of iterations to get right. JSONB columns were also new to me.

## Production deployment path

The worker only depends on interfaces. The Redis and Postgres client libraries are imported in the adapter classes, not in the worker itself.

The interface-based design means moving to managed cloud services is a wiring change. New adapter classes would be needed for the ingestion and storage layers and swapped in at startup. The worker, schema, and tests would stay as-is.

I'd want to align with the team's existing cloud stack before picking specific services.

### Permissions and access control

Locally, the stack runs with no authentication — a single-user dev environment with credentials hardcoded in `docker-compose.yml` and `.env` (see the note in [Running locally](#running-locally)). In production this changes on three fronts. The Redis stream should require authentication: `requirepass` / `ACL` on a self-managed instance, or IAM-based auth on a managed service such as ElastiCache. The worker's Postgres credentials should be scoped to the minimum necessary — `INSERT` and `SELECT` on `telemetry_events` and `dead_letters` only, not a superuser or table-owner role. Both sets of credentials should be injected at runtime from a secret manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, etc.) rather than from a committed `.env` file, so that rotating a credential doesn't require a code change or a redeploy.

## Running locally

**Prerequisites:** Node ≥ 20, Docker with Compose.

```bash
# 1. Clone and install dependencies
git clone <repo-url> drone-telemetry-pipeline
cd drone-telemetry-pipeline
npm install

# 2. Configure environment
cp .env.example .env
# The defaults in .env.example match docker-compose.yml — no edits needed for local dev.
# Note: .env is intentionally committed to this repository. It contains only the non-secret
# development credentials that are also hardcoded in docker-compose.yml. There are no real
# secrets — it exists purely as a convenience so the stack runs with zero configuration after
# cloning. In a real project, .env would be gitignored and injected by CI/CD or a secrets manager.

# 3. Start Postgres, Redis, run migrations, and start the worker
docker compose up -d

# 4. Tail worker logs to confirm it's consuming
docker compose logs -f worker
# You should see: "redis connected", "postgres connected", "worker running"
```

The worker is now live but the stream is empty. Start the producer to send a mix of valid and deliberately broken messages:

```bash
# Runs for 60 s at 20 msg/s with 8 simulated drones and 25% corrupt messages
docker compose --profile demo up producer
```

The producer prints a running summary to stdout and a corruption-variant breakdown when it exits. Adjust the defaults via environment variables:

```bash
PRODUCER_RATE=50 PRODUCER_DURATION=120 PRODUCER_CORRUPTION=0.1 PRODUCER_DRONES=20 PRODUCER_MAXLEN=50000 \
  docker compose --profile demo up producer
```

To run the worker outside Docker (useful when iterating on the source):

```bash
# Assumes docker compose up -d has started Postgres and Redis on their default ports
npm run dev
```

## Running tests

Unit tests have no infrastructure dependencies and run in a few seconds:

```bash
npm test
# vitest run tests/unit
```

Integration tests require a Postgres instance. They create and tear down the schema themselves using `DROP TABLE IF EXISTS`, so they need a dedicated test database — they must not run against the same database as a live worker. By default they connect to `localhost:5433` (note: port 5433, not 5432) so they can coexist with the dev stack without risk:

```bash
# Start a throw-away Postgres on 5433
docker run -d --name pg-test \
  -p 5433:5432 \
  -e POSTGRES_USER=telemetry \
  -e POSTGRES_PASSWORD=telemetry \
  -e POSTGRES_DB=telemetry_test \
  postgres:16-alpine

npm run test:integration
# vitest run tests/integration

# Or override the URL to point anywhere you like
DATABASE_URL=postgresql://telemetry:telemetry@localhost:5433/telemetry_test npm run test:integration
```

Run everything at once:

```bash
npm run test:all
```

## Verifying the pipeline

After running the producer for at least 30 seconds, connect to Postgres and run these queries:

```bash
docker compose exec postgres psql -U telemetry -d telemetry
```

**Events ingested vs dead-lettered** (with default settings expect ~900 and ~300):

```sql
SELECT
  (SELECT count(*) FROM telemetry_events) AS events_ingested,
  (SELECT count(*) FROM dead_letters)     AS dead_letters;
```

**Dead-letter breakdown by failure phase:**

```sql
SELECT failure_phase, count(*) AS n
FROM dead_letters
GROUP BY failure_phase
ORDER BY n DESC;
```

`ValidationError` should dominate (schema violations from the producer's corruption variants), with a smaller `ParseError` bucket for non-JSON payloads.

**Drill into a JSONB payload — confirms the telemetryData round-trip (keys are snake_cased):**

```sql
SELECT drone_id, event_time, payload AS readings
FROM telemetry_events
WHERE event_type = 'SENSOR_READING'
ORDER BY event_time DESC
LIMIT 5;
```

**Idempotency check — expect 0 rows:**

```sql
SELECT drone_id, event_time, event_type, count(*) AS copies
FROM telemetry_events
GROUP BY drone_id, event_time, event_type
HAVING count(*) > 1;
```
