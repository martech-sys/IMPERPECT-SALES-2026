'use strict';

/* Shared parsing + aggregation. Every source (Postgres, Google Sheet) is turned
   into the same record shape {phone, name, qty, value} and merged here, so one
   buyer who shows up in both sources is counted once, under one phone number. */

const STORE_TOP = 1500; // the board lists every jastiper, in two scrolling columns

function toNum(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? Math.round(s) : NaN;
  s = String(s == null ? '' : s).trim();
  if (!s) return NaN;
  s = s.replace(/rp\.?/gi, '').replace(/\s/g, '');
  // drop a trailing decimal part (",50" / ".00"), keep thousand separators for stripping
  const m = s.match(/^(.*?)[.,](\d{1,2})$/);
  if (m && /^[\d.,]*\d$/.test(m[1])) s = m[1];
  s = s.replace(/[^\d-]/g, '');
  return s ? parseInt(s, 10) : NaN;
}

function normPhone(s) {
  if (/e\+/i.test(String(s))) return ''; // number mangled by a spreadsheet into scientific notation
  let d = String(s == null ? '' : s).replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);        // 0062 812...: international prefix
  if (d.indexOf('62') === 0) d = d.slice(2);        // 62 812... / +62 812...
  d = '0' + d.replace(/^0+/, '');                   // +62 0812..., 0812..., 812... -> 0812...
  return /^0\d{8,13}$/.test(d) ? d : '';
}

/* The warehouse masks phones ("***********24"): only the last two digits are
   known, so such a buyer is identified by name + those two digits. Full phones
   keep identifying by number. */
function normName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z\u00c0-\u024f]+/g, ' ').trim();
}

function buyerKey(phone, name) {
  const full = normPhone(phone);
  if (full) return full;
  const s = String(phone == null ? '' : phone);
  if (!s.includes('*')) return '';
  const d = s.replace(/\D/g, ''), nm = normName(name);
  return d.length >= 2 && nm ? 'm:' + nm + '|' + d.slice(-2) : '';
}

function maskPhone(d) {
  if (d.startsWith('m:')) return 'xxxx-xxxx-xx' + d.slice(-2);
  return d.slice(0, 4) + '-xxxx-' + d.slice(-4);
}

function shortName(s) {
  const w = String(s || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
  return w.length > 1 ? cap(w[0]) + ' ' + w[1].charAt(0).toUpperCase() + '.' : cap(w[0]);
}

function parseCSV(text) {
  const rows = [];
  let row = [], f = '', q = false;
  text = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (q) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i++;
      row.push(f); f = ''; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/* Sheet rows -> records. Columns are found by header name (No HP, Nama, qty,
   trx value); without a recognisable header the order is HP, Nama, qty, value. */
function rowsToRecords(rows) {
  if (!rows.length) return [];
  let idx = { p: 0, n: 1, q: 2, v: 3 }, start = 0;
  const first = rows[0];
  if (isNaN(toNum(first[2])) && isNaN(toNum(first[3]))) {
    start = 1;
    const m = {};
    first.forEach((h, i) => {
      h = String(h).toLowerCase();
      if (m.p == null && /hp|phone|telp|tlp|wa/.test(h)) m.p = i;
      else if (m.n == null && /nama|name/.test(h)) m.n = i;
      else if (m.q == null && /qty|jumlah|pcs/.test(h)) m.q = i;
      else if (m.v == null && /value|nilai|total|trx|omzet|sales/.test(h)) m.v = i;
    });
    if (m.p != null && m.v != null) idx = { p: m.p, n: m.n != null ? m.n : -1, q: m.q != null ? m.q : -1, v: m.v };
  }
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const c = rows[i];
    out.push({
      phone: c[idx.p],
      name: idx.n >= 0 ? c[idx.n] : '',
      qty: idx.q >= 0 ? c[idx.q] : 0,
      value: c[idx.v],
      line: i + 1
    });
  }
  return out;
}

/* records -> per-phone totals. Returns the merged map plus counts so the
   diagnostics chip can say how many rows each source contributed or skipped.

   One phone can be written with different names (full name, nickname, ...).
   The board shows the short name used most often for that phone; on a tie the
   longer one (more complete), then alphabetical. The choice does not depend on
   row order, which Postgres and Drive do not guarantee, so the name on the TV
   does not flip between refreshes. */
function pickName(names) {
  let best = '', bc = 0;
  names.forEach((c, n) => {
    if (c > bc || (c === bc && (n.length > best.length || (n.length === best.length && n < best)))) { best = n; bc = c; }
  });
  return best;
}

function aggregate(records, map) {
  map = map || new Map();
  const stat = { rows: records.length, valid: 0, skipped: [] };
  records.forEach((r, i) => {
    const ph = buyerKey(r.phone, r.name), v = toNum(r.value), q = toNum(r.qty);
    if (!ph || !(v > 0)) { stat.skipped.push(r.line != null ? r.line : i + 1); return; }
    let e = map.get(ph);
    if (!e) {
      e = { p: ph, n: '', q: 0, t: 0, v: 0 };
      Object.defineProperty(e, 'names', { value: new Map() }); // not sent to the TV
      map.set(ph, e);
    }
    const n = shortName(r.name);
    if (n) {
      e.names.set(n, (e.names.get(n) || 0) + 1);
      e.n = pickName(e.names);
    }
    e.q += q > 0 ? q : 0; e.t += 1; e.v += v; stat.valid++;
  });
  return { map, stat };
}

/* A masked warehouse buyer and a brand-sheet buyer with a full phone are the
   same person when the full phone ends in the same two digits and one of its
   names has the same first name; merged only when exactly one full-phone
   buyer matches, otherwise both stay separate. */
function mergeMasked(map) {
  const first = (n) => normName(n).split(' ')[0];
  const idx = new Map();
  map.forEach((e, k) => {
    if (k.startsWith('m:')) return;
    new Set(Array.from(e.names.keys(), first)).forEach((f) => {
      if (!f) return;
      const id = f + '|' + k.slice(-2);
      if (!idx.has(id)) idx.set(id, []);
      idx.get(id).push(e);
    });
  });
  Array.from(map.keys()).forEach((k) => {
    if (!k.startsWith('m:')) return;
    const m = map.get(k), hits = idx.get(first(k.slice(2, -3)) + '|' + k.slice(-2));
    if (!hits || hits.length !== 1) return;
    const e = hits[0];
    e.q += m.q; e.t += m.t; e.v += m.v;
    m.names.forEach((c, n) => e.names.set(n, (e.names.get(n) || 0) + c));
    e.n = pickName(e.names);
    map.delete(k);
  });
}

function buildState(map, extra) {
  mergeMasked(map);
  const list = Array.from(map.values()).sort((a, b) => b.v - a.v);
  let sales = 0, qty = 0, trx = 0;
  list.forEach((e) => { sales += e.v; qty += e.q; trx += e.t; });
  return Object.assign({
    updatedAt: new Date().toISOString(),
    totals: { sales, qty, trx, buyers: list.length },
    // phone numbers are masked here, so full numbers never leave the server
    top: list.slice(0, STORE_TOP).map((e) => ({ p: maskPhone(e.p), n: e.n, q: e.q, t: e.t, v: e.v }))
  }, extra || {});
}

module.exports = { toNum, normPhone, buyerKey, maskPhone, shortName, parseCSV, rowsToRecords, aggregate, buildState, STORE_TOP };
