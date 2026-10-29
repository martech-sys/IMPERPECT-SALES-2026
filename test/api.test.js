'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const FN = path.resolve(__dirname, '../api/state.js');

/* Calls api/state.js the way Vercel does (Node req/res), in a fresh process so
   the module reads only the environment given here. Returns one result per url. */
function callVercel(env, urls) {
  const script = `
    const fn = require(${JSON.stringify(FN)});
    (async () => {
      const out = [];
      for (const url of ${JSON.stringify(urls)}) {
        const headers = {};
        const res = { statusCode: 200, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, end: (b) => { res.body = b; } };
        await fn({ url, method: 'GET', headers: {} }, res);
        out.push({ status: res.statusCode, headers, body: JSON.parse(res.body) });
      }
      console.log(JSON.stringify(out));
      process.exit(0);
    })();`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], { env: Object.assign({ PATH: process.env.PATH }, env) }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ results: JSON.parse(stdout.trim().split('\n').pop()), stdout, stderr });
    });
  });
}

test('Vercel function serves merged state on /api/state and /healthz', async (t) => {
  const csv = 'No HP,Nama,qty,trx value\n6287781510867,Bayu,1,3000000\n087781510867,Bayu,2,"2.000.000"\n';
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/csv' }); res.end(csv); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  const { results: [state, health, rewritten] } = await callVercel({
    DATA_SOURCES: 'sheet',
    SHEET_URL: 'http://127.0.0.1:' + srv.address().port + '/x?output=csv',
    CACHE_SECONDS: '30'
  }, ['/api/state', '/healthz', '/api/state?health=1']);

  assert.equal(state.status, 200);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.headers['vercel-cdn-cache-control'], 'max-age=30, stale-while-revalidate=86400, stale-if-error=86400');
  assert.equal(state.body.sources.sheet.ok, true);
  assert.deepEqual(state.body.state.top, [{ p: '0877-xxxx-0867', n: 'Bayu', q: 3, t: 2, v: 5000000 }]);

  for (const h of [health, rewritten]) {
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true, 'vercel.json rewrites /healthz to /api/state?health=1');
    assert.equal(h.headers['vercel-cdn-cache-control'], undefined, '/healthz is never cached');
  }
});

test('Vercel function without any source says which variables it received, never their values', async () => {
  const { results: [r], stdout } = await callVercel({ DATA_SOURCES: 'postgres', DATABASE_PASSWORD: 'rahasia#123' }, ['/healthz']);
  assert.equal(r.status, 500);
  assert.equal(r.body.env.DATABASE_PASSWORD, 'terisi');
  assert.equal(r.body.env.DATABASE_HOST, 'kosong');
  assert.deepEqual(r.body.dataSources, ['postgres']);
  assert.match(r.body.skipped[0], /DATABASE_URL \/ DATABASE_HOST kosong/);
  assert.ok(!stdout.includes('rahasia#123'), 'password value never appears');
});

test('brand sheets: one missing or private sheet does not stop the others', async (t) => {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/heymale')) { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end('No HP,Nama,qty,trx value\n081234567890,Dewi,1,2000000\n'); }
    if (req.url.startsWith('/private')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html><html>login</html>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.address().port;

  const { results: [state, health] } = await callVercel({
    DATA_SOURCES: 'sheet',
    SHEET_URL: base + '/heymale?output=csv',
    SHEET_URLS: ['Heymale | ' + base + '/heymale?output=csv', 'Zoma | ' + base + '/belum-ada?output=csv', 'Boonaboo | ' + base + '/private?output=csv'].join('\n')
  }, ['/api/state', '/healthz']);

  const src = state.body.sources;
  assert.deepEqual(Object.keys(src).sort(), ['sheet', 'sheet:Boonaboo', 'sheet:Heymale', 'sheet:Zoma']);
  assert.equal(src['sheet:Heymale'].ok, true);
  assert.equal(src['sheet:Zoma'].ok, false);
  assert.match(src['sheet:Zoma'].error, /HTTP 404/);
  assert.match(src['sheet:Boonaboo'].error, /tidak publik/);
  // same buyer in SHEET_URL and the Heymale sheet: merged by phone into one row
  assert.deepEqual(state.body.state.top, [{ p: '0812-xxxx-7890', n: 'Dewi', q: 2, t: 2, v: 4000000 }]);
  assert.equal(health.status, 200, 'board stays up while some brand sheets fail');
});
