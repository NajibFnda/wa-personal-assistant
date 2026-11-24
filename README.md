# All-in-One Personal Assistant

Asisten pribadi multimodal berbasis **WhatsApp Bot (`@whiskeysockets/baileys`) + Gemini Flash (`@google/genai`, default `gemini-3.5-flash-lite` dengan auto-fallback ke `gemini-3.8-flash` / `3.6-flash` / `3.5-flash`) + SQLite (`better-sqlite3`) + PWA Web Dashboard (`Express.js` + `web-push`)**.

## Fitur Utama
1. **Strict Single-User Whitelist & Silent Drop:** Hanya memproses pesan dari `NOMOR_UTAMA` (`fromMe === false`). Pesan dari nomor asing/grup langsung diabaikan tanpa memanggil Gemini API, tanpa balasan, dan tanpa read receipt.
2. **Modul 1 — Jadwal Kuliah, Presensi & Snooze:** Input via teks/voice note/screenshot KRS atau Dashboard. Mendukung jadwal rutin mingguan, sekali jalan (otomatis nonaktif setelah berjalan), dan balas *"tunda 10 menit"* untuk Snooze.
3. **Modul 2 — Task & Deadline Tracker (Anti-SKS):** Ekstrak tugas dari teks/screenshot/PDF. Pengingat ganda otomatis pada **H-24 Jam** dan **H-3 Jam**.
4. **Modul 3 — Brankas Memori & Wishlist Pacar:** Catat cerita/foto harian, pencarian memori berbasis tanggal relatif/kata kunci, wishlist, serta pengingat momen spesial otomatis pada **H-7, H-3, dan H-1**.
5. **Modul 4 — Morning Briefing Otomatis:** Terkirim setiap hari pukul **06:00 WIB**.
6. **Modul 5 — Quick Vault:** Simpan & ambil kembali URL atau file dokumen (`PDF/DOCX/ZIP/gambar`) via WhatsApp maupun Web Dashboard.
7. **Modul 6 — Quick Expense Log:** Catat pengeluaran dari teks santai atau foto struk, lengkap dengan rekap dan grafik Chart.js di Dashboard.
8. **Modul 7 — Auto-Backup Database Mingguan:** Mengirim snapshot `assistant.db` ke WhatsApp setiap Minggu pukul **23:00 WIB**.
9. **Dual-Channel Notification + PWA:** Pesan WhatsApp + OS Push Notification via Service Worker (`public/sw.js`) yang tetap masuk meskipun tab browser tertutup.

## Konfigurasi (`.env`)
Salin `.env.example` ke `.env` (sudah dibuatkan dengan VAPID keys siap pakai), lalu isi:

```env
PORT=3000
GEMINI_API_KEY=ISI_API_KEY_GEMINI_ANDA
NOMOR_UTAMA=6281234567890
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@localhost
WEB_PIN=
```

* `NOMOR_UTAMA`: Format internasional tanpa `+` atau spasi (contoh: `6281234567890`).
* `WEB_PIN`: Opsional. Jika diisi, Web Dashboard dan seluruh `/api/*` terkunci dengan PIN.
* Generate ulang VAPID keys kapan saja dengan: `npm run generate-vapid`.

## Menjalankan Aplikasi

### Mode Pengembangan / Manual
```bash
npm install
npm start
```
Buka Web Dashboard di `http://localhost:3000`, lalu scan QR Code WhatsApp menggunakan nomor khusus bot (**Perangkat Tertaut → Tautkan Perangkat**) dan klik **Aktifkan Notifikasi Browser**.

### Mode Latar Belakang 24/7 (PM2)
```bash
npm install -g pm2
pm2 start src/app.js --name "personal-assistant"
pm2 save
pm2 startup
```

## Pengujian Otomatis
```bash
npm test
```
