# Steam Discount Notification Bot

Backend Bun + ElysiaJS untuk bot Telegram yang mencari diskon game, memantau wishlist, menyinkronkan playtime Steam, mencatat pengeluaran, dan membuat rekomendasi.

Spesifikasi produk lengkap tersedia di [docs/PRD.md](docs/PRD.md).

## Yang sudah diimplementasikan

- Webhook Telegram Bot API dengan secret header, batas payload, sanitasi private chat, dan deduplikasi `update_id`.
- Perintah Telegram untuk pencarian, wishlist, statistik, purchase ledger, rekomendasi, Steam linking, opt-in/out, dan penghapusan data.
- Adapter IsThereAnyDeal, Steam Web API/OpenID, Telegram Bot API, serta mock provider tanpa kredensial.
- PostgreSQL schema, migrasi, queue dengan lease/retry/dead-letter, notification outbox, quiet hours, dan daily cap.
- Retry Telegram `429` mengikuti `retry_after`; kegagalan sementara memakai exponential backoff.
- Statistik playtime dari snapshot, nilai pengeluaran tercatat, serta rekomendasi content-based.
- OpenAPI, health/readiness, structured log dengan redaction, feature flags, Docker Compose, dan CI.

## Menjalankan dengan Docker

```bash
docker compose up --build
```

API tersedia di `http://localhost:3000` dan dokumentasi interaktif di `http://localhost:3000/openapi`.

## Menjalankan secara lokal

Syarat: Bun 1.3.14 dan PostgreSQL 17.

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d db
bun run db:migrate
```

Jalankan tiga proses pada terminal terpisah:

```bash
bun run dev
bun run worker
bun run scheduler
```

## Mencoba API tanpa akun provider

Pastikan `USE_MOCK_PROVIDERS=true`. Buat pengguna development:

```bash
curl -X POST http://localhost:3000/internal/users/bootstrap \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-internal-key' \
  -d '{"provider":"development","address":"demo-user"}'
```

Gunakan `userId` hasil respons untuk mencari deal:

```bash
curl 'http://localhost:3000/v1/games/search?q=Hades' \
  -H 'x-api-key: local-internal-key' \
  -H 'x-user-id: USER_ID_DARI_RESPONS'
```

## Mengaktifkan Telegram dan provider nyata

1. Buat bot melalui `@BotFather` dan simpan token di secret manager sebagai `TELEGRAM_BOT_TOKEN`.
2. Buat secret acak untuk `TELEGRAM_WEBHOOK_SECRET`.
3. Isi `STEAM_WEB_API_KEY` dan `ITAD_API_KEY`, lalu ubah `USE_MOCK_PROVIDERS=false`.
4. Jalankan API pada HTTPS publik.
5. Daftarkan webhook melalui `setWebhook` ke `https://DOMAIN/webhooks/telegram`, sertakan `secret_token`, dan batasi `allowed_updates` ke `message` serta `callback_query`.
6. Verifikasi dengan `getWebhookInfo`, lalu kirim `/start` pada private chat bot.

Jangan menaruh token bot pada URL webhook, repository, log, atau pesan error. Token hanya digunakan server saat memanggil `api.telegram.org`.

## Perintah Telegram

```text
/start
/diskon <nama game>
/wishlist tambah <nama game>
/wishlist atur <game> diskon <persen>
/wishlist atur <game> harga <IDR>
/wishlist atur <game> terendah
/wishlist
/wishlist hapus <nama game>
/wishlist jeda
/statistik
/pengeluaran
/beli tambah <game> <harga IDR> tanggal YYYY-MM-DD toko <nama>
/rekomendasi
/linksteam
/notifikasi on
/notifikasi off
/hapusdata
```

## Pengujian

```bash
bun run check
bun test --coverage
```

Integration test membutuhkan database yang sudah dimigrasi:

```bash
bun run db:migrate
bun run test:integration
```

## Operasional

- `/health/live` hanya memeriksa proses.
- `/health/ready` memeriksa koneksi PostgreSQL.
- `/admin/jobs` memerlukan `x-admin-key` dan menampilkan jumlah job per state tanpa payload.
- Worker melakukan retry exponential untuk error sementara dan memindahkan error permanen/terlalu sering gagal ke state `dead`.
- Pesan proaktif selalu memeriksa consent lagi tepat sebelum dikirim.
- Respons sukses Telegram menandakan pesan diterima Bot API, bukan bukti pesan telah dibaca pengguna.

## Batasan yang memerlukan setup eksternal

- Produksi memerlukan bot token dari BotFather dan endpoint webhook HTTPS yang dapat dijangkau Telegram.
- Bot hanya dapat mengirim pesan kepada pengguna yang telah memulai private chat dan belum memblokir bot.
- ITAD memerlukan API key dan verifikasi coverage wilayah/mata uang sebelum produksi.
- Statistik tujuh hari penuh baru tersedia setelah snapshot terkumpul selama tujuh hari.
- Nilai library adalah estimasi biaya pengganti, bukan harga jual akun Steam.
# steam-bot-notifications
