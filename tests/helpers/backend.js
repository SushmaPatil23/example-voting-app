const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function createBackend({ query }) {
  // Simulated PostgreSQL client.
  const client = new EventEmitter();
  client.query = jest.fn(query);

  // Simulate a successful database connection.
  const connect = jest.fn((callback) => {
    callback(null, client, jest.fn());
  });

  // Record events the backend sends to browsers.
  const io = new EventEmitter();
  io.sockets = {
    emit: jest.fn()
  };

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

  const dependencies = {
    express,
    async: require('async'),
    pg: {
      Pool: function () {
        return { connect };
      }
    },
    'cookie-parser': () => () => {},
    http: {
      Server: () => server
    },
    'socket.io': () => io
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
    process: { env: {} },
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

  return { connect, client, io };
}

module.exports = { createBackend };