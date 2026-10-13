# Automated Testing for Failure Scenarios

## Purpose

This suite provides repeatable regression tests for the result service's
database failure behavior. Developers can run it after backend changes
to check whether healthy results, failure notifications, stale-score
prevention, or polling behavior have broken.

## Framework choice

I chose Jest because it includes assertions, mocking, and fake timers
in one framework.

Mocks let the tests simulate successful database queries, query failures,
and connection-loss events. Fake timers let the tests check polling
behavior without waiting in real time.

Vitest also provides integrated testing tools and has strong Vite
integration. This application does not use Vite.

Mocha provides flexibility in choosing supporting tools. Node.js assertions
and a library such as Sinon could provide equivalent checks, but Jest
includes the tools needed for this suite.

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

The root `package.json` manages testing dependencies. The separate
`result/package.json` manages the result service's dependencies.

Commit `package.json` and `package-lock.json`. Do not commit `node_modules/`.

## Test files

| File | Purpose |
| --- | --- |
| `tests/helpers/backend.js` | Executes the actual backend with controlled database and network dependencies |
| `tests/fixtures/database.js` | Creates fresh healthy results, query errors, and connection-loss errors |
| `tests/backend.test.js` | Tests healthy scores, query failure, connection loss, stopped polling, late results, new browser connections, and the recovery policy |
| `tests/frontend.test.js` | Tests the actual Angular view in jsdom using simulated socket events |

## Covered scenarios

| Test | Expected behavior |
| --- | --- |
| Successful connection | A simulated successful connection leads to a query and a JSON scores event containing numeric, non-zero values |
| Query failure after success | Only `db-unavailable` is emitted after failure; no stale scores are emitted and polling stops |
| Frontend receives scores | The view displays 75.0%, 25.0%, and 4 votes for scores `a=3` and `b=1` |
| Frontend receives unavailable | The warning appears and the old percentages and vote total are removed |
| Recovery policy | Restoring the simulated database does not resume stopped polling; a fresh backend instance produces scores |
| Connection loss | The backend emits `db-unavailable`, cancels its pending polling timer, and does not perform another scheduled query |
| Late query result | A successful result arriving after connection loss is ignored; no scores or new polling timer are produced |
| New browser after query failure | The connection handler immediately sends `db-unavailable` to the new socket |
| New browser after connection loss | The connection handler immediately sends `db-unavailable` to the new socket |

Verified local execution on 13 October 2026:

```text
Test Suites: 2 passed, 2 total
Tests:       9 passed, 9 total
```

## Test design

### Backend tests

The backend helper executes the actual `result/server.js` in a fresh
Node.js VM context. It injects controlled PostgreSQL, Express, HTTP,
and Socket.IO dependencies.

The actual `async.retry` implementation is used. The current tests
simulate successful initial connections; they do not test startup retry
timing or retry exhaustion.

The simulated PostgreSQL client supports both:

- Query callbacks that return controlled results or errors.
- Connection-loss events delivered through its `error` event.

The Socket.IO double records outgoing events. New-browser tests invoke
the actual connection handler with a simulated socket.

No real HTTP server, database connection, or network socket is opened.

### Frontend tests

The frontend tests load the actual `index.html`, bundled Angular library,
and `app.js` into jsdom.

An EventEmitter simulates incoming Socket.IO events. Assertions check
the resulting DOM content, including percentages, vote totals, and the
unavailable message.

jsdom simulates a browser document; it is not a real browser.

### Fixtures and isolation

`tests/fixtures/database.js` provides factory functions for healthy query
results, query failures, and connection-loss errors. Each call creates
a fresh value. Some earlier tests also use inline vote fixtures.

Each backend test creates a fresh VM context. Each frontend test creates
a fresh jsdom instance.

Cleanup hooks remove fake timers, restore real timers, and close jsdom.
This prevents application state and scheduled work from leaking between
tests.

## Testing concepts applied

| Concept | Application in this suite |
| --- | --- |
| Unit testing | Individual behaviors are checked using controlled dependencies; backend tests exercise these through the service entry point |
| Integration testing | Frontend tests exercise the actual Angular controller, library, and HTML together in jsdom |
| End-to-end testing | Not included; it would require the complete application stack and real browser automation |
| Mocking | Jest mock functions record database calls and outgoing socket events |
| Stubbing | Database operations return predefined results or errors |
| Dependency injection | The helper supplies infrastructure dependencies through the VM context's `require` function |
| Test fixtures | Predictable vote rows and failure objects provide repeatable inputs |
| Test isolation | Fresh application state and cleanup prevent tests from interfering |
| Regression testing | Assertions protect failure behavior against later code changes |
| Failure injection | Tests deliberately cause query errors and connection-loss events |
| Contract testing | Local assertions check event names and the JSON scores payload; this is not a separate consumer/provider contract-verification system |
| Test doubles | Simulated database, HTTP, and socket collaborators replace external infrastructure |
| Assertions | Checks compare actual events, query counts, timer counts, and DOM content against expectations |
| CI test execution | The suite can run non-interactively and return a nonzero exit status when a test fails |

