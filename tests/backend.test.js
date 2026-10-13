const { createBackend } = require('./helpers/backend');
const {
  healthyResult,
  queryFailure,
  connectionLoss
} = require('./fixtures/database');

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('successful connection produces valid non-zero scores', () => {
  const databaseResult = {
    rows: [
      { vote: 'a', count: '3' },
      { vote: 'b', count: '1' }
    ]
  };

  const backend = createBackend({
    query: (_sql, _parameters, callback) => {
      callback(null, databaseResult);
    }
  });

  expect(backend.connect).toHaveBeenCalledTimes(1);
  expect(backend.client.query).toHaveBeenCalledTimes(1);
  expect(backend.io.sockets.emit).toHaveBeenCalledTimes(1);

  const [eventName, payload] =
    backend.io.sockets.emit.mock.calls[0];

  expect(eventName).toBe('scores');
  expect(typeof payload).toBe('string');

  expect(JSON.parse(payload)).toEqual({
    a: 3,
    b: 1
  });
}); // First test ends here.

test('query failure sends unavailable, emits no stale scores, and stops polling', () => {
  let databaseFails = false;

  const backend = createBackend({
    query: (_sql, _parameters, callback) => {
      if (databaseFails) {
        callback(new Error('Database unavailable'));
        return;
      }

      callback(null, {
        rows: [
          { vote: 'a', count: '3' },
          { vote: 'b', count: '1' }
        ]
      });
    }
  });

  // Confirm the initial healthy result.
  expect(backend.io.sockets.emit).toHaveBeenCalledWith(
    'scores',
    JSON.stringify({ a: 3, b: 1 })
  );

  expect(backend.client.query).toHaveBeenCalledTimes(1);

  // Make the next query fail.
  databaseFails = true;
  backend.io.sockets.emit.mockClear();

  jest.advanceTimersByTime(1000);

  expect(backend.client.query).toHaveBeenCalledTimes(2);

  // No scores should be emitted after the failure.
  expect(backend.io.sockets.emit.mock.calls).toEqual([
    ['db-unavailable']
  ]);

  expect(jest.getTimerCount()).toBe(0);

  // Polling must remain stopped.
  jest.advanceTimersByTime(60000);

  expect(backend.client.query).toHaveBeenCalledTimes(2);

  expect(backend.io.sockets.emit.mock.calls).toEqual([
    ['db-unavailable']
  ]);
}); // Second test ends here.
test('after query failure, polling resumes only with a fresh backend instance', () => {
  let databaseFails = false;

  const query = (_sql, _parameters, callback) => {
    if (databaseFails) {
      callback(new Error('Database unavailable'));
      return;
    }

    callback(null, {
      rows: [
        { vote: 'a', count: '2' },
        { vote: 'b', count: '1' }
      ]
    });
  };

  // Start healthy.
  const backend = createBackend({ query });

  expect(backend.io.sockets.emit).toHaveBeenCalledWith(
    'scores',
    JSON.stringify({ a: 2, b: 1 })
  );

  // Fail the next query.
  databaseFails = true;
  jest.advanceTimersByTime(1000);

  expect(backend.client.query).toHaveBeenCalledTimes(2);
  expect(backend.io.sockets.emit).toHaveBeenLastCalledWith(
    'db-unavailable'
  );

  backend.io.sockets.emit.mockClear();

  // Restore the simulated database.
  databaseFails = false;
  jest.advanceTimersByTime(60000);

  // The existing backend must remain stopped.
  expect(backend.client.query).toHaveBeenCalledTimes(2);
  expect(backend.io.sockets.emit).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);

  // Model restarting the service with a fresh backend instance.
  const restartedBackend = createBackend({ query });

  expect(restartedBackend.connect).toHaveBeenCalledTimes(1);
  expect(restartedBackend.client.query).toHaveBeenCalledTimes(1);

  expect(restartedBackend.io.sockets.emit).toHaveBeenCalledWith(
    'scores',
    JSON.stringify({ a: 2, b: 1 })
  );
});
test('connection loss sends unavailable and stops further polling', () => {
  const backend = createBackend({
    query: (_sql, _parameters, callback) => {
      callback(null, {
        rows: [
          { vote: 'a', count: '3' },
          { vote: 'b', count: '1' }
        ]
      });
    }
  });

  // Confirm the backend was initially healthy.
  expect(backend.client.query).toHaveBeenCalledTimes(1);

  expect(backend.io.sockets.emit).toHaveBeenCalledWith(
    'scores',
    JSON.stringify({ a: 3, b: 1 })
  );

  backend.io.sockets.emit.mockClear();

  // Simulate PostgreSQL reporting a lost connection.
  backend.client.emit(
    'error',
    new Error('Connection terminated unexpectedly')
  );

  expect(backend.io.sockets.emit.mock.calls).toEqual([
    ['db-unavailable']
  ]);

  // Allow time for any incorrectly retained poll to execute.
  jest.advanceTimersByTime(1000);

  expect(backend.client.query).toHaveBeenCalledTimes(1);

  expect(backend.io.sockets.emit.mock.calls).toEqual([
    ['db-unavailable']
  ]);

  expect(jest.getTimerCount()).toBe(0);
});
test('late query result after connection loss does not emit scores', () => {
  let finishQuery;

  const backend = createBackend({
    query: (_sql, _parameters, callback) => {
      // Keep the query pending until the test completes it.
      finishQuery = callback;
    }
  });

  expect(backend.client.query).toHaveBeenCalledTimes(1);
  expect(typeof finishQuery).toBe('function');
  expect(backend.io.sockets.emit).not.toHaveBeenCalled();

  // Lose the connection while the query is still pending.
  backend.client.emit('error', connectionLoss());

  expect(backend.io.sockets.emit.mock.calls).toEqual([
    ['db-unavailable']
  ]);

  // The old query then returns data.
  finishQuery(null, healthyResult());

  // That late result must be ignored.
  expect(backend.io.sockets.emit.mock.calls).toEqual([
    ['db-unavailable']
  ]);

  expect(jest.getTimerCount()).toBe(0);

  jest.advanceTimersByTime(60000);

  expect(backend.client.query).toHaveBeenCalledTimes(1);
  expect(backend.io.sockets.emit.mock.calls).toEqual([
    ['db-unavailable']
  ]);
});
test.each(['query failure', 'connection loss'])(
  'new browser receives unavailable after %s',
  (failureType) => {
    let failQuery = false;

    const backend = createBackend({
      query: (_sql, _parameters, callback) => {
        if (failQuery) {
          callback(queryFailure());
          return;
        }

        callback(null, healthyResult());
      }
    });

    // Establish an outage before the browser connects.
    if (failureType === 'query failure') {
      failQuery = true;
      jest.advanceTimersByTime(1000);
    } else {
      backend.client.emit('error', connectionLoss());
    }

    expect(backend.io.sockets.emit).toHaveBeenLastCalledWith(
      'db-unavailable'
    );

    // Simulate a new browser connection.
    const socket = {
      emit: jest.fn(),
      on: jest.fn(),
      join: jest.fn()
    };

    backend.io.emit('connection', socket);

    expect(socket.emit.mock.calls).toEqual([
      ['message', { text: 'Welcome!' }],
      ['db-unavailable']
    ]);
  }
);