'use strict';

/* Jubelio orders from one warehouse/location (e.g. "MAIN IMPERFECT WAREHOUS 2026").
   Read-only: POST /login for a token, everything else is GET.

   API behaviour, checked on this account on 2026-10-25 (see also
   martech-sys/data-db docs/jubelio-api.md):
   - Authorization header is the bare token, no "Bearer".
   - GET /sales/orders/ (v1) cannot filter by location, and its rows carry
     location_name but no location_id and no contact_id. So the event's date
     range is listed (pageSize max 200) and orders are kept by location name;
     contact_id comes from GET /sales/orders/{id} (about 1 s per call).
   - Phone numbers on orders are masked by Jubelio ("**********99"). The full
     number is only on GET /contacts/{contact_id} (`phone`, about 1.7 s per
     call). Walk-in orders have contact_id -1 ("Pelanggan Umum") and no phone.
   - lastModifiedSince only looks at the UTC date (the time is ignored), so a
     change pass re-lists everything modified that day; unchanged orders are
     skipped by comparing last_modified.
   - is_canceled is null on many canceled orders; internal_status "CANCELED"
     is the reliable flag.

   Sync is incremental and bounded by budgetMs per fetch: the first pass walks
   the date range page by page, later passes only ask for orders changed since
   the previous pass. Either pass resumes at its page on the next fetch when the
   budget runs out, and orders still waiting for their contact are resolved on
   later fetches. The sync state goes through cfg.store (in memory by default),
   so a host with durable storage can keep it across cold starts. */

const OVERLAP_MS = 5 * 60e3; // start the next change pass a little before this one
const EMPTY_PHONE_RETRY_MS = 5 * 60e3; // a cashier may add the phone to the contact later

function createJubelioSource(cfg) {
  const api = (cfg.api || 'https://api2.jubelio.com').replace(/\/+$/, '');
  const locations = (cfg.location || '').split(',').map(norm).filter(Boolean);
  const concurrency = Math.max(1, cfg.concurrency || 5);
  const budgetMs = Math.max(500, cfg.budgetMs || 20000);
  const pageSize = cfg.pageSize || 200;
  const valueField = cfg.valueField || 'grand_total';
  const store = cfg.store || memoryStore();
  const contactReads = new Map(); // contact_id -> in-flight read, shared by parallel workers
  let token = null, tokenAt = 0, loggingIn = null, state = null;

  if (!cfg.email || !cfg.password) throw new Error('JUBELIO_EMAIL dan JUBELIO_PASSWORD wajib diisi');
  if (!locations.length) throw new Error('Isi JUBELIO_LOCATION (nama gudang persis seperti di Jubelio)');
  if (!cfg.dateFrom) throw new Error('Isi JUBELIO_DATE_FROM (tanggal mulai event, YYYY-MM-DD)');
  // accept the two dates in either order
  const [dateFrom, dateTo] = cfg.dateTo && cfg.dateTo < cfg.dateFrom ? [cfg.dateTo, cfg.dateFrom] : [cfg.dateFrom, cfg.dateTo];
  // a saved sync for another location or date range is thrown away
  const scope = JSON.stringify([locations, dateFrom, dateTo || '', !!cfg.includeCanceled, valueField]);

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
    // pass: the list walk in progress. since: null until the first full walk is done
    state = saved && saved.v === 2 && saved.scope === scope ? saved
      : { v: 2, scope, pass: null, since: null, orders: {}, contacts: {} };
    return state;
  }

  function canceled(o) {
    return o.is_canceled === true || String(o.internal_status || '').toUpperCase() === 'CANCELED';
  }

  function take(o) {
    const id = String(o.salesorder_id), prev = state.orders[id];
    if (locations.indexOf(norm(o.location_name)) < 0 || (canceled(o) && !cfg.includeCanceled)) { delete state.orders[id]; return; }
    const mod = o.last_modified || '';
    if (prev && prev.mod === mod) return;
    state.orders[id] = { mod, no: o.salesorder_no || id, cid: null, name: o.customer_name || '', qty: 0, value: money(o.grand_total), phone: '', done: false };
  }

  async function syncList(deadline) {
    // a pass starts as a full walk of the date range, or a change walk once one full walk is done
    state.pass = state.pass || { page: 1, startedAt: new Date().toISOString(), since: state.since };
    const p = state.pass;
    while (Date.now() < deadline) {
      const q = {
        page: p.page, pageSize, sortBy: 'transaction_date', sortDirection: 'ASC',
        transactionDateFrom: wib(dateFrom, '00:00:00')
      };
      if (dateTo) q.transactionDateTo = wib(dateTo, '23:59:59');
      if (p.since) q.lastModifiedSince = p.since.slice(0, 10); // the API only uses the UTC date
      const r = await call('GET', '/sales/orders/?' + new URLSearchParams(q));
      const data = (r && r.data) || [];
      data.forEach(take);
      if (data.length < pageSize) { state.since = shift(p.startedAt, -OVERLAP_MS); state.pass = null; return; }
      p.page++;
    }
  }

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
      if (d[valueField] != null) e.value = money(d[valueField]);
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
    // a registered buyer without a phone yet stays pending and is asked again later
    e.done = !!e.phone || e.cid <= 0;
    e.waitUntil = e.done ? undefined : Date.now() + EMPTY_PHONE_RETRY_MS;
  }

  async function resolvePending(deadline) {
    const now = Date.now();
    const todo = Object.keys(state.orders).filter((id) => { const e = state.orders[id]; return !e.done && !(e.waitUntil > now); });
    let i = 0;
    async function worker() {
      while (i < todo.length && Date.now() < deadline) {
        const id = todo[i++], e = state.orders[id];
        if (e) await resolve(e, id);
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
        .filter((e) => e.done)
        .map((e) => ({ phone: e.phone, name: e.name, qty: e.qty, value: e.value, line: e.no }));
    },
    info() {
      if (!state) return {};
      const all = Object.values(state.orders);
      return {
        scanning: !state.since,
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
