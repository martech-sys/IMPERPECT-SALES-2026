'use strict';

/* Brand spreadsheets in one Google Drive folder, read with a service account.
   Read-only: the token asks for drive.readonly only.

   - Each brand fills its own spreadsheet; the folder is shared with the
     service account (Viewer) once, so every file in it is readable while the
     brand teams only see their own file. No link is public.
   - Each fetch lists the folder once and re-reads only the files whose
     modifiedTime changed, as a CSV export of the first tab. Both are Drive API
     calls: the Sheets API allows only 60 reads per minute, which 37+ brands
     on several cold Vercel instances use up at once (HTTP 429).
   - A file that fails keeps its last good rows and is reported per brand.
     The brand name is the file name; the row format is the same as any Sheet
     (No HP, Nama, qty, trx value). */

const crypto = require('node:crypto');
const { parseCSV, rowsToRecords } = require('../aggregate');

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
const SPREADSHEET = 'application/vnd.google-apps.spreadsheet';

function createDriveSource(cfg) {
  const key = serviceAccount(cfg);
  const folderId = folderIdOf(cfg.folder);
  if (!folderId) throw new Error('Isi DRIVE_FOLDER (link atau ID folder Google Drive)');
  const maxRows = Math.max(2, cfg.maxRows || 5000);
  const concurrency = Math.max(1, cfg.concurrency || 10); // 38 files cold: ~3.5 s instead of ~6.5 s at 5
  const urls = Object.assign({
    token: 'https://oauth2.googleapis.com/token',
    drive: 'https://www.googleapis.com/drive/v3'
  }, cfg.urls);
  const files = new Map(); // file id -> { name, mod, records, error, rows }
  let token = null, tokenExp = 0, getting = null;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60e3) return token;
    getting = getting || (async () => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = signJwt({ iss: key.email, scope: SCOPES, aud: urls.token, iat: now, exp: now + 3600 }, key.privateKey);
      const res = await fetch(urls.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) throw new Error('Login akun layanan gagal: ' + (body.error_description || body.error || 'HTTP ' + res.status));
      token = body.access_token; tokenExp = Date.now() + (body.expires_in || 3600) * 1000;
      return token;
    })().finally(() => { getting = null; });
    return getting;
  }

  async function get(url, asText) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + await accessToken() }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return asText ? res.text() : res.json();
    const body = await res.json().catch(() => ({}));
    throw new Error('HTTP ' + res.status + (body.error && body.error.message ? ': ' + body.error.message : ''));
  }

  async function listFolder() {
    const out = [];
    let page = '';
    do {
      const q = new URLSearchParams({
        q: "'" + folderId + "' in parents and mimeType='" + SPREADSHEET + "' and trashed=false",
        fields: 'nextPageToken,files(id,name,modifiedTime)',
        pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
      });
      if (page) q.set('pageToken', page);
      let r;
      try { r = await get(urls.drive + '/files?' + q); }
      catch (e) { throw new Error('Folder Drive tidak bisa dibaca (' + e.message + '). Share folder ke ' + key.email + ' sebagai Viewer'); }
      out.push(...(r.files || []));
      page = r.nextPageToken || '';
    } while (page);
    return out;
  }

  async function readFile(f) {
    // CSV export holds the first tab only, as displayed (2.500.000 is parsed by toNum)
    const csv = await get(urls.drive + '/files/' + encodeURIComponent(f.id) + '/export?mimeType=text%2Fcsv', true);
    const rows = parseCSV(csv).slice(0, maxRows);
    // skipped rows show up in #cek as "Brand:row"
    return rowsToRecords(rows).map((rec) => Object.assign(rec, { line: f.name + ':' + rec.line }));
  }

  return {
    name: 'drive',
    async fetch() {
      const listed = await listFolder();
      const ids = new Set(listed.map((f) => f.id));
      for (const id of files.keys()) if (!ids.has(id)) files.delete(id); // removed from the folder
      const todo = listed.filter((f) => {
        const c = files.get(f.id);
        if (c) c.name = f.name;
        return !c || c.mod !== f.modifiedTime || c.error;
      });
      let i = 0;
      async function worker() {
        while (i < todo.length) {
          const f = todo[i++];
          const c = files.get(f.id) || { name: f.name, records: [], rows: 0 };
          try {
            c.records = await readFile(f);
            c.rows = c.records.length; c.mod = f.modifiedTime; c.error = null;
          } catch (e) {
            c.error = e.message; // keep the last good rows of this brand
          }
          files.set(f.id, c);
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
      return [].concat(...Array.from(files.values(), (c) => c.records));
    },
    info() {
      const all = Array.from(files.values());
      return {
        brands: all.length,
        failed: all.filter((c) => c.error).map((c) => ({ brand: c.name, error: c.error })),
        empty: all.filter((c) => !c.error && !c.rows).map((c) => c.name)
      };
    },
    close: async () => {}
  };
}

/* GOOGLE_SERVICE_ACCOUNT_JSON (the downloaded key file, pasted whole) or
   GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY. */
function serviceAccount(cfg) {
  let email = cfg.email, pem = cfg.privateKey;
  if (cfg.json) {
    let j;
    try { j = JSON.parse(cfg.json); } catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON yang valid'); }
    email = j.client_email; pem = j.private_key;
  }
  if (!email || !pem) throw new Error('Isi GOOGLE_SERVICE_ACCOUNT_JSON (atau GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY)');
  // keys pasted into one-line env vars arrive with literal \n
  pem = String(pem).replace(/\\n/g, '\n');
  let privateKey;
  try { privateKey = crypto.createPrivateKey(pem); } catch (e) { throw new Error('Kunci privat akun layanan tidak valid'); }
  return { email, privateKey };
}

function signJwt(claims, privateKey) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc(claims);
  return head + '.' + crypto.sign('RSA-SHA256', Buffer.from(head), privateKey).toString('base64url');
}

function folderIdOf(s) {
  const v = String(s || '').trim();
  const m = v.match(/\/folders\/([a-zA-Z0-9_-]+)/) || v.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (/^[a-zA-Z0-9_-]{10,}$/.test(v) ? v : '');
}

module.exports = { createDriveSource, folderIdOf };
