'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createDriveSource, folderIdOf } = require('../server/sources/drive');
const { aggregate } = require('../server/aggregate');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA = JSON.stringify({ client_email: 'papan@proj.iam.gserviceaccount.com', private_key: PEM });

/* Stand-in for oauth2 + Drive v3 + Sheets v4: checks the JWT signature and
   the bearer token, lists one folder, serves values per file. */
function mockGoogle() {
  const calls = { token: 0, list: 0, values: [] };
  const state = {
    files: [
      { id: 'f1', name: 'Heymale', modifiedTime: '2026-10-30T03:00:00Z' },
      { id: 'f2', name: 'Heylocal', modifiedTime: '2026-10-30T03:00:00Z' },
      { id: 'f3', name: 'Boonaboo', modifiedTime: '2026-10-30T03:00:00Z' }
    ],
    values: {
      f1: [['No HP', 'Nama', 'qty', 'trx value'], [6281234567890, 'Dewi Lestari', 2, 1500000], ['', '', '', ''], ['bukan hp', 'X', 1, 100]],
      f2: [['No HP', 'Nama', 'qty', 'trx value'], ['081234567890', 'Dewi', 1, '2.500.000']],
      f3: [['No HP', 'Nama', 'qty', 'trx value']]
    },
    fail: new Set()
  };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/token') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        calls.token++;
        const jwt = new URLSearchParams(b).get('assertion');
        const [h, p, sig] = jwt.split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), publicKey, Buffer.from(sig, 'base64url'));
        const claims = JSON.parse(Buffer.from(p, 'base64url'));
        calls.claims = claims;
        if (!ok) return send(400, { error: 'invalid_grant', error_description: 'bad signature' });
        send(200, { access_token: 'tok', expires_in: 3600 });
      });
      return;
    }
    if (req.headers.authorization !== 'Bearer tok') return send(401, { error: { message: 'no auth' } });
    if (url.pathname === '/drive/files') {
      calls.list++; calls.q = url.searchParams.get('q');
      return send(200, { files: state.files });
    }
    const m = url.pathname.match(/^\/sheets\/spreadsheets\/([^/]+)\/values\/(.+)$/);
    if (m) {
      calls.values.push(m[1]); calls.range = decodeURIComponent(m[2]);
      if (state.fail.has(m[1])) return send(403, { error: { message: 'The caller does not have permission' } });
      return send(200, { values: state.values[m[1]] });
    }
    send(404, {});
  });
  return { srv, calls, state };
}

async function start(t) {
  const g = mockGoogle();
  await new Promise((r) => g.srv.listen(0, '127.0.0.1', r));
  t.after(() => g.srv.close());
  const base = 'http://127.0.0.1:' + g.srv.address().port;
  g.source = (extra) => createDriveSource(Object.assign({
    json: SA, folder: 'https://drive.google.com/drive/folders/FOLDER123abc?usp=sharing',
    urls: { token: base + '/token', drive: base + '/drive', sheets: base + '/sheets' }
  }, extra));
  return g;
}

test('Drive: every spreadsheet in the folder is a brand, merged per phone', async (t) => {
  const g = await start(t);
  const src = g.source();
  const recs = await src.fetch();

  assert.equal(g.calls.claims.iss, 'papan@proj.iam.gserviceaccount.com');
  assert.match(g.calls.claims.scope, /drive\.readonly/);
  assert.match(g.calls.claims.scope, /spreadsheets\.readonly/);
  assert.match(g.calls.q, /'FOLDER123abc' in parents/);
  assert.equal(g.calls.range, 'A1:D5000', 'first tab, columns A:D');
  assert.deepEqual(g.calls.values.sort(), ['f1', 'f2', 'f3']);

  const { map, stat } = aggregate(recs);
  assert.deepEqual(map.get('081234567890'), { p: '081234567890', n: 'Dewi L.', q: 3, t: 2, v: 4000000 });
  assert.deepEqual(stat.skipped, ['Heymale:3'], 'bad rows are reported as Brand:row');
  assert.deepEqual(src.info(), { brands: 3, failed: [], empty: ['Boonaboo'] });
});

test('Drive: later fetches only re-read edited files; a failing file keeps its last rows', async (t) => {
  const g = await start(t);
  const src = g.source();
  await src.fetch();

  await src.fetch();
  assert.equal(g.calls.values.length, 3, 'nothing changed: no file is read again');
  assert.equal(g.calls.token, 1, 'access token is reused');

  g.state.values.f2.push(['085711112222', 'Rina', 1, 300000]);
  g.state.files[1].modifiedTime = '2026-10-30T04:00:00Z';
  g.state.files[0].modifiedTime = '2026-10-30T04:00:00Z';
  g.state.fail.add('f1');
  const recs = await src.fetch();
  assert.deepEqual(g.calls.values.slice(3).sort(), ['f1', 'f2']);
  const { map } = aggregate(recs);
  assert.equal(map.get('081234567890').v, 4000000, 'Heymale failed now but its last rows stay');
  assert.equal(map.get('085711112222').v, 300000, 'Heylocal edit picked up');
  assert.deepEqual(src.info().failed, [{ brand: 'Heymale', error: 'HTTP 403: The caller does not have permission' }]);

  g.state.files = g.state.files.filter((f) => f.id !== 'f2');
  const after = aggregate(await src.fetch());
  assert.equal(after.map.get('085711112222'), undefined, 'a file removed from the folder drops out');
});

test('Drive: setup errors are explained', () => {
  assert.throws(() => createDriveSource({ folder: 'x'.repeat(20) }), /GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.throws(() => createDriveSource({ json: '{bukan json', folder: 'x'.repeat(20) }), /bukan JSON/);
  assert.throws(() => createDriveSource({ json: SA, folder: '' }), /DRIVE_FOLDER/);
  // a key pasted into a one-line variable, with literal \n
  const oneLine = PEM.replace(/\n/g, '\\n');
  assert.doesNotThrow(() => createDriveSource({ email: 'a@b.iam.gserviceaccount.com', privateKey: oneLine, folder: 'x'.repeat(20) }));
  assert.equal(folderIdOf('https://drive.google.com/drive/u/0/folders/1AbC-dEf_ghi'), '1AbC-dEf_ghi');
  assert.equal(folderIdOf('1AbC-dEf_ghi234'), '1AbC-dEf_ghi234');
});

test('Drive: folder not shared with the service account says so', async (t) => {
  const g = await start(t);
  g.srv.removeAllListeners('request');
  g.srv.on('request', (req, res) => {
    if (req.url === '/token') { req.resume(); return req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"access_token":"tok"}'); }); }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"File not found"}}');
  });
  await assert.rejects(g.source().fetch(), /Share folder ke papan@proj\.iam\.gserviceaccount\.com sebagai Viewer/);
});
