# EPIC 3 — Observability and Structured Logging

## Purpose

Make failures in the voting application's Node.js result service visible and diagnosable. Structured logs identify what happened, when it happened, and which HTTP request was involved. The database shutdown experiment measures how quickly the service records a failure.

Scope: “Vote backend” means the backend of the voting application. The PostgreSQL-specific design and recorded experiment target the Node.js `result` service, identified as `vote-result`; the Python `vote` service is a separate component. HTTP and lifecycle instrumentation can use the same design in each service, with a distinct `service` label. This document does not claim PostgreSQL instrumentation exists in the Python vote service.

This document keeps Scenario 3 implementation notes, validation evidence, and observability concepts together. It does not require a separate TESTING.md.

## Evidence and scope

This document is reconstructed from the Scenario 3 discussion and recorded local test output. The uploaded project ZIP contains an older `result/server.js` with plain-text logging, so it cannot independently verify the later structured-logging implementation. The observations below refer to the later local run. The exact original wording of SUSHMA-22–29 was not available for a reliable per-ticket completion mapping.

## Structured logging

The Scenario 3 implementation uses JSON log records in `result/server.js`. One event per line makes logs easier to filter and process than free-form text. Docker captures the application's output, allowing inspection with `docker compose logs`.

### Common fields

| Field | Purpose | Example |
| --- | --- | --- |
| `timestamp` | UTC time when the application records the event | `2026-10-13T03:57:23.707Z` |
| `level` | Severity of the event | `error` |
| `service` | Service that produced the log | `vote-result` |
| `event` | Stable event name used for filtering | `database_connection_failed` |

### Documented events

| Event | Meaning | Evidence |
| --- | --- | --- |
| `database_connection_failed` | A database connection failed or was lost | Observed in the database-stop experiment |
| `database_query_failed` | A database query failed | Described in the Scenario 3 implementation discussion |
| `http_request_completed` | An HTTP response completed; includes correlation and timing information | Observed for `GET /`, status `200` |

Database failure records use sanitized error metadata such as `error_name` and `error_code`. Do not log passwords, connection strings, authorization headers, cookies, or request bodies containing sensitive information. The specific logger package is not established by the available evidence and is therefore not attributed to Pino, Winston, or another library.

Observed application log:

```json
{"timestamp":"2026-10-13T03:57:23.707Z","level":"error","service":"vote-result","event":"database_connection_failed","error_name":"error","error_code":"57P01"}
```

## HTTP request correlation

The implementation assigns a UUID to an HTTP request, returns it in the `X-Request-ID` response header, and includes the matching identifier in its `http_request_completed` log. This connects a client response to the corresponding server-side record.

The recorded check confirmed:

| Item | Observed value |
| --- | --- |
| Request | `GET /` |
| HTTP status | `200` |
| Response `X-Request-ID` | `005e92ae-0ad3-4d41-9547-d3d0a1c3e3a8` |
| Completion-log identifier | Matches the response header |
| Logged duration | `7.27 ms` |

Socket.IO connection identifiers are separate from HTTP request IDs. A background database polling failure is not automatically associated with a particular browser request. An HTTP `200` for the page also does not prove that fresh database results are available.

## Repeatable validation

Run these commands from the repository root in Windows Command Prompt. Start with the updated Scenario 3 code and a running Docker environment.

### 1. Start the application

```bat
docker compose up -d --build
docker compose ps
```

Open the result page and verify that healthy results are available before introducing the failure. Use the result service's published port from `docker compose ps` for the HTTP check below.

### 2. Verify request correlation

For the default result port, run:

```bat
curl.exe -i http://localhost:5001/
docker compose logs --since 1m result
```

Find the `X-Request-ID` header and the matching `http_request_completed` record. Check the method, path, status, and duration. Substitute the configured published port if it differs from `5001`.

### 3. Follow result-service logs

In one terminal:

```bat
docker compose logs -f --since 10s --timestamps result
```

Docker may add a container name and its own timestamp before the application JSON. The inner JSON `timestamp` is the application event time used in the calculation below.

### 4. Record the stop time and stop PostgreSQL

In a second Command Prompt terminal:

```bat
powershell -NoProfile -Command "$t=[DateTime]::UtcNow; Write-Host ('DB stop initiated UTC: ' + $t.ToString('o')); docker compose stop db"
```

Record the printed UTC timestamp and the first subsequent `database_connection_failed` or `database_query_failed` event. Check the result page for the unavailable state and inspect whether the result container remains running:

```bat
docker compose ps -a
```

### 5. Restore the database

