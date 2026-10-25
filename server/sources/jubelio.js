'use strict';

/* Jubelio orders from one warehouse/location (e.g. "MAIN IMPERFECT WAREHOUS 2026").
   Read-only: POST /login for a token, everything else is GET.

   API behaviour (verified on this account, see martech-sys/data-db docs/jubelio-api.md
   and the read-only check of 2026-10-25):
   - Authorization header is the bare token, no "Bearer".
   - GET /sales/orders/ (v1) cannot filter by location, so the event's date range
     is listed (pageSize max 200) and orders are kept by location_name/location_id.
   - Phone numbers on orders are masked by Jubelio ("**********99"). The full
     number is only on GET /contacts/{contact_id} (`phone`). Walk-in orders have
     contact_id -1 ("Pelanggan Umum") and therefore no phone.
   - GET /sales/orders/{id} and /contacts/{id} take about 1 s each.

   Sync is incremental and bounded by budgetMs per fetch: the first pass walks the
   date range page by page (resuming where the last fetch stopped), later passes
   only ask for orders changed since the previous pass (lastModifiedSince).
   Orders still waiting for their contact are resolved on later fetches. The whole
   sync state goes through cfg.store, so a Netlify Function can keep it in Blobs
   and a cold start does not begin from zero. */

const PAGE_SIZE = 200;
const OVERLAP_MS = 5 * 60e3; // re-read a little of the previous window; updates are idempotent
const EMPTY_PHONE_RETRY_MS = 5 * 60e3; // a cashier may add the phone to the contact later

