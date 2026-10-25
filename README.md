# Imperfect Sale 2026 — Papan TV Live

Papan TV 16:9 "Top Spender Jastiper": total belanja terbesar per nomor HP, progres level hadiah
(100 / 200 / 300 / 400 mio) dan top 10 jastiper. Data dibaca dari **Postgres**, **Google Sheet** dan
**Jubelio** (order dari satu gudang/lokasi),
digabung per nomor HP di server, lalu halaman TV polling `/api/state`.

```
Postgres ─┐
 Sheet  ──┼─► server (Node) ─ gabung per nomor HP ─► /api/state ─► public/index.html (TV)
Jubelio ──┘     poll tiap POLL_MS, simpan data terakhir yang berhasil
```

- Nomor `0812…`, `62812…`, `+62 812…` dianggap nomor yang sama, dari sumber mana pun.
- Nomor HP disamarkan (`0812-xxxx-7890`) di server; nomor lengkap tidak pernah dikirim ke browser.
- Kalau satu sumber gagal (DB restart, Sheet tidak bisa dibuka), papan tetap memakai data terakhir
  dari sumber itu dan menampilkan peringatan di layar.

## Menjalankan

Butuh Node.js 20.12+.

```bash
cp .env.example .env   # isi DATABASE_URL dan SHEET_URL
npm install
npm start              # http://localhost:3000
```

Atau semua sekaligus dengan Postgres contoh: `docker compose up --build`.

## Deploy ke Netlify

Repo ini sudah siap untuk Netlify (`netlify.toml`):

- Halaman TV dipublish dari `public/`.
- `/api/state` dan `/healthz` dilayani Netlify Function `netlify/functions/state.mjs`, yang memakai
  kode yang sama dengan server Node (`server/`).
- Build menjalankan `npm test`; deploy batal kalau tes gagal.

Langkah:

1. Di Netlify: **Project configuration → Environment variables**, isi `DATABASE_URL`, `SHEET_URL`,
   `SHEET_GID`, dan bila perlu `PG_QUERY`, `PG_SSL=true` (lihat tabel di bawah).
2. Database harus bisa diakses dari internet (Netlify Functions berjalan di AWS, bukan di jaringan kantor).
   Untuk Postgres terkelola (Supabase, Neon, RDS), pakai URL *pooler* bila tersedia.
3. Deploy ulang. Cek `https://<site>.netlify.app/healthz` → `200` artinya minimal satu sumber terbaca.

Bedanya dengan server Node: di Netlify sumber data dibaca saat ada request (bukan timer), lalu hasilnya
di-cache di CDN Netlify selama `CACHE_SECONDS`. Jadi berapa pun TV yang membuka halaman, Postgres dan
Sheet dibaca paling sering sekali per `CACHE_SECONDS`. Kalau satu sumber gagal, data terakhirnya hanya
bertahan selama instance function masih hangat.

Tambahkan `#cek` di URL (`http://localhost:3000/#cek`) untuk melihat jumlah baris valid / dilewati per sumber.

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `DATABASE_URL` | – | Koneksi Postgres. Kosong = sumber Postgres dilewati. |
| `PG_QUERY` | `SELECT phone, name, qty, trx_value AS value FROM transactions` | Query yang mengembalikan kolom `phone, name, qty, value`, satu baris per transaksi. |
| `PG_SSL` | `false` | `true` untuk DB terkelola (Supabase, RDS, Neon, dll). |
| `SHEET_URL` | – | Link Sheet (Share: *Anyone with the link*, Viewer), ID Sheet, atau link CSV *Publish to web*. Kosong = sumber Sheet dilewati. |
| `SHEET_GID` | `0` | Tab yang dibaca bila link tidak memuat `gid`. |
| `DATA_SOURCES` | `postgres,sheet,jubelio` | Batasi sumber, mis. `jubelio` saja. |
| `JUBELIO_EMAIL`, `JUBELIO_PASSWORD` | – | Login API Jubelio. Kosong = sumber Jubelio dilewati. |
| `JUBELIO_LOCATION` / `JUBELIO_LOCATION_ID` | – | Gudang yang dibaca, mis. `Imperfect Sales 2025`. |
| `JUBELIO_DATE_FROM`, `JUBELIO_DATE_TO` | – / tanpa batas | Rentang tanggal transaksi event (WIB, `YYYY-MM-DD`). `FROM` wajib. |
| `JUBELIO_VALUE_FIELD` | `grand_total` | Kolom nilai dari detail order, mis. `sub_total`. |
| `POLL_MS` | `30000` | Interval baca ulang di server Node, sekaligus interval polling halaman TV (min 5000). |
| `CACHE_SECONDS` | `15` | Netlify saja: lama hasil `/api/state` di-cache di CDN. |
| `PORT` | `3000` | Port HTTP. |

### Postgres

Pakai tabel bawaan (`db/schema.sql`):

```bash
npm run db:init        # buat tabel transactions
npm run db:seed        # opsional: data contoh, jangan di produksi
```

Atau arahkan ke tabel yang sudah ada lewat `PG_QUERY`, contoh:

```sql
SELECT no_hp AS phone, nama AS name, jumlah AS qty, total AS value
FROM penjualan WHERE event = 'imperfect-2026'
```

### Jubelio

Sumber ini hanya **membaca**: `POST /login` untuk token, sisanya `GET`. Perilaku API mengikuti catatan
yang sudah diverifikasi di `martech-sys/data-db` (`docs/jubelio-api.md`).

1. `GET /sales/orders/` dengan `transactionDateFrom`/`To` dari `JUBELIO_DATE_FROM`/`JUBELIO_DATE_TO` (WIB),
   lalu disaring ke gudang `JUBELIO_LOCATION` (nama, tidak peka huruf besar/kecil) atau `JUBELIO_LOCATION_ID`.
   Order batal dilewati kecuali `JUBELIO_INCLUDE_CANCELED=true`.
2. Nomor HP dan item hanya ada di detail order, jadi tiap order dibaca dengan `GET /sales/orders/{id}`
   (±1 detik per order, 5 paralel). Detail disimpan di memori dan hanya dibaca ulang kalau
   `last_modified` order berubah.
3. HP = `customer_phone`, atau `shipping_phone` bila kosong. Nama = `customer_name`.
   Qty = jumlah `qty_in_base` item yang tidak dibatalkan. Nilai = `grand_total` (atau `JUBELIO_VALUE_FIELD`).

Kredensial Jubelio cukup di `.env` / environment variables hosting. Jangan di-commit.

### Google Sheet

Kolom dikenali dari judulnya: `No HP`, `Nama`, `qty`, `trx value` (juga `phone`, `telp`, `wa`, `jumlah`,
`total`, `nilai`, `omzet`, …). Tanpa judul, urutannya dianggap HP, Nama, qty, nilai.

> Jangan memasukkan transaksi yang sama ke Postgres **dan** Sheet: nilainya akan terhitung dua kali.

## Endpoint

- `GET /` — halaman TV
- `GET /api/state` — `{ state: { updatedAt, totals, top[] }, sources: { postgres, sheet }, pollMs }`
- `GET /healthz` — 200 bila minimal satu sumber terbaca, 503 bila tidak

## Tes

```bash
npm test
```
