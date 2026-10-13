##   Docker image traceability

A Docker tag is a name for an image and can be moved to a different image. For example, `latest` does not guarantee that a deployment will use the same image on a later pull.

A commit-SHA tag, such as `sha-<full-git-commit>`, makes it easier to identify which source commit produced an image. Docker’s metadata action supports generating a full-length SHA tag. A tag is still a name, so the registry must enforce tag immutability if the tag itself must not be overwritten.

An image digest, such as `image@sha256:<digest>`, identifies the image content and is the reference to record and deploy when the exact same image must be used again.

For each deployment, record the source commit SHA, the image tag, and the image digest together. Use the digest for deployment and rollback.

##— Candidate image smoke test

1. Build and publish a candidate Result image from a specific Git commit.
2. Record the full Git commit SHA, image tag, and registry digest.
3. Deploy the candidate to a staging environment using
   `repository@sha256:<digest>`, not a mutable tag such as `latest`.
4. Verify that `/version` reports the expected version and commit.
5. Verify `/healthz` returns HTTP 200 and `/readyz` returns HTTP 200.
6. Check that the Result page loads and that a test vote appears in the results.
7. Record the image digest and command output or screenshots for each check.
8. Shift production traffic only after all checks pass. Keep the previous
   production digest recorded for rollback.

A local Docker Compose test can validate a candidate, but Compose does not
provide gradual traffic shifting. Record the traffic-shift step for the
deployment platform used by the release.

##  — Backend deployment validation checklist

### Before deployment

- [ ] Record the source Git commit SHA.
- [ ] Record the candidate image tag and registry digest.
- [ ] Confirm the candidate image was built from the intended commit.
- [ ] Confirm required configuration is available and secrets are not stored in the image or logs.
- [ ] Confirm PostgreSQL and other required dependencies are healthy.
- [ ] Confirm any database changes are backward-compatible with the current application version.
- [ ] Complete the candidate image smoke test in staging.

### During deployment

- [ ] Deploy the exact candidate image digest.
- [ ] Confirm the new container starts and passes its readiness check.
- [ ] Confirm `/version` reports the expected version and commit.
- [ ] Confirm `/healthz` and `/readyz` return the expected status.
- [ ] Confirm the deployment rollout completes before shifting traffic.

### After deployment

- [ ] Check application logs for startup errors, database errors, or repeated restarts.
- [ ] Verify a test vote appears in the results.
- [ ] Monitor HTTP 5xx responses, request latency, and availability.
- [ ] Confirm the previous known-good image digest is recorded for rollback.
- [ ] Record the deployment time, candidate digest, test results, and operator.

## SUSHMA-34 — Application rollback runbook

### Purpose

Restore the last known-good Result application image when a deployment fails validation or causes a production incident.

### Rollback triggers

Start this runbook if the candidate image:

- Fails its readiness or smoke test.
- Fails to complete its rollout.
- Causes a sustained increase in HTTP 5xx responses or latency.
- Repeatedly restarts or produces database errors after deployment.

### Before deployment

Record these values before each release:

- Namespace: `<namespace>`
- Deployment: `result`
- Container: `result`
- Candidate image: `<repository>@sha256:<candidate-digest>`
- Known-good image: `<repository>@sha256:<known-good-digest>`
- Known-good commit: `<commit-sha>`

Do not use `latest` as the rollback target.

# SUSHMA-34 — Application Rollback Runbook

## Purpose

Restore the last known-good Result application image when a deployment fails validation or causes a production incident. This runbook covers rollback of the application image. It does not perform a database schema rollback.

## Scope and assumptions

- Kubernetes Deployment: `result`
- Container name: `result`
- Label selector: `app=result`
- Commands assume `kubectl` is configured for the intended cluster and namespace.
- The supplied Result Deployment currently has one replica. Image replacement may briefly interrupt service; this runbook does not claim zero downtime.
- The project does not currently include a database migration rollback procedure.

