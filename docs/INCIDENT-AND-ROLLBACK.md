## Graceful shutdown verification

The Result service was started with Node.js as the container process and stopped with Docker sending `SIGTERM`.

Test commands:

```cmd
docker compose run -d --name result-shutdown-test --no-deps --entrypoint node result server.js
docker stop -t 6 result-shutdown-test
docker logs result-shutdown-test
docker rm result-shutdown-test

Observed logs included application_shutdown_started with signal SIGTERM, followed by application_shutdown_completed. Shutdown completed within the five-second limit.
The regular development Compose service runs through Nodemon. The shutdown-handler test used Node.js directly as the container process.

That records the test accurately without implying the Nodemon-based stop produced the shutdown logs.

# Production Failure Playbook and Rollback Strategy

## Scope and verified results

This runbook covers the example-voting-app Result backend and the six Epic 5 production-reliability subtasks. Commands were exercised from Windows Command Prompt in the repository root on 13 October 2026.

The deployment uses Docker Desktop and Docker Compose. It is a local operational drill, not a highly available production deployment. Production recommendations and reliability targets below are proposals unless explicitly identified as tested.

| Verification | Observed result |
| --- | --- |
| Regression suite before building v1 | 2 suites passed; 9 tests passed |
| SIGTERM with an existing PostgreSQL query | Query finished successfully; pool closed; exit code 0 |
| Time from SIGTERM to shutdown completion | 1.420 seconds |
| Deliberately broken v2 | Container unhealthy; HTTP 503 from /readyz |
| Rollback to v1 | Container healthy; /readyz 200; /healthz 200 |
| Rollback command to healthy readiness | 6.943 seconds |
| Restored image | Exact v1 digest; no source-code mounts |
| Database backup | pg_dump exit code 0; custom-format archive readable |
| Restore read-back | Source and test database both returned a = 1 and b = 1 |

The rollback duration starts immediately before the rollback command and ends when Compose reports the service healthy. It excludes detection time and the manual inspection interval. Total outage duration was not measured. Browser rendering and a new vote-to-results transaction were not confirmed in the submitted terminal evidence.

## The 2:00 AM on-call runbook — SUSHMA-42

### 1. Detection

Proposed paging rules:

- Run an external results check every 10 seconds. Page after three consecutive failures to connect and receive a valid Socket.IO scores event within two seconds.
- Page when user-facing service errors exceed 5% over five minutes, provided there are at least 20 eligible requests. For low traffic, use the synthetic check.
- Alert on sustained vote-processing failures or a growing Redis queue when the Worker is not consuming votes.
- Treat three failed readiness checks as a deployment-health signal. Correlate this with the external check and recent deployment history.

The Result Compose health check calls /readyz every 10 seconds, has a two-second timeout, three retries, and a 15-second start period. Health status alone does not send a page: an alerting system must be configured separately. These paging rules were specified, not deployed in this exercise.

### 2. Triage: the first five minutes

**Minute 0–1: identify scope and the running version.**

```cmd
docker compose ps -a
docker inspect --format "{{.Config.Image}}" example-voting-app-result-1
docker inspect --format "{{json .State.Health}}" example-voting-app-result-1
curl -i http://localhost:8081/healthz
curl -i http://localhost:8081/readyz
curl --fail http://localhost:8081/version
```

Compare the running digest and commit with the deployment record. A live process is not proof that results are available.

**Minute 1–2: inspect recent application and dependency logs.**

```cmd
docker compose logs --since 5m --timestamps --tail 100 result worker db redis
```

Look for startup failures, HTTP 503s, database query failures, connection errors, or a Worker that has exited. Structured events include application_start, database_connected, database_connection_failed, database_query_failed, and http_request_completed. Readiness errors use a generic response; they do not expose the underlying SQL error to clients.

**Minute 2–3: distinguish application failure from database infrastructure failure.**

```cmd
docker compose exec -T db pg_isready -U postgres -d postgres
docker compose exec -T db psql -U postgres -d postgres -c "SELECT 1;"
docker compose exec -T db psql -U postgres -d postgres -c "SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote;"
```

A successful SELECT 1 confirms a basic database query works. The votes query additionally checks the application's table and aggregation.

**Minute 3–4: check blocked queries and connection pressure.**

```cmd
docker compose exec -T db psql -U postgres -d postgres -c "SHOW max_connections;"
docker compose exec -T db psql -U postgres -d postgres -c "SELECT state, COUNT(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY state;"
docker compose exec -T db psql -U postgres -d postgres -c "SELECT pid, application_name, state, wait_event_type, wait_event, now() - query_start AS query_age FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();"
```

PostgreSQL connection counts do not directly expose the Node.js pool's waiting queue. Pool diagnosis also needs pool.totalCount, pool.idleCount, and pool.waitingCount through internal telemetry. Their export is not demonstrated here. The existing readiness handler checks pool pressure, but its generic failure response does not distinguish saturation from other database failures.

| Evidence | Likely direction | Immediate response |
| --- | --- | --- |
| Failure begins after deploying a new digest; database checks succeed | Application regression | Check schema compatibility, then roll back Result |
| Queries wait on locks or Node pool requests queue | Lock contention or pool exhaustion | Identify the blocking workload or leaked clients; do not restart PostgreSQL blindly |
| Database container is unavailable or basic queries fail | Downstream infrastructure | Restore dependency connectivity/availability; an application-image rollback may not fix it |
| Docker CLI cannot reach its engine | Container host/control-plane issue | Resolve the engine/host issue before application commands |

For this Windows lab, a missing Docker Desktop Linux-engine named pipe was resolved by starting Docker Desktop:

```cmd
docker desktop start
docker info --format "{{.ServerVersion}}"
```

**Minute 4–5: choose the recovery action.** If the new application image is responsible and the old version remains compatible with the database, execute the rollback below. Preserve short diagnostic logs first when this does not delay recovery. Record timestamps; communicate and escalate through the team's established incident process.

### 3. Rollback: one command

From the repository root, with the checked-in rollback configuration and the v1 environment file:

```cmd
docker compose --env-file rollback-v1.env -f docker-compose.yml -f docker-compose.rollback.yml up -d --no-deps --no-build --wait --wait-timeout 60 result
```

rollback-v1.env must contain the exact known-good reference:

```dotenv
RESULT_IMAGE=localhost:5000/vote-result@sha256:beff496c00eba1e32854acf41087793da0e26fe3571aeb1a3abf66240cf44f05
```

The command recreates only Result when its image changes and waits for readiness. It does not rebuild code or recreate the database. Avoid a conflicting RESULT_IMAGE shell variable, since shell variables take precedence over an env file.

A production deployment must retain the known-good image in an accessible, authenticated registry. This drill's localhost registry is tied to the same machine and is not a production recovery service.

### 4. Verification

```cmd
curl --fail http://localhost:8081/healthz
curl --fail http://localhost:8081/readyz
curl --fail http://localhost:8081/version
docker inspect --format "{{.Config.Image}}" example-voting-app-result-1
docker inspect --format "{{json .Mounts}}" example-voting-app-result-1
docker compose logs --since 2m --timestamps --tail 50 result
```

Expected:

- /healthz returns 200 with status alive.
- /readyz returns 200 with database ok.
- /version reports commit 3a60b31f0f26944a1e172952619be1d07bbb04b2.
- Config.Image matches the v1 digest above.
- Mounts are [] for this Result deployment.

Then open the results page and verify that valid totals load. For end-to-end acceptance, submit a controlled test vote and confirm its corresponding PostgreSQL row and results update. Readiness uses SELECT 1, so it does not by itself validate the votes table, polling, Worker processing, or browser delivery.

Continue observing the service after recovery and record the incident timeline, cause, impact, and follow-up actions.

## Immutable versioning and safe rollback

A mutable tag such as latest may be overwritten, so it does not reliably identify the previous release. Rollback remains possible if the earlier image digest has been retained. Git-SHA tags aid traceability, but tags themselves must be protected against reassignment; deployment by digest pins the exact artifact.

| Image | Source/build-recipe commit | Registry digest |
| --- | --- | --- |
| v1, working | 3a60b31f0f26944a1e172952619be1d07bbb04b2 | sha256:beff496c00eba1e32854acf41087793da0e26fe3571aeb1a3abf66240cf44f05 |
| v2, intentional readiness failure | cb54ed69f38c7d65df1473196fa5e0997101a20f | sha256:70cfdd9473d1dd7a7029c3f6cb8f91ad877d6438b22e0a4e7472cfffa2f04239 |

v2 was derived from the pinned v1 image using a committed drill Dockerfile. It changed the readiness SQL to call a nonexistent function. Application source files were not edited to introduce this failure.

### Database schema compatibility

An application-image rollback does not undo database migrations or recover deleted data.

- Prefer backward-compatible expansion: add nullable columns or new tables while retaining fields used by the previous application.
- Migrate and validate data before switching all callers. Remove old fields only after the rollback window has closed.
- Before rollback, check whether the old image can read and write the current schema.
- A dropped column/table, incompatible rename, or destructive data conversion can make image rollback unsafe. Use a reviewed forward repair or restore procedure appropriate to the incident. Restoring an older backup can discard later writes.
- This drill performed no schema migration. Its rollback retained the existing PostgreSQL data.

## Graceful shutdown and connection draining

The Result service handles SIGTERM and SIGINT through one idempotent shutdown function. It marks shutdown in progress, stops further polling, and closes Socket.IO using io.close(). Socket.IO also closes the underlying HTTP server; this covers HTTP server closure while disconnecting persistent Socket.IO clients.

The service waits for the tracked polling query to finish and for HTTP closure before releasing its acquired PostgreSQL client and awaiting pool.end(). Normal completion permits a natural process exit with code 0. A five-second deadline destroys the checked-out client and exits with code 1 on timeout; pool-closure failure also records a failure exit code.

The rollback override gives Docker a six-second stop grace period, longer than the application's five-second deadline. The development Compose service uses Nodemon; the signal test ran Node directly so the tested signal recipient was the application process.

### Executed SIGTERM proof

Start dependencies, build, and create a separate test container:

```cmd
docker compose up -d db redis worker
docker compose build result
docker compose run -d --name result-shutdown-test --no-deps --entrypoint node result server.js
docker logs --tail 20 result-shutdown-test
```

In a second terminal, open psql:

```cmd
docker compose exec db psql -U postgres -d postgres
```

Hold a transaction lock:

```sql
SET application_name = 'shutdown-drill-lock';
BEGIN;
LOCK TABLE votes IN ACCESS EXCLUSIVE MODE;
```

Leave that session open. In the original terminal, confirm the polling query is blocked:

```cmd
docker compose exec -T db psql -U postgres -d postgres -c "SELECT pid, state, wait_event_type, wait_event FROM pg_stat_activity WHERE query LIKE 'SELECT vote,%';"
```

Observed: PID 167, state active, wait_event_type Lock, wait_event relation.

Send SIGTERM, wait one second, and release the lock by terminating only the named drill session:

```cmd
docker kill --signal=SIGTERM result-shutdown-test && timeout /t 1 /nobreak >nul && docker compose exec -T db psql -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'shutdown-drill-lock' AND pid <> pg_backend_pid();"
docker wait result-shutdown-test
docker logs --tail 15 result-shutdown-test
```

Observed exit code: 0. Relevant actual log output:

```json
{"timestamp":"2026-10-13T15:26:49.987Z","level":"info","service":"vote-result","event":"application_shutdown_started","signal":"SIGTERM","query_in_flight":true,"grace_period_ms":5000}
{"timestamp":"2026-10-13T15:26:51.407Z","level":"info","service":"vote-result","event":"database_query_finished_during_shutdown","operation":"fetch_vote_totals","outcome":"succeeded","duration_ms":87711.91}
{"timestamp":"2026-10-13T15:26:51.407Z","level":"info","service":"vote-result","event":"database_pool_closed"}
{"timestamp":"2026-10-13T15:26:51.407Z","level":"info","service":"vote-result","event":"application_shutdown_completed"}
```

Shutdown completed in 1.420 seconds. The 87,711.91 ms query duration includes its lock wait before the signal; it is not the shutdown duration.

Evidence was saved before removing the stopped container:

```cmd
docker logs result-shutdown-test > docs\graceful-shutdown-proof.log 2>&1
docker inspect --format "{{.State.ExitCode}}" result-shutdown-test > docs\graceful-shutdown-exit-code.txt
docker rm result-shutdown-test
```

This test demonstrates draining an existing database polling query. SIGINT, a separate long-running HTTP response, deadline expiry, and shutdown during startup connection retries were not separately exercised. Persistent Socket.IO sessions are disconnected during shutdown rather than preserved across the restart.

## Simulated image rollback: exact procedure

### Registry and v1

The local registry was started and verified:

```cmd
docker run -d --name rollback-registry -p 127.0.0.1:5000:5000 -v rollback-registry-data:/var/lib/registry registry:3
curl --fail http://localhost:5000/v2/
```

The API returned {}. The regression tests passed before building v1. After committing the shutdown logging and evidence, v1 was built and pushed:

```cmd
set "V1_SHA=3a60b31f0f26944a1e172952619be1d07bbb04b2"
docker build --build-arg GIT_SHA=%V1_SHA% --label org.opencontainers.image.revision=%V1_SHA% -t localhost:5000/vote-result:v1 ./result
docker push localhost:5000/vote-result:v1
docker image inspect --format "{{index .RepoDigests 0}}" localhost:5000/vote-result:v1
```

The rollback override, docker-compose.rollback.yml:

```yaml
services:
  result:
    image: ${RESULT_IMAGE:?Set RESULT_IMAGE using a rollback env file}
    build: !reset null
    entrypoint: ["/usr/bin/tini", "--"]
    command: ["node", "server.js"]
    volumes: !reset []
    stop_grace_period: 6s
