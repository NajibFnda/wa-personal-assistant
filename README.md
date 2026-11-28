# All-in-One Personal Assistant

Asisten pribadi multimodal 24/7 berbasis **WhatsApp Bot (`@whiskeysockets/baileys` v7)** + **Dual AI Orchestrator (`gemini-3.8-flash` & Groq `qwen/qwen3.8-27b` + Groq Whisper `whisper-large-v3-turbo`)** + **SQLite WAL (`better-sqlite3`)** + **PWA Web Dashboard bertema macOS Sonoma (Light & Dark Mode)** + **Dering Keras HP (`ntfy` Urgent Priority 5)**.

---

## Arsitektur & Highlight Utama

- **Triple-Layer Processing:**
  1. **0ms Slash Commands & Local Fast-Path** — perintah deterministik diproses instan tanpa latensi jaringan.
  2. **Groq Primary + Whisper STT** — respon super cepat (`< 1 detik`) dan transkripsi Voice Note akurat (`whisper-large-v3-turbo`).
  3. **Google Gemini (`gemini-3.8-flash`)** — multimodal native (PDF, gambar/struk/KRS, teks) dengan hedged fallback chain otomatis & pencatatan telemetri ke SQLite.
- **Zero-Leak Single-User Security:**
  - Strict whitelist hanya untuk `NOMOR_UTAMA` (`fromMe === false`); seluruh pesan grup, broadcast, newsletter, dan nomor asing langsung diabaikan (*Silent Drop*).
  - Pengecualian sempit *zero-leak* hanya aktif untuk menerima balasan `"ok"` dari nomor tujuan yang sedang memiliki alarm aktif (`outbound_pending`), tanpa pernah membuka akses AI atau data pribadi pemilik.
  - Opsional kunci akses Web Dashboard dengan `WEB_PIN` (`HttpOnly` cookie) + **Security Audit Logs** (IP, perkiraan lokasi, perangkat, dan notifikasi WA saat PIN salah).
- **Web Dashboard PWA (macOS Sonoma Light & Dark Mode):**
  - Desain bersih ala **macOS Sonoma** lengkap dengan toggle **Mode Terang / Gelap** di top bar (persisten via `localStorage`).
  - **Zero-Emoji Policy** di seluruh antarmuka web — 100% menggunakan ikon vektor **Lucide Icons** (`stroke-width: 1.75px`).
  - **Sinkronisasi Real-Time (SSE)** antara WhatsApp, Scheduler, dan Web Dashboard + **OS Web Push Notification** via Service Worker.

---

## Fitur Lengkap

### 1. Jadwal Kuliah, Presensi Berulang (`ok`), & Alarm Biasa
- **Pemisahan Otomatis Presensi vs Alarm Biasa:** AI (`is_presensi`) dan fast-path otomatis membedakan:
  - **Mode Presensi** (kuliah, matkul, praktikum, kelas, KRS): mengirim pengingat berulang setiap **20 menit** (interval dapat diatur `1–180` menit) sampai kamu membalas **`ok`** (atau `/ok` / klik tombol di Dashboard).
  - **Alarm Biasa** (kegiatan pribadi, rapat, eksperimen, bangun pagi): berbunyi **1 kali** saja pada waktunya (tetap mendukung Snooze `"tunda 10 menit"` / `/s 10`).
- Mendukung input teks santai, voice note, maupun **screenshot KRS** (multi-jadwal sekaligus).
- **Calendar Sync (`.ics` Feed):** Endpoint RFC 5545 (`/api/calendar.ics?token=...`, timezone `Asia/Jakarta`) untuk sinkronisasi otomatis jadwal aktif & deadline tugas ke **Apple Calendar (iOS)** dan **Google Calendar**.