## Required release record

Before deployment, record these values in the release notes or incident record:

| Value | Example or source |
|---|---|
| Namespace | `<namespace>` |
| Failed commit SHA | `/version` response or release record |
| Failed image reference | `<repository>@sha256:<failed-digest>` |
| Known-good commit SHA | Previous verified release |
| Known-good image reference | `<repository>@sha256:<known-good-digest>` |
| Deployment time | UTC timestamp |

Do not use `latest` as the rollback target. Use the exact known-good image digest.

## Rollback triggers

Start rollback when one or more of these conditions is met:

- The candidate image fails its smoke test or readiness check.
- The Deployment does not complete within the expected rollout time.
- The candidate repeatedly restarts or reports application startup errors.
- HTTP 5xx responses or request latency rise and correlate with the deployment.
- A critical application function, such as displaying current vote results, fails after deployment.

First check whether the fault is in the application release, PostgreSQL, or another dependency. If the database or infrastructure is the cause, image rollback alone may not resolve the incident.

## Procedure

### 1. Stop further rollout

Stop promoting the candidate and stop any additional traffic shift. Keep the failed release available for investigation; do not delete its image or logs.

### 2. Capture the current state

Replace `<namespace>` with the release namespace:

```bash
kubectl rollout history deployment/result -n <namespace>
kubectl get deployment/result -n <namespace> -o wide
kubectl get pods -l app=result -n <namespace> -o wide
kubectl logs deployment/result -n <namespace> --tail=100
```

Record the output with the incident time, failed commit, candidate digest, and symptoms.

### 3. Roll back to the known-good image digest

Replace the placeholder with the exact previously verified digest:

```bash
kubectl set image deployment/result result=<repository>@sha256:<known-good-digest> -n <namespace>
```

Wait for the Deployment to finish:

```bash
kubectl rollout status deployment/result -n <namespace> --timeout=120s
```

If the rollout does not complete, keep the incident active, collect Pod events and logs, and use the platform’s incident escalation path. Do not report rollback success while the rollout is still failing.

### 4. Verify the restored release

Check that the Deployment has ready Pods and the Result container uses the known-good image:

```bash
kubectl get deployment/result -n <namespace> -o wide
kubectl get pods -l app=result -n <namespace> -o wide
kubectl get pods -l app=result -n <namespace> -o jsonpath="{.items[*].spec.containers[?(@.name=='result')].image}"
```

From a machine that can reach the service, verify:

```bash
curl -i https://<result-service>/healthz
curl -i https://<result-service>/readyz
curl -i https://<result-service>/version
```

Confirm `/healthz` and `/readyz` return HTTP 200, `/version` reports the known-good commit, and a test vote appears in the results. Keep traffic on the restored release only after these checks pass.

### 5. Monitor and close the rollback

Monitor application logs, HTTP 5xx responses, latency, and database errors. Record the rollback start and finish times, the restored digest, verification results, and the operator. Preserve the failed candidate’s logs and evidence for root-cause analysis.

## Database schema handling

Application image rollback does not reverse database schema changes. Do not run a schema downgrade unless a reverse migration has been tested and is safe for the current data. Prefer backward-compatible, additive schema changes so the previous application version can continue to operate. If a destructive migration has already run, follow a tested database recovery plan or prepare a forward fix; do not assume that restoring the old image will restore the database.

The current project has no migration rollback procedure, so this exercise validates application image rollback only.

## Rollback record

| Field | Record |
|---|---|
| Incident or exercise date/time (UTC) | `<fill in>` |
| Failed commit SHA and digest | `<fill in>` |
| Restored commit SHA and digest | `<fill in>` |
| Rollback start and finish time | `<fill in>` |
| `/healthz`, `/readyz`, `/version` results | `<fill in>` |
| Functional smoke test result | `<fill in>` |
| Operator and follow-up actions | `<fill in>` |
