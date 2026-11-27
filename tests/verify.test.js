import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

// Isolate test database & uploads so tests NEVER touch the user's real assistant.db
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-test-'));
process.env.DB_PATH = path.join(TEST_DIR, 'test-assistant.db');
process.env.UPLOADS_DIR = path.join(TEST_DIR, 'uploads');
process.env.NOMOR_UTAMA = '6281234567890';
process.env.WEB_PIN = '';
process.env.GEMINI_API_KEY = '';

let createApp;
let createConsistentBackup;
let db;
let getDatabaseStats;
let jadwalRepo;
let memoriRepo;
let pushRepo;
let settingsRepo;
let tugasRepo;
let vaultRepo;
let getLastReminder;
let initWebPush;
let registerWhatsAppSender;
let checkSchedules;
let checkSpecialMoments;
let checkTaskDeadlines;
let runMorningBriefing;
let executeIntent;
let isAllowedSender;
let getWibParts;
let shiftDateStr;

describe('All-in-One Personal Assistant End-to-End Verification (Isolated Test DB)', () => {
  let server;
  let baseUrl;
  const sentWaMessages = [];

  before(async () => {
    const appMod = await import('../src/app.js');
    const dbMod = await import('../src/config/db.js');
    const notifMod = await import('../src/services/notifier.js');
    const schedMod = await import('../src/services/scheduler.js');
    const waMod = await import('../src/services/whatsapp.js');
    const timeMod = await import('../src/utils/time.js');

    createApp = appMod.createApp;
    ({
      createConsistentBackup,
      db,
      getDatabaseStats,
      jadwalRepo,
      memoriRepo,
      pushRepo,
      settingsRepo,
      tugasRepo,
      vaultRepo,
    } = dbMod);
    ({ getLastReminder, initWebPush, registerWhatsAppSender } = notifMod);
    ({ checkSchedules, checkSpecialMoments, checkTaskDeadlines, runMorningBriefing } = schedMod);
    ({ executeIntent, isAllowedSender } = waMod);
    ({ getWibParts, shiftDateStr } = timeMod);

    initWebPush();
    registerWhatsAppSender(async (text) => {
      sentWaMessages.push(text);
    });

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('1. Strict Single-User Whitelist & Silent Drop (Zero-Leak Security)', () => {
    const owner = '6281234567890';
    assert.equal(
      isAllowedSender({ remoteJid: '6281234567890@s.whatsapp.net', fromMe: false }, owner),
      true
    );
    assert.equal(
      isAllowedSender({ remoteJid: '6281234567890@s.whatsapp.net', fromMe: true }, owner),
      false
    );
    assert.equal(
      isAllowedSender({ remoteJid: '6289999999999@s.whatsapp.net', fromMe: false }, owner),
      false
    );
    assert.equal(
      isAllowedSender({ remoteJid: '12036301234567@g.us', fromMe: false }, owner),
      false
    );
    assert.equal(
      isAllowedSender({ remoteJid: 'status@broadcast', fromMe: false }, owner),
      false
    );
    assert.equal(
      isAllowedSender(
        {
          remoteJid: '9988776655@lid',
          remoteJidAlt: '6281234567890@s.whatsapp.net',
          fromMe: false,
        },
        owner
      ),
      true
    );
    assert.equal(
      isAllowedSender(
        {
          remoteJid: '9988776655@lid',
          remoteJidAlt: '6289999999999@s.whatsapp.net',
          fromMe: false,
        },
        owner
      ),
      false
    );
  });

  it('2. Modul 1: Jadwal Kuliah, Presensi, Scheduler Trigger, Auto-Deactivate & Snooze', async () => {
    const fixedNow = new Date('2026-11-24T07:50:00+07:00');
    const wib = getWibParts(fixedNow);
    assert.equal(wib.hari, 'Selasa');

    const addRes = await executeIntent({
      result: {
        intent: 'TAMBAH_JADWAL',
        reply_message: 'Siap, jadwal dicatat!',
        payload: {
          schedules: [
            { judul: 'Presensi Sistem Terdistribusi', hari: 'Selasa', jam: '07:50', is_rutin: true },
            { judul: 'Bimbingan Skripsi', tanggal: '2026-11-24', jam: '07:50', is_rutin: false },
          ],
        },
      },
      now: fixedNow,
    });
    assert.match(addRes.text, /Jadwal Tersimpan \(2\)/);

    const beforeCount = sentWaMessages.length;
    assert.equal(await checkSchedules(fixedNow), 2);
    assert.equal(sentWaMessages.length, beforeCount + 2);
    assert.equal(await checkSchedules(fixedNow), 0);

    const allJadwal = jadwalRepo.list();
    assert.equal(allJadwal.find((j) => j.nama === 'Presensi Sistem Terdistribusi').aktif, 1);
    assert.equal(allJadwal.find((j) => j.nama === 'Bimbingan Skripsi').aktif, 0);

    assert.ok(getLastReminder()?.activityName);
    const snoozeRes = await executeIntent({
      result: {
        intent: 'SNOOZE_JADWAL',
        reply_message: 'Oke ditunda.',
        payload: { menit_tunda: 10 },
      },
      now: fixedNow,
    });
    assert.match(snoozeRes.text, /08:00 WIB/);
  });

  it('3. Modul 2: Task & Deadline Tracker (Anti-SKS H-24h & H-3h + Complete via WA)', async () => {
    const now = new Date('2026-11-24T10:00:00+07:00');

    await executeIntent({
      result: {
        intent: 'TAMBAH_TUGAS',
        reply_message: 'Dicatat!',
        payload: {
          judul: 'Laporan Kriptografi RSA',
          matkul: 'Kriptografi',
          tanggal: '2026-11-24',
          jam: '22:00',
        },
      },
      now,
    });

    await executeIntent({
      result: {
        intent: 'TAMBAH_TUGAS',
        reply_message: 'Dicatat!',
        payload: {
          judul: 'Quiz Jaringan Komputer',
          matkul: 'Jarkom',
          tanggal: '2026-11-24',
          jam: '12:00',
        },
      },
      now,
    });

    assert.equal(await checkTaskDeadlines(now), 2);
    assert.equal(await checkTaskDeadlines(now), 0);

    const doneRes = await executeIntent({
      result: {
        intent: 'SELESAI_TUGAS',
        reply_message: 'Keren!',
        payload: { matkul: 'Kriptografi' },
      },
      rawText: 'Tugas Kriptografi udah kelar',
      now,
    });
    assert.match(doneRes.text, /SELESAI/);

    const cekRes = await executeIntent({
      result: { intent: 'CEK_TUGAS', reply_message: '', payload: {} },
      now,
    });
    assert.match(cekRes.text, /Quiz Jaringan Komputer/);
    assert.doesNotMatch(cekRes.text, /Laporan Kriptografi RSA/);
  });

  it('4. Modul 3: Brankas Memori + Deskripsi, Wishlist, & Custom Notification Timing', async () => {
    const morningNow = new Date('2026-11-24T07:30:00+07:00');
    const eveningNow = new Date('2026-11-24T19:30:00+07:00');
    const todayStr = getWibParts(morningNow).dateStr;
    const inTenDays = shiftDateStr(todayStr, 10);

    // Save memory with deskripsi & edit via API
    const createdMem = await fetch(`${baseUrl}/api/memori`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tanggal: '2026-11-21',
        isi: 'Menang lomba drama di sekolah',
        deskripsi: 'Suasananya meriah banget, dia dapat piala juara 1.',
      }),
    });
    assert.equal(createdMem.status, 201);
    const memObj = await createdMem.json();
    assert.equal(memObj.deskripsi, 'Suasananya meriah banget, dia dapat piala juara 1.');

    // Update deskripsi via PUT /api/memori/:id
    const updMem = await fetch(`${baseUrl}/api/memori/${memObj.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deskripsi: 'Ditambah traktir es matcha setelah pengumuman juara 1.',
      }),
    });
    assert.equal(updMem.status, 200);
    assert.match((await updMem.json()).deskripsi, /es matcha/);

    // Search memori by keyword inside deskripsi
    const searchRes = await fetch(`${baseUrl}/api/memori?q=matcha`);
    const searchRows = await searchRes.json();
    assert.equal(searchRows.length, 1);

    // Create MOMEN with custom notif_days = [10, 1] and custom notif_jam = '19:30'
    const momenRes = await fetch(`${baseUrl}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipe: 'MOMEN',
        judul: 'Anniversary Spesial',
        tanggal: inTenDays,
        catatan: 'Booking makan malam romantis',
        notif_days: [10, 1],
        notif_jam: '19:30',
      }),
    });
    assert.equal(momenRes.status, 201);
    const momenObj = await momenRes.json();
    assert.deepEqual(momenObj.effective_notif_days, [10, 1]);
    assert.equal(momenObj.effective_notif_jam, '19:30');

    // At 07:30 WIB -> should NOT trigger because custom notif_jam is 19:30
    assert.equal(await checkSpecialMoments(morningNow), 0);
    // At 19:30 WIB -> SHOULD trigger H-10!
    assert.equal(await checkSpecialMoments(eveningNow), 1);
    // Deduplicated on second check
    assert.equal(await checkSpecialMoments(eveningNow), 0);

    // Monthly recurrence (BULANAN): Tanggal Pacaran 2026-09-24 -> on 2026-11-23 is H-1 (Bulan ke-2), rolls to 2026-12-24 on 2026-11-25
    const monthlyRes = await fetch(`${baseUrl}/api/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipe: 'MOMEN',
        judul: 'Mensiversary Tanggal 24',
        tanggal: '2026-09-24',
        ulang: 'BULANAN',
        notif_days: [1, 0],
        notif_jam: '08:00',
      }),
    });
    assert.equal(monthlyRes.status, 201);
    const nov23Morning = new Date('2026-11-23T08:05:00+07:00');
    const nov25Morning = new Date('2026-11-25T08:05:00+07:00');
    const dec23Morning = new Date('2026-12-23T08:05:00+07:00');
    assert.equal(await checkSpecialMoments(nov23Morning), 1);
    assert.equal(await checkSpecialMoments(nov23Morning), 0); // deduplicated in Nov
    assert.equal(await checkSpecialMoments(nov25Morning), 0); // not yet H-1 for Dec
    assert.equal(await checkSpecialMoments(dec23Morning), 1); // fires again automatically next month!

    // Month-end clamping check: 31st in February 2026 -> 2026-02-28
    const { getDaysUntilMoment } = await import('../src/utils/time.js');
    const febCheck = getDaysUntilMoment('2026-01-31', new Date('2026-02-20T09:00:00+07:00'), 'BULANAN');
    assert.equal(febCheck.nextDate, '2026-02-28');
    assert.equal(febCheck.daysUntil, 8);

    // Update global notification settings via API
    const setRes = await fetch(`${baseUrl}/api/settings/notifications`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        momentDefaultDays: [14, 7, 3, 1, 0],
        momentDefaultTime: '09:15',
        morningBriefingEnabled: true,
        morningBriefingTime: '06:30',
        taskFirstReminderHours: 36,
        taskSecondReminderHours: 4,
        weeklyBackupEnabled: true,
        weeklyBackupDay: 6,
        weeklyBackupTime: '22:00',
      }),
    });
    assert.equal(setRes.status, 200);
    const savedSettings = await setRes.json();
    assert.deepEqual(savedSettings.momentDefaultDays, [14, 7, 3, 1, 0]);
    assert.equal(savedSettings.momentDefaultTime, '09:15');
    assert.equal(settingsRepo.getNotificationSettings().morningBriefingTime, '06:30');
  });

  it('5. Modul 4, 5, 6 & 7: Morning Briefing, Quick Vault, Expenses & DB Backup', async () => {
    const now = new Date('2026-11-24T06:00:00+07:00');
    const briefing = await runMorningBriefing(now);
    assert.match(briefing.title, /Morning Briefing/);

    await executeIntent({
      result: {
        intent: 'SIMPAN_VAULT',
        reply_message: 'Tersimpan!',
        payload: {
          tipe_item: 'LINK',
          kata_kunci: 'link presensi kripto',
          isi_catatan: 'https://presensi.kampus.ac.id/kripto',
        },
      },
      now,
    });

    const getLink = await executeIntent({
      result: { intent: 'CARI_VAULT', reply_message: '', payload: { kata_kunci: 'presensi kripto' } },
      now,
    });
    assert.match(getLink.text, /https:\/\/presensi\.kampus\.ac\.id\/kripto/);

    // Verify caption fallback when Gemini omits payload.kata_kunci for image vault upload
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const imgVault = await executeIntent({
      result: { intent: 'SIMPAN_VAULT', reply_message: 'Tersimpan!', payload: {} },
      rawText: 'simpan ini, pengumpulan paper',
      mediaBuffer: fakeJpg,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      now,
    });
    assert.match(imgVault.text, /pengumpulan paper/i);
    assert.doesNotMatch(imgVault.text, /Item Vault/);

    const fetchImgVault = await executeIntent({
      result: { intent: 'CARI_VAULT', reply_message: '', payload: { kata_kunci: 'pengumpulan paper' } },
      now,
    });
    assert.ok(fetchImgVault.imagePath && fs.existsSync(fetchImgVault.imagePath));

    const listAllVault = await executeIntent({
      result: { intent: 'CARI_VAULT', reply_message: '', payload: { kata_kunci: 'SEMUA' } },
      rawText: 'lihat semua isi vault',
      now,
    });
    assert.match(listAllVault.text, /Daftar Isi Quick Vault/);

    // Verify fast-path rename ("ubah nama di vault ini menjadi deca"), quoted content extraction, and AI title delegation
    const { tryLocalFastIntent } = await import('../src/services/gemini.js');

    // Bare "simpan ini" + media or 'simpan ini "..."' without title should return null so Gemini AI proactively invents a smart title
    assert.equal(tryLocalFastIntent({ text: 'simpan ini', hasMedia: true, now }), null);
    assert.equal(tryLocalFastIntent({ text: 'simpan ini "great of the fireflies"', hasMedia: false, now }), null);

    // Explicit title + quoted content should extract clean title & ONLY quoted content (0ms)
    const quotedFast = tryLocalFastIntent({
      text: 'simpan judul anime ini "great of the fireflies"',
      hasMedia: false,
      now,
    });
    assert.equal(quotedFast.intent, 'SIMPAN_VAULT');
    assert.equal(quotedFast.payload.kata_kunci, 'Judul Anime');
    assert.equal(quotedFast.payload.isi_catatan, 'great of the fireflies');

    // Even when Gemini leaves payload empty, executeIntent strips command words and extracts ONLY quoted content
    const quotedExec = await executeIntent({
      result: { intent: 'SIMPAN_VAULT', reply_message: 'Tersimpan!', payload: {} },
      rawText: 'simpan judul anime ini "great of the fireflies"',
      now,
    });
    assert.match(quotedExec.text, /\*Judul Anime\*/);
    const savedQuoteRow = vaultRepo.search('Judul Anime')[0];
    assert.equal(savedQuoteRow.kata_kunci, 'Judul Anime');
    assert.equal(savedQuoteRow.konten, 'great of the fireflies');

    // Add second "Anime" item and verify "liat anime" hits 0ms fast-path and lists BOTH items
    const secondAnime = tryLocalFastIntent({ text: 'simpan anime "kimi no nawa"', hasMedia: false, now });
    assert.equal(secondAnime.intent, 'SIMPAN_VAULT');
    await executeIntent({ result: secondAnime, rawText: 'simpan anime "kimi no nawa"', now });

    const liatAnimeFast = tryLocalFastIntent({ text: 'liat anime', hasMedia: false, now });
    assert.equal(liatAnimeFast.intent, 'CARI_VAULT');
    assert.equal(liatAnimeFast.payload.kata_kunci, 'anime');
    const liatAnimeRes = await executeIntent({ result: liatAnimeFast, rawText: 'liat anime', now });
    assert.match(liatAnimeRes.text, /kimi no nawa/i);
    assert.match(liatAnimeRes.text, /great of the fireflies/i);

    const renameFast = tryLocalFastIntent({ text: 'ubah nama di vault ini menjadi deca', hasMedia: false, now });
    assert.equal(renameFast.intent, 'UBAH_VAULT');
    assert.equal(renameFast.payload.nama_baru, 'deca');

    const renameRes = await executeIntent({ result: renameFast, rawText: 'ubah nama di vault ini menjadi deca', now });
    assert.match(renameRes.text, /berhasil diubah/i);
    assert.match(renameRes.text, /\*deca\*/);

    const renamedItem = vaultRepo.search('deca')[0];
    assert.ok(renamedItem);
    const apiRename = await fetch(`${baseUrl}/api/vault/${renamedItem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kata_kunci: 'deca_cantik' }),
    });
    assert.equal(apiRename.status, 200);
    assert.equal((await apiRename.json()).kata_kunci, 'deca_cantik');

    const expRes = await executeIntent({
      result: {
        intent: 'CATAT_PENGELUARAN',
        reply_message: 'Pengeluaran dicatat!',
        payload: {
          tanggal: '2026-11-24',
          expenses: [
            { item: 'Makan siang', nominal: 18000, kategori: 'Makan & Minum' },
            { item: 'Bensin', nominal: 25000, kategori: 'Transportasi' },
          ],
        },
      },
      now,
    });
    assert.match(expRes.text, /43\.000/);

    const backupFile = path.join(TEST_DIR, 'verify-backup.db');
    await createConsistentBackup(backupFile);
    assert.ok(fs.existsSync(backupFile));
    const checkDb = new Database(backupFile, { readonly: true });
    assert.equal(checkDb.prepare('SELECT COUNT(*) AS c FROM pengeluaran').get().c, 2);
    checkDb.close();
    assert.ok(getDatabaseStats().total_records >= 6);
  });

  it('6. Real-Time SSE Event Stream from WhatsApp + REST API + Optional WEB_PIN', async () => {
    // Open SSE connection and verify WhatsApp intent immediately pushes event
    const ac = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/events`, { signal: ac.signal });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();

    // Read initial connected event
    const firstChunk = await reader.read();
    assert.match(decoder.decode(firstChunk.value), /event: connected/);

    // Trigger WhatsApp intent
    await executeIntent({
      result: {
        intent: 'SIMPAN_MEMORI',
        reply_message: 'Tersimpan!',
        payload: { tanggal: '2026-11-23', isi_catatan: 'Tes sinkronisasi real-time WA ke Web' },
      },
    });

    const updateChunk = await reader.read();
    const updateText = decoder.decode(updateChunk.value);
    assert.match(updateText, /event: data-updated/);
    assert.match(updateText, /"module":"memori"/);
    assert.match(updateText, /"source":"whatsapp"/);
    ac.abort();

    // Push subscribe & VAPID
    const subRes = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://example.invalid/push/test-sub-1',
        keys: { p256dh: 'dGVzdA==', auth: 'dGVzdA==' },
      }),
    });
    assert.equal(subRes.status, 201);
    assert.equal(pushRepo.list().length, 1);

    // Optional WEB_PIN check + Security Audit Logs (PIN_SALAH, AKSES_DITOLAK, LOGIN_BERHASIL, /log)
    process.env.WEB_PIN = '2468';
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);
    const badPin = await fetch(`${baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
      },
      body: JSON.stringify({ pin: '9999' }),
    });
    assert.equal(badPin.status, 401);

    const rightPin = await fetch(`${baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
      },
      body: JSON.stringify({ pin: '2468' }),
    });
    assert.equal(rightPin.status, 200);
    const cookie = rightPin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } })).status, 200);

    const auditRes = await fetch(`${baseUrl}/api/audit-logs`, { headers: { Cookie: cookie } });
    assert.equal(auditRes.status, 200);
    const auditData = await auditRes.json();
    assert.ok(auditData.stats.failedCount >= 1);
    assert.ok(auditData.stats.successCount >= 1);
    const loginRow = auditData.logs.find((l) => l.event === 'LOGIN_BERHASIL');
    assert.ok(loginRow && /Android 14.*Chrome 130/i.test(loginRow.device));

    const { handleSlashCommand: runLogCmd } = await import('../src/services/commands.js');
    const logMsg = await runLogCmd({ text: '/log', now: new Date() });
    assert.match(logMsg.text, /Log Keamanan Web Dashboard/);
    assert.match(logMsg.text, /PIN Salah/);

    process.env.WEB_PIN = '';
  });

  it('7. 0ms WhatsApp Slash Commands (/p, /cp, /w, /m, /v, /rv, /j, /s, /t, /td, /k, /rk, /help)', async () => {
    const { handleSlashCommand } = await import('../src/services/commands.js');
    const now = new Date('2026-11-24T10:00:00+07:00');

    // Non-slash returns null so natural chat goes to AI
    assert.equal(await handleSlashCommand({ text: 'halo bot', now }), null);

    // /help
    const help = await handleSlashCommand({ text: '/help', now });
    assert.match(help.text, /Daftar Perintah Cepat/);

    // /p + /cp (Memori with deskripsi & custom date)
    const pRes = await handleSlashCommand({
      text: '/p 2026-11-20 Menang lomba pidato | Ditraktir gelato setelah acara',
      now,
    });
    assert.match(pRes.text, /Brankas Memori/);
    assert.match(pRes.text, /gelato/i);

    const cpRes = await handleSlashCommand({ text: '/cp gelato', now });
    assert.match(cpRes.text, /Menang lomba pidato/);

    // /w & /m (Wishlist & Monthly Momen)
    const wAdd = await handleSlashCommand({ text: '/w Parfum vanilla | botol 50ml', now });
    assert.match(wAdd.text, /Parfum vanilla/);
    const wList = await handleSlashCommand({ text: '/w', now });
    assert.match(wList.text, /Parfum vanilla/);

    const mAdd = await handleSlashCommand({ text: '/m 2026-09-24 Mensiversary Kita bulanan | Dinner bareng', now });
    assert.match(mAdd.text, /Tiap Bulan/);
    const mList = await handleSlashCommand({ text: '/m', now });
    assert.match(mList.text, /Mensiversary Kita/);

    // /v & /rv (Vault save, list, get, rename)
    const vSave = await handleSlashCommand({ text: '/v film | Interstellar', now });
    assert.match(vSave.text, /Interstellar/);
    const vGet = await handleSlashCommand({ text: '/v film', now });
    assert.match(vGet.text, /Interstellar/);
    const rvRes = await handleSlashCommand({ text: '/rv film | Film Favorit', now });
    assert.match(rvRes.text, /Film Favorit/);

    // /j & /s (Schedule & Snooze)
    const jAdd = await handleSlashCommand({ text: '/j kamis 08:30 Presensi AI', now });
    assert.match(jAdd.text, /Jadwal Rutin Tersimpan/);
    const sRes = await handleSlashCommand({ text: '/s 15', now });
    assert.match(sRes.text, /10:15 WIB/);

    // /t & /td (Task add, list, complete)
    const tAdd = await handleSlashCommand({ text: '/t 2026-11-29 22:00 Basis Data | ERD Toko Online', now });
    assert.match(tAdd.text, /ERD Toko Online/);
    const tDone = await handleSlashCommand({ text: '/td ERD Toko', now });
    assert.match(tDone.text, /SELESAI/);

    // /k, /pm & /rk (Expense, Income & Finance summary)
    const kAdd = await handleSlashCommand({ text: '/k bakso 22rb, es teh 5k', now });
    assert.match(kAdd.text, /27\.000/);
    const pmAdd = await handleSlashCommand({ text: '/pm uang saku 500rb, freelance 200k', now });
    assert.match(pmAdd.text, /700\.000/);
    const rkRes = await handleSlashCommand({ text: '/rk hari', now });
    assert.match(rkRes.text, /Rekap Keuangan/);
    assert.match(rkRes.text, /Pemasukan/);
    assert.match(rkRes.text, /Saldo Bersih/);

    // Verify natural Indonesian fast-path for Pemasukan (including bare "masuk 20k" & "masuk 20k dari ortu")
    const { tryLocalFastIntent: tryFastIncome } = await import('../src/services/gemini.js');
    const natInc = tryFastIncome({ text: 'dapat uang saku 350rb', hasMedia: false, now });
    assert.equal(natInc?.intent, 'CATAT_PEMASUKAN');
    assert.equal(natInc?.payload?.expenses?.[0]?.nominal, 350000);
    assert.equal(natInc?.payload?.expenses?.[0]?.kategori, 'Uang Saku');

    const bareInc = tryFastIncome({ text: 'masuk 20k', hasMedia: false, now });
    assert.equal(bareInc?.intent, 'CATAT_PEMASUKAN');
    assert.equal(bareInc?.payload?.expenses?.[0]?.nominal, 20000);
    assert.equal(bareInc?.payload?.expenses?.[0]?.item, 'Uang Masuk');

    const numFirstInc = tryFastIncome({ text: 'masuk 50rb dari ortu', hasMedia: false, now });
    assert.equal(numFirstInc?.intent, 'CATAT_PEMASUKAN');
    assert.equal(numFirstInc?.payload?.expenses?.[0]?.nominal, 50000);
    assert.equal(numFirstInc?.payload?.expenses?.[0]?.kategori, 'Uang Saku');

    // Unknown command
    const unk = await handleSlashCommand({ text: '/ngasal', now });
    assert.match(unk.text, /tidak dikenali/i);

    // Natural Indonesian fast-path for Tugas & Jadwal (immune to Gemini 503 outages)
    const { tryLocalFastIntent } = await import('../src/services/gemini.js');
    const mon = new Date('2026-11-23T20:51:00+07:00'); // Senin
    const natTask = tryLocalFastIntent({
      text: 'tugas matkul pcd mempelajari segmentasi hari kamis besok',
      hasMedia: false,
      now: mon,
    });
    assert.equal(natTask.intent, 'TAMBAH_TUGAS');
    assert.equal(natTask.payload.matkul, 'PCD');
    assert.equal(natTask.payload.tanggal, '2026-11-26');
    assert.match(natTask.payload.judul, /segmentasi/i);

    const natSched = tryLocalFastIntent({
      text: 'Ingetin presensi tiap Selasa jam 07.50 matkul Sistem Terdistribusi',
      hasMedia: false,
      now: mon,
    });
    assert.equal(natSched.intent, 'TAMBAH_JADWAL');
    assert.equal(natSched.payload.hari, 'Selasa');
    assert.equal(natSched.payload.jam, '07:50');
    assert.equal(natSched.payload.is_rutin, true);

    // Partner memory & schedule check queries must NOT be misrouted to CEK_WISHLIST_MOMEN or SIMPAN_MEMORI
    for (const q of ['cek pacar', 'cek aktivitas pacar', 'aktivitas pacar', 'cek memori pacar']) {
      const mIntent = tryLocalFastIntent({ text: q, hasMedia: false, now: mon });
      assert.equal(mIntent?.intent, 'CARI_MEMORI', `Expected CARI_MEMORI for "${q}"`);
      const mOut = await executeIntent({ result: mIntent, rawText: q, now: mon });
      assert.match(mOut.text, /Aktivitas & Memori Pacar/);
    }

    const schedIntent = tryLocalFastIntent({ text: 'cek jadwal', hasMedia: false, now: mon });
    assert.equal(schedIntent?.intent, 'CEK_JADWAL');
    const schedOut = await executeIntent({ result: schedIntent, rawText: 'cek jadwal', now: mon });
    assert.match(schedOut.text, /Jadwal/);
  });

  it('8. Power Features: Budget Alert + CSV Export, Quick Reminder (/r), Spotlight Search, Habits (/h), Focus (/fokus)', async () => {
    const { handleSlashCommand } = await import('../src/services/commands.js');
    const { checkBudgetThresholds } = await import('../src/services/budget.js');
    const { checkQuickReminders, checkFocusSessions } = await import('../src/services/scheduler.js');
    const { tryLocalFastIntent } = await import('../src/services/gemini.js');
    const { getWibParts } = await import('../src/utils/time.js');
    const todayStr = getWibParts().dateStr;
    const monthStr = getWibParts().monthStr;
    const now = new Date(`${todayStr}T14:00:00+07:00`);

    // 1. Budget limit + 80%/100% alert trigger + CSV Export
    const putBudget = await fetch(`${baseUrl}/api/budgets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyLimit: 50000, byCategory: { 'Makan & Minum': 30000 } }),
    });
    assert.equal(putBudget.status, 200);
    const { pengeluaranRepo: expRepoTest, stateRepo: stRepoTest } = await import('../src/config/db.js');
    stRepoTest.setJson('budget_alerts_sent', {});
    expRepoTest.create({ tanggal: todayStr, item: 'Makan malam', nominal: 45000, kategori: 'Makan & Minum', tipe: 'PENGELUARAN' });
    const alerts = await checkBudgetThresholds(monthStr);
    assert.ok(alerts.some((a) => a.scope === 'total' && a.level >= 80));
    assert.ok(alerts.some((a) => a.scope === 'Makan & Minum' && a.level === 100));

    const csvRes = await fetch(`${baseUrl}/api/pengeluaran/export?month=${monthStr}`);
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.match(csvText, /Tanggal,Tipe,Item,Kategori,Nominal/);
    assert.match(csvText, /Makan malam/);

    // 2. Quick Reminder (/r + natural fast-path + scheduler firing)
    const rCmd = await handleSlashCommand({ text: '/r 15m angkat jemuran', now });
    assert.match(rCmd.text, /14:15 WIB/);
    const natRem = tryLocalFastIntent({ text: 'ingetin 30 menit lagi matiin kompor', hasMedia: false, now });
    assert.equal(natRem?.intent, 'TAMBAH_REMINDER');
    assert.equal(natRem?.payload?.menit_tunda, 30);
    const firedRem = await checkQuickReminders(new Date(`${todayStr}T14:16:00+07:00`));
    assert.equal(firedRem, 1);

    // 3. Habit Tracker (/h + add, check-in, API 56-day streak grid)
    const hAdd = await handleSlashCommand({ text: '/h + Olahraga | 30 menit', now });
    assert.match(hAdd.text, /Olahraga/);
    const hCheck = await handleSlashCommand({ text: '/h olahraga', now });
    assert.match(hCheck.text, /Streak saat ini: \*1 hari/);
    const habitsApi = await (await fetch(`${baseUrl}/api/habits?days=56`)).json();
    assert.equal(habitsApi.grid.length, 56);
    assert.equal(habitsApi.summary.doneTodayCount, 1);

    // 4. Focus / Pomodoro Timer (/fokus + scheduler completion)
    const fStart = await handleSlashCommand({ text: '/fokus 25 belajar PCD', now });
    assert.match(fStart.text, /Mode Fokus Dimulai \(25 menit\)/);
    const fDone = await checkFocusSessions(new Date(`${todayStr}T14:26:00+07:00`));
    assert.equal(fDone, 1);
    const focusApi = await (await fetch(`${baseUrl}/api/focus`)).json();
    assert.equal(focusApi.stats.todaySessions, 1);
    assert.equal(focusApi.stats.todayMinutes, 25);

    // 5. Global Spotlight Search API
    const searchRes = await (await fetch(`${baseUrl}/api/search?q=olahraga`)).json();
    assert.ok(searchRes.total >= 1 && searchRes.habits.length >= 1);

    // 6. Natural fast-path for AI Partner Recommendations & Recap + ensure birthday/year is NOT hijacked as expense
    const ideaIntent = tryLocalFastIntent({ text: 'ide kado buat dia', hasMedia: false, now });
    assert.equal(ideaIntent?.intent, 'REKOMENDASI_PACAR');
    const recapIntent = tryLocalFastIntent({ text: 'rekap memori bulan ini', hasMedia: false, now });
    assert.equal(recapIntent?.intent, 'IDE_PACAR');
    assert.equal(recapIntent?.payload?.kata_kunci, 'REKAP');
    assert.equal(tryLocalFastIntent({ text: 'pacarku lahir 12 desember 2003', hasMedia: false, now }), null);
    assert.equal(tryLocalFastIntent({ text: 'ulang tahun ibu 5 mei 1978', hasMedia: false, now }), null);
  });

  it('9. New 4 Features: Study Notes (catatan_kuliah), AI Telemetry, Smart Date/Gift Planner, Calendar ICS Feed & Zero-Emoji Frontend', async () => {
    const { aiLogRepo, getCalendarFeedToken } = await import('../src/config/db.js');
    const { tryLocalFastIntent, PRIMARY_GEMINI_MODEL } = await import('../src/services/gemini.js');
    const { handleSlashCommand } = await import('../src/services/commands.js');
    const now = new Date('2026-11-25T10:00:00+07:00');

    // === FITUR 1: Catatan Kuliah & Ide ===
    assert.equal(PRIMARY_GEMINI_MODEL, 'gemini-3.8-flash');
    const noteSaveOutcome = await executeIntent({
      result: {
        intent: 'SIMPAN_CATATAN',
        reply_message: 'Siap, catatan kuliah sudah dirangkum!',
        payload: {
          judul: 'Enkripsi Simetris AES',
          kategori: 'Kriptografi',
          ringkasan: '- AES menggunakan ukuran blok 128-bit\n- Panjang kunci 128, 192, atau 256-bit\n- Terdiri dari SubBytes, ShiftRows, MixColumns, AddRoundKey',
        },
      },
      mediaType: 'audio',
      now,
    });
    assert.match(noteSaveOutcome.text, /Enkripsi Simetris AES/);
    assert.match(noteSaveOutcome.text, /VOICE/);

    // Fast-path CARI_CATATAN must NOT collide with CARI_VAULT or CARI_MEMORI
    const cariNoteIntent = tryLocalFastIntent({
      text: 'Cari catatan kuliah Kriptografi tentang enkripsi',
      hasMedia: false,
      now,
    });
    assert.equal(cariNoteIntent?.intent, 'CARI_CATATAN');
    const cariNoteOutcome = await executeIntent({ result: cariNoteIntent, rawText: 'Cari catatan kuliah Kriptografi tentang enkripsi', now });
    assert.match(cariNoteOutcome.text, /Enkripsi Simetris AES/);

    // /n slash command + REST API CRUD + Spotlight search
    const nAdd = await handleSlashCommand({ text: '/n Ide Proyek | Aplikasi Kasir | - Offline-first SQLite\n- Cetak struk thermal', now });
    assert.match(nAdd.text, /Aplikasi Kasir/);
    const nSearch = await handleSlashCommand({ text: '/n cari kasir', now });
    assert.match(nSearch.text, /Aplikasi Kasir/);

    const listCatatanRes = await (await fetch(`${baseUrl}/api/catatan`)).json();
    assert.ok(listCatatanRes.items.length >= 2);
    assert.ok(listCatatanRes.categories.includes('Kriptografi'));

    const postNote = await fetch(`${baseUrl}/api/catatan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ judul: 'Raft Consensus', kategori: 'Sistem Terdistribusi', ringkasan: '- Leader election\n- Log replication', sumber_tipe: 'IMAGE' }),
    });
    assert.equal(postNote.status, 201);
    const createdNote = await postNote.json();
    assert.equal(createdNote.sumber_tipe, 'IMAGE');

    const spotNote = await (await fetch(`${baseUrl}/api/search?q=Enkripsi`)).json();
    assert.ok(spotNote.catatan.length >= 1);

    // === FITUR 2: AI Telemetry & Server Health ===
    aiLogRepo.record({ provider: 'GEMINI', status: 'SUCCESS', latency_ms: 420, model: 'gemini-3.8-flash' });
    aiLogRepo.record({ provider: 'GROQ', status: 'FALLBACK', latency_ms: 610, model: 'qwen/qwen3.8-27b' });

    const telRes = await fetch(`${baseUrl}/api/telemetry`);
    assert.equal(telRes.status, 200);
    const tel = await telRes.json();
    assert.equal(tel.ai.primaryGeminiModel, 'gemini-3.8-flash');
    assert.ok(tel.ai.gemini.todayRequests >= 1);
    assert.ok(tel.ai.groq.fallbackCount >= 1);
    assert.ok(tel.ai.lastFallback && tel.ai.lastFallback.provider === 'GROQ');
    assert.ok(tel.server.ramRssBytes > 0);
    assert.ok(tel.server.dbSizeBytes > 0);
    assert.ok(typeof tel.server.uptimeSeconds === 'number');

    // === FITUR 3: Smart Date & Gift Assistant ===
    const dateFast = tryLocalFastIntent({ text: 'Weekend ini enaknya ngajak dia ke mana?', hasMedia: false, now });
    assert.equal(dateFast?.intent, 'REKOMENDASI_PACAR');

    const giftFast = tryLocalFastIntent({ text: 'Kasih rekomendasi kado buat dia di bawah 200rb', hasMedia: false, now });
    assert.equal(giftFast?.intent, 'REKOMENDASI_PACAR');
    assert.equal(giftFast?.payload?.budget, 200000);

    // Ensure /api/pacar/rekomendasi works (temporarily clear keys so test runs deterministic offline without network flakiness)
    const savedGemKey = process.env.GEMINI_API_KEY;
    const savedGroqKey = process.env.GROQ_API_KEY;
    process.env.GEMINI_API_KEY = '';
    process.env.GROQ_API_KEY = '';
    try {
      const recRes = await fetch(`${baseUrl}/api/pacar/rekomendasi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'gift', budget: 200000 }),
      });
      assert.equal(recRes.status, 200);
      const recData = await recRes.json();
      assert.equal(recData.mode, 'gift');
      assert.equal(recData.budget, 200000);
      assert.ok(recData.memoriesUsed <= 15);
      assert.match(recData.content, /200\.000/);
    } finally {
      process.env.GEMINI_API_KEY = savedGemKey || '';
      process.env.GROQ_API_KEY = savedGroqKey || '';
    }

    // === FITUR 4: Calendar Sync (.ics Feed + Token Guard) ===
    // Ensure at least one active task exists for VEVENT verification
    await fetch(`${baseUrl}/api/tugas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ judul: 'Presentasi Kriptografi', matkul: 'Kriptografi', deadline: '2026-12-01 15:00' }),
    });

    process.env.WEB_PIN = '121203';
    try {
      const unauthIcs = await fetch(`${baseUrl}/api/calendar.ics`);
      assert.equal(unauthIcs.status, 401);

      const infoRes = await fetch(`${baseUrl}/api/calendar/info`, {
        headers: { 'x-web-pin': '121203' },
      });
      assert.equal(infoRes.status, 200);
      const calInfo = await infoRes.json();
      assert.equal(calInfo.token, getCalendarFeedToken());
      assert.ok(calInfo.jadwalCount >= 1);
      assert.ok(calInfo.tugasCount >= 1);

      const icsRes = await fetch(`${baseUrl}${calInfo.path}`);
      assert.equal(icsRes.status, 200);
      assert.match(icsRes.headers.get('content-type') || '', /text\/calendar/i);
      const icsText = await icsRes.text();
      assert.match(icsText, /BEGIN:VCALENDAR/);
      assert.match(icsText, /TZID:Asia\/Jakarta/);
      assert.match(icsText, /RRULE:FREQ=WEEKLY;BYDAY=/);
      assert.match(icsText, /UID:jadwal-/);
      assert.match(icsText, /UID:tugas-/);
      assert.match(icsText, /END:VCALENDAR/);
    } finally {
      process.env.WEB_PIN = '';
    }

    // === ZERO EMOJI POLICY CHECK ON FRONTEND ===
    const emojiRe = /\p{Extended_Pictographic}/u;
    for (const rel of ['public/index.html', 'public/css/style.css', 'public/js/app.js']) {
      const content = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      assert.equal(emojiRe.test(content), false, `Found prohibited emoji in ${rel}`);
    }
  });

  it('10. Repeating Presensi Reminder every 20 minutes until user replies "ok" (WA + API)', async () => {
    const { jadwalRepo, presensiPendingRepo } = await import('../src/config/db.js');
    const { checkSchedules, checkPendingPresensi } = await import('../src/services/scheduler.js');
    const { tryAcknowledgePendingPresensi } = await import('../src/services/whatsapp.js');
    const { handleSlashCommand } = await import('../src/services/commands.js');

    // Clear any prior pending items from earlier tests
    presensiPendingRepo.acknowledgeAll('2026-11-25 00:00');

    // Create a routine class schedule on Rabu 12:30 (defaults to repeat_until_ok=1, repeat_interval_min=20)
    const sched = jadwalRepo.create({
      nama: 'Presensi Sistem Informasi',
      hari: 'Rabu',
      jam: '12:30',
      is_rutin: 1,
    });
    assert.equal(sched.repeat_until_ok, 1);
    assert.equal(sched.repeat_interval_min, 20);

    // 1. Trigger at 12:30 WIB -> creates pending presensi scheduled for 12:50
    const t0 = new Date('2026-11-25T12:30:00+07:00');
    const fired0 = await checkSchedules(t0);
    assert.ok(fired0 >= 1);
    const activeAfterStart = presensiPendingRepo.listActive();
    assert.equal(activeAfterStart.length, 1);
    assert.equal(activeAfterStart[0].next_trigger_at, '2026-11-25 12:50');
    assert.equal(activeAfterStart[0].repeat_count, 1);

    // 2. At 12:45 (+15m) -> should NOT fire yet
    const fired15 = await checkPendingPresensi(new Date('2026-11-25T12:45:00+07:00'));
    assert.equal(fired15, 0);

    // 3. At 12:50 (+20m) -> fires repeat #2 and reschedules to 13:10
    const fired20 = await checkPendingPresensi(new Date('2026-11-25T12:50:00+07:00'));
    assert.equal(fired20, 1);
    let current = presensiPendingRepo.listActive()[0];
    assert.equal(current.repeat_count, 2);
    assert.equal(current.next_trigger_at, '2026-11-25 13:10');

    // 4. At 13:10 (+40m) -> fires repeat #3 and reschedules to 13:30
    const fired40 = await checkPendingPresensi(new Date('2026-11-25T13:10:00+07:00'));
    assert.equal(fired40, 1);
    current = presensiPendingRepo.listActive()[0];
    assert.equal(current.repeat_count, 3);
    assert.equal(current.next_trigger_at, '2026-11-25 13:30');

    // 5. User replies "ok" via WhatsApp -> 0ms instant stop
    const ackReply = tryAcknowledgePendingPresensi('ok', new Date('2026-11-25T13:12:00+07:00'));
    assert.ok(ackReply && /Presensi Dikonfirmasi/.test(ackReply.text));
    assert.equal(presensiPendingRepo.listActive().length, 0);

    // 6. At 13:30 -> completely silent (0 fired)
    const fired60 = await checkPendingPresensi(new Date('2026-11-25T13:30:00+07:00'));
    assert.equal(fired60, 0);

    // 7. Replying "ok" when nothing is pending returns null (does not hijack normal chat)
    assert.equal(tryAcknowledgePendingPresensi('ok', new Date('2026-11-25T13:35:00+07:00')), null);

    // 8. Also test API /api/jadwal/pending & /api/jadwal/pending/ack + /ok slash command
    presensiPendingRepo.create({
      jadwal_id: sched.id,
      nama: sched.nama,
      tanggal: '2026-11-25',
      jam_awal: '12:30',
      interval_menit: 20,
      next_trigger_at: '2026-11-25 14:00',
    });
    const pendingApi = await (await fetch(`${baseUrl}/api/jadwal/pending`)).json();
    assert.equal(pendingApi.length, 1);
    const ackApi = await fetch(`${baseUrl}/api/jadwal/pending/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(ackApi.status, 200);
    assert.equal(presensiPendingRepo.listActive().length, 0);

    const slashOk = await handleSlashCommand({ text: '/ok', now: new Date('2026-11-25T14:05:00+07:00') });
    assert.match(slashOk.text, /Tidak ada pengingat presensi/);

    // 9. Distinguish Normal Alarm vs Presensi Alarm (normal alarm fires ONCE, NEVER repeats every 20m or asks "ok")
    const { tryLocalFastIntent } = await import('../src/services/gemini.js');
    const fri = new Date('2026-11-27T10:00:00+07:00');
    const normalAlarmIntent = tryLocalFastIntent({
      text: 'pasang alarm hari ini jam 14:00 Mulai Percobaan Unet/DeepLab',
      hasMedia: false,
      now: fri,
    });
    assert.equal(normalAlarmIntent?.intent, 'TAMBAH_JADWAL');
    assert.equal(normalAlarmIntent?.payload?.is_presensi, false);

    const normalExec = await executeIntent({
      result: normalAlarmIntent,
      rawText: 'pasang alarm hari ini jam 14:00 Mulai Percobaan Unet/DeepLab',
      now: fri,
    });
    assert.match(normalExec.text, /Alarm Biasa/);

    const normalRow = jadwalRepo.list().find((j) => /Unet\/DeepLab/i.test(j.nama));
    assert.ok(normalRow);
    assert.equal(normalRow.repeat_until_ok, 0);

    // Firing normal alarm at 14:00 sends 1x alarm message and creates ZERO presensi_pending
    const beforeNormalWa = sentWaMessages.length;
    const firedNormal = await checkSchedules(new Date('2026-11-27T14:00:00+07:00'));
    assert.equal(firedNormal, 1);
    assert.equal(presensiPendingRepo.listActive().length, 0);
    const lastNormalMsg = sentWaMessages[sentWaMessages.length - 1];
    assert.ok(sentWaMessages.length === beforeNormalWa + 1);
    assert.doesNotMatch(lastNormalMsg, /presensi|balas \*"ok"\*/i);
    assert.equal(await checkPendingPresensi(new Date('2026-11-27T14:20:00+07:00')), 0);

    // Explicit presensi one-shot still repeats until "ok"
    const presensiOneShot = jadwalRepo.create({
      nama: 'Presensi Pengganti Data Mining',
      tanggal: '2026-11-27',
      jam: '15:00',
      is_rutin: 0,
    });
    assert.equal(presensiOneShot.repeat_until_ok, 1);

    // Routine non-class personal alarm (e.g. "Alarm Bangun Pagi") defaults to normal alarm (repeat_until_ok = 0)
    const routinePersonalAlarm = jadwalRepo.create({
      nama: 'Alarm Bangun Pagi',
      hari: 'Senin',
      jam: '05:30',
      is_rutin: 1,
    });
    assert.equal(routinePersonalAlarm.repeat_until_ok, 0);
  });

  it('11. MacroDroid Loud Ring ([ALARM-RING]) per-alarm AI detection, /ring command & global settings', async () => {
    const { jadwalRepo, reminderRepo, settingsRepo } = await import('../src/config/db.js');
    const { tryLocalFastIntent } = await import('../src/services/gemini.js');
    const { handleSlashCommand } = await import('../src/services/commands.js');
    const { checkSchedules, checkQuickReminders } = await import('../src/services/scheduler.js');

    const morning = new Date('2026-11-28T09:00:00+07:00'); // Sabtu 09:00

    // 1. "ingatkan aku jam 2 siang pakai ring" -> 14:00 today, normal alarm (repeat=0), ring_loud=1
    const ringIntent = tryLocalFastIntent({
      text: 'ingatkan aku jam 2 siang pakai ring',
      hasMedia: false,
      now: morning,
    });
    assert.equal(ringIntent?.intent, 'TAMBAH_JADWAL');
    assert.equal(ringIntent?.payload?.jam, '14:00');
    assert.equal(ringIntent?.payload?.tanggal, '2026-11-28');
    assert.equal(ringIntent?.payload?.is_presensi, false);
    assert.equal(ringIntent?.payload?.ring_loud, true);

    const ringExec = await executeIntent({
      result: ringIntent,
      rawText: 'ingatkan aku jam 2 siang pakai ring',
      now: morning,
    });
    assert.match(ringExec.text, /Dering Keras \[RING\]/);

    // Fire at 14:00 -> MUST include [ALARM-RING] at top of WA message
    const beforeFire = sentWaMessages.length;
    await checkSchedules(new Date('2026-11-28T14:00:00+07:00'));
    assert.equal(sentWaMessages.length, beforeFire + 1);
    assert.ok(sentWaMessages[sentWaMessages.length - 1].startsWith('[ALARM-RING]\n'));

    // 2. Normal alarm WITHOUT ring ("ingatkan aku jam 3 siang baca jurnal") -> ring_loud=0 -> NO [ALARM-RING]
    const silentIntent = tryLocalFastIntent({
      text: 'ingatkan aku jam 3 siang baca jurnal',
      hasMedia: false,
      now: morning,
    });
    assert.equal(silentIntent?.intent, 'TAMBAH_JADWAL');
    assert.equal(silentIntent?.payload?.jam, '15:00');
    assert.equal(silentIntent?.payload?.ring_loud, false);
    await executeIntent({ result: silentIntent, rawText: 'ingatkan aku jam 3 siang baca jurnal', now: morning });
    await checkSchedules(new Date('2026-11-28T15:00:00+07:00'));
    assert.doesNotMatch(sentWaMessages[sentWaMessages.length - 1], /\[ALARM-RING\]/);

    // 3. Quick reminder with ring ("ingetin 30 menit lagi matiin kompor pakai ring" + "/r 10m cek oven ring")
    const qRemIntent = tryLocalFastIntent({
      text: 'ingetin 30 menit lagi matiin kompor pakai ring',
      hasMedia: false,
      now: morning,
    });
    assert.equal(qRemIntent?.intent, 'TAMBAH_REMINDER');
    assert.equal(qRemIntent?.payload?.ring_loud, true);
    assert.equal(qRemIntent?.payload?.judul, 'matiin kompor');

    const rSlash = await handleSlashCommand({ text: '/r 10m cek oven ring', now: morning });
    assert.match(rSlash.text, /Dering Keras \[RING\]/);
    const remRow = reminderRepo.list({ selesai: 0 }).find((r) => r.pesan === 'cek oven');
    assert.ok(remRow && remRow.ring_loud === 1);

    await checkQuickReminders(new Date('2026-11-28T09:11:00+07:00'));
    assert.ok(sentWaMessages[sentWaMessages.length - 1].startsWith('[ALARM-RING]\n'));

    // 4. /ring immediate & /ring 5 delayed + POST /api/actions/test-ring
    const beforeTestRing = sentWaMessages.length;
    const ringCmdNow = await handleSlashCommand({ text: '/ring', now: morning });
    assert.equal(ringCmdNow?.skipReply, true);
    assert.equal(sentWaMessages.length, beforeTestRing + 1);
    assert.ok(sentWaMessages[sentWaMessages.length - 1].startsWith('[ALARM-RING]\n'));

    const ringCmdDelay = await handleSlashCommand({ text: '/ring 5', now: morning });
    assert.match(ringCmdDelay.text, /5 detik/);

    const apiRing = await fetch(`${baseUrl}/api/actions/test-ring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 0 }),
    });
    assert.equal(apiRing.status, 200);
    const apiRingJson = await apiRing.json();
    assert.equal(apiRingJson.ok, true);
    assert.equal(apiRingJson.result?.ringLoud, true);

    // 5. Global settings toggle persists cleanly via API
    const putSet = await fetch(`${baseUrl}/api/settings/notifications`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ringOnNormalAlarm: true }),
    });
    assert.equal(putSet.status, 200);
    assert.equal(settingsRepo.getNotificationSettings().ringOnNormalAlarm, true);
    settingsRepo.updateNotificationSettings({ ringOnNormalAlarm: false });

    // Confirm jadwalRepo stores ring_loud=1 when created directly
    const jDirect = jadwalRepo.create({ nama: 'Telpon Bangun', tanggal: '2026-11-29', jam: '05:00', is_rutin: 0, ring_loud: 1 });
    assert.equal(jDirect.ring_loud, 1);
  });
});
