'use strict';

/* /api/state and /healthz for serverless hosting (Vercel), where there is no
   long-lived process to poll on a timer: sources are read on request, at most
   once per cacheSeconds per warm instance. The response is also cached on the
   CDN for cacheSeconds, so many TVs polling at once still mean one query.
   A warm instance keeps its collector, so a failing source falls back to the
   last data it read. */

const { createCollector } = require('./collector');
const { loadConfig, createSources } = require('./config');

function createApi(env, deps) {
  const settings = loadConfig(env);
  const skipped = []; // why each source was skipped, shown when nothing is configured
  const sources = createSources(settings, (m) => { skipped.push(m); console.warn(m); }, deps);
  const collector = sources.length ? createCollector(sources, { pollMs: settings.pollMs }) : null;
  const cacheSeconds = Math.max(0, parseInt(env.CACHE_SECONDS || '30', 10));
  let lastRefresh = 0;

  async function handle(pathname) {
    if (!collector) {
      return {
        status: 500,
        body: {
          error: 'Tidak ada sumber data. Isi DATABASE_HOST (atau DATABASE_URL), SHEET_URL / SHEET_URLS, atau JUBELIO_EMAIL di environment variables, lalu deploy ulang.',
          skipped,
          // names only, never values: which variables this deploy actually received
          env: Object.fromEntries(['DATA_SOURCES', 'DATABASE_URL', 'DATABASE_HOST', 'DATABASE_USER', 'DATABASE_PASSWORD',
            'DATABASE_NAME', 'PG_QUERY', 'SHEET_URL', 'SHEET_URLS', 'JUBELIO_EMAIL'].map((k) => [k, env[k] ? 'terisi' : 'kosong'])),
          dataSources: settings.sources
        }
      };
    }
    if (Date.now() - lastRefresh >= cacheSeconds * 1000) {
      await collector.refresh();
      lastRefresh = Date.now();
    }
    const snap = collector.snapshot();
    if (pathname === '/healthz') {
      const ok = Object.values(snap.sources).some((s) => s.ok);
      return { status: ok ? 200 : 503, body: { ok, sources: snap.sources } };
    }
    // only cache on the CDN once there is something worth showing
    return { status: 200, body: snap, cacheSeconds: snap.state ? cacheSeconds : 0 };
  }

  return { handle };
}

module.exports = { createApi };