function createJubelioSource(cfg) {
  const api = (cfg.api || 'https://api2.jubelio.com').replace(/\/+$/, '');
  const locations = (cfg.location || '').split(',').map(norm).filter(Boolean);
  const locationIds = (cfg.locationId || '').split(',').map((s) => s.trim()).filter(Boolean);
  const concurrency = Math.max(1, cfg.concurrency || 5);
  const budgetMs = Math.max(1000, cfg.budgetMs || 20000);
  const store = cfg.store || memoryStore();
  let token = null, tokenAt = 0, loggingIn = null, state = null;

  if (!cfg.email || !cfg.password) throw new Error('JUBELIO_EMAIL dan JUBELIO_PASSWORD wajib diisi');
  if (!locations.length && !locationIds.length) throw new Error('Isi JUBELIO_LOCATION (nama gudang) atau JUBELIO_LOCATION_ID');
  if (!cfg.dateFrom) throw new Error('Isi JUBELIO_DATE_FROM (tanggal mulai event, YYYY-MM-DD)');
  // accept the two dates in either order
  const [dateFrom, dateTo] = cfg.dateTo && cfg.dateTo < cfg.dateFrom ? [cfg.dateTo, cfg.dateFrom] : [cfg.dateFrom, cfg.dateTo];
  // a saved sync for another location or date range is thrown away
  const scope = JSON.stringify([locations, locationIds, dateFrom, dateTo || '', !!cfg.includeCanceled]);

  async function call(method, path, body, retried) {
    if (path !== '/login' && (!token || Date.now() - tokenAt > 11 * 3600e3)) {
      // parallel workers share one login instead of each logging in
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

  async function loadState() {
    if (state) return state;
    let saved = null;
    try { saved = await store.load(); } catch (e) { console.warn('[jubelio] gagal membaca sync tersimpan: ' + e.message); }
    state = saved && saved.v === 1 && saved.scope === scope ? saved
      : { v: 1, scope, scan: { page: 1, startedAt: null, done: false }, since: null, orders: {}, contacts: {} };
    return state;
  }

  function atLocation(o) {
    if (locationIds.length && o.location_id != null && locationIds.includes(String(o.location_id))) return true;
    return locations.includes(norm(o.location_name));
  }

  async function listPage(page, extra) {
    const q = Object.assign({
      page, pageSize: PAGE_SIZE, sortBy: 'transaction_date', sortDirection: 'ASC',
      transactionDateFrom: wib(dateFrom, '00:00:00')
    }, dateTo ? { transactionDateTo: wib(dateTo, '23:59:59') } : {}, extra);
    const r = await call('GET', '/sales/orders/?' + new URLSearchParams(q));
    return (r && r.data) || [];
  }

  function take(o) {
    const id = String(o.salesorder_id), prev = state.orders[id];
    if (!atLocation(o) || (o.is_canceled && !cfg.includeCanceled)) { delete state.orders[id]; return; }
    const mod = o.last_modified || '';
    if (prev && prev.mod === mod) return;
    state.orders[id] = {
      mod, no: o.salesorder_no || id,
      cid: o.contact_id != null ? Number(o.contact_id) : null, // null: read it from the order detail
      name: o.customer_name || '', qty: 0, value: money(o.grand_total), phone: '', done: false
    };
  }

  async function syncList(deadline) {
    const sc = state.scan;
    if (!sc.done) {
      sc.startedAt = sc.startedAt || new Date().toISOString();
      while (Date.now() < deadline) {
        const data = await listPage(sc.page);
        data.forEach(take);
        if (data.length < PAGE_SIZE) { sc.done = true; state.since = shift(sc.startedAt, -OVERLAP_MS); return; }
        sc.page++;
      }
      return;
    }
    const runStart = new Date().toISOString();
    for (let page = 1; Date.now() < deadline; page++) {
      const data = await listPage(page, { lastModifiedSince: state.since });
      data.forEach(take);
      if (data.length < PAGE_SIZE) { state.since = shift(runStart, -OVERLAP_MS); return; }
    }
  }

  const contactReads = new Map(); // contact_id -> in-flight read, so parallel workers share it

  async function contactPhone(cid) {
    const c = state.contacts[cid];
    if (c && (c.phone || Date.now() - c.at < EMPTY_PHONE_RETRY_MS)) return c;
    if (!contactReads.has(cid)) {
      contactReads.set(cid, call('GET', '/contacts/' + encodeURIComponent(cid)).then((r) => {
        state.contacts[cid] = { phone: unmasked(r && (r.phone || r.mobile)), name: (r && r.contact_name) || '', at: Date.now() };
        return state.contacts[cid];
      }).finally(() => contactReads.delete(cid)));
    }
    return contactReads.get(cid);
  }

  async function resolve(e, id) {
    if (e.cid == null) {
      const d = await call('GET', '/sales/orders/' + encodeURIComponent(id));
      e.cid = d.contact_id != null ? Number(d.contact_id) : -1;
      e.name = e.name || d.customer_name || '';
      e.qty = (d.items || []).filter((it) => !it.is_canceled_item)
        .reduce((s, it) => s + (Number(it.qty_in_base != null ? it.qty_in_base : it.qty) || 0), 0);
      if (d[cfg.valueField || 'grand_total'] != null) e.value = money(d[cfg.valueField || 'grand_total']);
      e.fallbackPhone = unmasked(d.customer_phone) || unmasked(d.shipping_phone);
    }
    if (e.cid > 0) {
      const c = await contactPhone(e.cid);
      e.phone = c.phone || e.fallbackPhone || '';
      e.name = e.name || c.name;
    } else {
      e.phone = e.fallbackPhone || '';
    }
    // walk-in orders are final without a phone (they show up as skipped);
    // a registered buyer without a phone yet stays pending and is retried
    e.done = !!e.phone || e.cid <= 0;
  }

  async function resolvePending(deadline) {
    const now = Date.now();
    const todo = Object.keys(state.orders).filter((id) => { const e = state.orders[id]; return !e.done && !(e.waitUntil > now); });
    let i = 0;
    async function worker() {
      while (i < todo.length && Date.now() < deadline) {
        const id = todo[i++], e = state.orders[id];
        if (!e) continue;
        await resolve(e, id);
        // a registered buyer without a phone yet is asked again a few minutes later
        e.waitUntil = e.done ? undefined : Date.now() + EMPTY_PHONE_RETRY_MS;
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  }

  return {
    name: 'jubelio',
    async fetch() {
      const deadline = Date.now() + budgetMs;
      await loadState();
      try {
        await syncList(deadline);
        await resolvePending(deadline);
      } finally {
        // keep whatever progress was made, even when a call failed half way
        try { await store.save(state); } catch (e) { console.warn('[jubelio] gagal menyimpan sync: ' + e.message); }
      }
      return Object.values(state.orders)
        .filter((e) => e.done || e.phone)
        .map((e) => ({ phone: e.phone, name: e.name, qty: e.qty, value: e.value, line: e.no }));
    },
    info() {
      if (!state) return {};
      const all = Object.values(state.orders);
      return {
        scanning: !state.scan.done,
        orders: all.length,
        pending: all.filter((e) => !e.done).length,
        noPhone: all.filter((e) => e.done && !e.phone).length
      };
    },
    close: async () => {}
  };
}

function memoryStore() {
  let saved = null;
  return { load: async () => saved, save: async (s) => { saved = s; } };
}

// API money comes as machine strings like "3000000.0000"; the Sheet parser would
// read the 4 decimals as digits, so convert here
function money(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : v; }
// Jubelio masks phones on orders ("**********99"); a masked value is useless
function unmasked(p) { return p && !/\*/.test(String(p)) ? String(p) : ''; }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }
function wib(date, time) { return /T/.test(date) ? date : date + 'T' + time + '+07:00'; }
function shift(iso, ms) { return new Date(new Date(iso).getTime() + ms).toISOString(); }

module.exports = { createJubelioSource };
