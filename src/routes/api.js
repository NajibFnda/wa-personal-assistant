import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_CATEGORIES,
  DB_PATH,
  INCOME_CATEGORIES,
  MEMORI_UPLOADS_DIR,
  PROJECT_ROOT,
  VAULT_UPLOADS_DIR,
  aiLogRepo,
  auditRepo,
  budgetRepo,
  catatanRepo,
  createConsistentBackup,
  focusRepo,
  getCalendarFeedToken,
  getDatabaseStats,
  globalSearch,
  habitRepo,
  jadwalRepo,
  memoriRepo,
  pengeluaranRepo,
  presensiPendingRepo,
  pushRepo,
  reminderRepo,
  resolveUploadPath,
  settingsRepo,
  tugasRepo,
  vaultRepo,
  wishlistRepo,
} from '../config/db.js';
import { recordAccessEvent } from '../services/audit.js';
import { checkBudgetThresholds } from '../services/budget.js';
import { generateCalendarIcs } from '../services/calendar.js';
import { emitDataChange, onDataChange } from '../services/events.js';
import {
  PRIMARY_GEMINI_MODEL,
  generateMonthlyPartnerRecap,
  generatePartnerIdeas,
  generatePartnerRecommendation,
  getActiveModelName,
  isGeminiApiConfigured,
  isGeminiConfigured,
  isGroqConfigured,
  testAiEngines,
} from '../services/gemini.js';
import { isWebPushConfigured, sendDualNotification, sendRingTestNotification } from '../services/notifier.js';
import { reloadScheduler, runMorningBriefing, runWeeklyBackup } from '../services/scheduler.js';
import {
  getWhatsAppStatus,
  initWhatsApp,
  logoutWhatsApp,
} from '../services/whatsapp.js';
import { addMinutesWib, formatCountdown, getWibParts, shiftDateStr } from '../utils/time.js';

const router = express.Router();

/* ==================== OPTIONAL WEB_PIN AUTH ==================== */
function getConfiguredPin() {
  return String(process.env.WEB_PIN || '').trim();
}

function derivePinToken(pin) {
  return crypto.createHash('sha256').update(`assistant-pin::${pin}`).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader = '') {
  const result = {};
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) result[key] = val;
  }
  return result;
}

export function isRequestAuthorized(req) {
  const pin = getConfiguredPin();
  if (!pin) return true;

  const headerPin = req.headers['x-web-pin'];
  if (headerPin && safeEqual(headerPin, pin)) return true;

  const cookies = parseCookies(req.headers.cookie);
  const expectedToken = derivePinToken(pin);
  if (cookies.assistant_auth && safeEqual(cookies.assistant_auth, expectedToken)) {
    return true;
  }

  return false;
}

export function requirePinMiddleware(req, res, next) {
  if (isRequestAuthorized(req)) return next();
  recordAccessEvent(req, 'AKSES_DITOLAK');
  return res.status(401).json({ error: 'PIN diperlukan untuk mengakses dashboard.' });
}

// Public auth endpoints
router.get('/auth/status', (req, res) => {
  const pin = getConfiguredPin();
  res.json({
    required: Boolean(pin),
    authenticated: isRequestAuthorized(req),
  });
});

