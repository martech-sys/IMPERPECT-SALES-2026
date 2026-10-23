'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createCollector } = require('./collector');
const { createPostgresSource } = require('./sources/postgres');
const { createSheetSource } = require('./sources/sheet');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { /* no .env: use the real environment */ }

const env = process.env;
const flag = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const config = {
  port: parseInt(env.PORT || '3000', 10),
  pollMs: Math.max(5000, parseInt(env.POLL_MS || '30000', 10)),
  sources: (env.DATA_SOURCES || 'postgres,sheet').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  pg: {
    url: env.DATABASE_URL,
    query: env.PG_QUERY,
    ssl: flag(env.PG_SSL, false),
    sslRejectUnauthorized: flag(env.PG_SSL_REJECT_UNAUTHORIZED, true)
  },
  sheet: { url: env.SHEET_URL, gid: env.SHEET_GID || '0' }
};

const sources = [];
if (config.sources.includes('postgres')) {
  if (config.pg.url) sources.push(createPostgresSource(config.pg));
  else console.warn('[postgres] DATABASE_URL kosong, sumber Postgres dilewati');
}
if (config.sources.includes('sheet')) {
  if (config.sheet.url) sources.push(createSheetSource(config.sheet));
  else console.warn('[sheet] SHEET_URL kosong, sumber Sheet dilewati');
}
if (!sources.length) {
  console.error('Tidak ada sumber data. Isi DATABASE_URL dan/atau SHEET_URL (lihat .env.example).');
  process.exit(1);
}

const collector = createCollector(sources, { pollMs: config.pollMs });

const PUBLIC = path.join(__dirname, '..', 'public');
// fixed whitelist: nothing outside these files can be requested
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png']
};

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' }, extra || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');

  if (url.pathname === '/api/state') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(collector.snapshot()), { 'Cache-Control': 'no-store' });
  }
  if (url.pathname === '/healthz') {
    const snap = collector.snapshot();
    const ok = Object.values(snap.sources).some((s) => s.ok);
    return send(res, ok ? 200 : 503, 'application/json', JSON.stringify({ ok, sources: snap.sources }), { 'Cache-Control': 'no-store' });
  }
  const file = STATIC[url.pathname];
  if (!file) return send(res, 404, 'text/plain', 'Not found');
  fs.readFile(path.join(PUBLIC, file[0]), (err, buf) => {
    if (err) return send(res, 500, 'text/plain', 'Gagal membaca file');
    send(res, 200, file[1], req.method === 'HEAD' ? undefined : buf, { 'Cache-Control': file[0] === 'logo.png' ? 'public, max-age=86400' : 'no-cache' });
  });
});

collector.start().then(() => {
  const snap = collector.snapshot();
  Object.entries(snap.sources).forEach(([name, s]) => {
    console.log('[' + name + '] ' + (s.ok ? s.valid + ' transaksi valid, ' + s.skipped + ' dilewati' : 'gagal: ' + s.error));
  });
});

server.listen(config.port, () => {
  console.log('Imperfect Sale Live di http://localhost:' + config.port + ' (sumber: ' + sources.map((s) => s.name).join(' + ') + ', poll ' + config.pollMs / 1000 + ' dtk)');
});

function shutdown() {
  collector.stop();
  server.close();
  Promise.all(sources.map((s) => s.close())).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
