var express = require('express'),
    async = require('async'),
    { Pool } = require('pg'),
    path = require('node:path'),
    cookieParser = require('cookie-parser'),
    app = express(),
    server = require('http').Server(app),
    io = require('socket.io')(server);

var port = process.env.PORT || 4000;

var dbAvailable = false;
var pollTimer = null;

var pool = new Pool({
  connectionString: 'postgres://postgres:postgres@db/postgres'
});

io.on('connection', function(socket) {
  socket.emit('message', { text: 'Welcome!' });

  if (!dbAvailable) {
    socket.emit('db-unavailable');
  }

  socket.on('subscribe', function(data) {
    socket.join(data.channel);
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
    pool.connect(function(err, client, done) {
      if (err) {
        console.error('Waiting for db');
      }

      callback(err, client);
    });
  },
  function(err, client) {
    if (err) {
      console.error('Giving up');
      return;
    }

    console.log('Connected to db');
    dbAvailable = true;

    client.on('error', function(err) {
      console.error('Database connection error: ' + err.message);
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

  client.query(
    'SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote',
    [],
    function(err, result) {
      // Ignore a query callback arriving after connection loss.
      if (!dbAvailable) {
        return;
      }

      if (err) {
        console.error('Error performing query: ' + err);
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
  console.log('App running on port ' + server.address().port);
});