router.post('/auth/verify', (req, res) => {
  const pin = getConfiguredPin();
  if (!pin) {
    return res.json({ authenticated: true });
  }
  const submitted = String(req.body?.pin || '').trim();
  if (!submitted || !safeEqual(submitted, pin)) {
    recordAccessEvent(req, 'PIN_SALAH', { notifyOnFail: true });
    return res.status(401).json({ error: 'PIN salah. Silakan coba lagi.' });
  }
  const token = derivePinToken(pin);
  res.setHeader(
    'Set-Cookie',
    `assistant_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
  recordAccessEvent(req, 'LOGIN_BERHASIL');
  return res.json({ authenticated: true });
});

router.post('/auth/logout', (req, res) => {
  recordAccessEvent(req, 'LOGOUT');
  res.setHeader('Set-Cookie', 'assistant_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

/* ==================== FITUR 4: PUBLIC / TOKEN-GATED ICS CALENDAR FEED ==================== */
router.get('/calendar.ics', (req, res) => {
  const pin = getConfiguredPin();
  const expectedToken = getCalendarFeedToken();
  const suppliedToken = String(req.query.token || '').trim();
  const authorized =
    !pin ||
    isRequestAuthorized(req) ||
    (Boolean(suppliedToken) && safeEqual(suppliedToken, expectedToken));

  if (!authorized) {
    return res.status(401).json({ error: 'Token kalender (.ics) tidak valid.' });
  }

  const schedules = jadwalRepo.list({ aktif: 1 });
  const tasks = tugasRepo.list({ selesai: 0 });
  const icsBody = generateCalendarIcs({ schedules, tasks });

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="personal-assistant.ics"');
  res.setHeader('Cache-Control', 'no-cache, max-age=0');
  return res.send(icsBody);
});

// Protect all remaining /api/* routes when WEB_PIN is configured
router.use(requirePinMiddleware);

/* ==================== MULTER STORAGE ==================== */
function makeStorage(destDir) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, destDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
      const base = path
        .basename(file.originalname || 'file', path.extname(file.originalname || ''))
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 48);
      cb(null, `${Date.now()}-${base || 'upload'}${ext}`);
    },
  });
}

const uploadMemori = multer({
  storage: makeStorage(MEMORI_UPLOADS_DIR),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || '').startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diperbolehkan untuk foto memori.'));
    }
  },
});

const uploadVault = multer({
  storage: makeStorage(VAULT_UPLOADS_DIR),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* ==================== STATUS & OVERVIEW ==================== */
router.get('/status', (_req, res) => {
  const now = new Date();
  const parts = getWibParts(now);
  const stats = getDatabaseStats();
  const todaySchedules = jadwalRepo.getTodaySchedules(parts.hari, parts.dateStr);
  const activeTasks = tugasRepo.list({ selesai: 0 }).map((t) => ({
    ...t,
    countdown: formatCountdown(t.deadline, now),
  }));
  const upcomingMoments = wishlistRepo.getUpcomingMoments(30, now);
  const todayExpense = pengeluaranRepo.getSummary({
    tanggal_mulai: parts.dateStr,
    tanggal_akhir: parts.dateStr,
  });
  const monthExpense = pengeluaranRepo.getSummary({ month: parts.monthStr });

  res.json({
    whatsapp: getWhatsAppStatus(),
    geminiConfigured: isGeminiConfigured(),
    geminiModel: getActiveModelName(),
    webPushConfigured: isWebPushConfigured(),
    pinEnabled: Boolean(getConfiguredPin()),
    notificationSettings: settingsRepo.getNotificationSettings(),
    serverTime: parts,
    stats,
    overview: {
      todaySchedules,
      pendingPresensi: presensiPendingRepo.listActive(),
      urgentTasks: activeTasks.slice(0, 5),
      upcomingMoments: upcomingMoments.slice(0, 5),
      todayExpenseTotal: todayExpense.totalExpense,
      monthExpenseTotal: monthExpense.totalExpense,
      todayIncomeTotal: todayExpense.totalIncome,
      monthIncomeTotal: monthExpense.totalIncome,
      monthBalance: monthExpense.balance,
    },
  });
});

/* ==================== REAL-TIME SSE EVENTS ==================== */
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const unsubscribe = onDataChange((payload) => {
    res.write(`event: data-updated\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

/* ==================== NOTIFICATION SETTINGS ==================== */
router.get('/settings/notifications', (_req, res) => {
  res.json(settingsRepo.getNotificationSettings());
});

router.put('/settings/notifications', (req, res) => {
  try {
    const updated = settingsRepo.updateNotificationSettings(req.body || {});
    reloadScheduler();
    emitDataChange('settings', 'api');
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ==================== WHATSAPP CONTROLS ==================== */
router.post('/whatsapp/logout', async (_req, res) => {
  await logoutWhatsApp();
  res.json({ ok: true, message: 'Sesi WhatsApp dihapus, memuat ulang QR Code...' });
});

router.post('/whatsapp/reconnect', async (_req, res) => {
  initWhatsApp().catch(() => {});
  res.json({ ok: true, message: 'Mencoba menghubungkan ulang WhatsApp...' });
});

/* ==================== WEB PUSH ==================== */
router.get('/push/vapid-key', (_req, res) => {
  res.json({
    publicKey: (process.env.VAPID_PUBLIC_KEY || '').trim(),
    configured: isWebPushConfigured(),
  });
});

router.post('/push/subscribe', (req, res) => {
  try {
    const subscription = req.body;
    const saved = pushRepo.upsert(subscription);
    res.status(201).json({ ok: true, id: saved.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ==================== ACTIONS (TEST / BRIEFING / BACKUP) ==================== */
router.post('/actions/test-notification', async (_req, res) => {
  const parts = getWibParts();
  const result = await sendDualNotification(
    '🔔 Test Notifikasi Personal Assistant',
    `Dual-Channel Notification aktif pada ${parts.display}!`,
    '/',
    { recordForSnooze: true, activityName: 'Test Pengingat' }
  );
  res.json({ ok: true, result });
});

router.post('/actions/test-ring', async (req, res) => {
  const delaySec = Math.max(0, Math.min(30, Math.round(Number(req.body?.delaySeconds) || 0)));
  if (delaySec > 0) {
    const timer = setTimeout(() => {
      sendRingTestNotification('Test Dering Keras HP (MacroDroid)').catch(() => {});
    }, delaySec * 1000);
    timer.unref?.();
    return res.json({ ok: true, delayedSeconds: delaySec });
  }
  const result = await sendRingTestNotification('Test Dering Keras HP (MacroDroid)');
  return res.json({ ok: true, delayedSeconds: 0, result });
});

router.post('/actions/morning-briefing', async (_req, res) => {
  const result = await runMorningBriefing();
  res.json({ ok: true, result });
});

router.post('/actions/backup-wa', async (_req, res) => {
  try {
    const result = await runWeeklyBackup();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

router.get('/actions/backup-download', async (_req, res) => {
  const parts = getWibParts();
  const fileName = `assistant-backup-${parts.dateStr}.db`;
  const tempPath = path.join(os.tmpdir(), `dl-backup-${Date.now()}.db`);
  try {
    await createConsistentBackup(tempPath);
    res.download(tempPath, fileName, () => {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==================== MODUL 1: JADWAL ==================== */
router.get('/jadwal/pending', (_req, res) => {
  res.json(presensiPendingRepo.listActive());
});

router.post('/jadwal/pending/ack', (req, res) => {
  const nowStr = getWibParts().dateTimeStr;
  const targetId = req.body?.id;
  if (targetId) {
    const acked = presensiPendingRepo.acknowledgeById(targetId, nowStr);
    if (!acked) return res.status(404).json({ error: 'Pengingat presensi aktif tidak ditemukan.' });
    emitDataChange('jadwal', 'api');
    return res.json({ ok: true, acknowledged: [acked] });
  }
  const ackedAll = presensiPendingRepo.acknowledgeAll(nowStr);
  emitDataChange('jadwal', 'api');
  return res.json({ ok: true, acknowledged: ackedAll });
});

router.get('/jadwal', (req, res) => {
  const data = jadwalRepo.list({
    aktif: req.query.aktif,
    is_rutin: req.query.is_rutin,
  });
  res.json(data);
});

router.post('/jadwal', (req, res) => {
  try {
    const created = jadwalRepo.create(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/jadwal/:id', (req, res) => {
  try {
    const updated = jadwalRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/jadwal/:id', (req, res) => {
  try {
    const updated = jadwalRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/jadwal/:id', (req, res) => {
  const deleted = jadwalRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
  return res.json({ ok: true });
});

/* ==================== MODUL 2: TUGAS ==================== */
router.get('/tugas', (req, res) => {
  const now = new Date();
  const rows = tugasRepo.list({ selesai: req.query.selesai }).map((t) => ({
    ...t,
    countdown: formatCountdown(t.deadline, now),
  }));
  res.json(rows);
});

router.post('/tugas', (req, res) => {
  try {
    const created = tugasRepo.create(req.body || {});
    res.status(201).json({ ...created, countdown: formatCountdown(created.deadline) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/tugas/:id', (req, res) => {
  try {
    const updated = tugasRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
    return res.json({ ...updated, countdown: formatCountdown(updated.deadline) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/tugas/:id', (req, res) => {
  try {
    const updated = tugasRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
    return res.json({ ...updated, countdown: formatCountdown(updated.deadline) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/tugas/:id', (req, res) => {
  const deleted = tugasRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Tugas tidak ditemukan.' });
  return res.json({ ok: true });
});

/* ==================== MODUL 3A: MEMORI PACAR ==================== */
router.get('/memori', (req, res) => {
  const rows = memoriRepo.list({
    tanggal: req.query.tanggal,
    tanggal_mulai: req.query.tanggal_mulai,
    tanggal_akhir: req.query.tanggal_akhir,
    q: req.query.q || req.query.keyword,
    limit: req.query.limit ? Number(req.query.limit) : 100,
  });
  res.json(rows);
});

router.post('/memori', uploadMemori.single('media'), (req, res) => {
  try {
    const mediaPath = req.file ? `uploads/memori/${req.file.filename}` : null;
    const created = memoriRepo.create({
      tanggal: req.body?.tanggal,
      hari: req.body?.hari,
      isi: req.body?.isi,
      deskripsi: req.body?.deskripsi || '',
      media_path: mediaPath,
    });
    emitDataChange('memori', 'api');
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function handleMemoriUpdate(req, res) {
  try {
    const patch = {
      tanggal: req.body?.tanggal,
      hari: req.body?.hari,
      isi: req.body?.isi,
      deskripsi: req.body?.deskripsi,
    };
    if (req.file) {
      patch.media_path = `uploads/memori/${req.file.filename}`;
    }
    const updated = memoriRepo.update(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'Catatan memori tidak ditemukan.' });
    emitDataChange('memori', 'api');
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

router.put('/memori/:id', uploadMemori.single('media'), handleMemoriUpdate);
router.patch('/memori/:id', uploadMemori.single('media'), handleMemoriUpdate);

router.delete('/memori/:id', (req, res) => {
  const deleted = memoriRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Catatan memori tidak ditemukan.' });
  emitDataChange('memori', 'api');
  return res.json({ ok: true });
});

/* ==================== MODUL 3B: WISHLIST & MOMEN ==================== */
router.get('/wishlist', (req, res) => {
  res.json(wishlistRepo.list({ tipe: req.query.tipe }));
});

router.post('/wishlist', (req, res) => {
  try {
    const created = wishlistRepo.create(req.body || {});
    emitDataChange('wishlist', 'api');
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function handleWishlistUpdate(req, res) {
  try {
    const updated = wishlistRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Item tidak ditemukan.' });
    emitDataChange('wishlist', 'api');
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

router.patch('/wishlist/:id', handleWishlistUpdate);
router.put('/wishlist/:id', handleWishlistUpdate);

router.delete('/wishlist/:id', (req, res) => {
  const deleted = wishlistRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Item tidak ditemukan.' });
  emitDataChange('wishlist', 'api');
  return res.json({ ok: true });
});

/* ==================== MODUL 5: QUICK VAULT ==================== */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.js', '.ts', '.py', '.html', '.css', '.log', '.xml', '.sql']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.opus']);

function enrichVaultItem(item) {
  if (!item) return item;
  if (item.tipe === 'FILE') {
    const absPath = resolveUploadPath(item.konten);
    const ext = path.extname(item.konten || '').toLowerCase();
    const extLabel = ext ? ext.slice(1).toUpperCase() : 'FILE';
    const fileName = path.basename(item.konten || 'file');

    let fileKind = 'DOC';
    if (IMAGE_EXTS.has(ext)) fileKind = 'IMAGE';
    else if (ext === '.pdf') fileKind = 'PDF';
    else if (TEXT_EXTS.has(ext)) fileKind = 'TEXT';
    else if (AUDIO_EXTS.has(ext)) fileKind = 'AUDIO';

    let fileSize = null;
    let previewSnippet = null;
    if (absPath && fs.existsSync(absPath)) {
      try {
        const stat = fs.statSync(absPath);
        fileSize = stat.size;
        if (fileKind === 'TEXT') {
          const fd = fs.openSync(absPath, 'r');
          try {
            const buf = Buffer.alloc(Math.min(stat.size, 600));
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
            previewSnippet = buf.subarray(0, bytesRead).toString('utf8').replace(/\0/g, '').trim();
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        // ignore stat/read errors
      }
    }

    return {
      ...item,
      file_kind: fileKind,
      file_ext: extLabel,
      file_name: fileName,
      file_size: fileSize,
      preview_url: `/${String(item.konten || '').replace(/^\/+/, '')}`,
      preview_snippet: previewSnippet,
      domain: null,
    };
  }

  let domain = null;
  let fileKind = 'NOTE';
  try {
    const u = new URL(item.konten);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      domain = u.hostname.replace(/^www\./i, '');
      fileKind = 'URL';
    }
  } catch {
    // plain text note
  }

  return {
    ...item,
    file_kind: fileKind,
    file_ext: fileKind,
    file_name: null,
    file_size: null,
    preview_url: null,
    preview_snippet: null,
    domain,
  };
}

router.get('/vault', (req, res) => {
  const rows = vaultRepo.list({ tipe: req.query.tipe, q: req.query.q });
  res.json(rows.map(enrichVaultItem));
});

router.post('/vault', uploadVault.single('file'), (req, res) => {
  try {
    if (req.file) {
      const created = vaultRepo.create({
        kata_kunci: req.body?.kata_kunci || req.file.originalname,
        konten: `uploads/vault/${req.file.filename}`,
        tipe: 'FILE',
      });
      emitDataChange('vault', 'api');
      return res.status(201).json(enrichVaultItem(created));
    }

    const created = vaultRepo.create({
      kata_kunci: req.body?.kata_kunci,
      konten: req.body?.konten,
      tipe: 'LINK',
    });
    emitDataChange('vault', 'api');
    return res.status(201).json(enrichVaultItem(created));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/vault/:id/download', (req, res) => {
  const item = vaultRepo.getById(req.params.id);
  if (!item || item.tipe !== 'FILE') {
    return res.status(404).json({ error: 'File vault tidak ditemukan.' });
  }
  const absPath = resolveUploadPath(item.konten);
  if (!absPath || !absPath.startsWith(VAULT_UPLOADS_DIR) || !fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'File fisik tidak tersedia di server.' });
  }
  return res.download(absPath, path.basename(absPath));
});

function handleVaultUpdate(req, res) {
  try {
    const updated = vaultRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Item vault tidak ditemukan.' });
    emitDataChange('vault', 'api');
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

router.put('/vault/:id', handleVaultUpdate);
router.patch('/vault/:id', handleVaultUpdate);

router.delete('/vault/:id', (req, res) => {
  const deleted = vaultRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Item vault tidak ditemukan.' });
  emitDataChange('vault', 'api');
  return res.json({ ok: true });
});

/* ==================== MODUL 6: KEUANGAN (PENGELUARAN & PEMASUKAN) ==================== */
router.get('/pengeluaran', (req, res) => {
  const parts = getWibParts();
  const month = req.query.month || (!req.query.tanggal_mulai && !req.query.tanggal_akhir ? parts.monthStr : undefined);

  const summary = pengeluaranRepo.getSummary({
    month,
    tanggal_mulai: req.query.tanggal_mulai,
    tanggal_akhir: req.query.tanggal_akhir,
  });

  const todaySummary = pengeluaranRepo.getSummary({
    tanggal_mulai: parts.dateStr,
    tanggal_akhir: parts.dateStr,
  });

  const weekStart = shiftDateStr(parts.dateStr, -6);
  const weekSummary = pengeluaranRepo.getSummary({
    tanggal_mulai: weekStart,
    tanggal_akhir: parts.dateStr,
  });

  const thisMonthSummary = pengeluaranRepo.getSummary({ month: parts.monthStr });

  res.json({
    ...summary,
    selectedMonth: month || null,
    categories: ALLOWED_CATEGORIES,
    incomeCategories: INCOME_CATEGORIES,
    budget: budgetRepo.get(),
    todayTotal: todaySummary.totalExpense,
    todayIncome: todaySummary.totalIncome,
    weekTotal: weekSummary.totalExpense,
    weekIncome: weekSummary.totalIncome,
    monthTotal: thisMonthSummary.totalExpense,
    monthIncome: thisMonthSummary.totalIncome,
    monthBalance: thisMonthSummary.balance,
  });
});

router.get('/pengeluaran/export', (req, res) => {
  const parts = getWibParts();
  const month = req.query.month || (!req.query.tanggal_mulai && !req.query.tanggal_akhir ? parts.monthStr : undefined);
  const summary = pengeluaranRepo.getSummary({
    month,
    tanggal_mulai: req.query.tanggal_mulai,
    tanggal_akhir: req.query.tanggal_akhir,
  });

  const csvEscape = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = [
    ['Tanggal', 'Tipe', 'Item', 'Kategori', 'Nominal (Rp)'],
    ...summary.items.map((item) => [
      item.tanggal,
      item.tipe === 'PEMASUKAN' ? 'Pemasukan' : 'Pengeluaran',
      item.item,
      item.kategori,
      item.nominal,
    ]),
    [],
    ['RINGKASAN', 'Total Pemasukan', '', '', summary.totalIncome],
    ['RINGKASAN', 'Total Pengeluaran', '', '', summary.totalExpense],
    ['RINGKASAN', 'Saldo Bersih', '', '', summary.balance],
  ];

  const csvBody = '\uFEFF' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const suffix = month || `${req.query.tanggal_mulai || parts.dateStr}_to_${req.query.tanggal_akhir || parts.dateStr}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="keuangan-${suffix}.csv"`);
  res.send(csvBody);
});

router.post('/pengeluaran', (req, res) => {
  try {
    if (Array.isArray(req.body?.items)) {
      const created = pengeluaranRepo.createMany(req.body.items, req.body.tanggal, req.body.tipe);
      emitDataChange('pengeluaran', 'api');
      if (created.some((x) => x.tipe !== 'PEMASUKAN')) {
        const month = (created[0]?.tanggal || getWibParts().dateStr).slice(0, 7);
        checkBudgetThresholds(month).catch(() => {});
      }
      return res.status(201).json(created);
    }
    const created = pengeluaranRepo.create(req.body || {});
    emitDataChange('pengeluaran', 'api');
    if (created.tipe !== 'PEMASUKAN') {
      checkBudgetThresholds((created.tanggal || getWibParts().dateStr).slice(0, 7)).catch(() => {});
    }
    return res.status(201).json(created);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/pengeluaran/:id', (req, res) => {
  const deleted = pengeluaranRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Catatan keuangan tidak ditemukan.' });
  emitDataChange('pengeluaran', 'api');
  return res.json({ ok: true });
});

/* ==================== BUDGET BULANAN ==================== */
router.get('/budgets', (_req, res) => {
  res.json(budgetRepo.get());
});

router.put('/budgets', (req, res) => {
  try {
    const updated = budgetRepo.update(req.body || {});
    emitDataChange('pengeluaran', 'api');
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ==================== GLOBAL SPOTLIGHT SEARCH ==================== */
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Number(req.query.limit) || 6;
  res.json(globalSearch(q, limit));
});

/* ==================== QUICK REMINDERS (/r) ==================== */
router.get('/reminders', (req, res) => {
  const selesai = req.query.selesai !== undefined ? req.query.selesai : 0;
  res.json(reminderRepo.list({ selesai }));
});

router.post('/reminders', (req, res) => {
  try {
    const pesan = String(req.body?.pesan || '').trim();
    let triggerAt = req.body?.trigger_at;
    if (!triggerAt && req.body?.menit) {
      const mins = Math.max(1, Math.min(1440, Math.round(Number(req.body.menit))));
      triggerAt = addMinutesWib(mins).dateTimeStr;
    }
    const created = reminderRepo.create({
      pesan,
      trigger_at: triggerAt,
      ring_loud: req.body?.ring_loud ? 1 : 0,
    });
    emitDataChange('reminder', 'api');
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/reminders/:id', (req, res) => {
  const deleted = reminderRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Pengingat tidak ditemukan.' });
  emitDataChange('reminder', 'api');
  res.json({ ok: true });
});

/* ==================== HABIT TRACKER & STREAK GRID ==================== */
router.get('/habits', (req, res) => {
  const days = Math.max(7, Math.min(90, Number(req.query.days) || 56));
  res.json(habitRepo.getDashboardData(days));
});

router.post('/habits', (req, res) => {
  try {
    const created = habitRepo.create(req.body || {});
    emitDataChange('habits', 'api');
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/habits/:id/toggle', (req, res) => {
  const tanggal = req.body?.tanggal || getWibParts().dateStr;
  const result = habitRepo.toggleDate(req.params.id, tanggal);
  if (!result) return res.status(404).json({ error: 'Habit tidak ditemukan.' });
  emitDataChange('habits', 'api');
  res.json(result);
});

router.delete('/habits/:id', (req, res) => {
  const deleted = habitRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Habit tidak ditemukan.' });
  emitDataChange('habits', 'api');
  res.json({ ok: true });
});

/* ==================== FOCUS / POMODORO TIMER ==================== */
router.get('/focus', (_req, res) => {
  const now = new Date();
  const active = focusRepo.getActive();
  const stats = focusRepo.getTodayStats(now);
  res.json({
    active,
    stats,
    serverNowIso: now.toISOString(),
  });
});

router.post('/focus/start', (req, res) => {
  try {
    const session = focusRepo.start({
      label: req.body?.label || 'Sesi Fokus',
      durationMinutes: req.body?.durationMinutes || 25,
    });
    emitDataChange('focus', 'api');
    res.status(201).json({ active: session, stats: focusRepo.getTodayStats(), serverNowIso: new Date().toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/focus/stop', (_req, res) => {
  focusRepo.stop();
  emitDataChange('focus', 'api');
  res.json({ ok: true, active: null, stats: focusRepo.getTodayStats() });
});

/* ==================== AI PARTNER GIFT/DATE IDEAS & MONTHLY RECAP ==================== */
router.post('/memori/ai-ideas', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || 'Berikan rekomendasi ide kado dan ide date untuk pacar saya').trim();
    const memories = memoriRepo.list({ limit: 25 });
    const wishlists = wishlistRepo.list({ tipe: 'WISHLIST' });
    const moments = wishlistRepo.getUpcomingMoments(60);
    const content = await generatePartnerIdeas(prompt, { memories, wishlists, moments });
    res.json({ content, memoriesUsed: memories.length, wishlistsUsed: wishlists.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/memori/monthly-recap', async (_req, res) => {
  try {
    const parts = getWibParts();
    const sinceDate = shiftDateStr(parts.dateStr, -30);
    const memories = memoriRepo.list({ tanggal_mulai: sinceDate, tanggal_akhir: parts.dateStr, limit: 35 });
    const content = await generateMonthlyPartnerRecap(memories, `30 Hari Terakhir (${sinceDate} s/d ${parts.dateStr})`);
    res.json({ content, count: memories.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==================== SECURITY & ACCESS AUDIT LOGS ==================== */
router.get('/audit-logs', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const event = req.query.event ? String(req.query.event).trim() : 'all';
  res.json({
    logs: auditRepo.list({ event, limit }),
    stats: auditRepo.getStats(),
  });
});

router.delete('/audit-logs', (_req, res) => {
  auditRepo.clear();
  emitDataChange('audit', 'api');
  res.json({ ok: true });
});

/* ==================== FITUR 1: CATATAN KULIAH & IDE (VOICE-TO-NOTES) ==================== */
router.get('/catatan', (req, res) => {
  const items = catatanRepo.list({
    kategori: req.query.kategori,
    q: req.query.q,
  });
  const categories = catatanRepo.getCategories();
  res.json({ items, categories, total: items.length });
});

router.post('/catatan', (req, res) => {
  try {
    const created = catatanRepo.create(req.body || {});
    emitDataChange('catatan', 'api');
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function handleCatatanUpdate(req, res) {
  try {
    const updated = catatanRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Catatan tidak ditemukan.' });
    emitDataChange('catatan', 'api');
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

router.put('/catatan/:id', handleCatatanUpdate);
router.patch('/catatan/:id', handleCatatanUpdate);

router.delete('/catatan/:id', (req, res) => {
  const deleted = catatanRepo.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Catatan tidak ditemukan.' });
  emitDataChange('catatan', 'api');
  return res.json({ ok: true });
});

/* ==================== FITUR 2: SYSTEM & AI TELEMETRY ==================== */
function getDbSizeBytes() {
  let total = 0;
  for (const p of [DB_PATH, `${DB_PATH}-wal`]) {
    try {
      if (fs.existsSync(p)) total += fs.statSync(p).size;
    } catch {
      // ignore stat errors
    }
  }
  return total;
}

function buildTelemetryPayload() {
  const aiToday = aiLogRepo.getTodayTelemetry();
  const mem = process.memoryUsage();
  return {
    ai: {
      ...aiToday,
      activeModel: getActiveModelName(),
      primaryGeminiModel: PRIMARY_GEMINI_MODEL,
      geminiConfigured: isGeminiApiConfigured(),
      groqConfigured: isGroqConfigured(),
    },
    server: {
      uptimeSeconds: Math.round(process.uptime()),
      ramRssBytes: mem.rss,
      ramHeapBytes: mem.heapUsed,
      ramHeapTotalBytes: mem.heapTotal,
      dbSizeBytes: getDbSizeBytes(),
      nodeVersion: process.version,
    },
  };
}

router.get('/telemetry', (_req, res) => {
  res.json(buildTelemetryPayload());
});

router.post('/telemetry/test-ai', async (_req, res) => {
  try {
    const test = await testAiEngines();
    emitDataChange('telemetry', 'api');
    res.json({
      test,
      telemetry: buildTelemetryPayload(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==================== FITUR 3: SMART DATE & GIFT PLANNER ==================== */
router.post('/pacar/rekomendasi', async (req, res) => {
  try {
    const modeRaw = String(req.body?.mode || 'auto').toLowerCase();
    const mode = ['date', 'gift', 'auto'].includes(modeRaw) ? modeRaw : 'auto';
    const rawBudget = req.body?.budget !== undefined && req.body?.budget !== null && req.body?.budget !== ''
      ? Number(String(req.body.budget).replace(/[^\d]/g, ''))
      : null;
    const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : null;
    const prompt = String(req.body?.prompt || '').trim();

    const memories = memoriRepo.list({ limit: 15 });
    const unfulfilledAll = wishlistRepo.list().filter((item) => !item.terpenuhi);
    const wishlists = unfulfilledAll.filter((item) => item.tipe === 'WISHLIST');
    const moments = unfulfilledAll.filter((item) => item.tipe === 'MOMEN');

    const content = await generatePartnerRecommendation({
      prompt,
      mode,
      budget,
      memories,
      wishlists,
      moments,
      noEmoji: true,
    });

    emitDataChange('telemetry', 'api');
    res.json({
      content,
      mode,
      budget,
      memoriesUsed: memories.length,
      wishlistsUsed: wishlists.length,
      momentsUsed: moments.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==================== FITUR 4: CALENDAR SYNC METADATA ==================== */
router.get('/calendar/info', (_req, res) => {
  const token = getCalendarFeedToken();
  const schedules = jadwalRepo.list({ aktif: 1 });
  const tasks = tugasRepo.list({ selesai: 0 });
  res.json({
    token,
    path: `/api/calendar.ics?token=${encodeURIComponent(token)}`,
    jadwalCount: schedules.length,
    tugasCount: tasks.length,
  });
});

/* ==================== API ERROR HANDLER ==================== */
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload gagal: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Terjadi kesalahan pada server.' });
  }
  return res.status(500).json({ error: 'Internal Server Error' });
});

export default router;
