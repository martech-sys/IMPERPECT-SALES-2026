'use strict';

const { parseCSV, rowsToRecords } = require('../aggregate');

/* Accepts a full Google Sheet link (Share: Anyone with the link, Viewer),
   a bare spreadsheet ID, or a "Publish to web" CSV link, and returns the CSV URL. */
function sheetCsvUrl(src, defaultGid) {
  const u = String(src || '').trim();
  if (/^https?:/i.test(u)) {
    if (/\/pub(\?|$)/.test(u) || /output=csv|tqx=out:csv/.test(u)) return u;
    const m = u.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m) {
      const g = u.match(/[#&?]gid=(\d+)/);
      return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&gid=' + (g ? g[1] : defaultGid || '0');
    }
    return u;
  }
  return 'https://docs.google.com/spreadsheets/d/' + u + '/gviz/tq?tqx=out:csv&gid=' + (defaultGid || '0');
}

function createSheetSource(cfg) {
  const url = sheetCsvUrl(cfg.url, cfg.gid);
  return {
    name: 'sheet',
    url,
    async fetch() {
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' dari Google Sheet');
      const txt = await res.text();
      // a private sheet answers with Google's HTML sign-in page instead of CSV
      if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error('Sheet tidak publik. Atur share: Anyone with the link (Viewer)');
      return rowsToRecords(parseCSV(txt));
    },
    close: async () => {}
  };
}

module.exports = { createSheetSource, sheetCsvUrl };