### 2. Alarm ke Nomor Lain (Kirim Sampai Penerima Balas `"ok"`)
- Suruh bot mengirim pengingat ke nomor WA lain (misal pacar, teman, keluarga, atau HP kedua) melalui bahasa natural, slash command, maupun Web Dashboard (**Tab Jadwal Presensi → Alarm ke Nomor Lain**).
- **Manajemen Kontak Alias:** Simpan nomor tujuan dengan nama alias (misal `pacar`, `yuna`) agar cukup menyebut namanya di chat (`"kirim alarm ke pacarku dengan pesan 'bangun' tiap pagi jam 6 sampai dibalas ok, interval pengulangan 15 menit"`).
- **4 Mode Jadwal:** *Setiap Hari (Harian)*, *Rutin Mingguan*, *Sekali Jalan (Tanggal & Jam)*, atau *Kirim Langsung Sekarang*.
- **Pengulangan Fleksibel & Aman:** Interval bisa diatur (`2–180` menit), batas maksimal pengulangan (`1–60` kali), tombol **Kirim Sekarang** & **Stop Manual**, serta laporan otomatis ke WA pemilik begitu penerima membalas `"ok"`.

### 3. Mode Dering Keras HP (`ntfy` Urgent Priority 5 & `[ALARM-RING]`)
- Agar HP Android berdering keras terus-menerus seperti ditelepon (tembus mode silent/DND) tanpa berisiko banned WA:
  - Terintegrasi langsung dengan aplikasi open-source **`ntfy`** (`https://ntfy.sh`, topik rahasia otomatis dibuat per server, dikirim dengan `Priority: 5 / Urgent`).
  - Juga menyematkan tag `[ALARM-RING]` di baris pertama pesan WA jika ingin dipasangkan dengan aplikasi otomatisasi Android.
- **Kontrol Per-Alarm lewat Bahasa Natural:** Cukup selipkan kata **`ring`**, **`dering keras`**, **`telpon`**, **`call`**, atau **`bangunin`** (contoh: *"Ingatkan aku jam 2 siang pakai ring"* atau *"Telpon aku besok jam 5 pagi bangun tidur"*).
- Pengaturan global (Presensi, Alarm Biasa, Pengingat Cepat, Deadline Mendesak) & tombol **Salin Topik `ntfy`** / **Test Dering (5 Detik)** tersedia di Dashboard maupun perintah `/ntfy` dan `/ring [detik]`.

### 4. Tugas & Deadline Tracker (Anti-SKS)
- Ekstrak tugas dari teks, copy-paste pengumuman grup, screenshot, voice note, atau PDF.
- Pengingat ganda otomatis yang bisa diatur waktunya (default **H-24 Jam** & **H-3 Jam** sebelum deadline) + tandai selesai langsung via chat (*"tugas Kriptografi udah kelar"* atau `/td`).

### 5. Catatan Kuliah & Ide (Voice-to-Notes)
- Kirim **Voice Note**, foto papan tulis/slide, atau teks panjang (*"Rangkumin jadi catatan kuliah Kriptografi"*) → otomatis ditranskrip via **Groq Whisper** lalu dirangkum menjadi poin-poin terstruktur ke tabel `catatan_kuliah`.
- Pencarian catatan via WA (*"Cari catatan kuliah Kriptografi tentang enkripsi"*, `/n cari ...`) dan tampilan **Bento Grid** dengan filter kategori & modal baca rapi di tab **Catatan**.

### 6. Brankas Memori, Wishlist, Momen Spesial & Smart Date/Gift Assistant
- Timeline catatan keseharian pacar lengkap dengan **deskripsi tambahan**, **galeri foto** (lightbox zoom), dan pencarian berbasis tanggal relatif (*"Minggu kemarin hari Selasa dia ngelakuin apa?"*).
- **Momen Spesial** dengan pola pengulangan fleksibel (**Tahunan**, **Bulanan / Mensiversary**, **Sekali Saja**) serta hari/jam notifikasi kustom (default `H-7, H-3, H-1` pukul `08:00 WIB`).
- **Smart Date & Gift Assistant:** Menganalisis **15 memori terbaru** (menghindari tempat kencan yang baru dikunjungi) & seluruh **wishlist belum terpenuhi** beserta batas budget (*"Kasih rekomendasi kado buat dia di bawah 200rb"*, *"Weekend ini enaknya ngajak dia ke mana?"*, atau lewat kartu asisten di Dashboard).
- **Rekap Memori Bulanan Otomatis** saat momen bulanan tiba atau on-demand via `/rekappacar`.

