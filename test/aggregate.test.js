'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toNum, normPhone, parseCSV, rowsToRecords, aggregate, buildState } = require('../server/aggregate');
const { sheetCsvUrl } = require('../server/sources/sheet');
const { pgNumber } = require('../server/sources/postgres');

test('toNum reads rupiah in the formats people type', () => {
  assert.equal(toNum('3000000'), 3000000);
  assert.equal(toNum('Rp 3.000.000'), 3000000);
  assert.equal(toNum('3,000,000.00'), 3000000);
  assert.equal(toNum('3000000.00'), 3000000); // Postgres NUMERIC comes back as a string
  assert.equal(toNum(1500000), 1500000);
  assert.ok(Number.isNaN(toNum('')));
});

test('normPhone merges 62 / +62 / 8 prefixes into 08', () => {
  assert.equal(normPhone('6287781510867'), '087781510867');
  assert.equal(normPhone('+62 877-8151-0867'), '087781510867');
  assert.equal(normPhone('87781510867'), '087781510867');
  assert.equal(normPhone('6.28778E+12'), '');
  assert.equal(normPhone('123'), '');
});

test('sheet rows are mapped by header name', () => {
  const rows = parseCSV('No HP,Nama,qty,trx value\n6287781510867,Bayu,1,3000000\n,Tanpa HP,1,10\n');
  const recs = rowsToRecords(rows);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], { phone: '6287781510867', name: 'Bayu', qty: '1', value: '3000000', line: 2 });
});

test('Postgres and Sheet records for one buyer are merged into one row', () => {
  const pg = [
    { phone: '081234567890', name: 'Dewi Lestari', qty: 2, value: '45000000.00' },
    { phone: '085711112222', name: 'Agus', qty: 1, value: '1000000.00' }
  ];
  const sheet = rowsToRecords(parseCSV('No HP,Nama,qty,trx value\n6281234567890,Dewi,3,"5.000.000"\nxx,Rusak,1,100\n'));
  let { map, stat } = aggregate(pg);
  assert.equal(stat.valid, 2);
  ({ map, stat } = aggregate(sheet, map));
  assert.equal(stat.valid, 1);
  assert.deepEqual(stat.skipped, [3]);

  const st = buildState(map, { updatedAt: '2026-10-23T00:00:00.000Z' });
  assert.equal(st.updatedAt, '2026-10-23T00:00:00.000Z');
  assert.deepEqual(st.totals, { sales: 51000000, qty: 6, trx: 3, buyers: 2 });
  assert.deepEqual(st.top[0], { p: '0812-xxxx-7890', n: 'Dewi L.', q: 5, t: 2, v: 50000000 });
});

test('sheetCsvUrl turns a share link into the CSV export URL', () => {
  assert.equal(
    sheetCsvUrl('https://docs.google.com/spreadsheets/d/ABC_123/edit?gid=949297504#gid=949297504'),
    'https://docs.google.com/spreadsheets/d/ABC_123/gviz/tq?tqx=out:csv&gid=949297504'
  );
  assert.equal(sheetCsvUrl('ABC_123', '5'), 'https://docs.google.com/spreadsheets/d/ABC_123/gviz/tq?tqx=out:csv&gid=5');
  const pub = 'https://docs.google.com/spreadsheets/d/e/XYZ/pub?output=csv';
  assert.equal(sheetCsvUrl(pub), pub);
});

test('pgNumber reads Postgres NUMERIC strings at any scale', () => {
  assert.equal(pgNumber('2500000.0000'), 2500000);
  assert.equal(pgNumber('2500000'), 2500000);
  assert.equal(pgNumber('1.5000'), 2);
  assert.equal(pgNumber(1200), 1200);
  assert.equal(pgNumber(null), null);
  assert.equal(pgNumber('Rp 2.500.000'), 'Rp 2.500.000', 'human formats are left to toNum');
});