## Connection-loss regression and fix

The connection-loss test initially failed:

```text
Expected number of calls: 1
Received number of calls: 2
```

The backend reported the database as unavailable but left a polling
timer active. That timer executed another query after connection loss.

The backend was updated to:

1. Store the pending polling timer.
2. Mark the database unavailable and cancel the timer on failure.
3. Prevent queries from starting while the database is unavailable.
4. Ignore query callbacks arriving after connection loss.
5. Notify browsers through `db-unavailable`.

All nine tests passed after the fix and the additional regression tests
were added.

The callback guard ignores a late result. It does not cancel the
underlying database operation.

## Recovery policy

The current backend retries initial database connections. After a query
failure or connection-loss event, polling stops and does not restart
automatically.

Automatic recovery after these failures is outside this implementation.
Adding it would require a reconnect policy, retry timing, connection
cleanup, and further tests for old callbacks arriving during recovery.

The restart-based recovery policy is unchanged. The connection-loss fix
ensures polling stops reliably and late results cannot emit scores after
the unavailable notification.

Once the database and required `votes` table are available, restart the
result service:

```bash
docker compose restart result
```

Refreshing the browser alone does not restart backend polling.

The recovery test models a restart by creating a fresh backend instance.
It does not execute a Docker restart.

The restart command assumes the container already contains the intended
code. After source changes, rebuild and recreate the result service:

```bash
docker compose up -d --build result
```

## Scope and limitations

These are isolated backend component tests and frontend DOM tests.

The suite does not use a real PostgreSQL connection or a real Socket.IO
network connection. The frontend receives simulated events independently
of the backend tests.

Therefore, the suite does not prove:

- Real database connectivity or SQL/schema correctness.
- Delivery of events across a real network.
- A complete voting journey through vote, Redis, worker, and PostgreSQL.
- Real-browser rendering or CSS appearance.
- Startup connection retry timing or retry exhaustion.

A full end-to-end test would require the application stack and a real
browser automation tool.

Regression tests cover query failures, scheduled polling after connection
loss, and a successful query callback arriving after connection loss.
They do not establish correctness for every possible driver or network
failure sequence.

The backend has no explicit query deadline. These tests do not prove that
a hung database query eventually reports unavailable. Database client
release and pool shutdown are also outside the current suite.

The frontend tests verify removal of percentages and the vote total.
They do not verify that background bar widths are cleared.

## Node.js asynchronous considerations

Tests must await or return asynchronous promises so assertions are not
executed after the test has already finished.

A never-settling promise or a database callback that never arrives can
leave work pending indefinitely. Starting unlimited asynchronous
operations can also exhaust memory or database connections.

Application timeouts, concurrency limits, cancellation, and cleanup are
separate responsibilities from the test framework. A timeout that stops
waiting does not automatically cancel the underlying operation.

Long synchronous work or continuously queued microtasks can starve the
event loop, delaying timers and I/O callbacks. Declaring a function
`async` does not move CPU-heavy work off the JavaScript thread.

Fake timers verify scheduling decisions; they do not measure real
event-loop responsiveness.

The tests advance the clock by bounded durations rather than running
every timer in a recurring healthy polling loop.

A Jest timeout does not cancel underlying database work and cannot
interrupt a synchronous infinite loop on the same thread. CI should
also have an external job timeout.

## CI execution

The suite can run in CI with:

```bash
npm ci
npm test -- --ci
```

A failing test causes the test command to return a nonzero exit status.

A CI workflow has not been added as part of this implementation.
The successful results reported above are from local execution.

## Subtask mapping

| ID | Subtask | Coverage |
| --- | --- | --- |
| SUSHMA-12 | Set up backend unit-test framework | Jest configuration and `npm test` |
| SUSHMA-13 | Test healthy database behavior | Successful connection and non-zero scores test |
| SUSHMA-14 | Test database query failure | Query failure after a healthy result |
| SUSHMA-15 | Test database connection loss | Client error event and stopped polling |
| SUSHMA-16 | Test unavailable-results state | Frontend unavailable-message test |
| SUSHMA-17 | Test prevention of stale scores | Query-failure assertions and late-result regression test |
| SUSHMA-18 | Test polling stops after failure | Query-failure and connection-loss tests |
| SUSHMA-19 | Test new browser connection after failure | Separate cases for query failure and connection loss |
| SUSHMA-20 | Add failure-state test fixtures | `tests/fixtures/database.js` |
| SUSHMA-21 | Document backend test strategy | This document |

## References

- [Jest assertions](https://jestjs.io/docs/expect)
- [Jest mocks](https://jestjs.io/docs/mock-functions)
- [Jest timers](https://jestjs.io/docs/timer-mocks)
- [Jest asynchronous tests](https://jestjs.io/docs/asynchronous)
- [Vitest](https://vitest.dev/guide/)
- [Mocha](https://mochajs.org/)
- [Node.js event loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)