```bat
docker compose start db
docker compose logs --since 1m result worker
```

Check recovery independently; an error log alone does not prove that automatic reconnection works. If results do not resume after PostgreSQL is ready, restart the affected application services for local cleanup:

```bat
docker compose restart result worker
```

## Measured database-failure detection

The latest recorded experiment produced these timestamps:

| Observation | UTC timestamp |
| --- | --- |
| Database stop command initiated | `2026-10-13T03:57:23.2836063Z` |
| First application failure event | `2026-10-13T03:57:23.707Z` |
| Subsequent application failure event | `2026-10-13T03:57:23.711Z` |

```text
Detection interval = first failure event − stop-command initiation
                   = 23.7070000 − 23.2836063 seconds
                   = 0.4233937 seconds
                   ≈ 423 ms
```

The first event carried error code `57P01`; the subsequent event carried `UNKNOWN`. These are two records during one induced outage, not evidence of two separate incidents.

This is one local measurement from command initiation to application logging. It includes Docker command execution time and assumes that the host and container clocks are sufficiently aligned. It does not measure browser notification latency, alert delivery time, or the exact instant PostgreSQL became unavailable. It replaces the earlier approximate two-second observation for this particular run; it is not an average or a guaranteed detection bound.

## Logs, metrics, and traces

| Signal | What it answers | Application example |
| --- | --- | --- |
| Logs | What happened in a particular event? | Database connection failed with an error code |
| Metrics | How often does it happen, and how does it change over time? | Database failure rate or request-duration distribution |
| Traces | Where was time spent across an operation and its components? | HTTP operation and dependent database calls |

Request IDs provide log correlation. They do not by themselves implement distributed tracing.

### Metrics design

The following definitions cover all six requested metric categories. Names are proposed Prometheus-style names, not verified exports from the supplied code.

| Required category | Metric and type | Definition and measurement boundary |
| --- | --- | --- |
| Database errors | `database_connection_failures_total` and `database_query_failures_total` — counters | Increment once per failed connection attempt or lost-connection notification, and once per failed query attempt, respectively. Count an individual callback/event only once even if multiple handlers process it. These count failures, not unique outages. |
| Request latency | `http_request_duration_seconds` — histogram | Measure elapsed time with a monotonic clock from HTTP middleware entry to response completion. Label by service, method, normalized route, and status. Report p50, p95, and p99 over a defined window. |
| HTTP errors | Derived from `http_requests_total{status}` — counter | Increment the base counter once per completed response. Sum statuses 400–499 for client errors and 500–599 for server errors. Calculate each rate separately; combined HTTP error percentage is `(4xx + 5xx responses) / all completed responses × 100`. |
| Successful requests | Derived from `http_requests_total{status}` — counter | Sum statuses 200–299. Success percentage is `2xx responses / all completed responses × 100`. Track 3xx separately; they are neither errors nor 2xx successes in this definition. |
| Database query latency | `database_query_duration_seconds` — histogram | Measure from query submission until success, failure, or timeout, including pool acquisition if the query API acquires the connection. Label by a fixed operation name and outcome, never raw SQL. Record failures as well as successes. If connection acquisition occurs separately, measure its duration separately. |
| Application availability | `application_probe_success` — externally collected 0/1 gauge | Every 10 seconds, probe the result backend from outside its process with a 2-second timeout. Success requires a response and a successful bounded database check; otherwise record 0, including connection refusal and timeout. Over 24 hours, availability is `successful checks / executed checks × 100`. Report missing scheduled checks separately as monitoring gaps. |

Availability is sampled service readiness, not just process uptime. The proposed probe can target a readiness endpoint once implemented; fetching a static page with HTTP 200 is insufficient. Database availability can additionally be exposed as `database_available` (1 for a recent successful database check, 0 after a failure), but an in-process gauge alone cannot detect a stopped application.

Exclude health, readiness, and metrics routes from user-request ratios, or report them separately. Count aborted connections in a separate `http_requests_aborted_total` counter and record their elapsed time with outcome `aborted`; they have no completed HTTP status and are excluded from completed-response ratios. A zero denominator means “no traffic,” not 100% success. HTTP measurements cover HTTP transactions, not the full lifetime or individual messages of a Socket.IO connection.

Use bounded labels such as service, method, normalized route, status, and fixed operation name. Do not use request IDs, raw URLs, user identifiers, or error messages as metric labels. Counter rates must account for process restarts. A `/metrics` endpoint, external availability probe, and Prometheus collection remain proposed design, not verified implementation.

### Required log-event design

