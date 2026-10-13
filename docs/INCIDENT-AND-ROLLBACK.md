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