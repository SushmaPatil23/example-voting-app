function healthyResult() {
  return {
    rows: [
      { vote: 'a', count: '3' },
      { vote: 'b', count: '1' }
    ]
  };
}

function queryFailure() {
  return new Error('Database query failed');
}

function connectionLoss() {
  return new Error('Connection terminated unexpectedly');
}

module.exports = {
  healthyResult,
  queryFailure,
  connectionLoss
};