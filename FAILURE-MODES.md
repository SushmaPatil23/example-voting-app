# Failure -Mode Notes - Vote Application
 
**Environment:** Local Docker Compose, run from VS Code on Windows  
**Scope:** Five manual failure simulations and recovery observations. No application-code changes were made as part of these simulations.

These notes record the terminal output, screenshots and browser observations collected during the exercise. They describe current behaviour, not completed reliability fixes. Existing container images were used with `--no-build`; a clean rebuild was not validated.

## Application flow

Vote accepts a submission and adds it to Redis. Worker reads the queued vote and saves it in PostgreSQL. Result queries PostgreSQL and sends totals to the browser. Queue acceptance and database persistence are separate steps.

## Failure matrix

| Failure | Detection / backend behaviour | User experience | Operator signal | Recovery observed |
|---|---|---|---|---|
| PostgreSQL unavailable at Result startup | Initial connection fails; Result stays running and retries. | “Results currently unavailable.” | Repeated `Waiting for db`. | After DB started, Result logged `Connected to db` and totals returned without a browser refresh or Result restart. |
| PostgreSQL responds slowly | A 15-second table lock delays the vote-count query and Worker writes. No explicit Result query timeout is configured. | Previous totals remain visible during the delay. | SQL output confirmed `LOCK TABLE`, `pg_sleep` and `ROLLBACK`. No application slow-query warning was captured. | After a vote was changed during the lock, results updated automatically, approximately after the delay ended. |
| PostgreSQL connection lost after startup | Result logs connection/query errors and stops its polling chain. Worker exits with code 1. | Results stay unavailable even after DB restarts. | `Connection terminated unexpectedly`; client `is not queryable`; Worker reports PostgreSQL error `57P01`. | Restarting DB alone did not restore results. Manually restarting Result and Worker restored the results page. |
| Redis unavailable | Vote cannot complete its Redis write. Worker stays running and retries Redis connections. | Submission loads for a long time, then shows a Flask technical error page. | `POST /` returns HTTP 500; Redis `ConnectionError`; Worker logs `Waiting for redis`. | After Redis returned, reopening/refreshing the voting page and submitting again updated results. No Vote or Worker restart was reported. |
| PostgreSQL returns a query error | DB stays running, but renaming `votes` makes Result's SELECT fail. Polling stops. | “Results currently unavailable,” including after the table name is restored. | `Error performing query: error: relation "votes" does not exist`. | After restoring the table, restarting Result and starting Worker restored the results page. |

## 1. PostgreSQL unavailable at startup

**Simulation:** Stopped Result, Worker and DB, then started only Result with `--no-deps`. This bypassed Compose's DB health dependency so Result's own startup handling could be tested.

```bash
docker compose stop result worker db
docker compose up -d --no-deps result
```

**Partial functionality:** Vote and Redis remained running. Worker was deliberately stopped, so queued votes could not be processed. Successful vote persistence during the outage was not demonstrated.

**Retries:** Confirmed by repeated `Waiting for db`. The source permits up to 1,000 initial connection attempts with a 1-second delay after each failed attempt. Actual log intervals were about 5-9 seconds because attempts also took time. This is not exponential backoff or a 1,000-second overall deadline.

**Recovery:** Started DB only. The browser recovered automatically. Worker was subsequently started to restore processing.

**When to stop retrying:** Current startup retries stop on success or after 1,000 attempts. A future policy should bound elapsed time and distinguish temporary outages from permanent configuration errors. The exhaustion path was not tested.

## 2. PostgreSQL responds slowly

**Simulation:** Held an exclusive lock on `votes` for 15 seconds, then released it:

```bash
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "BEGIN; SET LOCAL lock_timeout = '5s'; LOCK TABLE votes IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(15); ROLLBACK;"
```

Changed the vote to the other option during the second run. Percentages updated automatically afterward. Changing an existing vote does not necessarily increase the total vote count.

**Partial functionality:** The voting page remained usable; reads and writes to the locked table were delayed. Existing results remained visible without a freshness warning.

**Retries:** This was a pending query completing after a delay, not a failed query being retried. Result schedules its next poll only after success.

**When to stop waiting/retrying:** Result currently has no explicit query deadline. A future timeout should bound the wait and mark results unavailable or stale; this exercise did not add one. The `lock_timeout` above applies only to the test session acquiring its lock, not to Result's query.

