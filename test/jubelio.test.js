'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createJubelioSource } = require('../server/sources/jubelio');
const { aggregate } = require('../server/aggregate');

const LOC = 'MAIN IMPERFECT WAREHOUS 2026';

/* A small stand-in for api2.jubelio.com with the behaviour seen on the real
   account: masked phones on orders, full phone on /contacts/{id}, list without
   location filter, lastModifiedSince on the list. */
function mockJubelio() {
  const calls = { login: 0, list: [], detail: [], contact: [] };
  let validToken = 'tok-1';
  const orders = [
    { salesorder_id: 1, salesorder_no: 'SO-1', location_name: LOC, grand_total: '3000000.0000', last_modified: '2026-10-30T03:00:00.000Z' },
    { salesorder_id: 2, salesorder_no: 'SO-2', location_name: 'main imperfect  warehous 2026', customer_name: 'Dewi Lestari', grand_total: '2000000.0000', last_modified: '2026-10-30T03:05:00.000Z' },
    { salesorder_id: 3, salesorder_no: 'SO-3', location_name: 'General Warehouse', grand_total: '9000000', last_modified: '2026-10-30T03:06:00.000Z' },
    { salesorder_id: 4, salesorder_no: 'SO-4', location_name: LOC, grand_total: '7000000', is_canceled: null, internal_status: 'CANCELED', last_modified: '2026-10-30T03:07:00.000Z' },
    { salesorder_id: 5, salesorder_no: 'SO-5', location_name: LOC, grand_total: '500000.0000', last_modified: '2026-10-30T03:08:00.000Z' }
  ];
  const detail = {
    1: { contact_id: 101, customer_name: 'Dewi Lestari', customer_phone: '**************90', grand_total: '3000000.0000', items: [{ qty: '0.0000', qty_in_base: '2.0000' }, { qty_in_base: '1.0000' }, { qty_in_base: '5.0000', is_canceled_item: true }] },
    2: { contact_id: 101, customer_name: 'Dewi Lestari', customer_phone: '**************90', grand_total: '2000000.0000', items: [{ qty_in_base: '4.0000' }] },
    5: { contact_id: -1, customer_name: 'Pelanggan Umum', shipping_phone: '**********99', grand_total: '500000.0000', items: [{ qty_in_base: '1.0000' }] }
  };
  const contacts = { 101: { contact_name: 'Dewi Lestari', phone: '+6281234567890', mobile: null } };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/login') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        calls.login++;
        const { email, password } = JSON.parse(b);
        send(email === 'a@b.c' && password === 'pw' ? 200 : 401, { token: validToken });
      });
      return;
    }
    if (req.headers.authorization !== validToken) return send(401, {});
    if (url.pathname === '/sales/orders/') {
      const q = Object.fromEntries(url.searchParams);
      calls.list.push(q);
      let data = orders.slice();
      // like the real API: only the UTC date of lastModifiedSince counts
      if (q.lastModifiedSince) data = data.filter((o) => o.last_modified.slice(0, 10) >= q.lastModifiedSince.slice(0, 10));
      const size = Number(q.pageSize), page = Number(q.page);
      const out = data.slice((page - 1) * size, page * size);
      return setTimeout(() => send(200, { data: out, totalCount: data.length }), mock.listDelay || 0);
    }
    let m = url.pathname.match(/^\/sales\/orders\/(\d+)$/);
    if (m) { calls.detail.push(Number(m[1])); return send(200, detail[m[1]]); }
    m = url.pathname.match(/^\/contacts\/(\d+)$/);
    if (m) { calls.contact.push(Number(m[1])); return send(200, contacts[m[1]]); }
    send(404, {});
  });
  const mock = { srv, calls, orders, expireToken() { validToken = 'tok-2'; } };
  return mock;
}

async function start(t) {
  const mock = mockJubelio();
  await new Promise((r) => mock.srv.listen(0, '127.0.0.1', r));
  t.after(() => mock.srv.close());
  mock.cfg = (extra) => Object.assign({
    api: 'http://127.0.0.1:' + mock.srv.address().port,
    email: 'a@b.c', password: 'pw',
    location: LOC, dateFrom: '2026-11-01', dateTo: '2026-10-30'
  }, extra);
  return mock;
}