```

It removes the source bind mount and build configuration, while retaining the base ports, networks, and readiness check. Node runs under Tini.

Deploy and verify v1:

```cmd
docker compose --env-file rollback-v1.env -f docker-compose.yml -f docker-compose.rollback.yml up -d --no-deps --no-build --wait --wait-timeout 60 result
curl --fail http://localhost:8081/readyz
curl --fail http://localhost:8081/version
```

### Intentional v2

The committed result/Dockerfile.rollback-drill:

```dockerfile
FROM localhost:5000/vote-result@sha256:beff496c00eba1e32854acf41087793da0e26fe3571aeb1a3abf66240cf44f05

# Intentionally break the readiness query for this drill.
RUN node -e "const fs = require('node:fs'); const file = 'health-probes.js'; const source = fs.readFileSync(file, 'utf8'); if (!source.includes('SELECT 1')) throw new Error('Expected readiness query missing'); fs.writeFileSync(file, source.replace('SELECT 1', 'SELECT intentional_rollback_failure()'));"

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
```

Build and push:

```cmd
set "V2_SHA=cb54ed69f38c7d65df1473196fa5e0997101a20f"
docker build -f result/Dockerfile.rollback-drill --build-arg GIT_SHA=%V2_SHA% --label org.opencontainers.image.revision=%V2_SHA% -t localhost:5000/vote-result:v2 ./result
docker push localhost:5000/vote-result:v2
docker image inspect --format "{{index .RepoDigests 0}}" localhost:5000/vote-result:v2
```

rollback-v2.env:

```dotenv
RESULT_IMAGE=localhost:5000/vote-result@sha256:70cfdd9473d1dd7a7029c3f6cb8f91ad877d6438b22e0a4e7472cfffa2f04239
```

Deploy v2 and preserve failure evidence:

```cmd
docker compose --env-file rollback-v2.env -f docker-compose.yml -f docker-compose.rollback.yml up -d --no-deps --no-build --wait --wait-timeout 60 result
curl -i http://localhost:8081/readyz
docker logs --tail 60 example-voting-app-result-1 > docs\rollback-v2-failure.log 2>&1
```

Compose reported the container unhealthy after approximately 36.7 seconds. The manual probe returned:

```text
HTTP/1.1 503 Service Unavailable
{"status":"not_ready","error":{"code":"DATABASE_UNAVAILABLE","message":"Database readiness check failed"}}
```

### Timed recovery

The following was executed as one Command Prompt line:

```cmd
powershell -NoProfile -Command "$timer=[Diagnostics.Stopwatch]::StartNew(); docker compose --env-file rollback-v1.env -f docker-compose.yml -f docker-compose.rollback.yml up -d --no-deps --no-build --wait --wait-timeout 60 result; $resultCode=$LASTEXITCODE; $timer.Stop(); if ($resultCode -ne 0) { exit $resultCode }; ('rollback_seconds={0:F3}' -f $timer.Elapsed.TotalSeconds) | Tee-Object -FilePath 'docs/rollback-timing.txt'"
```

Observed:

```text
Container example-voting-app-result-1 Healthy
rollback_seconds=6.943
```

Final verification returned:

```json
{"status":"ready","checks":{"database":"ok"}}
{"service":"vote-result","version":"1.0.0","commit":"3a60b31f0f26944a1e172952619be1d07bbb04b2"}
{"status":"alive"}
```

Config.Image matched the v1 digest and Mounts was []. No database migration or data-volume reset was performed.

Docker Compose marks unhealthy containers but does not automatically remove them from HTTP traffic. This drill measured restoration of healthy readiness at the local endpoint. Production traffic shifting requires a load balancer or orchestrator configured to respect readiness.

## Architecture review: single points of failure — SUSHMA-37

| Component | Current exposure | Failure impact | Proposed mitigation |
| --- | --- | --- | --- |
| PostgreSQL | One container and a host-local named volume | Results/processing unavailable; host or disk loss may lose data | Independent standby/failover plus validated off-host backups |
| Redis | One instance; no explicit durable /data mount in Compose | Submission/queue interruption; replacement may lose queued votes | Persistence with a durable volume; replication/failover; monitor queue processing |
| Result | One instance | Results delivery unavailable during failure/replacement | Multiple instances, readiness-aware routing, and Socket.IO scaling support |
| Vote | One instance | Vote submission unavailable | Multiple instances behind a load balancer |
| Worker | One instance | Votes stop reaching PostgreSQL | Restart supervision; verify processing semantics before adding concurrent workers |
| Container host | All local services share one machine | One host failure affects the entire stack | Independent hosts/failure domains and managed orchestration |

The application services have no explicit restart policy in the reviewed Compose configuration. depends_on with service_healthy controls startup ordering; it does not provide runtime failover. The rollback registry also shares this host.

## Database redundancy research — SUSHMA-38

PostgreSQL physical streaming replication supplies a standby with write-ahead log (WAL) records from the primary. Asynchronous replication is the default; replication lag can cause recent committed transactions to be absent when a standby is promoted. Synchronous replication waits for the required standby acknowledgement, increasing write latency and potentially blocking commits when required standbys are unavailable.

A production design needs independent primary/standby storage, monitoring of replication lag and WAL retention, a failover decision mechanism, fencing of the old primary, and an application connection endpoint that follows the writable primary. Two containers on the same host do not protect against host failure.

Replication does not replace backups: accidental deletions can be replicated. Retain recoverable backups and, when tighter recovery points are needed, archived WAL for point-in-time recovery (PITR). PostgreSQL replication, automatic failover, and PITR were researched, not implemented in this lab.

## Backup and recovery procedure — SUSHMA-39

### Tested backup

Run in Command Prompt so binary archive redirection is preserved:

```cmd
if not exist backups mkdir backups
docker compose exec -T db pg_dump -U postgres -d postgres -Fc > backups\vote-2026-10-13.dump
echo %ERRORLEVEL%
docker compose exec -T db pg_restore --list < backups\vote-2026-10-13.dump > docs\backup-archive-list.txt
type docs\backup-archive-list.txt
```

Observed pg_dump exit code: 0. The archive was created at 2026-10-13 15:52:47 UTC using PostgreSQL 15.19. It listed the public.votes table, table data, and votes_id_key constraint.

pg_dump takes a consistent single-database snapshot. Cluster-global objects, such as roles, require a separate plan; this exercise used the existing postgres role.

### Tested restore into a separate database

```cmd
docker compose exec -T db createdb -U postgres rollback_restore_test
docker compose exec -T db pg_restore -U postgres -d rollback_restore_test --no-owner --no-privileges --exit-on-error < backups\vote-2026-10-13.dump
echo %ERRORLEVEL%
docker compose exec -T db psql -U postgres -d postgres -c "SELECT vote, COUNT(*) AS count FROM votes GROUP BY vote ORDER BY vote;"
docker compose exec -T db psql -U postgres -d rollback_restore_test -c "SELECT vote, COUNT(*) AS count FROM votes GROUP BY vote ORDER BY vote;"
```

Both databases returned:

```text
 vote | count
