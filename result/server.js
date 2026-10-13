var crypto = require('node:crypto'),
    express = require('express'),
    async = require('async'),
    { Pool } = require('pg'),
    path = require('node:path'),
    cookieParser = require('cookie-parser'),
    { performance } = require('node:perf_hooks'),
    app = express(),
    server = require('http').Server(app),
    io = require('socket.io')(server);

var port = process.env.PORT || 4000;
var logLevels = { debug: 10, info: 20, warn: 30, error: 40 };
var configuredLogLevel = process.env.LOG_LEVEL || 'info';
var minimumLogLevel = logLevels[configuredLogLevel] || logLevels.info;

function log(level, event, fields) {
  fields = fields || {};
  if (logLevels[level] < minimumLogLevel) {
    return;
  }

  var record = Object.assign({
    timestamp: new Date().toISOString(),
    level: level,
    service: 'vote-result',
    event: event
  }, fields);
  var line = JSON.stringify(record);

  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function safeDatabaseError(err) {
  return {
    error_name: err && typeof err.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(err.name)
      ? err.name
      : 'DatabaseError',
    // Keep only short, stable error codes. Do not log raw messages or SQL.
    error_code: err && typeof err.code === 'string' && /^[A-Z0-9]{2,10}$/.test(err.code)
      ? err.code
      : 'UNKNOWN'
  };
}

var dbAvailable = false;
var pollTimer = null;
var connectionAttempts = 0;

var pool = new Pool({
  connectionString: 'postgres://postgres:postgres@db/postgres'
});

// Generate an ID at the service boundary; do not trust a caller-supplied ID.
// The response header lets an operator correlate a browser request with its log.
app.use(function(req, res, next) {
  req.requestId = crypto.randomUUID();
  req.requestStartedAt = performance.now();
  res.setHeader('X-Request-ID', req.requestId);

  res.on('finish', function() {
    var route = req.route && req.route.path
      ? String(req.route.path)
      : (req.path === '/' ? '/' : 'static_or_unmatched');
    var statusCode = res.statusCode;
    var level = statusCode >= 500 ? 'error' : (statusCode >= 400 ? 'warn' : 'info');

    log(level, 'http_request_completed', {
      request_id: req.requestId,
      method: req.method,
      route: route,
      status_code: statusCode,
      duration_ms: Number((performance.now() - req.requestStartedAt).toFixed(2))
    });
  });

  next();
});

io.use(function(socket, next) {
  socket.data.requestId = crypto.randomUUID();
  next();
});

io.on('connection', function(socket) {
  log('info', 'socket_connected', { request_id: socket.data.requestId });
  socket.emit('message', { text: 'Welcome!' });

  if (!dbAvailable) {
    socket.emit('db-unavailable');
  }

  socket.on('subscribe', function(data) {
    if (data && typeof data.channel === 'string') {
      socket.join(data.channel);
    }
  });

  socket.on('disconnect', function() {
    log('info', 'socket_disconnected', { request_id: socket.data.requestId });
  });
});

function markDatabaseUnavailable() {
  dbAvailable = false;

  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  io.sockets.emit('db-unavailable');
}

async.retry(
  { times: 1000, interval: 1000 },
  function(callback) {
    connectionAttempts += 1;
    pool.connect(function(err, client, done) {
      if (err && (connectionAttempts === 1 || connectionAttempts % 10 === 0)) {
        log('warn', 'database_connection_attempt_failed', Object.assign({
          attempt: connectionAttempts
        }, safeDatabaseError(err)));
      }

      callback(err, client);
    });
  },
  function(err, client) {
    if (err) {
      log('error', 'database_connection_failed', Object.assign({
        message: 'PostgreSQL connection could not be established',
        attempts: connectionAttempts
      }, safeDatabaseError(err)));
      return;
    }

    log('info', 'database_connected', { attempts: connectionAttempts });
    dbAvailable = true;

    client.on('error', function(err) {
      log('error', 'database_connection_failed', safeDatabaseError(err));
      markDatabaseUnavailable();
    });

    getVotes(client);
  }
);

function getVotes(client) {
  // Do not start a query after the database becomes unavailable.
  if (!dbAvailable) {
    return;
  }

  var queryStartedAt = performance.now();

  client.query(
    'SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote',
    [],
    function(err, result) {
      var queryDurationMs = Number((performance.now() - queryStartedAt).toFixed(2));

      // Ignore a query callback arriving after connection loss.
      if (!dbAvailable) {
        return;
      }

      if (err) {
        log('error', 'database_query_failed', Object.assign({
          message: 'PostgreSQL query failed',
          operation: 'fetch_vote_totals',
          duration_ms: queryDurationMs
        }, safeDatabaseError(err)));
        markDatabaseUnavailable();
        return;
      }

      var votes = collectVotesFromResult(result);
      io.sockets.emit('scores', JSON.stringify(votes));

      pollTimer = setTimeout(function() {
        pollTimer = null;
        getVotes(client);
      }, 1000);
    }
  );
}

function collectVotesFromResult(result) {
  var votes = { a: 0, b: 0 };

  result.rows.forEach(function(row) {
    votes[row.vote] = parseInt(row.count, 10);
  });

  return votes;
}

app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname + '/views'));

app.get('/', function(req, res) {
  res.sendFile(path.resolve(__dirname, 'views/index.html'));
});

server.listen(port, function() {
  log('info', 'application_start', {
    port: server.address().port,
    environment: process.env.NODE_ENV || 'development'
  });
});