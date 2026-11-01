/**
 * Top 10 spender (nomor HP LENGKAP) yang ikut ter-update otomatis seperti papan.
 *
 * Dihitung sama dengan papan: tab pertama semua spreadsheet di folder papan
 * (Sheet brand + Internal), nomor 0812 / 62812 / +62 812 dianggap sama, nama =
 * yang paling sering dipakai untuk nomor itu, tier dari total. Hasilnya ditulis
 * ke spreadsheet "Top 10 Spender" di My Drive (BUKAN di folder papan, supaya
 * tidak ikut terbaca papan).
 *
 * Pasang, di project Apps Script yang sama dengan buat-sheet-brand.gs (FOLDER
 * dan folderId_ diambil dari sana):
 *   1. + (Add a file) → Script → beri nama top10-spender → tempel file ini.
 *   2. Isi AKSES_TOP10 (dan PENONTON_TOP10 kalau 'email'), lalu Save.
 *   3. Jalankan top10Spender → izinkan akses. Link ada di Execution log.
 *   4. Jalankan pasangJadwalTop10: update otomatis tiap MENIT_TOP10 menit.
 *      Berhenti: hapusJadwalTop10.
 *   Ubah akses belakangan: ganti AKSES_TOP10 lalu jalankan aturAksesTop10.
 *
 * Isinya nomor HP lengkap + nama pembeli (data pribadi). Pilih akses sesempit
 * mungkin; 'link' berarti siapa pun yang memegang link bisa melihat.
 */

var TOP10_FILE = 'Top 10 Spender';
var TOP10_N = 10;
var MENIT_TOP10 = 10;                     // 5, 10, 15 atau 30
var EXCLUDE_TOP10 = [];                   // nama file brand yang tidak dihitung, mis. ['Mayoutfit']

// Siapa yang bisa MELIHAT (tidak bisa mengubah):
//   'email'  = hanya email di PENONTON_TOP10
//   'domain' = semua akun Google di domain kantor pemilik file (perlu link)
//   'link'   = siapa pun yang memegang link
var AKSES_TOP10 = 'email';
var PENONTON_TOP10 = [
  // 'nama@heymale.id',
];

var TIER_TOP10 = [
  [400e6, 'Tier 4', 'Motor Honda Beat'],
  [300e6, 'Tier 3', 'Kulkas LG Side by Side'],
  [200e6, 'Tier 2', 'Smart TV Samsung 4K 50"'],
  [100e6, 'Tier 1', 'Voucher belanja Rp 3 jt']
];

function top10Spender() {
  var mulai = Date.now();
  var lewati = {};
  EXCLUDE_TOP10.forEach(function (n) { lewati[String(n).trim().toLowerCase()] = true; });
  var it = DriveApp.getFolderById(folderId_(FOLDER)).getFilesByType(MimeType.GOOGLE_SHEETS);
  var per = {}, file = 0, gagal = [];
  while (it.hasNext()) {
    var f = it.next();
    if (lewati[f.getName().trim().toLowerCase()]) continue;
    try {
      t10Tambah_(per, SpreadsheetApp.openById(f.getId()).getSheets()[0].getDataRange().getValues());
      file++;
    } catch (e) {
      gagal.push(f.getName() + ' (' + e.message + ')');
    }
  }
  var list = t10Urut_(per);
  var ss = t10File_();
  t10Tulis_(ss, list.slice(0, TOP10_N), list.length, file, gagal);
  Logger.log('File dibaca: ' + file + (gagal.length ? ', gagal: ' + gagal.join('; ') : '') +
    ', pembeli: ' + list.length + ', ' + Math.round((Date.now() - mulai) / 1000) + ' dtk. ' + ss.getUrl());
}

/* ---------- hitung (sama dengan papan) ---------- */

// rows: tab pertama satu file (baris 1 = judul). Kolom dicari dari judulnya.
function t10Tambah_(per, rows) {
  if (rows.length < 2) return;
  var k = { hp: 0, nama: 1, qty: 2, nilai: 3 }, m = {};
  rows[0].forEach(function (h, i) {
    h = String(h).toLowerCase();
    if (m.hp == null && /hp|phone|telp|tlp|wa/.test(h)) m.hp = i;
    else if (m.nama == null && /nama|name/.test(h)) m.nama = i;
    else if (m.qty == null && /qty|jumlah|pcs/.test(h)) m.qty = i;
    else if (m.nilai == null && /value|nilai|total|trx|omzet|sales/.test(h)) m.nilai = i;
  });
  if (m.hp != null && m.nilai != null) k = { hp: m.hp, nama: m.nama != null ? m.nama : -1, qty: m.qty != null ? m.qty : -1, nilai: m.nilai };
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r], hp = t10Hp_(row[k.hp]), v = t10Angka_(row[k.nilai]);
    if (!hp || !(v > 0)) continue;
    var q = k.qty >= 0 ? t10Angka_(row[k.qty]) : 0;
    var e = per[hp] = per[hp] || { hp: hp, nama: {}, trx: 0, qty: 0, total: 0 };
    var n = k.nama >= 0 ? String(row[k.nama] || '').trim().replace(/\s+/g, ' ') : '';
    if (n) e.nama[n] = (e.nama[n] || 0) + 1;
    e.trx++; e.qty += q > 0 ? q : 0; e.total += v;
  }
}

