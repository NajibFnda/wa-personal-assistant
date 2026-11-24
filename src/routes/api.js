import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_CATEGORIES,
  INCOME_CATEGORIES,
  MEMORI_UPLOADS_DIR,
  PROJECT_ROOT,
  VAULT_UPLOADS_DIR,
  createConsistentBackup,
  getDatabaseStats,
  jadwalRepo,
  memoriRepo,
  pengeluaranRepo,
  pushRepo,
  resolveUploadPath,
  settingsRepo,
  tugasRepo,
  vaultRepo,
  wishlistRepo,
} from '../config/db.js';
import { emitDataChange, onDataChange } from '../services/events.js';
import { getActiveModelName, isGeminiConfigured } from '../services/gemini.js';
import { isWebPushConfigured, sendDualNotification } from '../services/notifier.js';
import { reloadScheduler, runMorningBriefing, runWeeklyBackup } from '../services/scheduler.js';
import {
  getWhatsAppStatus,
  initWhatsApp,
  logoutWhatsApp,
} from '../services/whatsapp.js';
import { formatCountdown, getWibParts, shiftDateStr } from '../utils/time.js';

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
    return res.status(401).json({ error: 'PIN salah. Silakan coba lagi.' });
  }
  const token = derivePinToken(pin);
  res.setHeader(
    'Set-Cookie',
    `assistant_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
  return res.json({ authenticated: true });
});

router.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'assistant_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
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
    todayTotal: todaySummary.totalExpense,
    todayIncome: todaySummary.totalIncome,
    weekTotal: weekSummary.totalExpense,
    weekIncome: weekSummary.totalIncome,
    monthTotal: thisMonthSummary.totalExpense,
    monthIncome: thisMonthSummary.totalIncome,
    monthBalance: thisMonthSummary.balance,
  });
});

router.post('/pengeluaran', (req, res) => {
  try {
    if (Array.isArray(req.body?.items)) {
      const created = pengeluaranRepo.createMany(req.body.items, req.body.tanggal, req.body.tipe);
      emitDataChange('pengeluaran', 'api');
      return res.status(201).json(created);
    }
    const created = pengeluaranRepo.create(req.body || {});
    emitDataChange('pengeluaran', 'api');
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