### 7. Quick Vault (Link, Catatan, & Dokumen)
- Simpan, cari, dan ubah nama link presensi/Zoom/Drive, teks catatan, maupun file dokumen (`PDF`, `DOCX`, `XLSX`, `ZIP`, gambar, audio) lewat WhatsApp maupun Web Dashboard.
- AI otomatis membuatkan judul rapi jika caption hanya *"simpan ini"*, dan mendukung pratinjau langsung di modal web.

### 8. Keuangan Lengkap (Pemasukan, Pengeluaran, Budget, & Export CSV)
- Catat pengeluaran (*"Makan siang 18rb, bensin 25rb"*, foto struk belanja, `/k`) dan pemasukan (*"Dapat uang saku 500rb"*, *"masuk 20k"*, `/pm`).
- Rekap saldo bersih harian/mingguan/bulanan (`/rk`), ring chart SVG native (tanpa Chart.js), batas **Budget Bulanan & Per-Kategori** dengan peringatan otomatis di **80% & 100%**, serta **Export CSV**.

### 9. Produktivitas Harian, Telemetri AI, & Utilitas
- **System & AI Telemetry Widget (Overview):** Pantau kuota & latensi harian **Gemini vs Groq**, status fallback terakhir, uptime server, penggunaan RAM, ukuran `assistant.db`, serta tombol **Test AI Engine**.
- **Habit Tracker:** Checklist harian dengan visualisasi 56-day streak grid & pengingat malam pukul `21:00 WIB` (`/h`).
- **Focus / Pomodoro Timer:** Timer fokus tersinkronisasi antara WA (`/fokus 25 belajar PCD`) & Dashboard.
- **Pengingat Cepat (`/r`):** Pengingat berbasis durasi (*"ingetin 30 menit lagi matiin kompor pakai ring"* atau `/r 30m angkat jemuran ring`).
- **Global Spotlight Search (`Ctrl + K` / `Cmd + K`):** Pencarian instan lintas seluruh modul.
- **Morning Briefing Otomatis** (default `06:00 WIB`) & **Auto-Backup `assistant.db` Mingguan** langsung ke WhatsApp (default Minggu `23:00 WIB`).

---

## Daftar Perintah Cepat WhatsApp (0ms Slash Commands)

