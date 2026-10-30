'use strict';

const { createPostgresSource } = require('./sources/postgres');
const { createSheetSource } = require('./sources/sheet');
const { createJubelioSource } = require('./sources/jubelio');
const { createDriveSource } = require('./sources/drive');

/* One place that turns environment variables into sources, shared by the
   long-running server (server/index.js) and the Vercel Function (server/api.js). */
const flag = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

function loadConfig(env) {
  return {
    port: parseInt(env.PORT || '3000', 10),
    pollMs: Math.max(5000, parseInt(env.POLL_MS || '30000', 10)),
    sources: (env.DATA_SOURCES || 'postgres,sheet,drive,jubelio').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    pg: {
      url: env.DATABASE_URL,
      host: env.DATABASE_HOST,
      port: parseInt(env.DATABASE_PORT || '5432', 10),
      user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      database: env.DATABASE_NAME,
      query: env.PG_QUERY,
      ssl: flag(env.PG_SSL, false),
      sslRejectUnauthorized: flag(env.PG_SSL_REJECT_UNAUTHORIZED, true)
    },
    sheet: { url: env.SHEET_URL, gid: env.SHEET_GID || '0' },
    brandSheets: parseBrandSheets(env.SHEET_URLS),
    drive: {
      folder: env.DRIVE_FOLDER,
      json: env.GOOGLE_SERVICE_ACCOUNT_JSON,
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      privateKey: env.GOOGLE_PRIVATE_KEY,
      maxRows: parseInt(env.DRIVE_MAX_ROWS || '5000', 10),
      exclude: String(env.DRIVE_EXCLUDE || '').split(/[\n;,]/).map((s) => s.trim()).filter(Boolean)
    },
    jubelio: {
      email: env.JUBELIO_EMAIL,
      password: env.JUBELIO_PASSWORD,
      api: env.JUBELIO_API,
      location: env.JUBELIO_LOCATION,
      dateFrom: env.JUBELIO_DATE_FROM,
      dateTo: env.JUBELIO_DATE_TO,
      valueField: env.JUBELIO_VALUE_FIELD,
      includeCanceled: flag(env.JUBELIO_INCLUDE_CANCELED, false),
      concurrency: parseInt(env.JUBELIO_CONCURRENCY || '5', 10),
      budgetMs: parseInt(env.JUBELIO_BUDGET_MS || '20000', 10)
    }
  };
}

function createSources(config, log, deps) {
  const sources = [];
  if (config.sources.includes('postgres')) {
    if (config.pg.url || config.pg.host) sources.push(createPostgresSource(Object.assign({}, config.pg, deps)));
    else log('[postgres] DATABASE_URL / DATABASE_HOST kosong, sumber Postgres dilewati');
  }
  if (config.sources.includes('sheet')) {
    if (config.sheet.url) sources.push(createSheetSource(config.sheet));
    // one source per brand, so a brand sheet that is missing or broken only
    // flags that brand; the others keep feeding the board
    const seen = new Set();
    config.brandSheets.forEach((b) => {
      const name = 'sheet:' + b.brand;
      if (seen.has(name)) { log('[' + name + '] brand ini tertulis dua kali di SHEET_URLS, yang kedua dilewati'); return; }
      seen.add(name);
      sources.push(createSheetSource({ name, url: b.url, gid: config.sheet.gid }));
    });
    if (!config.sheet.url && !config.brandSheets.length) log('[sheet] SHEET_URL / SHEET_URLS kosong, sumber Sheet dilewati');
  }
  if (config.sources.includes('drive')) {
    if (!config.drive.folder) log('[drive] DRIVE_FOLDER kosong, sumber Sheet brand (Drive) dilewati');
    else {
      try { sources.push(createDriveSource(Object.assign({}, config.drive, deps && deps.drive))); }
      catch (e) { log('[drive] ' + e.message + ', sumber Sheet brand (Drive) dilewati'); }
    }
  }
  if (config.sources.includes('jubelio')) {
    if (!config.jubelio.email) log('[jubelio] JUBELIO_EMAIL kosong, sumber Jubelio dilewati');
    else {
      try { sources.push(createJubelioSource(Object.assign({}, config.jubelio, deps && deps.jubelio))); }
      catch (e) { log('[jubelio] ' + e.message + ', sumber Jubelio dilewati'); }
    }
  }
  return sources;
}

/* SHEET_URLS: one brand per line (or separated by ";"), as "Brand | link".
   A line without "|" gets the name "Sheet N". Blank lines and lines starting
   with # are ignored. */
function parseBrandSheets(text) {
  return String(text || '').split(/[\n;]+/).map((l) => l.trim()).filter((l) => l && l[0] !== '#')
    .map((line, i) => {
      const bar = line.indexOf('|');
      const brand = bar < 0 ? 'Sheet ' + (i + 1) : line.slice(0, bar).trim().replace(/\s+/g, ' ');
      const url = (bar < 0 ? line : line.slice(bar + 1)).trim();
      return { brand: brand || 'Sheet ' + (i + 1), url };
    })
    .filter((b) => b.url);
}

module.exports = { loadConfig, createSources, parseBrandSheets };
