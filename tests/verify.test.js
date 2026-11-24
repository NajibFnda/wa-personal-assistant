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

    // Optional WEB_PIN check
    process.env.WEB_PIN = '2468';
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);
    const rightPin = await fetch(`${baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2468' }),
    });
    assert.equal(rightPin.status, 200);
    const cookie = rightPin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } })).status, 200);
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
});