------+-------
 a    |     1
 b    |     1
(2 rows)
```

Evidence was saved to backup-source-votes.txt and backup-restored-votes.txt in docs. This verifies aggregate read-back of the restored snapshot. Full row-by-row validation, complete service failover to the restored database, and database-recovery elapsed time were not measured.

### Proposed production recovery procedure

1. Preserve the failed database and logs where possible; determine whether the incident is availability loss, corruption, or accidental deletion.
2. Select a validated backup and recovery point. Check expected data loss against the RPO.
3. Provision an isolated compatible PostgreSQL target and restore schema/data. Recreate required roles, extensions, permissions, and configuration.
4. Where configured, replay archived WAL to the selected recovery point.
5. Validate rows, constraints, representative queries, application compatibility, and a controlled end-to-end vote.
6. Control writers before switching the application endpoint. Account for writes since the backup and queued Redis votes, then switch and verify.
7. Observe the recovered service and record actual RTO/RPO.

Schedule daily validated backups, retain a defined history, store protected copies outside the application host, monitor failures/backup age, and regularly test restores. The local backups folder remains in the same failure domain and is not an off-host disaster-recovery copy. No recurring backup schedule was implemented.

## Recovery objectives — SUSHMA-40

RPO is the maximum acceptable data-loss interval. RTO is the maximum acceptable time to recover the service. The following are proposed targets for this sample application, not contractual guarantees.

| Scenario | RPO target | RTO target | Required capability / evidence |
| --- | --- | --- | --- |
| Broken application deployment | No loss of committed PostgreSQL vote rows | 5 minutes from incident detection to verified service recovery | Retained compatible image, fast triage, digest rollback; command-to-readiness measured at 6.943 seconds |
| PostgreSQL data-volume loss | At most 24 hours | 30 minutes to provision, restore, switch, and verify | Latest valid backup snapshot no more than 24 hours old, off-host storage, monitored backup completion, tested recovery |

The deployment RPO applies to committed database rows; it does not promise that votes waiting in non-durable Redis survive every failure. Database restoration was tested on a small dataset within the existing PostgreSQL container, so it does not establish the 30-minute production RTO.

## Application SLI/SLO specification — SUSHMA-41

Each SLI is good events divided by all eligible events. Evaluate these proposed targets over a rolling 30-day window.

| SLI | Good event / denominator | Proposed SLO |
| --- | --- | --- |
| Results availability | Browser synthetic check connects and receives a valid scores event within 2 seconds / all attempted checks | At least 99.5% |
| HTTP response latency | Eligible valid user request succeeds within 500 ms / all eligible valid user requests | At least 95% |
| Vote processing | Controlled synthetic vote is reflected correctly in results within 5 seconds / all submitted synthetic votes | At least 99% |

For HTTP latency, exclude healthz, readyz, version, static assets, and deliberately invalid requests. Eligible server errors, timeouts, and connection failures count as bad events. Measure at the client/gateway boundary so failures that never reach the application are counted.

Validate score payload structure and correctness in the browser check. For vote-processing checks, use identifiable synthetic voter identities and verify the persisted vote plus displayed results without corrupting real voting data.

A 99.5% availability target leaves 0.5% of eligible checks as the error budget. If it is exhausted, prioritize recovery/reliability work and restrict unrelated risky releases according to an agreed team policy.

These are design specifications. Automated synthetic checks, alert routing, production telemetry collection, and 30-day SLO compliance were not demonstrated by this drill.

## Evidence and follow-up

| File | Purpose |
| --- | --- |
| graceful-shutdown-proof.log | Actual SIGTERM lifecycle and query-drain logs |
| graceful-shutdown-exit-code.txt | Exit code 0 |
| rollback-v2-failure.log | Broken-v2 application logs |
| rollback-timing.txt | Measured rollback_seconds=6.943 |
| backup-archive-list.txt | Backup schema/data contents |
| backup-source-votes.txt | Source vote totals |
| backup-restored-votes.txt | Restored vote totals |

Paths above are relative to this document in docs/. The backup is in ../backups/, and the Compose override/env files are in the repository root.

Remaining verification: browser totals and a new end-to-end vote, SIGINT, startup-retry shutdown, an active HTTP-response drain, timeout behavior, production alerting, independent-host recovery, and full restored-data validation. Preserve the working digest and this evidence before subsequent deployment changes.

## References

- [Docker: pulling images by immutable digest](https://docs.docker.com/reference/cli/docker/image/pull/)
- [Docker Compose: merge and reset configuration](https://docs.docker.com/reference/compose-file/merge/)
- [Docker Compose: production configuration](https://docs.docker.com/compose/how-tos/production/)
- [CNCF Distribution: deploying a registry](https://distribution.github.io/distribution/about/deploying/)
- [Node.js 18: HTTP server shutdown](https://nodejs.org/download/release/v18.20.8/docs/api/http.html)
- [Socket.IO: server close](https://socket.io/docs/v4/server-api/#serverclosecallback)
- [node-postgres: pooling and shutdown](https://node-postgres.com/features/pooling)
- [PostgreSQL 15: standby servers and replication](https://www.postgresql.org/docs/15/warm-standby.html)
- [PostgreSQL 15: continuous archiving and PITR](https://www.postgresql.org/docs/15/continuous-archiving.html)
- [PostgreSQL 15: pg_dump](https://www.postgresql.org/docs/15/app-pgdump.html)
- [PostgreSQL 15: pg_restore](https://www.postgresql.org/docs/15/app-pgrestore.html)
- [AWS Well-Architected: recovery objectives](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_planning_for_recovery_objective_defined_recovery.html)
- [Google SRE: implementing SLOs](https://sre.google/workbook/implementing-slos/)