Every event uses the common `timestamp`, `level`, `service`, and `event` fields defined above. The following table explicitly covers all five requested log categories. Additional fields are proposed schema fields; the examples are not claims of observed output.

| Required category | Event and severity | When to emit | Useful safe fields |
| --- | --- | --- | --- |
| Database connection failure | `database_connection_failed` — `error` | When connection establishment fails or an established connection is lost | `error_name`, allowlisted `error_code`, `attempt`, `retry_delay_ms` when applicable |
| Database recovery | `database_recovered` — `info` | Once on transition from unavailable to available, after a successful validation query; initial healthy startup is not a recovery | `outage_duration_ms`, `attempts` when tracked |
| Query failure | `database_query_failed` — `error` | Once for a query that fails or times out | Fixed `operation`, `duration_ms`, allowlisted `error_code`, `request_id` only if caused by an HTTP request |
| Application startup | `application_started` — `info` | Once the HTTP server begins listening | `port`, deployment `version` when known, `database_ready` as a boolean; listening alone does not imply readiness |
| Application shutdown | `application_shutdown_started` — `info`; `application_shutdown_completed` — `info` | At receipt of SIGTERM/SIGINT and after HTTP/query draining and resource cleanup | `signal`, `in_flight_requests`, then `duration_ms` and `exit_code` |

If graceful shutdown exceeds its deadline, emit `application_shutdown_timeout` at `error` level with a safe count of unfinished work before forced termination. Abrupt termination such as SIGKILL cannot reliably produce a shutdown log; external monitoring must detect the disappearance.

For repeated connection failures, retain counters for every failure but rate-limit repetitive logs or periodically summarize them. Preserve the initial failure and recovery transition so the incident timeline remains clear.

### Sensitive-data exclusions

Use an allowlist of log fields. Never serialize entire request objects, database clients, configuration objects, or raw error objects. Exclude passwords, tokens, API keys, credentials, connection strings, cookies, authorization headers, request/response bodies, query parameters, SQL parameter values, personal data, and vote contents. Use a fixed operation name such as `fetch_vote_counts` instead of raw SQL or user input. Error messages and stack traces can contain sensitive values, so omit them unless explicitly sanitized. Generate opaque request IDs and avoid embedding user information in identifiers.

### Design acceptance checks

- Trigger a failed database connection and failed query: check the corresponding counters and sanitized events.
- Complete 2xx, 4xx, and 5xx requests: check classification, counts, and latency observations; verify probe traffic is separated.
- Run successful and failing queries: check query-duration observations and outcome labels.
- Stop the backend or database: the external probe should record failure even when the backend cannot emit metrics.
- Restore the database: emit one recovery event only after a successful check, provided recovery is implemented.
- Start and gracefully stop the service: verify lifecycle events and shutdown timing; do not expect a final log after SIGKILL.
- Inspect emitted fields for sensitive data and unbounded labels.

These are acceptance criteria for the design. They are not additional tests claimed to have passed in the recorded local run.

## Health and readiness

Liveness describes whether the service process can continue operating. Readiness describes whether it can currently serve its intended workload, including required dependencies. Database loss should make readiness fail without making database availability the sole liveness condition.

These are observability design concepts here. This document does not claim that `/healthz`, `/livez`, or `/readyz` endpoints were implemented or tested in Scenario 3.

## Reliability measurements

| Measurement | Definition | Current evidence |
| --- | --- | --- |
| Detection interval | Failure reference time to first detection | Approximately `423 ms` for the recorded local run |
| Mean time to detect (MTTD) | Average detection interval across incidents | Requires multiple incident measurements |
| Mean time to recovery (MTTR) | Average time from a defined incident start to verified service restoration | Not established by this run |
| Availability | Successful service time or successful eligible requests divided by the corresponding total | Requires a defined observation window and success criterion |

Database reconnection is useful evidence, but recovery should be confirmed with a successful query and fresh results. No recovery timestamp from this same measured outage was supplied, so recovery duration is not calculated.

## Validation summary

- Confirmed in the recorded local output: structured database failure logging.
- Confirmed in the recorded HTTP check: matching response and completion-log request IDs, status `200`, and duration `7.27 ms`.
- Calculated from the supplied timestamps: approximately `423 ms` from stop-command initiation to the first failure log.
- Not independently verified from the older ZIP: the final Scenario 3 source, metric export, health/readiness endpoints, or automatic recovery for this measured outage.

The experiment demonstrates observable database failure and HTTP log correlation. It does not establish production alerting, distributed tracing, or long-term reliability statistics.
