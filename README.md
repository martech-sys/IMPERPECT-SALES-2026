# Imperfect Sale 2026 — Papan TV Live

Papan TV 16:9 "Ranking Jastiper": **semua jastiper** diurutkan dari belanja terbesar per nomor HP, dalam
dua kolom yang mengalir sebagai satu daftar (kolom kanan melanjutkan kolom kiri, berhenti sejenak di
peringkat 1), plus "Juara sementara" di kanan atas. Data dibaca dari **Postgres** (warehouse),
**Google Sheet per brand** (satu folder Drive) dan opsional **Jubelio**,
digabung per nomor HP di server, lalu halaman TV polling `/api/state`.

```
  Postgres ─┐
Folder Drive ┼─► server (Node) ─ gabung per nomor HP ─► /api/state ─► public/index.html (TV)
(Sheet brand)│    poll tiap POLL_MS, simpan data terakhir yang berhasil
  Jubelio ───┘
```

- Nomor `0812…`, `62812…`, `+62 812…` dianggap nomor yang sama, dari sumber mana pun.
- Nomor HP disamarkan (`0812-xxxx-7890`) di server; nomor lengkap tidak pernah dikirim ke browser.
- Kalau satu sumber gagal (DB restart, Sheet tidak bisa dibuka), papan tetap memakai data terakhir
  dari sumber itu tanpa menampilkan peringatan ke penonton; statusnya terlihat di `#cek` dan `/healthz`.

## Menjalankan

Butuh Node.js 20.12+.

```bash
cp .env.example .env   # isi data koneksi database dan DRIVE_FOLDER
npm install
npm start              # http://localhost:3000
```

Atau semua sekaligus dengan Postgres contoh: `docker compose up --build`.

## Deploy ke Vercel

Repo ini siap untuk Vercel (`vercel.json`):

- Halaman TV dipublish dari `public/`.
- `/api/state` dilayani Vercel Function `api/state.js`; `/healthz` di-*rewrite* ke function yang sama.
  Logikanya di `server/api.js`, memakai kode yang sama dengan server Node (`server/`).
- Function berjalan di region `sin1` (Singapura), dekat dengan database.
- Build menjalankan `npm test`; deploy batal kalau tes gagal.

Langkah:

1. Vercel → **Add New → Project**, impor repo `martech-sys/IMPERPECT-SALES-2026`. Framework Preset
   **Other**; pengaturan build lain sudah diambil dari `vercel.json`, tidak perlu diubah.