**Evidence limit:** Approximately 15-second recovery was reported from visual observation, not precisely measured. This models lock-induced latency, not a network timeout.

## 3. PostgreSQL connection lost after startup

**Simulation:** With results already updating, stopped only DB:

```bash
docker compose stop db
```

Result's container remained up, but its logs showed connection errors followed by a failed query. Worker exited with code 1. Starting DB again left results unavailable.

**Partial functionality:** Vote and Redis remained running, but Worker was no longer processing votes. Submission durability during this outage was not verified.

**Retries:** Result has no runtime reconnection loop. Its startup retry loop had already completed. Worker did not recover automatically in this run.

**When to stop retrying:** Do not reuse a broken connection. Any future reconnection policy should acquire a fresh connection with bounded retries. Current manual recovery was:

```bash
docker compose start db
# After PostgreSQL is available:
docker compose restart result worker
```

**Finding:** Process availability did not mean results were updating. Manual recovery restored the page; a separate fresh-vote persistence check was not explicitly confirmed for this case.

## 4. Redis unavailable

**Simulation:** Stopped Redis and attempted to change a vote:

```bash
docker compose stop redis
```

The request waited, then failed with HTTP 500. The screenshot showed `redis.exceptions.ConnectionError: Error -2 connecting to redis:6379. Name or service not known.` Worker continued logging connection attempts rather than exiting in this run.

**Partial functionality:** PostgreSQL and Result remained running. Vote's GET health check continued returning HTTP 200, although submissions were failing. The results page's appearance during the Redis outage was not explicitly confirmed.

**Retries:** Worker retried Redis connections. The Python traceback includes client retry handling, but the exact retry count was not measured. `Received vote` is logged before `rpush`, so it does not prove queue acceptance. Multiple submissions appear in the logs; an exact duration for one request cannot be reliably calculated from them.

**When to stop retrying:** User requests should have a bounded deadline and a clear failure response. Worker should avoid unbounded rapid retries. Any future automatic replay must account for whether a write might already have succeeded.

**Recovery:** Started Redis. The failed browser page did not recover itself. A fresh submission worked and appeared in results without a reported Vote or Worker restart. This proves new work could proceed; it does not prove every earlier failed/pending submission was recovered.

## 5. Backend dependency returns an error

**Simulation:** Stopped Worker, then temporarily renamed the table while PostgreSQL stayed running:

```bash
docker compose stop worker
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SET lock_timeout = '5s'; ALTER TABLE votes RENAME TO votes_failure_test;"
```

Result logged `relation "votes" does not exist` at `2026-10-12T06:58:13.161440583Z`. This tests an error response from a reachable dependency. Worker was stopped deliberately to avoid concurrent writes or table recreation; this was not a Worker crash.

**Partial functionality:** Vote and Redis were not stopped. Persistence was interrupted by the test setup, and results were unavailable. New submission behaviour was not separately verified.

**Retries:** Result stopped polling after the query error. Restoring the table alone did not resume polling.

**When to stop retrying:** A missing-table error needs correction; repeatedly running the unchanged query will not repair the schema. After correction, recovery needs a new query attempt. Current recovery required restarting Result.

```bash
docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER TABLE votes_failure_test RENAME TO votes;"
docker compose restart result
docker compose start worker
```

Existing rows were preserved by renaming the table back. The user confirmed results returned; a separate fresh-vote persistence check was not explicitly confirmed for this case.

## Findings and scope decision

- Startup DB retries worked, but runtime connection loss and query errors required manual Result recovery.
- Slow queries left previous totals visible without indicating that they were stale.
- Redis failure caused a long wait followed by a technical HTTP 500 page.
- A healthy container or successful GET check did not prove that vote submission and processing worked.
- No exact failure-detection/recovery targets, retry-exhaustion behaviour or vote-loss guarantees were validated.

This exercise remains documentation-only: it demonstrates and records existing behaviour. No reliability fixes or automated regression tests are claimed. The broader ticket contains separate implementation/testing tasks; these notes do not mark those tasks complete.

**Deliverable naming:** These notes include the requested failure matrix. If the company requires the exact filename `FAILURE-MODES.md`, save this document under that name in the repository.