test('Jubelio: one warehouse, full phone from the contact, walk-ins skipped', async (t) => {
  const mock = await start(t);
  const src = createJubelioSource(mock.cfg());
  const recs = await src.fetch();

  const q = mock.calls.list[0];
  assert.equal(q.transactionDateFrom, '2026-10-30T00:00:00+07:00', 'swapped dates are accepted');
  assert.equal(q.transactionDateTo, '2026-11-01T23:59:59+07:00');
  assert.equal(q.sortDirection, 'ASC');
  assert.deepEqual(mock.calls.detail.sort(), [1, 2, 5], 'contact_id only comes from the order detail');
  assert.deepEqual(mock.calls.contact, [101], 'one contact read for two orders of the same buyer');

  const { map, stat } = aggregate(recs);
  assert.deepEqual(stat.skipped, ['SO-5'], 'walk-in order has only a masked phone');
  assert.deepEqual(map.get('081234567890'), { p: '081234567890', n: 'Dewi L.', q: 7, t: 2, v: 5000000 });
  assert.deepEqual(src.info(), { scanning: false, orders: 3, pending: 0, noPhone: 1 });
});

test('Jubelio: later polls only read changed orders and drop canceled ones', async (t) => {
  const mock = await start(t);
  const src = createJubelioSource(mock.cfg());
  await src.fetch();
  const since = mock.calls.list[mock.calls.list.length - 1];
  assert.equal(since.lastModifiedSince, undefined, 'first pass scans the whole range');

  const later = new Date(Date.now() + 60e3).toISOString();
  mock.orders[1].last_modified = later;
  mock.orders[0].internal_status = 'CANCELED'; // is_canceled stays undefined, like most real cancels
  mock.orders[0].last_modified = later;
  const recs = await src.fetch();

  assert.match(mock.calls.list[mock.calls.list.length - 1].lastModifiedSince, /^\d{4}-\d{2}-\d{2}$/, 'second pass asks for changes, as a UTC date');
  assert.deepEqual(mock.calls.detail.sort(), [1, 2, 2, 5], 'only the changed order is read again');
  const { map } = aggregate(recs);
  assert.equal(map.get('081234567890').v, 2000000, 'canceled SO-1 dropped');
});

test('Jubelio: saved sync is reused by a new instance, unless the scope changes', async (t) => {
  const mock = await start(t);
  let saved = null;
  const store = { load: async () => saved, save: async (s) => { saved = JSON.parse(JSON.stringify(s)); } };
  await createJubelioSource(mock.cfg({ store })).fetch();
  const reads = mock.calls.detail.length + mock.calls.contact.length;

  const recs = await createJubelioSource(mock.cfg({ store })).fetch();
  assert.equal(mock.calls.detail.length + mock.calls.contact.length, reads, 'cold start resumes from the store');
  assert.equal(aggregate(recs).map.get('081234567890').v, 5000000);

  const detailsBefore = mock.calls.detail.length;
  await createJubelioSource(mock.cfg({ store, dateFrom: '2026-10-29' })).fetch();
  assert.ok(mock.calls.detail.length > detailsBefore, 'another date range starts a fresh sync');
});

test('Jubelio: a walk cut off by the time budget resumes at its page', async (t) => {
  const mock = await start(t);
  mock.listDelay = 350;
  const src = createJubelioSource(mock.cfg({ pageSize: 2, budgetMs: 500 }));
  await src.fetch();
  assert.deepEqual(mock.calls.list.map((q) => q.page), ['1', '2']);
  assert.equal(src.info().scanning, true);
  await src.fetch();
  assert.deepEqual(mock.calls.list.map((q) => q.page), ['1', '2', '3'], 'continues with page 3, not page 1');
  assert.equal(src.info().scanning, false);
});

test('Jubelio: expired token logs in again once', async (t) => {
  const mock = await start(t);
  const src = createJubelioSource(mock.cfg());
  await src.fetch();
  mock.expireToken();
  const before = mock.calls.login;
  await src.fetch();
  assert.equal(mock.calls.login, before + 1);
});

test('Jubelio: refuses to start without location or start date', () => {
  assert.throws(() => createJubelioSource({ email: 'a', password: 'b', dateFrom: '2025-01-01' }), /JUBELIO_LOCATION/);
  assert.throws(() => createJubelioSource({ email: 'a', password: 'b', location: 'X' }), /JUBELIO_DATE_FROM/);
});
