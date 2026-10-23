'use strict';

const { aggregate, buildState } = require('./aggregate');

/* Polls every source on an interval and keeps one merged state in memory.
   If a source fails, its last good records are reused (marked stale) so a
   flaky Sheet or a DB restart never wipes the board on the TV. */
function createCollector(sources, opts) {
  const pollMs = opts.pollMs;
  const last = new Map(); // source name -> { records, fetchedAt }
  const status = {};
  let state = null, timer = null, running = null;

  sources.forEach((s) => { status[s.name] = { ok: false, error: null, fetchedAt: null, rows: 0, valid: 0, skipped: 0 }; });

  async function refreshOne(src) {
    const st = status[src.name];
    try {
      const records = await src.fetch();
      last.set(src.name, { records, fetchedAt: new Date().toISOString() });
      st.ok = true; st.error = null;
    } catch (e) {
      st.ok = false; st.error = e.message || String(e);
      console.error('[' + src.name + '] ' + st.error);
    }
    const prev = last.get(src.name);
    st.fetchedAt = prev ? prev.fetchedAt : null;
    st.stale = !st.ok && !!prev;
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      await Promise.all(sources.map(refreshOne));
      if (!last.size) return; // nothing has ever loaded: keep state null so the page knows
      let map = new Map();
      sources.forEach((src) => {
        const st = status[src.name], got = last.get(src.name);
        if (!got) { st.rows = st.valid = st.skipped = 0; st.skippedLines = []; return; }
        const r = aggregate(got.records, map);
        map = r.map;
        st.rows = r.stat.rows; st.valid = r.stat.valid; st.skipped = r.stat.skipped.length;
        st.skippedLines = r.stat.skipped.slice(0, 6);
      });
      // "last update" is the newest successful read, not the time of this attempt
      const newest = Object.values(status).map((s) => s.fetchedAt).filter(Boolean).sort().pop();
      state = buildState(map, { updatedAt: newest });
    })().finally(() => { running = null; });
    return running;
  }

  return {
    start() {
      const p = refresh();
      timer = setInterval(refresh, pollMs);
      return p;
    },
    stop() { clearInterval(timer); },
    refresh,
    snapshot() {
      return {
        state,
        sources: JSON.parse(JSON.stringify(status)),
        pollMs
      };
    }
  };
}

module.exports = { createCollector };
