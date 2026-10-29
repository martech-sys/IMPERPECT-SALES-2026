/**
 * Cadangan manual papan TV: ranking gabungan Postgres + semua Sheet brand,
 * ditulis ke spreadsheet "Rekap Manual Ranking" di My Drive (bukan di folder
 * papan). Dipakai kalau papan live bermasalah.
 *
 * Cara pakai, di project Apps Script yang sama dengan buat-sheet-brand.gs
 * (FOLDER dan folderId_ diambil dari sana):
 *   1. + (Add a file) → Script → beri nama rekap-manual → tempel file ini.
 *   2. Jalankan rekapManual sekali: spreadsheet "Rekap Manual Ranking" dibuat
 *      dengan tab "Postgres" (kosong) dan "Ranking".
 *   3. Jalankan query 1 di scripts/ranking-manual.sql, salin hasilnya
 *      (kolom no_hp, nama, trx, qty, total) ke tab "Postgres" mulai A2.
 *      Lewati langkah ini kalau hanya butuh data Sheet brand.
 *   4. Jalankan rekapManual lagi → tab "Ranking" berisi peringkat, nomor HP,
 *      nama, trx, qty, total, tier. Ringkasan ada di Execution log.
 *
 * Logikanya sama dengan papan: nomor 0812 / 62812 / +62 812 dianggap sama,
 * baris tanpa nomor HP valid atau tanpa nilai dilewati, tier dari total.
 * Nomor HP ditulis LENGKAP: untuk tim internal saja.
 */

var REKAP = 'Rekap Manual Ranking';
var TIER_MIN = [[400e6, 'Tier 4'], [300e6, 'Tier 3'], [200e6, 'Tier 2'], [100e6, 'Tier 1']];

function rekapManual() {
  var ss = rekapFile_();
  var per = {}, dilewati = 0, baris = 0;

  // 1. Postgres: hasil query 1 yang ditempel di tab "Postgres"
  var pg = ss.getSheetByName('Postgres');
  var pgRows = pg.getLastRow() > 1 ? pg.getRange(2, 1, pg.getLastRow() - 1, 5).getValues() : [];
  pgRows.forEach(function (r) {
    if (tambah_(per, r[0], r[1], r[2], r[3], r[4])) baris++; else if (String(r[0]).trim()) dilewati++;
  });
  var dariPg = baris;

  // 2. Semua file brand di folder papan, tab pertama
  var it = DriveApp.getFolderById(folderId_(FOLDER)).getFilesByType(MimeType.GOOGLE_SHEETS);
  var brand = 0;
  while (it.hasNext()) {
    var f = it.next();
    var rows = SpreadsheetApp.openById(f.getId()).getSheets()[0].getDataRange().getValues();
    if (rows.length < 2) { brand++; continue; }
    var k = kolom_(rows[0]);
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!String(r[k.hp]).trim() && !String(r[k.nilai]).trim()) continue; // baris kosong
      if (tambah_(per, r[k.hp], k.nama >= 0 ? r[k.nama] : '', 1, k.qty >= 0 ? r[k.qty] : 0, r[k.nilai])) baris++;
      else dilewati++;
    }
    brand++;
  }

  // 3. Tulis ranking
  var list = Object.keys(per).map(function (hp) { return per[hp]; })
    .sort(function (a, b) { return b.total - a.total; });
  var out = list.map(function (e, i) {
    return [i + 1, e.hp, e.nama, e.trx, e.qty, e.total, tier_(e.total)];
  });
  var sh = ss.getSheetByName('Ranking');
  sh.clearContents();
  sh.getRange(1, 1, 1, 7).setValues([['Peringkat', 'No HP', 'Nama', 'Trx', 'Qty', 'Total', 'Tier']]).setFontWeight('bold');
  if (out.length) {
    sh.getRange(2, 2, out.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, out.length, 7).setValues(out);
    sh.getRange(2, 6, out.length, 1).setNumberFormat('#,##0');
  }
  sh.setFrozenRows(1);

  var totalJual = list.reduce(function (s, e) { return s + e.total; }, 0);
  var perTier = {};
  out.forEach(function (r) { if (r[6]) perTier[r[6]] = (perTier[r[6]] || 0) + 1; });
  Logger.log('Postgres: ' + dariPg + ' baris, Sheet brand: ' + brand + ' file, ' + (baris - dariPg) + ' baris, dilewati: ' + dilewati);
  Logger.log('Pembeli: ' + list.length + ', total penjualan: Rp ' + totalJual.toLocaleString('id-ID'));
  Logger.log('Per tier: ' + (Object.keys(perTier).sort().reverse().map(function (t) { return t + ' = ' + perTier[t]; }).join(', ') || 'belum ada'));
  Logger.log('Hasil: ' + ss.getUrl());
}

