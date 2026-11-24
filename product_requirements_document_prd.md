# Product Requirements Document (PRD)
**Nama Proyek:** All-in-One Personal Assistant (WhatsApp Multimodal Bot + Gemini AI + Web Dashboard)  
**Target Platform:** Lokal (Windows / Linux) & Cloud Hosting 24/7 (Node.js Runtime)  
**Arsitektur Utama:** Monolithic Node.js Backend (`Express.js` + `@whiskeysockets/baileys` + `@google/genai` + `better-sqlite3` + `node-cron` + `web-push`) dengan Single-Page Web Dashboard (HTML/CSS/JS + Service Worker PWA).

---

## 1. Ringkasan Produk & Tujuan
Membangun asisten pribadi cerdas berbasis WhatsApp dan Web Dashboard yang berjalan 24/7 secara gratis. Pengguna berinteraksi dengan bot menggunakan bahasa manusia sehari-hari (teks, gambar/*screenshot*, dokumen PDF, atau *voice note*) melalui nomor WhatsApp khusus bot. **Gemini AI (`gemini-2.5-flash`)** bertindak sebagai *intent classifier* dan *structured data extractor* yang menyimpan/mengambil data dari database lokal SQLite. Sistem ini dilengkapi **Dual-Channel Notification** (Pesan WhatsApp + Web Push Notification) yang berjalan di latar belakang tanpa perlu membuka tab web.

---

## 2. Arsitektur Sistem & Keamanan

### 2.1 Diagram Alur Data
```text
[User WhatsApp (Nomor Utama)] 
       │  (Teks / Gambar / PDF / Voice Note)
       ▼
[Baileys WA Client] ──(Strict Whitelist Check: NOMOR_UTAMA)──> [Gemini 2.5 Flash API]
       │                                                              │
       │ <───────────────(Structured JSON Output)─────────────────────┘
       ▼
[SQLite Database (assistant.db)] <────(REST API)────> [Web Dashboard (localhost:3000)]
       │                                                       │
       ▼                                                       ▼
[Node-Cron Scheduler] ───(Dual Notification)───> [WA Chat] + [Web Push / Service Worker]
```

### 2.2 Aturan Keamanan & Privasi
1. **Strict Single-User Whitelist:** Bot menggunakan nomor WhatsApp kedua. Pada event `messages.upsert`, sistem **WAJIB** memvalidasi `msg.key.remoteJid === process.env.NOMOR_UTAMA + '@s.whatsapp.net'` dan `msg.key.fromMe === false`.
2. **Silent Drop:** Semua pesan dari nomor asing atau grup yang tidak terdaftar harus langsung diabaikan (`return`) tanpa memanggil Gemini API, tanpa mengirim balasan, dan tanpa menandai pesan sebagai terbaca (*no read receipt*).
3. **Environment Variables (`.env`):** Menyimpan `PORT`, `GEMINI_API_KEY`, `NOMOR_UTAMA`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, dan opsional `WEB_PIN` (PIN sederhana untuk mengunci akses Web Dashboard).

---

## 3. Spesifikasi Fitur Fungsional (Core Modules)

### Modul 1: Jadwal Kuliah, Presensi & Snooze
* **Input:** Dapat ditambahkan via chat WA (*"Ingetin presensi tiap Selasa jam 07.50 matkul Sistem Terdistribusi"*, atau via *screenshot* KRS/jadwal) maupun form di Web Dashboard.
* **Tipe Jadwal:**
  * *Rutin Mingguan (`is_rutin = 1`):* Berulang setiap hari yang ditentukan (Senin–Minggu) pada jam tertentu.
  * *Sekali Jalan (`is_rutin = 0`):* Berjalan satu kali pada tanggal (`YYYY-MM-DD`) dan jam (`HH:MM`) tertentu, lalu otomatis dinonaktifkan (`aktif = 0`).
* **Fitur Snooze (Tunda Pengingat):** Jika pengguna membalas pesan pengingat dengan kalimat seperti *"Ingetin lagi 10 menit lagi"* atau *"Tunda 15 menit"*, sistem membuat jadwal sekali jalan baru pada waktu `sekarang + N menit` dengan nama kegiatan dari pengingat terakhir yang dikirim bot.

### Modul 2: Task & Deadline Tracker (Anti-SKS)
* **Input:** Teks bebas, *copy-paste* pengumuman grup, *screenshot* tugas, atau file PDF silabus/modul. Gemini mengekstrak `judul`, `matkul`, dan `deadline` (`YYYY-MM-DD HH:MM`).
* **Pengingat Bertingkat Otomatis:** Selama `selesai = 0`, scheduler mengecek setiap menit dan mengirim notifikasi ganda pada:
  * **H-24 Jam (H-1):** Menandai `notif_h1 = 1`.
  * **H-3 Jam:** Menandai `notif_h3jam = 1`.
* **Manajemen Status:** Pengguna dapat menandai tugas selesai via chat WA (*"Tugas Kriptografi udah kelar"*) atau mencentang di Web Dashboard (`selesai = 1`), yang otomatis menghentikan pengingat berikutnya.

### Modul 3: Brankas Memori & Wishlist Pacar
* **Pencatatan Harian (`memori_pacar`):** Pengguna mengirim cerita/aktivitas pacar atau *forward* chat/foto. Gemini merangkum poin-poin penting dan menyimpannya bersama `tanggal` (`YYYY-MM-DD`), `hari` (Senin–Minggu), dan `media_path` (jika ada gambar).
* **Pencarian Konteks & Tanggal Relatif:** Pengguna dapat bertanya via WA (*"Minggu kemarin hari Selasa dia ngelakuin apa?"*, *"3 hari lalu dia cerita apa?"*, atau *"Kapan terakhir kali dia beli matcha?"*). Sistem menjalankan query SQL berdasarkan tanggal hasil kalkulasi Gemini atau pencarian kata kunci (`LIKE`), lalu Gemini merangkum hasilnya menjadi jawaban natural.
* **Wishlist & Tanggal Spesial (`momen_wishlist`):**
  * Menyimpan keinginan pacar (*"Masukin wishlist dia: tas selempang warna krem"* atau dari *screenshot*).
  * Menyimpan tanggal penting (`MOMEN`, misal: Ulang Tahun, Anniversary) dan memicu pengingat otomatis pada **H-7, H-3, dan H-1**.

### Modul 4: Morning Briefing Otomatis
* **Waktu Eksekusi:** Setiap hari pukul `06:00` WIB (`0 6 * * *` dengan timezone `Asia/Jakarta`).
* **Konten:** Bot mengirim 1 pesan terstruktur ke WhatsApp yang berisi:
  1. Daftar jadwal kuliah & jam presensi hari ini.
  2. Daftar tugas aktif yang deadline-nya hari ini atau besok.
  3. Momen spesial (jika ada dalam 7 hari ke depan).

### Modul 5: Quick Vault (Brankas Link & Dokumen Kuliah)
* **Input:** Pengguna mengirim URL (link presensi, Zoom, Google Drive) atau file dokumen (PDF/DOCX/ZIP) ke WA dengan keterangan/kata kunci (*"Simpan ini sebagai link presensi kripto"*). File disimpan di folder `./uploads/` dan path-nya dicatat di tabel `vault`.
* **Retrieval:** Pengguna meminta via WA (*"Minta link presensi kripto"*). Bot mencari kata kunci di database dan mengirimkan teks URL atau mengirim balik file dokumen langsung ke chat WA.

### Modul 6: Quick Expense Log (Pencatat Pengeluaran Kilat)
* **Input:** Teks santai (*"Makan siang 18rb, bensin 25rb, kopi 20k"*) atau foto struk belanja. Gemini mengekstrak array item, nominal integer, dan kategori (`Makan & Minum`, `Transportasi`, `Akademik`, `Hiburan`, `Lainnya`).
* **Rekap & Visualisasi:** Pengguna dapat meminta rekap pengeluaran hari ini/minggu ini/bulan ini via WA, serta melihat grafik dan total pengeluaran di Web Dashboard.

### Modul 7: Auto-Backup Database Mingguan
* **Waktu Eksekusi:** Setiap hari Minggu pukul `23:00` WIB (`0 23 * * 0`).
* **Aksi:** Bot mengirimkan file `assistant.db` sebagai dokumen langsung ke chat WhatsApp `NOMOR_UTAMA` dengan caption berisi tanggal backup dan jumlah total record tersimpan.

---

## 4. Spesifikasi Teknis & Skema Database

### 4.1 Tech Stack & Dependencies
* **Runtime:** Node.js v20+ (LTS)
* **Packages:**
  * `@whiskeysockets/baileys` & `pino` & `qrcode` (WhatsApp WebSocket & QR Generator)
  * `@google/genai` (Model: `gemini-2.5-flash` dengan `responseSchema` JSON Mode)
  * `better-sqlite3` (Database lokal ringan & cepat)
  * `express` & `multer` & `cors` (Web Server, REST API, & File Upload)
  * `node-cron` (Penjadwalan latar belakang timezone `Asia/Jakarta`)
  * `web-push` (Notifikasi pop-up sistem via Service Worker)
  * `dotenv` (Konfigurasi environment)

### 4.2 Skema SQLite (`assistant.db`)
```sql
CREATE TABLE IF NOT EXISTS jadwal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  hari TEXT,
  tanggal TEXT,
  jam TEXT NOT NULL,
  is_rutin INTEGER DEFAULT 1,
  aktif INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tugas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judul TEXT NOT NULL,
  matkul TEXT,
  deadline TEXT NOT NULL,
  selesai INTEGER DEFAULT 0,
  notif_h1 INTEGER DEFAULT 0,
  notif_h3jam INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memori_pacar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT NOT NULL,
  hari TEXT NOT NULL,
  isi TEXT NOT NULL,
  media_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS momen_wishlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipe TEXT NOT NULL,
  judul TEXT NOT NULL,
  tanggal TEXT,
  catatan TEXT,
  terpenuhi INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vault (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kata_kunci TEXT NOT NULL,
  konten TEXT NOT NULL,
  tipe TEXT DEFAULT 'LINK',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pengeluaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT NOT NULL,
  item TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  kategori TEXT DEFAULT 'Lainnya'
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT UNIQUE NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL
);
```

---

## 5. Spesifikasi Gemini AI Orchestration (`gemini.js`)

### 5.1 Multimodal Input Handling
* Jika pesan WA berisi `imageMessage`, `documentMessage`, atau `audioMessage`, unduh media menggunakan `downloadMediaMessage(msg, 'buffer', {})`.
* Kirim buffer sebagai `inlineData` (Base64 + `mimeType`) bersamaan dengan teks/caption pesan dan waktu lokal WIB saat ini (`Hari, Tanggal Bulan Tahun, HH:MM`) ke `gemini-2.5-flash`.

### 5.2 Intent Classification & JSON Schema
Gemini wajib mengembalikan JSON dengan struktur:
```json
{
  "intent": "TAMBAH_JADWAL | SNOOZE_JADWAL | TAMBAH_TUGAS | SELESAI_TUGAS | CEK_TUGAS | SIMPAN_MEMORI | CARI_MEMORI | TAMBAH_WISHLIST_MOMEN | CEK_WISHLIST_MOMEN | SIMPAN_VAULT | CARI_VAULT | CATAT_PENGELUARAN | REKAP_PENGELUARAN | OBROLAN_BIASA",
  "reply_message": "String balasan natural dalam bahasa Indonesia",
  "payload": {
    "judul": "string",
    "matkul": "string",
    "hari": "string",
    "tanggal": "YYYY-MM-DD",
    "tanggal_mulai": "YYYY-MM-DD",
    "tanggal_akhir": "YYYY-MM-DD",
    "jam": "HH:MM",
    "is_rutin": true,
    "menit_tunda": 10,
    "isi_catatan": "string",
    "kata_kunci": "string",
    "tipe_item": "WISHLIST | MOMEN | LINK | FILE",
    "expenses": [
      { "item": "string", "nominal": 0, "kategori": "string" }
    ]
  }
}
```
*Catatan Khusus `CARI_MEMORI` & `CARI_VAULT`:* Backend mengambil data yang relevan dari SQLite berdasarkan parameter `tanggal` / `kata_kunci` di `payload`, lalu memformat hasil atau melakukan panggilan kedua ke Gemini untuk menyusun jawaban akhir yang akurat berdasarkan isi database.

---

## 6. Spesifikasi Web Dashboard & Dual Notification

### 6.1 Dual-Channel Notification Engine (`notifier.js`)
Fungsi terpusat `sendDualNotification(title, body, url = '/')`:
1. **WhatsApp:** Memanggil `sock.sendMessage(NOMOR_UTAMA, { text: `*${title}*\n${body}` })` dan menyimpan `lastReminderText` di memori/database untuk mendukung fitur *Snooze*.
2. **Web Push:** Mengambil semua baris dari `push_subscriptions` dan memanggil `webpush.sendNotification(...)`. Jika endpoint mengembalikan HTTP `410 Gone` atau `404`, hapus subscription tersebut dari database secara otomatis.

### 6.2 Antarmuka Web Dashboard (`public/`)
* **Desain:** Modern, bersih, responsif (*mobile-first* agar nyaman dibuka di HP maupun desktop), menggunakan *dark/light mode* elegan dengan navigasi tab:
  1. **Overview & Status Bot:** Indikator status koneksi WA (`Connected` / `Disconnected`), tampilan QR Code dinamis (via DataURL) jika WA belum login, tombol *"Aktifkan Notifikasi Browser"*, dan ringkasan hari ini.
  2. **Jadwal & Presensi:** Tabel jadwal mingguan + form tambah/edit/hapus + toggle aktif/nonaktif.
  3. **Tugas & Deadline:** Daftar tugas dengan badge hitung mundur (*countdown*), filter (Aktif / Selesai), tombol centang selesai, dan form tambah manual.
  4. **Brankas Memori & Wishlist:** Tampilan *timeline*/kalender catatan aktivitas pacar, *search bar* kata kunci/tanggal, galeri foto terlampir, serta daftar *Wishlist* & *Countdown Momen Spesial*.
  5. **Quick Vault:** Daftar link & file tersimpan dengan tombol *Copy Link* dan *Download File*.
  6. **Keuangan:** Ringkasan total pengeluaran hari ini & bulan ini, grafik kategori sederhana (Chart.js via CDN), dan tabel riwayat transaksi.
* **PWA & Service Worker (`sw.js` & `manifest.json`):** Mendukung instalasi ke Desktop/Home Screen dan menangani event `push` serta `notificationclick` agar notifikasi pop-up tetap muncul saat browser tertutup.

---

## 7. Struktur Direktori Proyek & Endpoint REST API

### 7.1 Struktur File
```text
personal-assistant/
├── .env
├── .gitignore
├── package.json
├── assistant.db              # Auto-generated SQLite file
├── auth_info_baileys/        # Auto-generated WA session folder
├── uploads/                  # Folder penyimpanan file Vault & gambar Memori
├── src/
│   ├── config/
│   │   └── db.js             # Inisialisasi SQLite & Helper Queries
│   ├── services/
│   │   ├── gemini.js         # Integrasi @google/genai & JSON Schema
│   │   ├── whatsapp.js       # Koneksi Baileys, Whitelist, & Media Downloader
│   │   ├── notifier.js       # Dual Notification (WA + Web Push)
│   │   └── scheduler.js      # Cron jobs (Presensi, Tugas, Briefing, Backup)
│   ├── routes/
│   │   └── api.js            # REST API CRUD untuk Web Dashboard
│   └── app.js                # Entry point Express + Inisialisasi Bot & Cron
└── public/
    ├── index.html
    ├── manifest.json
    ├── sw.js
    ├── css/
    │   └── style.css
    └── js/
        └── app.js
```

### 7.2 Daftar Endpoint REST API (`/api/...`)
* `GET /api/status` — Status koneksi WA, QR Code DataURL (jika belum login), dan statistik ringkas.
* `POST /api/push/subscribe` — Menyimpan objek `PushSubscription` dari browser ke SQLite.
* `GET /api/push/vapid-key` — Mengembalikan `VAPID_PUBLIC_KEY` ke frontend.
* `GET/POST/PUT/DELETE /api/jadwal` — CRUD jadwal kuliah & presensi.
* `GET/POST/PATCH/DELETE /api/tugas` — CRUD tugas & toggle status selesai.
* `GET/POST/DELETE /api/memori` — Query (by tanggal/keyword) & CRUD catatan pacar (mendukung `multipart/form-data` untuk upload foto).
* `GET/POST/PATCH/DELETE /api/wishlist` — CRUD wishlist & momen spesial.
* `GET/POST/DELETE /api/vault` — CRUD link & upload file dokumen.
* `GET/POST/DELETE /api/pengeluaran` — CRUD pengeluaran & agregasi total per kategori/bulan.

---

## 8. Kriteria Penerimaan & Deployment (Acceptance Criteria)
1. **Zero-Leak Security:** Pesan dari nomor selain `NOMOR_UTAMA` tidak menghasilkan respons WA dan tidak memicu panggilan ke Gemini API.
2. **Multimodal Accuracy:** Mengirim teks, foto/screenshot jadwal, dokumen PDF tugas, atau *voice note* ke bot berhasil disimpan ke tabel SQLite yang sesuai dalam waktu kurang dari 8 detik.
3. **Background Reliability:** Aplikasi dapat dijalankan menggunakan `pm2 start src/app.js --name "personal-assistant"` dan otomatis menyala saat sistem booting tanpa memunculkan jendela terminal.
4. **Dual Notification Verified:** Saat waktu jadwal/deadline tercapai (dan tab browser tertutup), pesan masuk ke WhatsApp pengguna **DAN** notifikasi pop-up sistem muncul di Windows/Android melalui Service Worker.