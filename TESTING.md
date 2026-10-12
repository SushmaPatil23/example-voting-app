# Automated Testing for Failure Scenarios

## Purpose

This suite provides repeatable regression tests for the result service's
database failure behavior. Developers can run it after backend changes
to check whether healthy results, failure notifications, or polling
behavior have broken.

## Framework choice

I chose Jest because it includes assertions, mocking, and fake timers
in one framework.

Mocks let the tests simulate successful database queries and query errors.
Fake timers let the tests check polling behavior without waiting in real
time.

Vitest also provides integrated testing tools and has strong Vite
integration. This application does not use Vite.

Mocha provides flexibility in choosing supporting tools, but assertions,
mocking, and timer controls would require separate choices.

## Requirements and execution

The suite was run locally using Node.js 24.18.0.

From the repository root, install the locked dependencies:

```bash
npm ci
```

Run all tests with one command:

```bash
npm test
```

Docker and a running PostgreSQL database are not required for this suite.

The root package.json manages testing dependencies. The separate
result/package.json manages the result service's dependencies.

Commit package.json and package-lock.json. Do not commit node_modules.

## Test files

| File | Purpose |
| --- | --- |
| tests/helpers/backend.js | Runs the actual backend with injected database and network dependencies |
| tests/backend.test.js | Tests healthy scores, query failure, stopped polling, and the recovery policy |
| tests/frontend.test.js | Tests the actual Angular view in jsdom with simulated socket events |

## Covered scenarios

| Test | Expected behavior |
| --- | --- |
| Successful connection | A simulated successful connection leads to a query and a JSON scores event containing numeric, non-zero values |
| Query failure after success | Only db-unavailable is emitted after failure; no stale scores are emitted and polling stops |
| Frontend receives scores | The view displays 75.0%, 25.0%, and 4 votes for scores a=3 and b=1 |
| Frontend receives unavailable | The warning appears and old percentages and the vote total are removed |
| Recovery policy | Restoring the simulated database does not resume stopped polling; a fresh backend instance produces scores |

Local execution result: 2 test suites passed, 5 tests passed.

## Test design

The backend helper executes the actual result/server.js in a fresh Node.js
VM context. It injects controlled PostgreSQL, Express, HTTP, and Socket.IO
dependencies. The actual async.retry implementation is used.

The frontend tests load the actual index.html, bundled Angular library,
and app.js into jsdom. An EventEmitter simulates incoming socket events.

The tests use:

- Assertions to check event names, payloads, query counts, and DOM content.
- Stubs to return controlled database results or errors.
- Jest mock functions to record calls.
- Failure injection to make a query fail deliberately.
- Inline fixtures containing predictable vote rows.
- Fake timers to advance polling time deterministically.
- Fresh backend or browser instances to isolate test state.
- Cleanup hooks to remove timers and close jsdom after tests.

## Recovery policy

The current backend retries initial database connections. However, after
a query error, its polling function returns without scheduling another
query.

Automatic recovery after a query failure is outside this implementation.
This testing change preserves the existing backend behavior. Adding
recovery would require a reconnect policy, retry timing, resource cleanup,
and additional tests.

Once the database and required votes table are available, restart the
result service:

```bash
docker compose restart result
```

Refreshing the browser alone does not restart backend polling.

The recovery test models a restart by creating a fresh backend instance.
It does not execute a Docker restart.

## Scope and limitations

These are isolated backend component tests and frontend DOM tests.
The frontend tests integrate the actual controller, Angular, and HTML.

The suite does not use a real PostgreSQL connection or a real Socket.IO
network connection. The frontend receives simulated events independently
of the backend tests.

Therefore, the suite does not prove:

- Real database connectivity or SQL/schema correctness.
- Delivery of events across a real network.
- A complete voting journey through vote, Redis, worker, and PostgreSQL.
- Real-browser rendering or CSS appearance.

A full end-to-end test would require the application stack and a real
browser automation tool.

The no-stale-scores and stopped-polling checks cover the query-error
callback path. They do not cover every asynchronous connection-error
race. The existing connection-error handler does not cancel an already
scheduled poll or invalidate an in-flight query.

The current backend also has no explicit query deadline. These tests
do not prove that a hung database query eventually reports unavailable.

The frontend tests verify removal of percentages and the vote total.
They do not verify that background bar widths are cleared.

## Node.js asynchronous considerations

Tests must await or return asynchronous promises so assertions are not
executed after the test has already finished.

Never-settling operations can leave work pending indefinitely. Starting
unlimited asynchronous operations can also exhaust memory or database
connections. Application timeouts, concurrency limits, and cleanup are
separate responsibilities from the test framework.

Long synchronous work or continuously queued microtasks can starve the
event loop, delaying timers and I/O callbacks. Fake timers verify
scheduling decisions; they do not measure real event-loop responsiveness.

A Jest timeout does not cancel underlying database work and cannot
interrupt a synchronous infinite loop on the same thread.

## CI execution

The suite can run in CI with:

```bash
npm ci
npm test -- --ci
```

A failing test causes the test command to return a nonzero exit status.

A CI workflow has not been added as part of these step-by-step changes.

## References

- Jest assertions: https://jestjs.io/docs/expect
- Jest mocks: https://jestjs.io/docs/mock-functions
- Jest timers: https://jestjs.io/docs/timer-mocks
- Jest asynchronous tests: https://jestjs.io/docs/asynchronous
- Vitest: https://vitest.dev/guide/
- Mocha: https://mochajs.org/
- Node.js event loop:
  https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick