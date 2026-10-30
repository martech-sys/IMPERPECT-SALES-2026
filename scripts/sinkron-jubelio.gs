/**
 * Sinkron order Jubelio (laporan Sales List) ke Sheet internal papan TV.
 *
 * Alurnya sama dengan script Colab "voucher treatment":
 *   login Jubelio → minta laporan Sales List (lokasi LDS, rentang event) →
 *   unduh Excel → baca kolom No Pesanan / Pelanggan / No Telp / Grand Total →
 *   satu baris per pesanan → tulis ke tab pertama SHEET_ID dengan format papan:
 *   No HP | Nama | qty | trx value.
 * Laporan Jubelio memuat nomor HP lengkap, jadi tidak ada masalah nomor
 * tersamar seperti di tabel warehouse.
 *
 * Pasang (sekali):
 *   1. script.google.com → New project → tempel file ini, beri nama "Sinkron Jubelio".
 *   2. Services (ikon +) → Drive API → Add  (untuk membaca file Excel laporan).
 *   3. Project Settings (ikon gerigi) → Script Properties → Add:
 *        JUBELIO_EMAIL     = email login Jubelio
 *        JUBELIO_PASSWORD  = password Jubelio
 *      Password tidak ditulis di kode.
 *   4. Pilih sinkronJubelio → Run → izinkan akses. Cek Execution log.
 *   5. Pilih pasangJadwal → Run: sinkron otomatis tiap MENIT_JADWAL menit.
 *      Berhenti: jalankan hapusJadwal.
 *
 * Sheet tujuan harus ada di folder Drive papan (DRIVE_FOLDER) supaya terbaca
 * papan, dan JANGAN di-share ke brand: isinya nomor HP lengkap pembeli.
 * Tab pertama ditimpa setiap sinkron; tab "Sinkron" berisi status terakhir.
 */

var SHEET_ID = '1Wcq0-ZffpHpZuQVRsuAVVGLGQWPGeCpGR4GScthA0x4';
var LDS = [26, 64];                       // ID lokasi Jubelio
var DARI = '2026-10-30';                  // hari pertama event (WIB)
var SAMPAI = '2026-11-01';                // hari terakhir event (WIB)
var PREFIX = 'JP';                        // hanya No Pesanan berawalan ini; '' = semua pesanan
var MENIT_JADWAL = 15;                    // 1, 5, 10, 15 atau 30

var HEADER = ['No HP', 'Nama', 'qty', 'trx value'];

function sinkronJubelio() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('Sinkron sebelumnya masih jalan, dilewati.'); return; }
  var mulai = Date.now();
  try {
    var values = ambilLaporan_();
    var hasil = olahLaporan_(values, PREFIX);
    tulis_(hasil.rows);
    status_('OK', hasil, Date.now() - mulai);
    Logger.log('Pesanan ' + (PREFIX || 'semua') + ': ' + hasil.pesanan + ', ditulis: ' + hasil.rows.length +
      ', tanpa HP valid: ' + hasil.tanpaHp + ', cancel: ' + hasil.cancel +
      ', lokasi: ' + JSON.stringify(hasil.lokasi) + ', ' + Math.round((Date.now() - mulai) / 1000) + ' dtk');
  } catch (e) {
    status_('GAGAL: ' + e.message, null, Date.now() - mulai);
    throw e; // data lama di sheet dibiarkan; papan tetap memakai isi terakhir
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Jubelio ---------- */

function ambilLaporan_() {
  var p = PropertiesService.getScriptProperties();
  var email = p.getProperty('JUBELIO_EMAIL'), pass = p.getProperty('JUBELIO_PASSWORD');
  if (!email || !pass) throw new Error('Isi JUBELIO_EMAIL dan JUBELIO_PASSWORD di Script Properties');

  var login = UrlFetchApp.fetch('https://api2.jubelio.com/login', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ email: email, password: pass }), muteHttpExceptions: true
  });
  if (login.getResponseCode() !== 200) throw new Error('Login Jubelio gagal (HTTP ' + login.getResponseCode() + ')');
  var token = JSON.parse(login.getContentText()).token;

  // rentang sama seperti halaman Reports: "Fri Oct 30 2026 00:00:00 GMT+0700 (Western Indonesia Time)"
  var akhir = new Date(SAMPAI + 'T23:59:59+07:00');
  if (akhir > new Date()) akhir = new Date();
  var q = 'date_from=' + encodeURIComponent(tglJubelio_(new Date(DARI + 'T00:00:00+07:00'))) +
    '&date_to=' + encodeURIComponent(tglJubelio_(akhir)) +
    '&reference=order&hpp=false&tz=Asia%2FJakarta&' +
    LDS.map(function (v, i) { return 'lds%5B' + i + '%5D=' + v; }).join('&');
  var rep = UrlFetchApp.fetch('https://open.jubelio.com/core-api/reports/sales-list/date-range/?' + q,
    { headers: { Authorization: token }, muteHttpExceptions: true });
  if (rep.getResponseCode() !== 200) throw new Error('Laporan Jubelio gagal (HTTP ' + rep.getResponseCode() + '): ' + rep.getContentText().slice(0, 200));
  var parts = JSON.parse(rep.getContentText()).url.split('?');
  var xlsx = UrlFetchApp.fetch(parts[0].replace(/\/+$/, '') + '/xlsx/?' + parts.slice(1).join('?'), { muteHttpExceptions: true });
  if (xlsx.getResponseCode() !== 200) throw new Error('Unduh Excel gagal (HTTP ' + xlsx.getResponseCode() + ')');

  // Excel → Google Sheet sementara (My Drive, bukan folder papan) → baca → buang
  var tmp = Drive.Files.create({ name: 'tmp-jubelio-' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
    xlsx.getBlob().setContentType(MimeType.MICROSOFT_EXCEL));
  try {
    return SpreadsheetApp.openById(tmp.id).getSheets()[0].getDataRange().getValues();
  } finally {
    Drive.Files.remove(tmp.id);
  }
}

