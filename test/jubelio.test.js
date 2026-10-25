'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createJubelioSource } = require('../server/sources/jubelio');
const { aggregate } = require('../server/aggregate');

function mockJubelio() {
  const calls = { login: 0, list: 0, detail: [] };
  let validToken = 'tok-1';
  const orders = [
    { salesorder_id: 1, salesorder_no: 'SO-1', location_name: 'Imperfect Sales 2025', grand_total: '3000000.0000', last_modified: 'a', transaction_date: '2025-11-01T03:00:00Z' },
    { salesorder_id: 2, salesorder_no: 'SO-2', location_name: 'IMPERFECT SALES 2025 ', grand_total: '2000000', last_modified: 'a' },
    { salesorder_id: 3, salesorder_no: 'SO-3', location_name: 'Gudang Utama', grand_total: '9000000', last_modified: 'a' },
    { salesorder_id: 4, salesorder_no: 'SO-4', location_name: 'Imperfect Sales 2025', grand_total: '7000000', is_canceled: true, last_modified: 'a' }
  ];
  const detail = {
    1: { customer_name: 'Dewi Lestari', customer_phone: '6281234567890', grand_total: '3000000.0000', items: [{ qty_in_base: 2 }, { qty_in_base: 1 }, { qty_in_base: 5, is_canceled_item: true }] },
    2: { customer_name: 'Dewi', customer_phone: '', shipping_phone: '081234567890', grand_total: '2000000', items: [{ qty: 4 }] }
  };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/login') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        calls.login++;
        const { email, password } = JSON.parse(b);
        if (email !== 'a@b.c' || password !== 'pw') return send(401, {});
        send(200, { token: validToken });
      });
      return;
    }
    if (req.headers.authorization !== validToken) return send(401, {});
    if (url.pathname === '/sales/orders/') {
      calls.list++;
      calls.lastQuery = Object.fromEntries(url.searchParams);
      return send(200, { data: orders, totalCount: orders.length });
    }
    const m = url.pathname.match(/^\/sales\/orders\/(\d+)$/);
    if (m) { calls.detail.push(Number(m[1])); return send(200, detail[m[1]]); }
    send(404, {});
  });
  return { srv, calls, orders, expireToken() { validToken = 'tok-2'; } };
}

test('Jubelio source reads one location, skips canceled orders and caches details', async (t) => {
  const mock = mockJubelio();
  await new Promise((r) => mock.srv.listen(0, '127.0.0.1', r));
  t.after(() => mock.srv.close());

  const src = createJubelioSource({
    api: 'http://127.0.0.1:' + mock.srv.address().port,
    email: 'a@b.c', password: 'pw',
    location: 'Imperfect Sales 2025', dateFrom: '2025-11-01', dateTo: '2025-11-03'
  });

  const recs = await src.fetch();
  assert.equal(mock.calls.lastQuery.transactionDateFrom, '2025-11-01T00:00:00+07:00');
  assert.equal(mock.calls.lastQuery.transactionDateTo, '2025-11-03T23:59:59+07:00');
  assert.deepEqual(mock.calls.detail.sort(), [1, 2], 'only orders at the location, canceled one skipped');
  assert.deepEqual(recs.map((r) => r.qty), [3, 4], 'canceled items do not count');

  const { map, stat } = aggregate(recs);
  assert.equal(stat.valid, 2);
  assert.deepEqual(map.get('081234567890'), { p: '081234567890', n: 'Dewi L.', q: 7, t: 2, v: 5000000 });

  // second poll: nothing changed, so no detail calls; a modified order is re-read
  mock.orders[1].last_modified = 'b';
  await src.fetch();
  assert.deepEqual(mock.calls.detail.slice(2), [2]);

  // expired token: one re-login, then the call goes through
  mock.expireToken();
  const before = mock.calls.login;
  await src.fetch();
  assert.equal(mock.calls.login, before + 1);
});

test('Jubelio source refuses to start without location or start date', () => {
  assert.throws(() => createJubelioSource({ email: 'a', password: 'b', dateFrom: '2025-01-01' }), /JUBELIO_LOCATION/);
  assert.throws(() => createJubelioSource({ email: 'a', password: 'b', location: 'X' }), /JUBELIO_DATE_FROM/);
});
