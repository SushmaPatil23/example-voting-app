# On-Call Reflection: A Database Failure at 2:00 AM

If I were on call for this application at 2:00 AM and PostgreSQL suddenly failed, my first priority would be to restore useful service while protecting data and keeping users informed. This project taught me that a running container does not necessarily mean a working application. The Result service can remain alive even when it cannot retrieve or display current vote totals.

## How I would know

In production, I would use an external check that connects to the Result service and verifies that it receives valid scores within a defined deadline. Repeated failures would trigger an alert. The project defines this monitoring approach, but automatic paging is not implemented in the local lab. Here, I can detect the failure through the unavailable-results message, structured database error logs, and failing readiness checks. The recorded database-stop experiment detected an error approximately 423 ms after the stop command began, although one local measurement is not a guaranteed detection time.

I would compare `/healthz` and `/readyz`. Liveness returning 200 while readiness returns 503 suggests that the process is responding but its dependency check is failing. I would also check actual results delivery, because the current readiness probe tests `SELECT 1` and can succeed even when results polling has stopped.

## How I would respond

I would record the incident time and inspect `docker compose ps -a`, recent Result and Worker logs, the running image, and `/version`. Then I would check PostgreSQL connectivity, the application's vote query, blocked queries, and connection pressure. This would help distinguish an application regression from a database outage or resource problem.

If a new application release caused the failure and the previous image remained compatible with the database, I would use the documented digest-based rollback. If PostgreSQL itself was unavailable, changing the application image would not repair it. I would restore the dependency first and preserve its data volume. If data recovery were necessary, I would follow the tested backup-and-restore procedure and assess possible data loss against the proposed RPO.

After PostgreSQL became ready, I would restart Result and Worker as needed. The current Result implementation stops polling after runtime connection loss and requires manual recovery. During the outage, users should see “Results currently unavailable,” rather than old totals presented as current. Votes queued in Redis would need separate checks; queue acceptance alone does not prove persistence.

## How I would prove recovery

I would confirm healthy containers, successful probes, the intended application version, and the absence of continuing database errors. Then I would submit a controlled vote, verify its database persistence, and confirm that the browser displays the correct updated totals. I would also check a new browser connection and observe the system for recurring failures. A successful readiness response alone would not be sufficient.

Finally, I would record recovery time, actions taken, and any uncertain or lost votes. The complete lifecycle—design, build, test, observe, deploy, fail, recover, and improve—connects every part of this work. My next improvements would address results-aware readiness, bounded queries, controlled reconnection, durable queue handling, and automated alerts. The goal is to make the next incident easier to detect, safer to recover from, and possible to verify with evidence.