function tglJubelio_(d) {
  return Utilities.formatDate(d, 'Asia/Jakarta', "EEE MMM dd yyyy HH:mm:ss") + ' GMT+0700 (Western Indonesia Time)';
}

/* ---------- olah laporan → baris papan ---------- */

// values: isi Excel (baris pertama = judul kolom). Satu baris per pesanan:
// Grand Total diambil SEKALI per No Pesanan (laporan bisa satu baris per item),
// qty dijumlahkan kalau ada kolom qty, pesanan Cancel dibuang.
function olahLaporan_(values, prefix) {
  var head = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  function col(re, wajib) {
    for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i;
    if (wajib) throw new Error('Kolom "' + wajib + '" tidak ada di laporan. Kolom: ' + values[0].join(', '));
    return -1;
  }
  var cPesanan = col(/^no\.? pesanan$/, 'No Pesanan'), cTelp = col(/^no\.? telp/, 'No Telp'),
    cNama = col(/^pelanggan$/, 'Pelanggan'), cTotal = col(/^grand total$/, 'Grand Total'),
    cLokasi = col(/^lokasi$/), cStatus = col(/status/), cQty = col(/^(qty|jumlah|kuantitas)$/);

  var per = {}, urut = [], lokasi = {}, cancel = {};
  for (var r = 1; r < values.length; r++) {
    var v = values[r], no = String(v[cPesanan]).trim();
    if (!no || (prefix && no.indexOf(prefix) !== 0)) continue;
    if (cStatus >= 0 && /cancel|batal/i.test(String(v[cStatus]))) { cancel[no] = true; continue; }
    var o = per[no];
    if (!o) {
      o = per[no] = { hp: rapikan_(v[cTelp]), nama: String(v[cNama] || '').trim(), qty: 0, total: angka_(v[cTotal]) };
      urut.push(no);
      if (cLokasi >= 0) lokasi[v[cLokasi]] = (lokasi[v[cLokasi]] || 0) + 1;
    }
    if (!o.hp) o.hp = rapikan_(v[cTelp]);
    o.qty += cQty >= 0 ? (angka_(v[cQty]) || 0) : 0;
  }
  var rows = [], tanpaHp = 0;
  urut.forEach(function (no) {
    var o = per[no];
    if (!o.hp || !(o.total > 0)) { tanpaHp++; return; }
    rows.push([o.hp, o.nama, o.qty || 1, o.total]);
  });
  return { rows: rows, pesanan: urut.length, tanpaHp: tanpaHp, cancel: Object.keys(cancel).length, lokasi: lokasi };
}

function rapikan_(x) {
  if (/\*/.test(String(x))) return '';                // nomor tersamar
  var s = String(x == null ? '' : x).replace(/\D/g, '');
  if (s.indexOf('00') === 0) s = s.slice(2);        // 0062 812...
  if (s.indexOf('62') === 0) s = s.slice(2);        // 62 812... / +62 812...
  s = '0' + s.replace(/^0+/, '');                   // +62 0812..., 812... -> 0812...
  return /^08\d{7,11}$/.test(s) ? s : '';
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

/* ---------- tulis ke sheet ---------- */

// Baris baru ditulis dulu, sisa baris lama dikosongkan setelahnya, supaya papan
// tidak pernah membaca sheet yang sedang kosong.
function tulis_(rows) {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  var all = [HEADER].concat(rows);
  var kurang = all.length - sh.getMaxRows();
  if (kurang > 0) sh.insertRowsAfter(sh.getMaxRows(), kurang);
  sh.getRange(1, 1, all.length, 1).setNumberFormat('@');
  sh.getRange(1, 1, all.length, 4).setValues(all);
  var last = sh.getLastRow();
  if (last > all.length) sh.getRange(all.length + 1, 1, last - all.length, 4).clearContent();
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function status_(teks, hasil, ms) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName('Sinkron') || ss.insertSheet('Sinkron');
  sh.getRange(1, 1, 6, 2).setValues([
    ['Terakhir sinkron', Utilities.formatDate(new Date(), 'Asia/Jakarta', 'dd MMM yyyy HH:mm:ss') + ' WIB'],
    ['Status', teks],
    ['Pesanan dibaca', hasil ? hasil.pesanan : ''],
    ['Baris ditulis', hasil ? hasil.rows.length : ''],
    ['Tanpa HP valid / Cancel', hasil ? hasil.tanpaHp + ' / ' + hasil.cancel : ''],
    ['Durasi', Math.round(ms / 1000) + ' dtk']
  ]);
}

/* ---------- jadwal otomatis ---------- */

function pasangJadwal() {
  hapusJadwal();
  ScriptApp.newTrigger('sinkronJubelio').timeBased().everyMinutes(MENIT_JADWAL).create();
  Logger.log('Sinkron otomatis tiap ' + MENIT_JADWAL + ' menit.');
}

function hapusJadwal() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sinkronJubelio') ScriptApp.deleteTrigger(t);
  });
}
