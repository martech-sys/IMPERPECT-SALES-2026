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
 *   isiDataBeban       → uji beban: BEBAN_BARIS baris di SETIAP file brand,
 *                        dibagi ke BEBAN_JASTIPER jastiper. Total penjualan,
 *                        jumlah jastiper dan 5 teratas ditulis di Execution log.
 *   hapusDataPercobaan → hapus semua baris dengan nomor HP percobaan
 *                        (0899-0000-xxxx) dari semua file brand. Baris
 *                        transaksi asli tidak disentuh.
 *
 * Nomor HP percobaan 0899-0000-xxxx (di papan: 0899-xxxx-xxxx), jadi mudah
 * dikenali dan tidak bentrok dengan pembeli asli. Jalankan hapusDataPercobaan
 * sebelum event dimulai, dan jangan saat brand sedang mengisi.
 */

var ORANG = ['Dodi', 'Bayu', 'Wahyu', 'Rengga', 'Ojan', 'Kai', 'Fedro', 'Desy', 'Nadi'];

var BEBAN_BARIS = 2000;     // baris per file brand (papan membaca maks. DRIVE_MAX_ROWS = 5000)
var BEBAN_JASTIPER = 3000;  // jumlah nomor HP berbeda (maks. 9000)

var HP_PERCOBAAN = '08990000'; // 0899-0000-xxxx

function hpPercobaan_(i) {
  return HP_PERCOBAAN + ('000' + (i + 1)).slice(-4);
}

function fileBrand_() {
  var folder = DriveApp.getFolderById(folderId_(FOLDER));
  var out = [];
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { var f = it.next(); out.push({ id: f.getId(), name: f.getName() }); }
  if (!out.length) throw new Error('Folder belum berisi file brand. Jalankan buatSheetBrand dulu.');
  return out;
}

// Tambah baris di bawah data yang ada; sheet baru hanya punya 1000 baris
function tambahBaris_(id, rows) {
  var sh = SpreadsheetApp.openById(id).getSheets()[0];
  var r = sh.getLastRow() + 1;
  var kurang = r + rows.length - 1 - sh.getMaxRows();
  if (kurang > 0) sh.insertRowsAfter(sh.getMaxRows(), kurang);
  sh.getRange(r, 1, rows.length, 1).setNumberFormat('@'); // 0899… tetap teks
  sh.getRange(r, 1, rows.length, 4).setValues(rows);
}

function acak_(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

function isiDataPercobaan() {
  var files = fileBrand_();
  var perFile = {}, total = {};
  ORANG.forEach(function (nama, i) {
    var hp = hpPercobaan_(i);
    total[nama] = { hp: hp, trx: 0, qty: 0, nilai: 0, brand: [] };
    var kali = acak_(2, 4);
    for (var k = 0; k < kali; k++) {
      var f = files[acak_(0, files.length - 1)];
      var qty = acak_(1, 5);
      var nilai = acak_(50, 1500) * 1000; // 50.000 – 1.500.000
      (perFile[f.id] = perFile[f.id] || []).push([hp, nama, qty, nilai]);
      var t = total[nama]; t.trx++; t.qty += qty; t.nilai += nilai; t.brand.push(f.name);
    }
  });
  Object.keys(perFile).forEach(function (id) { tambahBaris_(id, perFile[id]); });

  Logger.log('Data percobaan masuk ke ' + Object.keys(perFile).length + ' file brand. Yang seharusnya tampil di papan:');
  ORANG.slice().sort(function (a, b) { return total[b].nilai - total[a].nilai; }).forEach(function (nama, i) {
    var t = total[nama];
    Logger.log((i + 1) + '. ' + nama + '  ' + samar_(t.hp) + '  ' + rp_(t.nilai) +
      '  (' + t.trx + ' trx, ' + t.qty + ' pcs: ' + t.brand.join(', ') + ')');
  });
}

function isiDataBeban() {
  var files = fileBrand_();
  var n = Math.min(BEBAN_JASTIPER, 9000);
  var total = {}, semua = 0, trx = 0, mulai = Date.now();
  files.forEach(function (f) {
    var rows = [];
    for (var k = 0; k < BEBAN_BARIS; k++) {
      // sebagian kecil jastiper belanja jauh lebih sering, seperti event sungguhan
      var j = Math.floor(Math.pow(Math.random(), 2) * n);
      var hp = hpPercobaan_(j + 99); // 0899-0000-0100 dst.; 0001–0009 milik ORANG
      var nama = ORANG[j % ORANG.length] + ' ' + ORANG[(Math.floor(j / ORANG.length) + 1) % ORANG.length];
      var qty = acak_(1, 5), nilai = acak_(50, 1500) * 1000;
      rows.push([hp, nama, qty, nilai]);
      var t = total[hp] = total[hp] || { nama: nama, nilai: 0 };
      t.nilai += nilai; semua += nilai; trx++;
    }
    tambahBaris_(f.id, rows);
    Logger.log(f.name + ': ' + rows.length + ' baris');
  });
  var urut = Object.keys(total).sort(function (a, b) { return total[b].nilai - total[a].nilai; });
  Logger.log('Selesai dalam ' + Math.round((Date.now() - mulai) / 1000) + ' dtk: ' + trx + ' baris di ' + files.length +
    ' file, ' + urut.length + ' jastiper, total ' + rp_(semua) + '.');
  Logger.log('Papan menampilkan 1500 jastiper teratas. 5 teratas yang seharusnya tampil:');
  urut.slice(0, 5).forEach(function (hp, i) {
    Logger.log((i + 1) + '. ' + total[hp].nama + '  ' + samar_(hp) + '  ' + rp_(total[hp].nilai));
  });
}

function hapusDataPercobaan() {
  var dihapus = 0, mulai = Date.now();
  fileBrand_().forEach(function (f) {
    var sh = SpreadsheetApp.openById(f.id).getSheets()[0];
    var last = sh.getLastRow();
    if (last < 2) return;
    var kolomA = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    var n = 0, akhir = -1;
    // dari bawah ke atas, hapus per blok baris percobaan yang berurutan (cepat untuk ribuan baris)
    for (var i = kolomA.length - 1; i >= -1; i--) {
      var tes = i >= 0 && percobaan_(kolomA[i][0]);
      if (tes && akhir < 0) akhir = i;
      if (!tes && akhir >= 0) {
        if (i + 1 === 0 && akhir === kolomA.length - 1) {
          sh.getRange(2, 1, akhir + 1, sh.getLastColumn()).clearContent(); // semua baris data: kosongkan saja
        } else {
          sh.deleteRows(i + 3, akhir - i);
        }
        n += akhir - i; akhir = -1;
      }
    }
    if (n) Logger.log(f.name + ': ' + n + ' baris percobaan dihapus');
    dihapus += n;
  });
  Logger.log('Selesai dalam ' + Math.round((Date.now() - mulai) / 1000) + ' dtk: ' + dihapus + ' baris percobaan dihapus.');
}

function percobaan_(hp) {
  var d = String(hp).replace(/\D/g, '');
  return d.length === 12 && d.indexOf(HP_PERCOBAAN) === 0;
}

function samar_(hp) { return hp.slice(0, 4) + '-xxxx-' + hp.slice(-4); }
function rp_(v) { return 'Rp ' + v.toLocaleString('id-ID'); }