// nama yang paling sering dipakai; seri: yang lebih lengkap
function t10Urut_(per) {
  return Object.keys(per).map(function (hp) {
    var e = per[hp], best = '', bc = 0;
    Object.keys(e.nama).forEach(function (n) {
      var c = e.nama[n];
      if (c > bc || (c === bc && n.length > best.length)) { best = n; bc = c; }
    });
    return { hp: e.hp, nama: best, trx: e.trx, qty: e.qty, total: e.total };
  }).sort(function (a, b) { return b.total - a.total; });
}

function t10Hp_(s) {
  if (/e\+/i.test(String(s))) return '';
  var d = String(s == null ? '' : s).replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.indexOf('62') === 0) d = d.slice(2);
  d = '0' + d.replace(/^0+/, '');
  return /^0\d{8,13}$/.test(d) ? d : '';
}

function t10Angka_(s) {
  if (typeof s === 'number') return isFinite(s) ? Math.round(s) : NaN;
  s = String(s == null ? '' : s).trim().replace(/rp\.?/gi, '').replace(/\s/g, '');
  if (!s) return NaN;
  var m = s.match(/^(.*?)[.,](\d{1,2})$/);
  if (m && /^[\d.,]*\d$/.test(m[1])) s = m[1];
  s = s.replace(/[^\d-]/g, '');
  return s ? parseInt(s, 10) : NaN;
}

function t10Tier_(v) {
  for (var i = 0; i < TIER_TOP10.length; i++) if (v >= TIER_TOP10[i][0]) return TIER_TOP10[i];
  return [0, '', ''];
}

/* ---------- tulis ---------- */

function t10File_() {
  var files = DriveApp.getRootFolder().getFilesByName(TOP10_FILE);
  if (files.hasNext()) return SpreadsheetApp.open(files.next());
  var ss = SpreadsheetApp.create(TOP10_FILE);
  ss.getSheets()[0].setName('Top 10');
  aturAksesTop10_(ss);
  return ss;
}

function t10Tulis_(ss, top, pembeli, file, gagal) {
  var sh = ss.getSheets()[0];
  var w = 8, out = [['Peringkat', 'Nama', 'No HP', 'Total belanja', 'Trx', 'Qty', 'Tier', 'Hadiah']];
  top.forEach(function (e, i) {
    var t = t10Tier_(e.total);
    out.push([i + 1, e.nama, e.hp, e.total, e.trx, e.qty, t[1], t[2]]);
  });
  while (out.length < TOP10_N + 1) out.push(['', '', '', '', '', '', '', '']);
  sh.getRange(1, 1, out.length, w).setValues(out);
  sh.getRange(1, 1, 1, w).setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange(2, 3, TOP10_N, 1).setNumberFormat('@');
  sh.getRange(2, 4, TOP10_N, 1).setNumberFormat('"Rp "#,##0');
  sh.setFrozenRows(1);
  sh.getRange(TOP10_N + 3, 1, 3, 2).setValues([
    ['Terakhir update', Utilities.formatDate(new Date(), 'Asia/Jakarta', 'dd MMM yyyy HH:mm') + ' WIB'],
    ['Dihitung dari', file + ' file, ' + pembeli + ' pembeli'],
    ['File gagal dibaca', gagal.length ? gagal.join('; ') : '-']
  ]);
  sh.autoResizeColumns(1, w);
}

/* ---------- akses & jadwal ---------- */

function aturAksesTop10() {
  var ss = t10File_();
  aturAksesTop10_(ss);
  Logger.log('Akses ' + AKSES_TOP10 + ': ' + ss.getUrl());
}

function aturAksesTop10_(ss) {
  var f = DriveApp.getFileById(ss.getId());
  if (AKSES_TOP10 === 'link') f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  else if (AKSES_TOP10 === 'domain') f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  else f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  if (AKSES_TOP10 === 'email') {
    var sudah = f.getViewers().map(function (u) { return u.getEmail().toLowerCase(); });
    PENONTON_TOP10.forEach(function (e) {
      if (/@/.test(e) && sudah.indexOf(e.toLowerCase()) < 0) f.addViewer(e);
    });
  }
}

function pasangJadwalTop10() {
  hapusJadwalTop10();
  ScriptApp.newTrigger('top10Spender').timeBased().everyMinutes(MENIT_TOP10).create();
  Logger.log('Top 10 Spender otomatis tiap ' + MENIT_TOP10 + ' menit.');
}

function hapusJadwalTop10() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'top10Spender') ScriptApp.deleteTrigger(t);
  });
}