2. **Settings → Environment Variables**: isi variabel sumber data untuk **Production** (dan Preview bila
   perlu). Untuk event 2026 ikuti [Setup koneksi database](#setup-koneksi-database-warehouse-we_data_store).
3. Database harus bisa diakses dari internet: Vercel Functions tidak punya IP tetap.
4. **Deployments → ⋯ → Redeploy** (perubahan env baru berlaku di deploy berikutnya). Cek
   `https://<project>.vercel.app/healthz` → `200` artinya minimal satu sumber terbaca.

Bedanya dengan server Node: di Vercel sumber data dibaca saat ada request (bukan timer), paling sering
sekali per `CACHE_SECONDS` per instance, dan hasil `/api/state` di-cache di CDN Vercel selama
`CACHE_SECONDS`. Jadi berapa pun TV yang membuka halaman, database dibaca paling sering sekali per
`CACHE_SECONDS`. Kalau satu sumber gagal, data terakhirnya hanya bertahan selama instance function masih
hangat.

Kalau belum ada sumber data yang terbaca, `/healthz` menjawab `500` beserta daftar variabel yang diterima
deploy (`terisi`/`kosong`, tanpa nilainya) dan alasan tiap sumber dilewati.

Tambahkan `#cek` di URL (`http://localhost:3000/#cek`) untuk melihat jumlah baris valid / dilewati per sumber.

## Setup koneksi database (warehouse `we_data_store`)

Langkah menyambungkan papan ke tabel `laporan_penjualan`. Password database cukup diisi di `.env`
(lokal) dan di Vercel; jangan dikirim lewat chat atau di-commit.

### 1. Siapkan user read-only

Minta DBA membuat user khusus papan yang hanya bisa membaca satu tabel. Lebih aman, dan bebannya
terbatas:

```sql
CREATE ROLE imperfect_tv LOGIN PASSWORD 'ganti-password-kuat' CONNECTION LIMIT 5;
GRANT CONNECT ON DATABASE we_data_store TO imperfect_tv;
GRANT USAGE ON SCHEMA public TO imperfect_tv;          -- ganti public kalau tabelnya di schema lain
GRANT SELECT ON laporan_penjualan TO imperfect_tv;
ALTER ROLE imperfect_tv SET statement_timeout = '20s';
```

Sementara belum ada, user read-only yang dipakai OFFLINE-STORE / `data-db` juga bisa (secrets
`DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` di repo itu).

### 2. Isi data koneksi

Pilih **salah satu** cara. Kalau keduanya terisi, `DATABASE_URL` yang dipakai.

**a. Variabel terpisah (disarankan, terutama kalau password banyak tanda bacanya).** Password ditulis
apa adanya, tanpa encode:

```
DATABASE_HOST=1.2.3.4
DATABASE_PORT=5432
DATABASE_USER=imperfect_tv
DATABASE_PASSWORD='Rh#4s!a/9?q@x:%20'
DATABASE_NAME=we_data_store
```

Di `.env`, **selalu apit password dengan kutip tunggal**. Tanpa kutip, `#` di posisi mana pun dibaca
sebagai awal komentar: `DATABASE_PASSWORD=Rh#4s` hanya terbaca `Rh`. Kalau password sendiri memuat
kutip tunggal, pakai kutip ganda (`"..."`). Di Vercel tidak perlu kutip: tempel apa adanya di kolom
nilai.

**b. Satu `DATABASE_URL`.**

```
postgres://USER:PASSWORD@HOST:5432/we_data_store
```

Tanda baca di password harus di-encode (`#` → `%23`, `/` → `%2F`, `?` → `%3F`, `@` → `%40`,
`:` → `%3A`, `%` → `%25`, dst.). Supaya tidak salah, biarkan komputer yang meng-encode. Perintah ini
meminta password tanpa menampilkannya dan tidak menyimpannya di riwayat shell:

```bash
read -rs PW && PW="$PW" node -e 'console.log(encodeURIComponent(process.env.PW))'; unset PW
```

Lainnya:

- Kalau tabelnya di schema lain (mis. `mysql_db_store`): dengan `DATABASE_URL`, tambahkan di ujungnya
  `?options=-c%20search_path%3Dmysql_db_store`; dengan variabel terpisah, ubah `PG_QUERY` menjadi
  `FROM mysql_db_store.laporan_penjualan`.
- SSL: OFFLINE-STORE memakai `DATABASE_SSL=false`, jadi mulai dengan `PG_SSL=false`.
- Untuk `psql` di langkah 3, variabel terpisah dipetakan ke `PGHOST`, `PGPORT`, `PGUSER`,
  `PGPASSWORD`, `PGDATABASE`, lalu jalankan `psql` tanpa argumen koneksi.

### 3. Tes koneksi dan jalankan skrip cek

Dengan `psql` (atau DBeaver/TablePlus):

```bash
psql "$DATABASE_URL" -c "select current_user, current_database(), now()"
psql "$DATABASE_URL" -f scripts/cek-event-postgres.sql
# atau, dengan variabel terpisah:
export PGHOST=... PGPORT=5432 PGUSER=... PGDATABASE=we_data_store
read -rs PGPASSWORD && export PGPASSWORD
psql -f scripts/cek-event-postgres.sql
```

Hasil skrip cek hanya berisi nama kolom, store/gudang, status, dan hitungan (tanpa data pelanggan),
jadi aman dibagikan. Dari situ `PG_QUERY` disesuaikan: kolom dan nilai penanda event (`warehouse` atau
`channel`), status yang dibuang, dan penyaring yang memakai index
(lihat [Beban ke database](#beban-ke-database)).

### 4. (Opsional) Coba di laptop

```bash
git pull
cp .env.example .env      # isi data koneksi (langkah 2); PG_QUERY sesuaikan hasil langkah 3
npm install
npm start                 # buka http://localhost:3000/#cek
```

Chip `#cek` menampilkan "Postgres N valid · M dilewati". "Dilewati" = invoice tanpa nomor HP.

### 5. Pasang di Vercel

1. Vercel → project **imperpect-sales-2026** → **Settings → Environment Variables**. Isi tiap variabel
   untuk environment **Production** (centang juga Preview kalau deploy preview perlu data). Tandai
   `DATABASE_PASSWORD` (atau `DATABASE_URL`) sebagai **Sensitive**. Beberapa variabel sekaligus bisa
   ditempel dalam format `.env` ke kolom *Key*.

   | Variabel | Nilai |
   |---|---|
   | `DATA_SOURCES` | `postgres,drive` (`postgres` saja kalau folder Sheet brand belum siap) |
   | `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` | dari langkah 2a (atau satu `DATABASE_URL`, langkah 2b) |
   | `PG_QUERY` | dari `.env.example`, disesuaikan hasil cek |
   | `PG_SSL` | `false` (atau `true` kalau server mewajibkan) |
   | `POLL_MS` | `60000` |
   | `CACHE_SECONDS` | `30` |

2. **Deployments → ⋯ pada deploy teratas → Redeploy.** Perubahan env baru berlaku setelah deploy ulang.
3. Cek:
   - `https://imperpect-sales-2026.vercel.app/healthz` → status `200` dengan `"ok":true`.
   - `https://imperpect-sales-2026.vercel.app/#cek` → jumlah invoice valid.

### 6. Kalau gagal

Pesan error asli tampil di `/healthz` (`sources.postgres.error`) dan di chip `#cek`:

| Pesan | Penyebab dan solusi |
|---|---|
| `password authentication failed` | Password salah. Dengan `DATABASE_URL`: tanda bacanya belum di-encode; pakai variabel terpisah (langkah 2a). |
| `timeout` / `ECONNREFUSED` | Host/port salah, atau firewall database menolak. Vercel Functions tidak punya IP tetap, jadi user ini harus boleh masuk dari IP mana pun. |
| `relation "laporan_penjualan" does not exist` | Tabel ada di schema lain: tambahkan `search_path` (langkah 2). |
| `permission denied for table` | `GRANT SELECT` belum diberikan (langkah 1). |
| `no pg_hba.conf entry ... SSL off` | Set `PG_SSL=true`. |
| `self-signed certificate` | Set juga `PG_SSL_REJECT_UNAUTHORIZED=false`. |

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `DATABASE_URL` | – | Koneksi Postgres sebagai URL (password di-encode). Didahulukan bila terisi. |
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` | – / `5432` | Koneksi Postgres per bagian; password apa adanya. Dipakai bila `DATABASE_URL` kosong. Keduanya kosong = sumber Postgres dilewati. |
| `PG_QUERY` | `SELECT phone, name, qty, trx_value AS value FROM transactions` | Query yang mengembalikan kolom `phone, name, qty, value`, satu baris per transaksi. |
| `PG_SSL` | `false` | `true` untuk DB terkelola (Supabase, RDS, Neon, dll). |
| `DRIVE_FOLDER` | – | Link/ID folder Drive berisi satu spreadsheet per brand. Lihat [Sheet brand](#sheet-brand-folder-google-drive--akun-layanan--disarankan-untuk-50-brand). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | – | Isi file key JSON akun layanan. Atau `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`. |
| `DRIVE_MAX_ROWS` | `5000` | Baris maksimum yang dibaca per file brand. |
| `SHEET_URLS` | – | Sheet per brand lewat link publik, satu per baris: `Brand \| link`. |
| `SHEET_URL` | – | Satu Sheet tanpa brand (Share: *Anyone with the link*, Viewer), ID Sheet, atau link CSV *Publish to web*. |
| `SHEET_GID` | `0` | Tab yang dibaca bila link tidak memuat `gid`. |
| `DATA_SOURCES` | `postgres,sheet,drive,jubelio` | Batasi sumber. Event 2026: `postgres,drive`. |
| `JUBELIO_EMAIL`, `JUBELIO_PASSWORD` | – | Login API Jubelio. Kosong = sumber Jubelio dilewati. |
| `JUBELIO_LOCATION` | – | Nama gudang persis di Jubelio: `MAIN IMPERFECT WAREHOUS 2026`. |
| `JUBELIO_DATE_FROM`, `JUBELIO_DATE_TO` | – / tanpa batas | Rentang tanggal transaksi event (WIB, `YYYY-MM-DD`). `FROM` wajib. |
| `JUBELIO_VALUE_FIELD` | `grand_total` | Kolom nilai dari detail order, mis. `sub_total`. |
| `JUBELIO_BUDGET_MS` | `20000` | Batas waktu sinkron Jubelio per pembacaan (di bawah `maxDuration` 30 detik Vercel). |
| `POLL_MS` | `30000` | Interval baca ulang di server Node, sekaligus interval polling halaman TV (min 5000). |
| `CACHE_SECONDS` | `30` | Vercel saja: lama hasil `/api/state` di-cache di CDN (= jarak minimum antar query). |
| `PORT` | `3000` | Port HTTP. |

### Postgres (warehouse `we_data_store`) — sumber event 2026

Transaksi event dibaca dari tabel **`laporan_penjualan`** di warehouse `we_data_store` (sama dengan yang
dipakai dashboard OFFLINE-STORE). Tabel itu berisi **satu baris per produk**, dengan kolom pelanggan
`nama` dan `no_hp`, jadi `PG_QUERY` mengelompokkannya per invoice:

```sql
SELECT MAX(no_hp) AS phone, MAX(nama) AS name, SUM(qty) AS qty, MAX(total_bayar) AS value
  FROM laporan_penjualan
 WHERE warehouse = 'MAIN IMPERFECT WAREHOUS 2026'          -- atau channel = '...', lihat cek di bawah
   AND tanggal >= DATE '2026-10-30' AND tanggal < DATE '2026-11-02'
 GROUP BY COALESCE(NULLIF(btrim(invoice_number), ''), no_order)
```

- Nilai = **`total_bayar`, diambil sekali per invoice**. `total_bayar` adalah total satu invoice yang
  berulang di tiap baris produknya; invoice berisi 3 produk tetap dihitung satu kali (`MAX`), bukan
  dijumlahkan jadi tiga kali lipat. Invoice-invoice berbeda milik nomor HP yang sama dijumlahkan papan.
- Invoice tanpa `invoice_number` memakai `no_order` sebagai kunci.
- Batas atas ditulis `< hari berikutnya`, agar transaksi di hari terakhir tidak terbuang kalau `tanggal`
  bertipe timestamp.
- Transaksi tanpa `no_hp` tidak masuk papan (terlihat sebagai "dilewati" di `#cek`).
- Angka `numeric` dari Postgres (mis. `"2500000.0000"`) dibaca dengan benar.

**Sebelum event**, jalankan `scripts/cek-event-postgres.sql` dengan user read-only. Skrip ini hanya
mencetak nama kolom, nama store/gudang, status, dan hitungan (tanpa data pelanggan) untuk memastikan:
kolom penyaring event (`warehouse` atau `channel`) dan nilainya, seberapa banyak transaksi event yang
punya `no_hp`, status apa yang perlu dibuang (batal/retur), dan seberapa cepat transaksi masuk ke tabel.

```bash
psql "$DATABASE_URL" -f scripts/cek-event-postgres.sql
```

#### Beban ke database

Papan dirancang agar **jumlah TV tidak menambah beban database**:

- **Satu query per interval, berapa pun TV-nya.** TV membaca `/api/state`, bukan database. Server Node
  menjalankan `PG_QUERY` sekali tiap `POLL_MS`; di Vercel hasilnya di-cache di CDN selama
  `CACHE_SECONDS`, jadi function (dan query) jalan paling sering sekali per interval itu.
- **Koneksi sedikit dan dipakai ulang.** Server Node memakai pool maksimal 2 koneksi, Vercel Function
  maksimal 1 per instance; koneksi menganggur ditutup setelah 30 detik. Query dibatasi 20 detik
  (`statement_timeout`).
- **Hanya hasil agregat yang dikirim**: satu baris per invoice untuk 3 hari event, bukan seluruh tabel.

Yang perlu dipastikan adalah **query-nya memakai index**. `laporan_penjualan` besar; kalau penyaringnya
tidak ter-index, Postgres membaca seluruh tabel setiap poll. Bagian 6–7 skrip cek menampilkan index
yang ada dan rencana eksekusi query papan:

- Index yang dipakai OFFLINE-STORE adalah `(sumber, channel, tanggal)`. Kalau event tercatat sebagai
  satu `channel` di `sumber = 'OFFLINE-STORE'`, saring dengan
  `sumber = 'OFFLINE-STORE' AND channel = '...' AND tanggal ...` agar index itu terpakai.
- Kalau event hanya bisa disaring lewat `warehouse`, minta DBA membuat index
  `(warehouse, tanggal)`, atau naikkan interval.
- Interval wajar: `POLL_MS=60000` dan `CACHE_SECONDS=30`. Kalau `laporan_penjualan` sendiri diisi
  berkala (mis. tiap 30 menit), poll lebih cepat dari itu tidak menambah kesegaran, hanya beban.

Untuk tabel lain, cukup ganti `PG_QUERY`; kolom yang dibutuhkan selalu `phone, name, qty, value`.
Tabel contoh untuk uji lokal ada di `db/schema.sql` + `db/seed.sql` (`npm run db:init`, `npm run db:seed`).

### Jubelio

Sumber ini hanya **membaca**: `POST /login` untuk token, sisanya `GET`. Perilaku API sudah dicek di akun
ini (lihat juga `martech-sys/data-db`, `docs/jubelio-api.md`):

- Gudang event 2026: **`MAIN IMPERFECT WAREHOUS 2026`** (id lokasi 26, outlet POS).
- `GET /sales/orders/` tidak bisa difilter per lokasi dan hanya memuat **nama** lokasi, jadi order di
  rentang `JUBELIO_DATE_FROM`–`TO` (WIB) dibaca lalu disaring ke `JUBELIO_LOCATION` (nama persis, tidak
  peka huruf besar/kecil). Order batal (`internal_status` `CANCELED`) dilewati.
- **Nomor HP di order disamarkan Jubelio** (`**********99`). Nomor lengkap diambil dari
  `GET /contacts/{contact_id}` (kolom `phone`), sekali per pembeli.
- **Order "Pelanggan Umum" (walk-in, `contact_id` -1) tidak punya nomor HP**, jadi tidak masuk papan
  (terlihat sebagai "dilewati" / "tanpa HP" di `#cek`). Supaya belanja jastiper terhitung, kasir harus
  memilih atau membuat kontak pembeli **dengan nomor HP** di POS.
- Kontak yang belum punya HP dicoba lagi tiap 5 menit, jadi nomor yang ditambahkan belakangan tetap masuk.
- Nilai = `grand_total` (atau `JUBELIO_VALUE_FIELD`), angka string seperti `"750000.0000"` dikonversi
  dengan benar. Qty = jumlah `qty_in_base` item yang tidak batal.

Sinkronisasinya bertahap dengan batas waktu `JUBELIO_BUDGET_MS` per pembacaan: pemindaian pertama
berjalan halaman per halaman, setelah itu hanya order yang berubah yang dibaca (`lastModifiedSince`; API
hanya memakai tanggal UTC-nya, jadi yang terbaca ulang adalah semua perubahan hari itu dan order yang
tidak berubah dilewati). Pembacaan yang terpotong batas waktu dilanjutkan dari halamannya. Progres sinkron
disimpan di memori, jadi di Vercel function yang baru menyala mulai memindai lagi dari awal; untuk event
dengan ribuan order, server Node yang berjalan terus lebih cocok. Progres terlihat di `#cek`
("memindai order", "N menunggu kontak", "N tanpa HP").

Kredensial Jubelio cukup di `.env` / environment variables hosting. Jangan di-commit.

### Sheet brand (folder Google Drive + akun layanan) — disarankan untuk 50+ brand

Transaksi yang tidak masuk warehouse (dicatat sendiri oleh tiap brand) diisi di **satu spreadsheet per
brand**, semuanya di **satu folder Google Drive**. Papan membaca folder itu dengan **akun layanan**
(service account) Google, lalu menggabungkannya per nomor HP bersama Postgres.

- Tiap brand hanya menerima link / akses ke file-nya sendiri. Folder tidak di-share ke brand, jadi
  **brand tidak bisa melihat omzet brand lain** (daftar isi folder dan link brand lain tidak terlihat).
- Folder di-share **sekali** ke email akun layanan (Viewer); semua file di dalamnya (termasuk yang
  ditambahkan nanti) otomatis terbaca. Tidak perlu daftar link atau sheet MASTER.
- Nama file = nama brand (muncul di `#cek`). Yang dibaca: tab **pertama** (diekspor sebagai CSV lewat
  Drive API; kolom dikenali dari judulnya).
- Tiap pembacaan: 1× daftar isi folder, lalu hanya file yang **berubah** sejak pembacaan terakhir yang
  dibaca ulang. File yang gagal dibaca tetap memakai data terakhirnya; nama brand dan errornya terlihat
  di `#cek` dan `/healthz` (bukan di TV).

Format tiap file — baris pertama judul, satu baris = satu transaksi:

| No HP | Nama | qty | trx value |
|---|---|---|---|
| 081234567890 | Dewi Lestari | 3 | 2500000 |

#### Setup (sekali, ±15 menit)

1. **Buat akun layanan** — [console.cloud.google.com](https://console.cloud.google.com):
   1. Pilih/buat project (mis. `imperfect-papan-tv`).
   2. **APIs & Services → Library**: aktifkan **Google Drive API**. (Google Sheets API tidak dipakai:
      jatahnya hanya 60 baca/menit, terlalu kecil untuk 37+ brand.)
   3. **IAM & Admin → Service Accounts → Create service account**, nama mis. `papan-tv`. Lewati langkah
      *roles* dan *grant users access* (tidak perlu role apa pun).
   4. Buka akun layanan itu → **Keys → Add key → Create new key → JSON**. File `.json` terunduh.
      Simpan baik-baik: isinya kunci rahasia. Jangan di-commit / dikirim ke chat.
   5. Catat emailnya: `papan-tv@<project>.iam.gserviceaccount.com`.
2. **Buat folder** di Google Drive (mis. `Imperfect Sale 2026 – Sheet Brand`) → **Share** → tambahkan
   email akun layanan sebagai **Viewer** (hapus centang *Notify people*). Jangan share folder ke brand.
   Google Workspace yang membatasi share ke luar domain perlu mengizinkan domain
   `iam.gserviceaccount.com` (Admin console → Drive → Sharing settings).
3. **Buat file per brand** dengan [`scripts/buat-sheet-brand.gs`](scripts/buat-sheet-brand.gs) (daftar
   37 brand event 2026 sudah terisi): buka [script.google.com](https://script.google.com) → *New project* →
   tempel isi file → isi `FOLDER` → pilih `buatSheetBrand` → **Run**. Script membuat file dengan judul
   kolom, kolom No HP berformat teks, dan validasi angka. Dengan `AKSES = 'link'` (bawaan) tiap file
   dibuka *Anyone with the link → Editor*, tanpa email; dengan `'email'` hanya email di `BRANDS` yang
   diberi akses. Link tiap brand ditulis ke spreadsheet **Daftar Link Sheet Brand** di My Drive admin:
   kirim ke tiap brand **hanya link miliknya**. Aman dijalankan ulang (brand baru tinggal ditambah).

   > Dengan akses link, siapa pun yang memegang link sebuah file bisa melihat dan mengubah isinya
   > (termasuk nomor HP pembeli). Brand tetap tidak bisa melihat file brand lain selama link tidak
   > disebar. Link file tidak bisa diganti; kalau satu link bocor, ubah file itu ke *Share → General
   > access → Restricted* lalu tambahkan email tim brand tersebut. Riwayat perubahan ada di
   > *File → Version history*.
4. **Vercel → Settings → Environment Variables** (Production), lalu **Redeploy**:

   | Variabel | Isi |
   |---|---|
   | `DATA_SOURCES` | `postgres,drive` |
   | `DRIVE_FOLDER` | link folder dari langkah 2 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | seluruh isi file `.json` dari langkah 1, ditempel apa adanya. Tandai **Sensitive**. |

5. Cek `https://<project>.vercel.app/healthz`: sumber `drive` `ok: true`, dan `#cek` di halaman TV
   menampilkan `Sheet brand … · N brand`.

Kalau gagal:

| Pesan | Perbaikan |
|---|---|
| `Folder Drive tidak bisa dibaca (HTTP 404 …). Share folder ke … sebagai Viewer` | Folder belum di-share ke email akun layanan, atau `DRIVE_FOLDER` salah. |
| `HTTP 403 … has not been used in project` | Google Drive API belum diaktifkan (langkah 1.2). |
| `HTTP 429: Quota exceeded … sheets.googleapis.com` | Deploy lama yang masih memakai Sheets API. Redeploy dari `main` terbaru. |
| `Login akun layanan gagal: invalid_grant` | Kunci sudah dihapus / salah tempel. Buat key JSON baru. |
| `GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON yang valid` | Tempel ulang seluruh isi file, dari `{` sampai `}`. |
| Brand tidak muncul | File harus berupa Google Sheets (bukan `.xlsx`) dan berada langsung di folder itu. |

Tips untuk brand: isi kolom `trx value` sebagai angka (`2500000`); nomor HP boleh `0812…`, `62812…`, atau
`+62 812…`. Baris yang nomor HP-nya tidak valid atau nilainya kosong dilewati dan dilaporkan di `#cek`
sebagai `Brand:baris`.

> Jangan memasukkan transaksi yang sama ke Postgres **dan** Sheet brand: nilainya akan terhitung dua kali.

### Google Sheet dengan link (alternatif)

Tanpa akun layanan, Sheet bisa dibaca lewat link publik: Share **Anyone with the link → Viewer**. Siapa pun
yang memegang link bisa melihat isinya, jadi untuk omzet brand pakai cara folder Drive di atas.

Daftar Sheet diisi di `SHEET_URLS`, satu brand per baris (di `.env` satu baris, pisahkan dengan `;`), dan
`DATA_SOURCES` harus memuat `sheet`:

```
Heymale | https://docs.google.com/spreadsheets/d/AAA/edit?gid=0
Heylocal | https://docs.google.com/spreadsheets/d/BBB/edit?gid=0
```

Tiap brand jadi sumber sendiri (`sheet:Heymale`, …); Sheet yang gagal dibaca tidak menghentikan papan.
`SHEET_URL` membaca satu Sheet tanpa nama brand.

## Endpoint

- `GET /` — halaman TV
- `GET /api/state` — `{ state: { updatedAt, totals, top[] }, sources: { postgres, drive, … }, pollMs }`
- `GET /healthz` — 200 bila minimal satu sumber terbaca, 503 bila tidak

## Tes

```bash
npm test
```
