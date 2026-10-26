'use strict';

/* The query must return one row per transaction with the columns
   phone, name, qty, value. Override PG_QUERY to map your own table, e.g.
   SELECT no_hp AS phone, nama AS name, jumlah AS qty, total AS value FROM penjualan WHERE event = 'imperfect-2026' */
const DEFAULT_QUERY = 'SELECT phone, name, qty, trx_value AS value FROM transactions';

function createPostgresSource(cfg) {
  // the Netlify Function passes its own statically imported Pool so the bundler ships pg
  const Pool = cfg.Pool || require('pg').Pool;
  // DATABASE_URL wins; otherwise separate fields, so a password full of
  // punctuation can be given as-is instead of URL-encoded
  const conn = cfg.url ? { connectionString: cfg.url }
    : { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database };
  const pool = new Pool(Object.assign(conn, {
    ssl: cfg.ssl ? { rejectUnauthorized: cfg.sslRejectUnauthorized } : undefined,
    max: cfg.maxConnections || 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 20000
  }));
  // an idle client dropping its connection must not crash the server
  pool.on('error', (e) => console.error('[postgres] idle client error:', e.message));
  const query = cfg.query || DEFAULT_QUERY;

  return {
    name: 'postgres',
    async fetch() {
      const res = await pool.query(query);
      return res.rows.map((r, i) => ({ phone: r.phone, name: r.name, qty: pgNumber(r.qty), value: pgNumber(r.value), line: i + 1 }));
    },
    close: () => pool.end()
  };
}

// pg returns NUMERIC/BIGINT as strings in machine format at the column's scale,
// e.g. "2500000.0000"; the Sheet-oriented parser would read those decimals as
// digits, so plain machine numbers are converted here
function pgNumber(v) {
  return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Math.round(Number(v)) : v;
}

module.exports = { createPostgresSource, DEFAULT_QUERY, pgNumber };