function rekapFile_() {
  var files = DriveApp.getRootFolder().getFilesByName(REKAP);
  var baru = !files.hasNext();
  var ss = baru ? SpreadsheetApp.create(REKAP) : SpreadsheetApp.open(files.next());
  if (!ss.getSheetByName('Postgres')) {
    var pg = baru ? ss.getSheets()[0].setName('Postgres') : ss.insertSheet('Postgres');
    pg.getRange(1, 1, 1, 5).setValues([['no_hp', 'nama', 'trx', 'qty', 'total']]).setFontWeight('bold');
    pg.getRange('A:A').setNumberFormat('@');
    pg.setFrozenRows(1);
  }
  if (!ss.getSheetByName('Ranking')) ss.insertSheet('Ranking');
  return ss;
}

// kolom Sheet brand dicari dari judulnya, sama seperti papan
function kolom_(head) {
  var k = { hp: 0, nama: 1, qty: 2, nilai: 3 }, m = {};
  head.forEach(function (h, i) {
    h = String(h).toLowerCase();
    if (m.hp == null && /hp|phone|telp|tlp|wa/.test(h)) m.hp = i;
    else if (m.nama == null && /nama|name/.test(h)) m.nama = i;
    else if (m.qty == null && /qty|jumlah|pcs/.test(h)) m.qty = i;
    else if (m.nilai == null && /value|nilai|total|trx|omzet|sales/.test(h)) m.nilai = i;
  });
  if (m.hp != null && m.nilai != null) k = { hp: m.hp, nama: m.nama != null ? m.nama : -1, qty: m.qty != null ? m.qty : -1, nilai: m.nilai };
  return k;
}

function tambah_(per, hpRaw, nama, trx, qty, nilai) {
  var hp = normHp_(hpRaw), v = angka_(nilai);
  if (!hp || !(v > 0)) return false;
  var e = per[hp] = per[hp] || { hp: hp, nama: '', trx: 0, qty: 0, total: 0 };
  if (!e.nama && nama) e.nama = String(nama).trim();
  var q = angka_(qty), t = angka_(trx);
  e.trx += t > 0 ? t : 1; e.qty += q > 0 ? q : 0; e.total += v;
  return true;
}

function normHp_(s) {
  if (/e\+/i.test(String(s))) return '';
  var d = String(s == null ? '' : s).replace(/\D/g, '');
  if (d.indexOf('62') === 0) d = '0' + d.slice(2);
  else if (d.charAt(0) === '8') d = '0' + d;
  return /^0\d{8,13}$/.test(d) ? d : '';
}

function angka_(s) {
  if (typeof s === 'number') return isFinite(s) ? Math.round(s) : NaN;
  s = String(s == null ? '' : s).trim().replace(/rp\.?/gi, '').replace(/\s/g, '');
  if (!s) return NaN;
  var m = s.match(/^(.*?)[.,](\d{1,2})$/);
  if (m && /^[\d.,]*\d$/.test(m[1])) s = m[1];
  s = s.replace(/[^\d-]/g, '');
  return s ? parseInt(s, 10) : NaN;
}

function tier_(v) {
  for (var i = 0; i < TIER_MIN.length; i++) if (v >= TIER_MIN[i][0]) return TIER_MIN[i][1];
  return '';
}
