'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollector } = require('../server/collector');

function fakeSource(name, batches) {
  let i = 0;
  return {
    name,
    async fetch() {
      const b = batches[Math.min(i++, batches.length - 1)];
      if (b instanceof Error) throw b;
      return b;
    }
  };
}

test('a failing source keeps its last good records and is marked stale', async () => {
  const pg = fakeSource('postgres', [[{ phone: '081234567890', name: 'A', qty: 1, value: 100e6 }], new Error('db down')]);
  const sheet = fakeSource('sheet', [[{ phone: '085711112222', name: 'B', qty: 1, value: 50e6 }]]);
  const c = createCollector([pg, sheet], { pollMs: 60000 });

  await c.refresh();
  let snap = c.snapshot();
  assert.equal(snap.state.totals.sales, 150e6);
  assert.equal(snap.sources.postgres.ok, true);

  await c.refresh();
  snap = c.snapshot();
  assert.equal(snap.state.totals.sales, 150e6, 'board keeps Postgres numbers from the last good read');
  assert.equal(snap.sources.postgres.ok, false);
  assert.equal(snap.sources.postgres.stale, true);
  assert.equal(snap.sources.postgres.error, 'db down');
});

test('state stays null until some source has loaded', async () => {
  const c = createCollector([fakeSource('sheet', [new Error('private')])], { pollMs: 60000 });
  await c.refresh();
  const snap = c.snapshot();
  assert.equal(snap.state, null);
  assert.equal(snap.sources.sheet.error, 'private');
});
