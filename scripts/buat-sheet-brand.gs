/**
 * Buat satu spreadsheet per brand di folder Drive papan TV.
 *
 * Cara pakai (sekali, oleh admin pemilik folder):
 *   1. script.google.com → New project → hapus isinya, tempel file ini.
 *   2. Isi FOLDER (dan periksa BRANDS) di bawah.
 *   3. Pilih fungsi buatSheetBrand → Run → izinkan akses Drive & Sheets.
 *   4. Link tiap brand ditulis ke spreadsheet "Daftar Link Sheet Brand" di
 *      My Drive (di luar folder papan) dan di Execution log. Kirim tiap
 *      brand HANYA link miliknya.
 *
 * Aman dijalankan ulang: brand yang file-nya sudah ada di folder tidak dibuat
 * lagi. Brand baru cukup ditambah ke BRANDS lalu Run lagi.
 *
 * Folder TIDAK di-share ke brand. Akun layanan papan bisa membaca semua file
 * karena folder di-share ke akun itu (Viewer).
 */

// Link atau ID folder Drive yang sama dengan DRIVE_FOLDER di Vercel
var FOLDER = 'https://drive.google.com/drive/folders/ISI_ID_FOLDER';

// Akses tiap file brand:
//   'link'  = Anyone with the link → Editor. Cepat, tanpa email: brand cukup
//             menerima link file-nya. Siapa pun yang memegang link bisa melihat
//             dan mengubah isinya, jadi jangan sebar link ke luar tim brand itu.
//   'email' = hanya email yang ditulis di BRANDS (Editor).
var AKSES = 'link';

// Satu brand per baris: "Nama Brand" atau "Nama Brand | email1, email2".
// Nama brand = nama file = nama yang muncul di #cek.
var BRANDS = [
  'Shi by Shireen',
  'Zaskia Sungkar',
  'L by LCB',
  'Haidee Orlin',
  'Nehhat (Rafindo Group)',
  'Booyah (Rafindo Group)',
  'Moseshah (Rafindo Group)',
  'Rurik',
  'Heaven Lights',
  'Lozy Hijab',
  'Muda',
  'Sabine & Heem',
  'Alur Cerita',
  'Zeta Scarves',
  'Chante',
  'Hijabchic',
  'Klamby',
  'Amapola',
  'Ayu Diah Andari',
  'Geulis',
  'Mayoutfit',
  'Muhajir Project',
  'Khalewale',
  'Casio',
  'Torch',
  'Roughneck (Rafindo Group)',
  'All Basic (Rafindo Group)',
  'Leaf (Rafindo Group)',
  'Sneakerdepts',
  'Ground Studio',
  'Unerd',
  'Toms (Primer Group)',
  'Allbirds (Primer Group)',
  'Herschel (Primer Group)',
  'Hydroflask (Primer Group)',
  'Erspo',
  'Radwah'
].join('\n');

// AKSES 'email': false = brand tidak menerima email undangan dari Google
var KIRIM_EMAIL = true;

var DAFTAR = 'Daftar Link Sheet Brand';

var HEADER = ['No HP', 'Nama', 'qty', 'trx value'];

function buatSheetBrand() {
  var folder = DriveApp.getFolderById(folderId_(FOLDER));
  var ada = {};
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { var f = it.next(); ada[f.getName().toLowerCase()] = f.getId(); }

  var hasil = [];
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
    var file = DriveApp.getFileById(id);
    var catatan = '';
    if (AKSES === 'link') {
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
      } catch (err) {
        // Google Workspace yang melarang share publik: pakai "siapa pun di domain"
        file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
        catatan = 'hanya akun domain kantor (share publik diblokir admin)';
      }
    }
    emails.forEach(function (e) {
      try {
        if (KIRIM_EMAIL) file.addEditor(e);
        else Drive_addEditorTanpaEmail_(id, e);
      } catch (err) {
        catatan += (catatan ? '; ' : '') + 'gagal menambah ' + e + ' (' + err.message + ')';
      }
    });
    var link = 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
    hasil.push([brand, link, baru ? 'baru' : 'sudah ada', catatan]);
    Logger.log((baru ? 'BARU  ' : 'ADA   ') + brand + ' → ' + link + (catatan ? '  (' + catatan + ')' : ''));
  });
  tulisDaftar_(hasil);
}

// Daftar link untuk dibagikan, di My Drive admin (BUKAN di folder papan:
// isinya bukan transaksi). Hanya admin yang bisa membukanya.
function tulisDaftar_(hasil) {
  var files = DriveApp.getRootFolder().getFilesByName(DAFTAR);
  var ss = files.hasNext() ? SpreadsheetApp.open(files.next()) : SpreadsheetApp.create(DAFTAR);
  var sh = ss.getSheets()[0];
  sh.clear();
  sh.getRange(1, 1, 1, 4).setValues([['Brand', 'Link (kirim ke brand ini saja)', 'Status', 'Catatan']]).setFontWeight('bold');
  if (hasil.length) sh.getRange(2, 1, hasil.length, 4).setValues(hasil);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, 4);
  Logger.log('Daftar link: ' + ss.getUrl());
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
