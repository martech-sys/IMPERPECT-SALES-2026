-- Tabel transaksi Imperfect Sale 2026.
-- Satu baris = satu transaksi. Papan TV menjumlahkan per nomor HP.
-- Kalau data sudah ada di tabel lain, tidak perlu tabel ini: atur PG_QUERY di .env.
CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT        NOT NULL,               -- 0812..., 62812..., atau +62 812...
  name        TEXT,
  qty         INTEGER     NOT NULL DEFAULT 0,
  trx_value   NUMERIC(14,2) NOT NULL CHECK (trx_value >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_phone_idx ON transactions (phone);
