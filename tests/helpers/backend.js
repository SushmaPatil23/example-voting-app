const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function createBackend({ query }) {
  // Simulated PostgreSQL client.
  const client = new EventEmitter();
  client.query = jest.fn(query);

  const releaseClient = jest.fn();

  // Simulate a successful database connection.
  const connect = jest.fn((callback) => {
    callback(null, client, releaseClient);
  });

  const pool = {
    connect,
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    waitingCount: 0,
    totalCount: 1,
    idleCount: 1,
    end: jest.fn().mockResolvedValue(undefined)
  };

  // Record events the backend sends to browsers.
  const io = new EventEmitter();
  io.use = jest.fn();
  io.sockets = {
    emit: jest.fn()
  };
  io.close = jest.fn((callback) => {
    if (callback) callback();
  });

  // Simulate Socket.IO's middleware assigning socket.data before connection.
  const emitIoEvent = io.emit.bind(io);
  io.emit = jest.fn((eventName, ...args) => {
    if (eventName === 'connection' && args[0]) {
      args[0].data = args[0].data || {};
      args[0].data.requestId =
        args[0].data.requestId || 'test-socket-request-id';
    }

    return emitIoEvent(eventName, ...args);
  });

  // Replace HTTP infrastructure so no real server starts.
  const app = {
    use: jest.fn(),
    get: jest.fn()
  };

  const express = Object.assign(() => app, {
    urlencoded: jest.fn(),
    static: jest.fn()
  });

  const server = {
    listen: jest.fn(),
    address: () => ({ port: 4000 })
  };

  const processHandlers = {};

  const dependencies = {
    'node:crypto': {
      randomUUID: jest.fn(() => 'test-request-id')
    },
    'node:perf_hooks': require('node:perf_hooks'),
    'node:path': path,
    express,
    async: require('async'),
    pg: {
      Pool: function() {
        return pool;
      }
    },
    'cookie-parser': () => function(req, res, next) {
      if (next) next();
    },
    http: {
      Server: () => server
    },
    'socket.io': () => io,
    './health-probes': require('../../result/health-probes'),
    './package.json': require('../../result/package.json')
  };

  const resultDirectory = path.resolve(__dirname, '../../result');

  // Give each test its own backend state and dependencies.
  const context = vm.createContext({
    require(name) {
      if (!(name in dependencies)) {
        throw new Error(`Unexpected dependency: ${name}`);
      }

      return dependencies[name];
    },
    __dirname: resultDirectory,
    process: {
      env: {},
      on: jest.fn((signal, handler) => {
        processHandlers[signal] = handler;
      }),
      exit: jest.fn(),
      exitCode: 0
    },
    console: {
      log: jest.fn(),
      error: jest.fn()
    },
    setTimeout,
    clearTimeout
  });

  const source = fs.readFileSync(
    path.join(resultDirectory, 'server.js'),
    'utf8'
  );

  vm.runInContext(source, context, {
    filename: 'result/server.js'
  });

  return {
    connect,
    client,
    io,
    pool,
    processHandlers
  };
}

module.exports = { createBackend };