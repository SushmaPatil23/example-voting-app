# Health and Readiness Probes

## Endpoint contracts

| Endpoint | Contract |
|---|---|
| `GET /healthz` | Returns HTTP 200 with `{"status":"alive"}` when the Node.js service can handle the request. It does not check PostgreSQL. |
| `GET /readyz` | Runs a bounded `SELECT 1` through the PostgreSQL pool. Returns HTTP 200 when the check succeeds; returns HTTP 503 with a structured error if PostgreSQL is unavailable, the check exceeds 500 ms, or the pool is saturated. |

Docker Compose checks `/readyz` every 10 seconds, with a 2-second timeout and 3 retries. A failed readiness check marks the container unhealthy; it does not restart the process or route traffic away by itself.

## Expected behavior

| Scenario | `/healthz` | `/readyz` | Expected container behavior |
|---|---|---|---|
| Normal load | 200 | 200 | Healthy |
| PostgreSQL down or paused | 200 | 503 | Remains running; becomes unhealthy after repeated failed checks |
| Slow database check over 500 ms | 200 | 503 | Remains running; becomes unhealthy after repeated failed checks |
| Process event loop deadlock | Request times out | Request times out | Becomes unhealthy because the readiness check cannot complete |

Normal operation and the paused-database scenario were tested. Slow database and event-loop deadlock behavior are expected outcomes and were not simulated.

## Validation evidence

With PostgreSQL running, `/healthz` returned HTTP 200 with `{"status":"alive"}`, and `/readyz` returned HTTP 200 with `{"status":"ready","checks":{"database":"ok"}}`. Compose reported both `db` and `result` as healthy.

After running `docker compose pause db`:

- `/healthz` returned HTTP 200.
- `/readyz` returned HTTP 503 with `DATABASE_UNAVAILABLE`.
- Compose reported Result as unhealthy while it remained running.
- `docker inspect` reported `status=running health=unhealthy restarts=0`.

After running `docker compose unpause db`, `/readyz` returned HTTP 200 again. Compose later reported both `db` and `result` as healthy, and Result healthcheck logs showed successful checks.

## Commands used

```cmd
docker compose pause db
curl.exe -i http://localhost:8081/healthz
curl.exe -i http://localhost:8081/readyz
docker compose ps
docker inspect --format "status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}}" example-voting-app-result-1
docker compose unpause db