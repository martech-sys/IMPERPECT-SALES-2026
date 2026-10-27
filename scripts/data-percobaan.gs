/**
 * Data percobaan untuk papan TV: isi dan hapus transaksi palsu di file brand.
 *
 * Cara pakai: di project Apps Script yang sama dengan buat-sheet-brand.gs,
 * klik + (Add a file) → Script → beri nama data-percobaan → tempel file ini.
 * FOLDER dan folderId_ diambil dari buat-sheet-brand.gs.
 *
 *   isiDataPercobaan   → tiap orang di ORANG belanja 2–4 kali di brand acak.
 *                        Total per orang yang seharusnya tampil di papan
 *                        ditulis di Execution log.
 *   hapusDataPercobaan → hapus semua baris dengan nomor HP percobaan dari
 *                        semua file brand. Baris transaksi asli tidak disentuh.
 *
 * Nomor HP percobaan 0899-0000-00xx (di papan: 0899-xxxx-00xx), jadi mudah
 * dikenali dan tidak bentrok dengan pembeli asli. Jalankan hapusDataPercobaan
 * sebelum event dimulai.
 */

var ORANG = ['Dodi', 'Bayu', 'Wahyu', 'Rengga', 'Ojan', 'Kai', 'Fedro', 'Desy', 'Nadi'];

function hpPercobaan_(i) {
  return '0899000000' + ('0' + (i + 1)).slice(-2);
}

function fileBrand_() {
  var folder = DriveApp.getFolderById(folderId_(FOLDER));
  var out = [];
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { var f = it.next(); out.push({ id: f.getId(), name: f.getName() }); }
  return out;
}

function isiDataPercobaan() {
  var files = fileBrand_();
  if (!files.length) throw new Error('Folder belum berisi file brand. Jalankan buatSheetBrand dulu.');

  var perFile = {}, total = {};
  ORANG.forEach(function (nama, i) {
    var hp = hpPercobaan_(i);
    total[nama] = { hp: hp, trx: 0, qty: 0, nilai: 0, brand: [] };
    var kali = 2 + Math.floor(Math.random() * 3); // 2–4 transaksi
    for (var k = 0; k < kali; k++) {
      var f = files[Math.floor(Math.random() * files.length)];
      var qty = 1 + Math.floor(Math.random() * 5);
      var nilai = (50 + Math.floor(Math.random() * 1451)) * 1000; // 50.000 – 1.500.000
      (perFile[f.id] = perFile[f.id] || { name: f.name, rows: [] }).rows.push([hp, nama, qty, nilai]);
      var t = total[nama]; t.trx++; t.qty += qty; t.nilai += nilai; t.brand.push(f.name);
    }
  });

  Object.keys(perFile).forEach(function (id) {
    var sh = SpreadsheetApp.openById(id).getSheets()[0];
    var rows = perFile[id].rows;
    var r = sh.getLastRow() + 1;
    sh.getRange(r, 1, rows.length, 1).setNumberFormat('@'); // 0899… tetap teks
    sh.getRange(r, 1, rows.length, 4).setValues(rows);
  });

  Logger.log('Data percobaan masuk ke ' + Object.keys(perFile).length + ' file brand. Yang seharusnya tampil di papan:');
  ORANG.slice().sort(function (a, b) { return total[b].nilai - total[a].nilai; }).forEach(function (nama, i) {
    var t = total[nama];
    Logger.log((i + 1) + '. ' + nama + '  ' + t.hp.slice(0, 4) + '-xxxx-' + t.hp.slice(-4) +
      '  Rp ' + t.nilai.toLocaleString('id-ID') + '  (' + t.trx + ' trx, ' + t.qty + ' pcs: ' + t.brand.join(', ') + ')');
  });
}

function hapusDataPercobaan() {
  var hp = {};
  ORANG.forEach(function (_, i) { hp[hpPercobaan_(i)] = true; });
  var dihapus = 0;
  fileBrand_().forEach(function (f) {
    var sh = SpreadsheetApp.openById(f.id).getSheets()[0];
    var last = sh.getLastRow();
    if (last < 2) return;
    var kolomA = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    var n = 0;
    for (var i = kolomA.length - 1; i >= 0; i--) { // dari bawah agar nomor baris tidak bergeser
      if (hp[String(kolomA[i][0]).replace(/\D/g, '')]) { sh.deleteRow(i + 2); n++; }
    }
    if (n) Logger.log(f.name + ': ' + n + ' baris percobaan dihapus');
    dihapus += n;
  });
  Logger.log('Selesai: ' + dihapus + ' baris percobaan dihapus.');
}
