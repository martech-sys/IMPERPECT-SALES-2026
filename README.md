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
| `JUBELIO_LOCATION` / `JUBELIO_LOCATION_ID` | – | Gudang yang dibaca: `MAIN IMPERFECT WAREHOUS 2026` / `26`. |
| `JUBELIO_DATE_FROM`, `JUBELIO_DATE_TO` | – / tanpa batas | Rentang tanggal transaksi event (WIB, `YYYY-MM-DD`). `FROM` wajib. |
| `JUBELIO_VALUE_FIELD` | `grand_total` | Kolom nilai dari detail order, mis. `sub_total`. |
| `JUBELIO_BUDGET_MS` | `20000` (Netlify `7000`) | Batas waktu sinkron Jubelio per pembacaan. |
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

Sumber ini hanya **membaca**: `POST /login` untuk token, sisanya `GET`. Perilaku API sudah dicek di akun
ini (lihat juga `martech-sys/data-db`, `docs/jubelio-api.md`):

- Gudang event 2026: **`MAIN IMPERFECT WAREHOUS 2026`** (id lokasi 26, outlet POS).
- `GET /sales/orders/` tidak bisa difilter per lokasi, jadi order di rentang `JUBELIO_DATE_FROM`–`TO` (WIB)
  dibaca lalu disaring ke `JUBELIO_LOCATION` (nama, tidak peka huruf besar/kecil) atau `JUBELIO_LOCATION_ID`.
  Order batal dilewati.
- **Nomor HP di order disamarkan Jubelio** (`**********99`). Nomor lengkap diambil dari
  `GET /contacts/{contact_id}` (kolom `phone`), sekali per pembeli.
- **Order "Pelanggan Umum" (walk-in, `contact_id` -1) tidak punya nomor HP**, jadi tidak masuk papan
  (terlihat sebagai "dilewati" / "tanpa HP" di `#cek`). Supaya belanja jastiper terhitung, kasir harus
  memilih atau membuat kontak pembeli **dengan nomor HP** di POS.
- Kontak yang belum punya HP dicoba lagi tiap 5 menit, jadi nomor yang ditambahkan belakangan tetap masuk.
- Nilai = `grand_total` (atau `JUBELIO_VALUE_FIELD`), angka string seperti `"750000.0000"` dikonversi
  dengan benar. Qty = jumlah `qty_in_base` item yang tidak batal.

Sinkronisasinya bertahap dengan batas waktu `JUBELIO_BUDGET_MS` per pembacaan: pemindaian pertama
berjalan halaman per halaman dan dilanjutkan pada pembacaan berikutnya, setelah itu hanya order yang
berubah yang dibaca (`lastModifiedSince`). Di Netlify, progresnya disimpan di **Netlify Blobs**
(store `imperfect-jubelio`, berisi nomor HP pembeli), jadi function yang baru menyala melanjutkan dari
situ. Progres terlihat di `#cek` ("memindai order", "N menunggu kontak", "N tanpa HP").

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
