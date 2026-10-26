/**
 * Buat satu spreadsheet per brand di folder Drive papan TV.
 *
 * Cara pakai (sekali, oleh admin pemilik folder):
 *   1. script.google.com → New project → hapus isinya, tempel file ini.
 *   2. Isi FOLDER dan BRANDS di bawah.
 *   3. Pilih fungsi buatSheetBrand → Run → izinkan akses Drive & Sheets.
 *   4. Hasilnya ada di View → Logs (Execution log): link tiap brand.
 *
 * Aman dijalankan ulang: brand yang file-nya sudah ada di folder tidak dibuat
 * lagi, hanya email editor baru yang ditambahkan. Brand baru cukup ditambah
 * ke BRANDS lalu Run lagi.
 *
 * Tiap brand hanya diberi akses Editor ke file-nya sendiri. Folder TIDAK
 * di-share ke brand, jadi brand tidak bisa melihat file (dan omzet) brand lain.
 * Akun layanan papan bisa membaca semuanya karena folder di-share ke akun itu.
 */

// Link atau ID folder Drive yang sama dengan DRIVE_FOLDER di Vercel
var FOLDER = 'https://drive.google.com/drive/folders/ISI_ID_FOLDER';

// Satu brand per baris: "Nama Brand | email1, email2". Nama brand = nama file
// = nama yang muncul di #cek. Email boleh dikosongkan dulu.
var BRANDS = [
  'Heymale | tim@heymale.id',
  'Heylocal | ',
  'Boonaboo | admin@boonaboo.id, kasir@boonaboo.id'
].join('\n');

// false = brand tidak menerima email undangan dari Google (link dikirim manual)
var KIRIM_EMAIL = true;

var HEADER = ['No HP', 'Nama', 'qty', 'trx value'];

function buatSheetBrand() {
  var folder = DriveApp.getFolderById(folderId_(FOLDER));
  var ada = {};
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { var f = it.next(); ada[f.getName().toLowerCase()] = f.getId(); }

  BRANDS.split('\n').forEach(function (line) {
    var parts = line.split('|');
    var brand = parts[0].trim();
    if (!brand) return;
    var emails = (parts[1] || '').split(/[,;\s]+/).filter(function (e) { return /@/.test(e); });

    var id = ada[brand.toLowerCase()];
    var baru = !id;
    if (baru) {
      var ss = SpreadsheetApp.create(brand);
      id = ss.getId();
      DriveApp.getFileById(id).moveTo(folder);
      siapkan_(ss);
      ada[brand.toLowerCase()] = id;
    }
    emails.forEach(function (e) {
      try {
        // Drive API lanjutan tidak diperlukan: addEditor mengirim undangan bawaan Google
        if (KIRIM_EMAIL) DriveApp.getFileById(id).addEditor(e);
        else Drive_addEditorTanpaEmail_(id, e);
      } catch (err) {
        Logger.log('  ! ' + brand + ': gagal menambah ' + e + ' (' + err.message + ')');
      }
    });
    Logger.log((baru ? 'BARU  ' : 'ADA   ') + brand + ' → https://docs.google.com/spreadsheets/d/' + id + '/edit' +
      (emails.length ? '  (editor: ' + emails.join(', ') + ')' : ''));
  });
}

// Judul kolom, kolom No HP sebagai teks (agar 0812… tidak jadi 812 / 6,28E+12),
// angka tanpa desimal, baris judul dikunci.
function siapkan_(ss) {
  var sh = ss.getSheets()[0];
  sh.setName('Transaksi');
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('C:D').setNumberFormat('#,##0');
  sh.setColumnWidth(1, 150); sh.setColumnWidth(2, 200); sh.setColumnWidth(4, 140);
  var angka = SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0)
    .setAllowInvalid(false).setHelpText('Isi angka saja, tanpa Rp atau titik').build();
  sh.getRange('C2:D').setDataValidation(angka);
  // brand tidak bisa mengubah judul kolom (papan membaca kolom dari judul ini)
  sh.getRange(1, 1, 1, HEADER.length).protect().setDescription('Judul kolom papan TV').setWarningOnly(true);
}

// Tanpa email undangan: butuh layanan lanjutan "Drive API" (Services → + → Drive API, v3)
function Drive_addEditorTanpaEmail_(id, email) {
  Drive.Permissions.create({ role: 'writer', type: 'user', emailAddress: email }, id,
    { sendNotificationEmail: false, supportsAllDrives: true });
}

function folderId_(s) {
  var m = String(s).match(/\/folders\/([\w-]+)/) || String(s).match(/[?&]id=([\w-]+)/);
  return m ? m[1] : String(s).trim();
}
