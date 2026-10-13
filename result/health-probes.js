function createHealthProbes(pool) {
  return {
    healthz: function(req, res) {
      return res.status(200).json({ status: 'alive' });
    },

    readyz: async function(req, res) {
      var timeoutId;

      try {
        if (pool.waitingCount > 0 ||
            (pool.totalCount >= 10 && pool.idleCount === 0)) {
          throw new Error('Database pool is saturated');
        }

        await Promise.race([
          pool.query({
            text: 'SELECT 1',
            query_timeout: 500
          }),
          new Promise(function(_, reject) {
            timeoutId = setTimeout(function() {
              reject(new Error('Readiness check timed out'));
            }, 500);
          })
        ]);

        return res.status(200).json({
          status: 'ready',
          checks: { database: 'ok' }
        });
      } catch (err) {
        return res.status(503).json({
          status: 'not_ready',
          error: {
            code: 'DATABASE_UNAVAILABLE',
            message: 'Database readiness check failed'
          }
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }
  };
}

module.exports = createHealthProbes;