| Modul | Perintah | Fungsi |
| :--- | :--- | :--- |
| **Bantuan** | `/help` atau `/menu` | Menampilkan daftar seluruh perintah cepat |
| **Jadwal & Presensi** | `/j` | Lihat jadwal aktif hari ini |
| | `/j <hari/YYYY-MM-DD> <HH:MM> <nama> [ring]` | Tambah jadwal rutin/sekali jalan (opsional `ring`) |
| | `/ok` _(atau balas `ok`)_ | Hentikan pengingat presensi berulang (tiap 20m) |
| | `/s <menit>` | Snooze pengingat terakhir |
| **Dering Keras (`ntfy`)** | `/ntfy` | Lihat topik rahasia & panduan pasang `ntfy` di Android |
| | `/ring [detik]` | Tes dering keras HP (`ntfy` Urgent + `[ALARM-RING]`) |
| **Alarm Nomor Lain** | `/kontak` / `/kontak <nama> <nomor>` | Lihat atau simpan kontak alias tujuan |
| | `/kirim` | Lihat jadwal & antrean alarm nomor lain yang aktif |
| | `/kirim <kontak/no> <sekarang\|harian\|hari\|YYYY-MM-DD> [HH:MM] \| <pesan> [\| interval_m] [\| max]` | Kirim / jadwalkan alarm ke nomor lain sampai balas `ok` |
| | `/stopkirim [kontak/no]` | Hentikan alarm berulang ke nomor lain secara manual |
| **Tugas** | `/t` | Lihat semua tugas aktif |
| | `/t <YYYY-MM-DD> [HH:MM] <matkul> \| <judul>` | Tambah tugas baru |
| | `/td <kata kunci>` | Tandai tugas selesai |
| **Catatan Kuliah** | `/n` / `/n cari <topik>` | Lihat daftar atau cari catatan kuliah & ide |
| | `/n <Kategori> \| <Judul> \| <Ringkasan>` | Tambah catatan manual |
| **Memori & Pacar** | `/p <cerita> [\| deskripsi]` | Catat memori pacar (bisa + foto atau awali `YYYY-MM-DD`) |
| | `/cp [kata kunci / tanggal]` | Cari catatan memori pacar |
| | `/w` / `/w <judul> [\| deskripsi]` | Lihat atau tambah wishlist |
| | `/m` / `/m <YYYY-MM-DD> <judul> [bulanan\|tahunan\|sekali]` | Lihat atau tambah momen spesial |
| | `/ide [kado\|date]` & `/rekappacar` | Rekomendasi AI & rekap memori 30 hari |
| **Quick Vault** | `/v` / `/v <kata kunci>` / `/v <kata kunci> \| <isi>` | Lihat, ambil, atau simpan link/teks/file |
| | `/rv [nama lama \|] <nama baru>` | Ubah nama item di Quick Vault |
| **Keuangan** | `/k <item> <nominal>, ...` | Catat pengeluaran |
| | `/pm <sumber> <nominal>, ...` | Catat pemasukan |
| | `/rk [hari\|minggu\|bulan]` | Rekap keuangan & saldo bersih |
| **Produktivitas** | `/r <30m\|2j> <pesan> [ring]` | Pengingat cepat berbasis durasi |
| | `/h` / `/h + <nama>` / `/h <kata kunci>` | Habit tracker & check-in harian |
| | `/fokus [menit] [topik]` / `/fokus stop` | Mulai atau hentikan sesi Pomodoro |
| **Utilitas** | `/log`, `/briefing`, `/backup` | Log keamanan web, kirim Morning Briefing, kirim backup DB |

---

## Struktur Proyek

```text
├── public/
│   ├── css/style.css          # Tema macOS Sonoma Light & Dark Mode (Zero-Emoji)
│   ├── js/app.js              # SPA Dashboard, SSE Live Sync, Web Push, CRUD UI
│   ├── index.html             # Layout Bento Grid, Segmented Control & Modals
│   ├── manifest.json          # Konfigurasi PWA
│   └── sw.js                  # Service Worker (caching + OS Web Push handler)
├── src/
│   ├── config/db.js           # Skema SQLite WAL, migrasi non-destruktif & repository
│   ├── routes/api.js          # REST API (/api/*), PIN auth, SSE, .ics feed, upload
│   ├── services/
│   │   ├── audit.js           # Security & access audit logger + GeoIP lookup
│   │   ├── budget.js          # Pengecekan threshold budget bulanan (80% & 100%)
│   │   ├── calendar.js        # Generator feed iCalendar (.ics) RFC 5545 (WIB)
│   │   ├── commands.js        # 0ms WhatsApp slash command router
│   │   ├── events.js          # Event bus untuk SSE real-time push
│   │   ├── gemini.js          # Dual AI orchestrator (Gemini 3.8 Flash + Groq + Whisper + Fast-Path)
│   │   ├── notifier.js        # Engine notifikasi (WhatsApp + Web Push + ntfy Urgent + Target WA)
│   │   ├── scheduler.js       # Cron job (jadwal, presensi 20m, outbound alarm, tugas, momen, briefing, backup)
│   │   └── whatsapp.js        # Baileys v7 socket, single-user whitelist, intent executor & target OK handler
│   ├── utils/time.js          # Helper waktu WIB (Asia/Jakarta)
│   └── app.js                 # Entry point Express + Scheduler + WhatsApp
├── tests/
│   └── verify.test.js         # 12 end-to-end automated test suites (isolated temp DB)
├── ecosystem.config.cjs       # Konfigurasi PM2 24/7
├── .env.example               # Template environment variables
└── package.json
```

