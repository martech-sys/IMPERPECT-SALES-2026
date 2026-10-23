# Imperfect Sale 2026 — Papan TV Live

Papan TV 16:9 "Top Spender Jastiper": total belanja terbesar per nomor HP, progres level hadiah
(100 / 200 / 300 / 400 mio) dan top 10 jastiper. Data dibaca dari **Postgres** dan **Google Sheet**,
digabung per nomor HP di server, lalu halaman TV polling `/api/state`.

```
Postgres ─┐
          ├─► server (Node) ─ gabung per nomor HP ─► /api/state ─► public/index.html (TV)
 Sheet  ──┘     poll tiap POLL_MS, simpan data terakhir yang berhasil
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

Tambahkan `#cek` di URL (`http://localhost:3000/#cek`) untuk melihat jumlah baris valid / dilewati per sumber.

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `DATABASE_URL` | – | Koneksi Postgres. Kosong = sumber Postgres dilewati. |
| `PG_QUERY` | `SELECT phone, name, qty, trx_value AS value FROM transactions` | Query yang mengembalikan kolom `phone, name, qty, value`, satu baris per transaksi. |
| `PG_SSL` | `false` | `true` untuk DB terkelola (Supabase, RDS, Neon, dll). |
| `SHEET_URL` | – | Link Sheet (Share: *Anyone with the link*, Viewer), ID Sheet, atau link CSV *Publish to web*. Kosong = sumber Sheet dilewati. |
| `SHEET_GID` | `0` | Tab yang dibaca bila link tidak memuat `gid`. |
| `DATA_SOURCES` | `postgres,sheet` | Batasi sumber, mis. `postgres` saja. |
| `POLL_MS` | `30000` | Interval baca ulang (min 5000). |
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
