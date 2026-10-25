'use strict';

/* Jubelio orders from one warehouse/location (e.g. "Imperfect Sales 2025").
   Read-only: POST /login for a token, everything else is GET.

   API behaviour (verified in martech-sys/data-db, docs/jubelio-api.md):
   - Authorization header is the bare token, no "Bearer".
   - GET /sales/orders/ lists orders (pageSize max 200, filter on
     transactionDateFrom/To) and carries location_name, but no buyer phone
     and no items. Those are only in GET /sales/orders/{id}, about 1 s per
     call, so details are cached per order and re-read only when the order's
     last_modified changes. */

const PAGE_SIZE = 200;

function createJubelioSource(cfg) {
  const api = (cfg.api || 'https://api2.jubelio.com').replace(/\/+$/, '');
  const locations = (cfg.location || '').split(',').map(norm).filter(Boolean);
  const locationIds = (cfg.locationId || '').split(',').map((s) => s.trim()).filter(Boolean);
  const concurrency = Math.max(1, cfg.concurrency || 5);
  const valueField = cfg.valueField || 'grand_total';
  const details = cfg.cache || new Map(); // salesorder_id -> { mod, rec }
  let token = null, tokenAt = 0, loggingIn = null;

  if (!cfg.email || !cfg.password) throw new Error('JUBELIO_EMAIL dan JUBELIO_PASSWORD wajib diisi');
  if (!locations.length && !locationIds.length) throw new Error('Isi JUBELIO_LOCATION (nama gudang) atau JUBELIO_LOCATION_ID');
  if (!cfg.dateFrom) throw new Error('Isi JUBELIO_DATE_FROM (tanggal mulai event, YYYY-MM-DD)');
  // accept the two dates in either order
  const [dateFrom, dateTo] = cfg.dateTo && cfg.dateTo < cfg.dateFrom ? [cfg.dateTo, cfg.dateFrom] : [cfg.dateFrom, cfg.dateTo];

  async function call(method, path, body, retried) {
    if (path !== '/login' && (!token || Date.now() - tokenAt > 11 * 3600e3)) {
      // parallel detail workers share one login instead of each logging in
      loggingIn = loggingIn || login().finally(() => { loggingIn = null; });
      await loggingIn;
    }
    const res = await fetch(api + path, {
      method,
      headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}, path !== '/login' ? { Authorization: token } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    if (res.status === 401 && path !== '/login' && !retried) { token = null; return call(method, path, body, true); }
    if (!res.ok) throw new Error('Jubelio ' + method + ' ' + path.split('?')[0] + ': HTTP ' + res.status);
    return res.json();
  }

  async function login() {
    const r = await call('POST', '/login', { email: cfg.email, password: cfg.password });
    if (!r || !r.token) throw new Error('Login Jubelio gagal: respons tanpa token');
    token = r.token; tokenAt = Date.now();
  }

  function atLocation(o) {
    if (locationIds.length && o.location_id != null && locationIds.includes(String(o.location_id))) return true;
    return locations.includes(norm(o.location_name));
  }

  async function listOrders() {
    const q = { pageSize: PAGE_SIZE, sortBy: 'transaction_date', sortDirection: 'DESC', transactionDateFrom: wib(dateFrom, '00:00:00') };
    if (dateTo) q.transactionDateTo = wib(dateTo, '23:59:59');
    const out = [];
    for (let page = 1; ; page++) {
      const r = await call('GET', '/sales/orders/?' + new URLSearchParams(Object.assign({ page }, q)));
      const data = (r && r.data) || [];
      data.forEach((o) => { if (atLocation(o) && !(o.is_canceled && !cfg.includeCanceled)) out.push(o); });
      if (data.length < PAGE_SIZE) return out;
    }
  }

  function toRecord(o, d) {
    const items = (d.items || []).filter((it) => !it.is_canceled_item);
    return {
      phone: d.customer_phone || d.shipping_phone || '',
      name: d.customer_name || d.shipping_full_name || '',
      qty: items.reduce((s, it) => s + (Number(it.qty_in_base != null ? it.qty_in_base : it.qty) || 0), 0),
      value: money(d[valueField] != null ? d[valueField] : o.grand_total),
      line: o.salesorder_no || o.salesorder_id
    };
  }

  async function fetchDetails(orders) {
    const todo = orders.filter((o) => { const c = details.get(o.salesorder_id); return !c || c.mod !== (o.last_modified || ''); });
    let i = 0;
    async function worker() {
      while (i < todo.length) {
        const o = todo[i++];
        const d = await call('GET', '/sales/orders/' + encodeURIComponent(o.salesorder_id));
        details.set(o.salesorder_id, { mod: o.last_modified || '', rec: toRecord(o, d) });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    return todo.length;
  }

  return {
    name: 'jubelio',
    async fetch() {
      const orders = await listOrders();
      await fetchDetails(orders);
      // orders that left the location or got canceled drop out because only listed ids are returned
      return orders.map((o) => details.get(o.salesorder_id).rec);
    },
    close: async () => {}
  };
}

// API money comes as machine strings like "3000000.0000"; the Sheet parser would
// read the 4 decimals as digits, so convert here
function money(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : v; }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }
function wib(date, time) { return /T/.test(date) ? date : date + 'T' + time + '+07:00'; }

module.exports = { createJubelioSource };
