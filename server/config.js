'use strict';

const { createPostgresSource } = require('./sources/postgres');
const { createSheetSource } = require('./sources/sheet');
const { createJubelioSource } = require('./sources/jubelio');

/* One place that turns environment variables into sources, shared by the
   long-running server (server/index.js) and the Netlify Function. */
const flag = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

function loadConfig(env) {
  return {
    port: parseInt(env.PORT || '3000', 10),
    pollMs: Math.max(5000, parseInt(env.POLL_MS || '30000', 10)),
    sources: (env.DATA_SOURCES || 'postgres,sheet,jubelio').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    pg: {
      url: env.DATABASE_URL,
      query: env.PG_QUERY,
      ssl: flag(env.PG_SSL, false),
      sslRejectUnauthorized: flag(env.PG_SSL_REJECT_UNAUTHORIZED, true)
    },
    sheet: { url: env.SHEET_URL, gid: env.SHEET_GID || '0' },
    jubelio: {
      email: env.JUBELIO_EMAIL,
      password: env.JUBELIO_PASSWORD,
      api: env.JUBELIO_API,
      location: env.JUBELIO_LOCATION,
      locationId: env.JUBELIO_LOCATION_ID,
      dateFrom: env.JUBELIO_DATE_FROM,
      dateTo: env.JUBELIO_DATE_TO,
      valueField: env.JUBELIO_VALUE_FIELD,
      includeCanceled: flag(env.JUBELIO_INCLUDE_CANCELED, false),
      concurrency: parseInt(env.JUBELIO_CONCURRENCY || '5', 10)
    }
  };
}

function createSources(config, log, deps) {
  const sources = [];
  if (config.sources.includes('postgres')) {
    if (config.pg.url) sources.push(createPostgresSource(Object.assign({}, config.pg, deps)));
    else log('[postgres] DATABASE_URL kosong, sumber Postgres dilewati');
  }
  if (config.sources.includes('sheet')) {
    if (config.sheet.url) sources.push(createSheetSource(config.sheet));
    else log('[sheet] SHEET_URL kosong, sumber Sheet dilewati');
  }
  if (config.sources.includes('jubelio')) {
    if (!config.jubelio.email) log('[jubelio] JUBELIO_EMAIL kosong, sumber Jubelio dilewati');
    else {
      try { sources.push(createJubelioSource(config.jubelio)); }
      catch (e) { log('[jubelio] ' + e.message + ', sumber Jubelio dilewati'); }
    }
  }
  return sources;
}

module.exports = { loadConfig, createSources };
