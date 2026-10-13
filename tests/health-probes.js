var createHealthProbes = require('../result/health-probes');

function createResponse() {
  return {
    statusCode: null,
    body: null,

    status: function(code) {
      this.statusCode = code;
      return this;
    },

    json: function(body) {
      this.body = body;
      return this;
    }
  };
}

describe('health probes', function() {
  test('/healthz returns 200 without checking the database', function() {
    var probes = createHealthProbes({});
    var res = createResponse();

    probes.healthz({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });

  test('/readyz returns 200 when the database query succeeds', async function() {
    var pool = {
      waitingCount: 0,
      totalCount: 1,
      idleCount: 0,
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] })
    };
    var probes = createHealthProbes(pool);
    var res = createResponse();

    await probes.readyz({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'ready',
      checks: { database: 'ok' }
    });
  });

  test('/readyz returns 503 when the database query fails', async function() {
    var pool = {
      waitingCount: 0,
      totalCount: 1,
      idleCount: 0,
      query: jest.fn().mockRejectedValue(new Error('database unavailable'))
    };
    var probes = createHealthProbes(pool);
    var res = createResponse();

    await probes.readyz({}, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      status: 'not_ready',
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database readiness check failed'
      }
    });
  });
});