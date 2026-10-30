-- Cadangan manual papan TV: ranking jastiper dari warehouse (we_data_store).
-- Hanya membaca. Logika sama dengan PG_QUERY papan: dua gudang event,
-- 30 Okt - 1 Nov 2026, order "Cancel" tidak dihitung, total_bayar diambil
-- sekali per invoice, lalu dijumlahkan per nomor HP (0812/62812/+62 812 = sama).
-- Nomor HP yang tersamar di warehouse ("***********24") dikenali dari nama +
-- 2 digit terakhir, sama seperti papan.
--
-- PERHATIAN: hasilnya memuat nomor HP LENGKAP pembeli. Untuk tim internal
-- saja; jangan ditampilkan di TV atau dibagikan.
--
-- Hanya data warehouse. Transaksi Sheet brand digabung lewat
-- scripts/rekap-manual.gs (tempel hasil query 1 ke tab "Postgres").

-- 1. Ranking per nomor HP (salin hasilnya untuk rekap-manual.gs)
WITH inv AS (
  SELECT MAX(no_hp) AS no_hp, MAX(nama) AS nama, SUM(qty) AS qty, MAX(total_bayar) AS nilai
    FROM laporan_penjualan
   WHERE warehouse IN ('MAIN IMPERFECT WAREHOUS 2026', 'TEBUS MURAH IMPERFECT 2026')
     AND tanggal >= DATE '2026-10-30' AND tanggal < DATE '2026-11-02'
     AND COALESCE(status, '') !~* 'cancel|batal'
   GROUP BY COALESCE(NULLIF(btrim(invoice_number), ''), no_order)
), n AS (
  SELECT CASE WHEN d LIKE '62%' THEN '0' || substr(d, 3)
              WHEN d LIKE '8%'  THEN '0' || d
              ELSE d END AS full_hp,
         d, COALESCE(no_hp, '') LIKE '%*%' AS tersamar,
         btrim(regexp_replace(lower(COALESCE(nama, '')), '[^a-z]+', ' ', 'g')) AS nama_norm,
         nama, qty, nilai
    FROM (SELECT regexp_replace(COALESCE(no_hp, ''), '\D', '', 'g') AS d, no_hp, nama, qty, nilai FROM inv) x
), hp AS (
  -- kunci pembeli: nomor lengkap, atau nama + 2 digit terakhir untuk nomor tersamar
  SELECT CASE WHEN full_hp ~ '^0[0-9]{8,13}$' THEN full_hp
              WHEN tersamar AND length(d) >= 2 AND nama_norm <> '' THEN 'm:' || nama_norm || '|' || right(d, 2)
         END AS hp,
         CASE WHEN full_hp ~ '^0[0-9]{8,13}$' THEN full_hp ELSE '*********' || right(d, 2) END AS tampil,
         nama, qty, nilai
    FROM n
)
SELECT ROW_NUMBER() OVER (ORDER BY SUM(nilai) DESC) AS peringkat,
       MAX(tampil)           AS no_hp,
       MAX(nama)             AS nama,
       COUNT(*)              AS trx,
       SUM(qty)              AS qty,
       SUM(nilai)            AS total,
       CASE WHEN SUM(nilai) >= 400000000 THEN 'Tier 4'
            WHEN SUM(nilai) >= 300000000 THEN 'Tier 3'
            WHEN SUM(nilai) >= 200000000 THEN 'Tier 2'
            WHEN SUM(nilai) >= 100000000 THEN 'Tier 1'
            ELSE '' END      AS tier
  FROM hp
 WHERE hp IS NOT NULL   -- nomor tidak valid / kosong dilewati, sama seperti papan
 GROUP BY hp
 ORDER BY total DESC;

-- 2. Ringkasan: total penjualan, invoice, pembeli, invoice tanpa nomor HP valid
WITH inv AS (
  SELECT MAX(no_hp) AS no_hp, MAX(nama) AS nama, MAX(total_bayar) AS nilai
    FROM laporan_penjualan
   WHERE warehouse IN ('MAIN IMPERFECT WAREHOUS 2026', 'TEBUS MURAH IMPERFECT 2026')
     AND tanggal >= DATE '2026-10-30' AND tanggal < DATE '2026-11-02'
     AND COALESCE(status, '') !~* 'cancel|batal'
   GROUP BY COALESCE(NULLIF(btrim(invoice_number), ''), no_order)
), hp AS (
  SELECT CASE WHEN f ~ '^0[0-9]{8,13}$' THEN f
              WHEN no_hp LIKE '%*%' AND length(d) >= 2 AND nn <> '' THEN 'm:' || nn || '|' || right(d, 2)
         END AS hp, nilai
    FROM (SELECT d, no_hp, nilai, btrim(regexp_replace(lower(COALESCE(nama, '')), '[^a-z]+', ' ', 'g')) AS nn,
                 CASE WHEN d LIKE '62%' THEN '0' || substr(d, 3) WHEN d LIKE '8%' THEN '0' || d ELSE d END AS f
            FROM (SELECT regexp_replace(COALESCE(no_hp, ''), '\D', '', 'g') AS d, COALESCE(no_hp, '') AS no_hp, nama, nilai FROM inv) y) x
)
SELECT SUM(nilai)                              AS total_penjualan,
       COUNT(*)                                AS invoice,
       COUNT(DISTINCT hp)                      AS pembeli,
       COUNT(*) FILTER (WHERE hp IS NULL)      AS invoice_tanpa_hp_valid
  FROM hp;

-- 3. Riwayat satu pembeli. Nomor lengkap: ganti 81234567890 (tanpa 0/62 di depan).
--    Nomor tersamar: ganti dengan 2 digit terakhir (mis. '%24') dan tambahkan
--    AND nama ILIKE '%dewi%' sebelum GROUP BY.
SELECT tanggal, warehouse, COALESCE(NULLIF(btrim(invoice_number), ''), no_order) AS invoice,
       MAX(nama) AS nama, SUM(qty) AS qty, MAX(total_bayar) AS total_bayar, MAX(status) AS status
  FROM laporan_penjualan
 WHERE warehouse IN ('MAIN IMPERFECT WAREHOUS 2026', 'TEBUS MURAH IMPERFECT 2026')
   AND tanggal >= DATE '2026-10-30' AND tanggal < DATE '2026-11-02'
   AND regexp_replace(COALESCE(no_hp, ''), '\D', '', 'g') LIKE '%81234567890'
 GROUP BY tanggal, warehouse, COALESCE(NULLIF(btrim(invoice_number), ''), no_order)
 ORDER BY tanggal;