---

## Konfigurasi (`.env`)

Salin `.env.example` menjadi `.env`, lalu sesuaikan nilainya:

```env
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
GROQ_API_KEY=your_groq_api_key_here
GEMINI_MODEL=gemini-3.8-flash
NOMOR_UTAMA=6281234567890
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@localhost
WEB_PIN=
CALENDAR_TOKEN=
NTFY_TOPIC=
```

- `NOMOR_UTAMA`: Nomor WA pemilik dalam format internasional tanpa `+` atau spasi (contoh: `6281234567890`).
- `GROQ_API_KEY`: Sangat disarankan agar respon teks `< 1 detik` dan Voice Note ditranskrip cepat via Whisper.
- `WEB_PIN`: Opsional. Jika diisi, Web Dashboard dan seluruh `/api/*` terkunci dengan layar PIN.
- `CALENDAR_TOKEN` & `NTFY_TOPIC`: Opsional. Jika dikosongkan, sistem otomatis menghasilkan token & topik acak yang aman dan menyimpannya permanen di SQLite.
- Generate pasangan VAPID keys baru dengan: `npm run generate-vapid`.

---

## Cara Menjalankan

### 1. Lokal / Pengembangan
```bash
npm install
npm start
```
Buka `http://localhost:3000`, pindai QR Code WhatsApp melalui menu **Perangkat Tertaut → Tautkan Perangkat** pada nomor khusus bot, lalu klik **Aktifkan Notifikasi**.

### 2. Produksi 24/7 (Linux VPS / Azure VM + PM2 + Caddy HTTPS)
```bash
npm install --omit=dev
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```
> Disarankan menggunakan **Caddy** sebagai reverse proxy HTTPS otomatis agar **PWA** dan **Web Push Notification** aktif penuh (pastikan `encode zstd gzip` mengecualikan endpoint SSE `/api/events`).

### 3. Setup Dering Keras HP (`ntfy` — 30 Detik di Android)
1. Kirim `/ntfy` ke bot WhatsApp (atau buka Dashboard → **Atur Waktu Notif**) untuk menyalin **Topik Rahasia `ntfy`**.
2. Install aplikasi **ntfy** (gratis & open-source) di Play Store → tap **`+`** → tempel topik rahasia → **Subscribe**.
3. Di menu **Settings** aplikasi `ntfy`, aktifkan **Keep alerting for highest priority** & **Instant delivery**, serta matikan pembatasan baterai (*No restrictions* + *Autostart*).
4. Uji dengan mengirim `/ring 5` di WhatsApp lalu kunci layar HP.

---

## Pengujian Otomatis

Seluruh 12 suite pengujian berjalan pada database SQLite sementara yang terisolasi (tidak menyentuh `assistant.db` produksi):

```bash
npm test
```

Mencakup pengujian Strict Whitelist & Silent Drop, Jadwal/Presensi berulang 20m & pemisahan Alarm Biasa, Tugas Anti-SKS, Memori & Wishlist/Momen, Morning Briefing/Vault/Keuangan/Backup, SSE & `WEB_PIN`, Slash Commands, Power Features (Budget/CSV/Habits/Focus/Spotlight), Study Notes/AI Telemetry/Smart Date & Gift/Calendar `.ics`, Zero-Emoji Frontend Policy, Dering Keras (`ntfy` Priority 5 + `[ALARM-RING]`), serta Alarm ke Nomor Lain (*repeat-until-ok* & Zero-Leak).
