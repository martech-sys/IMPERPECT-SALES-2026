'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, createSources } = require('../server/config');

// captures what the Postgres source hands to pg.Pool, without connecting
function fakePool() {
  const seen = [];
  function Pool(opts) { seen.push(opts); this.on = () => {}; this.end = async () => {}; }
  return { Pool, seen };
}

test('separate DATABASE_* vars pass the password through untouched', () => {
  const { Pool, seen } = fakePool();
  const password = 'p@ss:w/o#r?d%20&é';
  const cfg = loadConfig({
    DATA_SOURCES: 'postgres', DATABASE_HOST: '10.0.0.5', DATABASE_PORT: '6543',
    DATABASE_USER: 'imperfect_tv', DATABASE_PASSWORD: password, DATABASE_NAME: 'we_data_store'
  });
  const sources = createSources(cfg, () => {}, { Pool });
  assert.equal(sources.length, 1);
  assert.equal(seen[0].connectionString, undefined);
  assert.deepEqual(
    { host: seen[0].host, port: seen[0].port, user: seen[0].user, password: seen[0].password, database: seen[0].database },
    { host: '10.0.0.5', port: 6543, user: 'imperfect_tv', password, database: 'we_data_store' }
  );
});

test('DATABASE_URL wins over the separate vars', () => {
  const { Pool, seen } = fakePool();
  const cfg = loadConfig({ DATA_SOURCES: 'postgres', DATABASE_URL: 'postgres://a:b@h/db', DATABASE_HOST: 'other' });
  createSources(cfg, () => {}, { Pool });
  assert.equal(seen[0].connectionString, 'postgres://a:b@h/db');
  assert.equal(seen[0].host, undefined);
});

test('no database settings: Postgres source is skipped with a note', () => {
  const notes = [];
  const sources = createSources(loadConfig({ DATA_SOURCES: 'postgres' }), (m) => notes.push(m), {});
  assert.equal(sources.length, 0);
  assert.match(notes[0], /DATABASE_URL \/ DATABASE_HOST kosong/);
});
