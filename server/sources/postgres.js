'use strict';

/* The query must return one row per transaction with the columns
   phone, name, qty, value. Override PG_QUERY to map your own table, e.g.
   SELECT no_hp AS phone, nama AS name, jumlah AS qty, total AS value FROM penjualan WHERE event = 'imperfect-2026' */
const DEFAULT_QUERY = 'SELECT phone, name, qty, trx_value AS value FROM transactions';

function createPostgresSource(cfg) {
  // the Netlify Function passes its own statically imported Pool so the bundler ships pg
  const Pool = cfg.Pool || require('pg').Pool;
  const pool = new Pool({
    connectionString: cfg.url,
    ssl: cfg.ssl ? { rejectUnauthorized: cfg.sslRejectUnauthorized } : undefined,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 20000
  });
  // an idle client dropping its connection must not crash the server
  pool.on('error', (e) => console.error('[postgres] idle client error:', e.message));
  const query = cfg.query || DEFAULT_QUERY;

  return {
    name: 'postgres',
    async fetch() {
      const res = await pool.query(query);
      return res.rows.map((r, i) => ({ phone: r.phone, name: r.name, qty: r.qty, value: r.value, line: i + 1 }));
    },
    close: () => pool.end()
  };
}

module.exports = { createPostgresSource, DEFAULT_QUERY };
