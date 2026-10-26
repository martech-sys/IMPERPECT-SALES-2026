/* Netlify Function for /api/state and /healthz.
   Netlify cannot run the long-lived server, so sources are read on request
   instead of on a timer. A warm instance reuses its collector (and the last
   good data per source); results are also cached on Netlify's CDN for
   CACHE_SECONDS so many TVs polling at once do not each hit Postgres. */
import pg from 'pg';
import { getStore } from '@netlify/blobs';
import collectorMod from '../../server/collector.js';
import configMod from '../../server/config.js';

const { createCollector } = collectorMod;
const { loadConfig, createSources } = configMod;

const env = process.env;
const settings = loadConfig(env);
// Jubelio sync progress lives in Netlify Blobs, so a cold instance carries on
// where the last one stopped instead of re-reading every order and contact.
// Each request gets a short budget; the CDN cache spaces requests out.
const jubelioStore = {
  load: () => getStore({ name: 'imperfect-jubelio', consistency: 'strong' }).get('sync', { type: 'json' }),
  save: (s) => getStore({ name: 'imperfect-jubelio', consistency: 'strong' }).setJSON('sync', s)
};
const sources = createSources(settings, console.warn, {
  Pool: pg.Pool,
  maxConnections: 1, // one query per refresh; every warm instance holds at most one connection
  jubelio: { store: jubelioStore, budgetMs: parseInt(env.JUBELIO_BUDGET_MS || '7000', 10) }
});
const collector = sources.length ? createCollector(sources, { pollMs: settings.pollMs }) : null;
const cacheSeconds = Math.max(0, parseInt(env.CACHE_SECONDS || '15', 10));
let lastRefresh = 0;

function json(status, body, cdnCache) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (cdnCache && cacheSeconds) {
    headers['Netlify-CDN-Cache-Control'] = 'public, durable, s-maxage=' + cacheSeconds + ', stale-while-revalidate=' + cacheSeconds * 4;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export default async (req) => {
  if (!collector) {
    return json(500, { error: 'Tidak ada sumber data. Isi DATABASE_URL dan/atau SHEET_URL di environment variables Netlify.' });
  }
  if (Date.now() - lastRefresh >= cacheSeconds * 1000) {
    await collector.refresh();
    lastRefresh = Date.now();
  }
  const snap = collector.snapshot();
  if (new URL(req.url).pathname === '/healthz') {
    const ok = Object.values(snap.sources).some((s) => s.ok);
    return json(ok ? 200 : 503, { ok, sources: snap.sources });
  }
  // only cache on the CDN once there is something worth showing
  return json(200, snap, !!snap.state);
};

export const config = { path: ['/api/state', '/healthz'] };
