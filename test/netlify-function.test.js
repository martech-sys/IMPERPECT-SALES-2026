'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('Netlify function serves merged state on /api/state and /healthz', async (t) => {
  const csv = 'No HP,Nama,qty,trx value\n6287781510867,Bayu,1,3000000\n087781510867,Bayu,2,"2.000.000"\n';
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/csv' }); res.end(csv); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  Object.assign(process.env, {
    DATA_SOURCES: 'sheet',
    SHEET_URL: 'http://127.0.0.1:' + srv.address().port + '/x?output=csv',
    CACHE_SECONDS: '15'
  });
  const fn = await import('../netlify/functions/state.mjs');
  assert.deepEqual(fn.config.path, ['/api/state', '/healthz']);

  const res = await fn.default(new Request('https://tv.example/api/state'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('netlify-cdn-cache-control'), /s-maxage=15/);
  const body = await res.json();
  assert.equal(body.sources.sheet.ok, true);
  assert.deepEqual(body.state.top, [{ p: '0877-xxxx-0867', n: 'Bayu', q: 3, t: 2, v: 5000000 }]);

  const health = await fn.default(new Request('https://tv.example/healthz'));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test('Netlify function without any source says which variables it received, never their values', async () => {
  const { execFileSync } = require('node:child_process');
  // a fresh process, so module-level config is read from this environment only
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const fn = await import(${JSON.stringify(require('node:path').resolve(__dirname, '../netlify/functions/state.mjs'))});
    const r = await fn.default(new Request('https://tv.example/healthz'));
    console.log(JSON.stringify({ status: r.status, body: await r.json() }));
  `], { env: { PATH: process.env.PATH, DATA_SOURCES: 'postgres', DATABASE_PASSWORD: 'rahasia#123' }, encoding: 'utf8' });
  const { status, body } = JSON.parse(out.trim().split('\n').pop());
  assert.equal(status, 500);
  assert.equal(body.env.DATABASE_PASSWORD, 'terisi');
  assert.equal(body.env.DATABASE_HOST, 'kosong');
  assert.deepEqual(body.dataSources, ['postgres']);
  assert.match(body.skipped[0], /DATABASE_URL \/ DATABASE_HOST kosong/);
  assert.ok(!out.includes('rahasia#123'), 'password value never appears');
});
