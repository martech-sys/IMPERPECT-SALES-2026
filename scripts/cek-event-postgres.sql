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

\echo '== 3. Event 2025 (20-23 Nov): berapa baris yang punya nomor HP =='
SELECT channel, warehouse,
       COUNT(*) AS baris,
       COUNT(*) FILTER (WHERE NULLIF(btrim(no_hp), '') IS NOT NULL) AS baris_ada_hp,
       COUNT(*) FILTER (WHERE no_hp LIKE '%*%') AS baris_hp_tersamar,
       COUNT(DISTINCT NULLIF(btrim(no_hp), '')) AS nomor_hp_unik,
       COUNT(DISTINCT COALESCE(NULLIF(btrim(invoice_number), ''), no_order)) AS invoice,
       SUM(total_harga_barang) AS omzet
  FROM laporan_penjualan
 WHERE tanggal >= DATE '2025-11-20' AND tanggal < DATE '2025-11-24'
   AND (channel ILIKE '%imperf%' OR warehouse ILIKE '%imperf%')
 GROUP BY channel, warehouse
 ORDER BY baris DESC;

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
