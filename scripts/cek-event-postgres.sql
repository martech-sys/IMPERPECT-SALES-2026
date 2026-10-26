-- Cek sebelum papan TV dibaca dari warehouse (we_data_store, tabel laporan_penjualan).
-- Hanya membaca, dan hanya mencetak nama kolom, nama store/gudang, status, dan hitungan.
-- TIDAK ada nama, nomor HP, atau isi baris pelanggan yang dicetak, jadi hasilnya aman dibagikan.
--
-- Jalankan dengan user read-only, mis.:
--   psql "$DATABASE_URL" -f scripts/cek-event-postgres.sql
-- Kalau tabelnya ada di schema lain (mis. mysql_db_store), jalankan dulu:
--   SET search_path TO mysql_db_store, public;

\echo '== 1. Kolom yang dipakai papan =='
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'laporan_penjualan'
   AND column_name IN ('no_hp', 'nama', 'id_pelanggan', 'tanggal', 'waktu', 'sumber', 'channel', 'warehouse',
                       'status', 'invoice_number', 'no_order', 'qty', 'total_harga_barang', 'total_bayar')
 ORDER BY column_name;

\echo '== 2. Di mana baris event Imperfect tercatat (channel / warehouse), sejak 2025 =='
SELECT sumber, channel, warehouse,
       MIN(tanggal) AS tanggal_awal, MAX(tanggal) AS tanggal_akhir,
       COUNT(*) AS baris,
       COUNT(DISTINCT COALESCE(NULLIF(btrim(invoice_number), ''), no_order)) AS invoice
  FROM laporan_penjualan
 WHERE tanggal >= DATE '2025-01-01'
   AND (channel ILIKE '%imperf%' OR warehouse ILIKE '%imperf%')
 GROUP BY sumber, channel, warehouse
 ORDER BY tanggal_akhir DESC, baris DESC;

\echo '== 3. Event 2025 (20-23 Nov): berapa invoice yang punya nomor HP, omzet = total_bayar sekali per invoice =='
WITH inv AS (
  SELECT channel, warehouse,
         COALESCE(NULLIF(btrim(invoice_number), ''), no_order) AS invoice,
         MAX(NULLIF(btrim(no_hp), '')) AS no_hp,
         MAX(total_bayar) AS total_bayar,
         COUNT(*) AS baris_produk
    FROM laporan_penjualan
   WHERE tanggal >= DATE '2025-11-20' AND tanggal < DATE '2025-11-24'
     AND (channel ILIKE '%imperf%' OR warehouse ILIKE '%imperf%')
   GROUP BY 1, 2, 3
)
SELECT channel, warehouse,
       COUNT(*) AS invoice,
       SUM(baris_produk) AS baris_produk,
       COUNT(*) FILTER (WHERE no_hp IS NOT NULL) AS invoice_ada_hp,
       COUNT(*) FILTER (WHERE no_hp LIKE '%*%') AS invoice_hp_tersamar,
       COUNT(DISTINCT no_hp) AS nomor_hp_unik,
       SUM(total_bayar) AS omzet_total_bayar
  FROM inv
 GROUP BY channel, warehouse
 ORDER BY invoice DESC;

\echo '== 4. Nilai status pada baris event 2025 (untuk memutuskan apa yang dibuang, mis. batal/retur) =='
SELECT status, COUNT(*) AS baris, SUM(total_harga_barang) AS omzet
  FROM laporan_penjualan
 WHERE tanggal >= DATE '2025-11-20' AND tanggal < DATE '2025-11-24'
   AND (channel ILIKE '%imperf%' OR warehouse ILIKE '%imperf%')
 GROUP BY status
 ORDER BY baris DESC;

\echo '== 5. Kesegaran data: transaksi terakhir per sumber, 3 hari terakhir =='
SELECT sumber, MAX(tanggal) AS tanggal_terakhir,
       MAX(waktu::text) FILTER (WHERE tanggal = (SELECT MAX(tanggal) FROM laporan_penjualan)) AS jam_terakhir,
       COUNT(*) AS baris
  FROM laporan_penjualan
 WHERE tanggal >= CURRENT_DATE - 3
 GROUP BY sumber
 ORDER BY tanggal_terakhir DESC;

\echo '== 6. Index yang ada di laporan_penjualan =='
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'laporan_penjualan'
 ORDER BY indexname;

\echo '== 7. Rencana eksekusi query papan (EXPLAIN saja, query tidak dijalankan) =='
\echo '   Cari "Index Scan"/"Bitmap Index Scan". "Seq Scan on laporan_penjualan" berarti seluruh tabel dibaca tiap poll.'
EXPLAIN
SELECT MAX(no_hp) AS phone, MAX(nama) AS name, SUM(qty) AS qty, MAX(total_bayar) AS value
  FROM laporan_penjualan
 WHERE warehouse = 'MAIN IMPERFECT WAREHOUS 2026'
   AND tanggal >= DATE '2026-10-30' AND tanggal < DATE '2026-11-02'
 GROUP BY COALESCE(NULLIF(btrim(invoice_number), ''), no_order);
