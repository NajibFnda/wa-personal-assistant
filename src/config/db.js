import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDaysUntilMoment,
  getHariFromDateStr,
  getWibParts,
  normalizeDateStr,
  normalizeDeadline,
  normalizeHari,
  normalizeJam,
  shiftDateStr,
} from '../utils/time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(PROJECT_ROOT, 'assistant.db');
export const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(PROJECT_ROOT, 'uploads');
export const MEMORI_UPLOADS_DIR = path.join(UPLOADS_DIR, 'memori');
export const VAULT_UPLOADS_DIR = path.join(UPLOADS_DIR, 'vault');

export function resolveUploadPath(relPath) {
  if (!relPath) return null;
  const normalized = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('uploads/')) {
    return path.resolve(UPLOADS_DIR, normalized.slice('uploads/'.length));
  }
  return path.resolve(PROJECT_ROOT, normalized);
}

for (const dir of [UPLOADS_DIR, MEMORI_UPLOADS_DIR, VAULT_UPLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize PRD schema + internal persistent app_state table
db.exec(`
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

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waktu TEXT NOT NULL,
    event TEXT NOT NULL,
    ip TEXT,
    lokasi TEXT DEFAULT 'Mencari lokasi...',
    device TEXT,
    device_type TEXT DEFAULT 'desktop',
    user_agent TEXT,
    path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS quick_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pesan TEXT NOT NULL,
    trigger_at TEXT NOT NULL,
    selesai INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    target_harian TEXT DEFAULT '',
    aktif INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS habit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL,
    tanggal TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(habit_id, tanggal),
    FOREIGN KEY(habit_id) REFERENCES habits(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    durasi_menit INTEGER NOT NULL,
    selesai_pada TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS catatan_kuliah (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    judul TEXT NOT NULL,
    kategori TEXT DEFAULT 'Umum',
    ringkasan TEXT NOT NULL,
    sumber_tipe TEXT DEFAULT 'TEXT',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanggal TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    model TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS presensi_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jadwal_id INTEGER,
    nama TEXT NOT NULL,
    tanggal TEXT NOT NULL,
    jam_awal TEXT NOT NULL,
    interval_menit INTEGER DEFAULT 20,
    next_trigger_at TEXT NOT NULL,
    repeat_count INTEGER DEFAULT 1,
    acknowledged INTEGER DEFAULT 0,
    acknowledged_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Non-destructive column migrations for existing databases
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('jadwal', 'repeat_until_ok', 'INTEGER DEFAULT 1');
ensureColumn('jadwal', 'repeat_interval_min', 'INTEGER DEFAULT 20');
ensureColumn('memori_pacar', 'deskripsi', "TEXT DEFAULT ''");
ensureColumn('momen_wishlist', 'notif_days', "TEXT DEFAULT ''");
ensureColumn('momen_wishlist', 'notif_jam', "TEXT DEFAULT ''");
ensureColumn('momen_wishlist', 'ulang', "TEXT DEFAULT 'TAHUNAN'");
ensureColumn('pengeluaran', 'tipe', "TEXT DEFAULT 'PENGELUARAN'");

export function normalizeRecurrence(input) {
  const up = String(input || '').trim().toUpperCase();
  if (up === 'BULANAN' || up === 'MONTHLY') return 'BULANAN';
  if (up === 'SEKALI' || up === 'ONCE') return 'SEKALI';
  return 'TAHUNAN';
}

export const DEFAULT_NOTIFICATION_SETTINGS = {
  momentDefaultDays: [7, 3, 1],
  momentDefaultTime: '08:00',
  morningBriefingEnabled: true,
  morningBriefingTime: '06:00',
  taskFirstReminderHours: 24,
  taskSecondReminderHours: 3,
  weeklyBackupEnabled: true,
  weeklyBackupDay: 0, // 0 = Minggu ... 6 = Sabtu
  weeklyBackupTime: '23:00',
};

export function parseNotifDays(input, fallback = []) {
  if (Array.isArray(input)) {
    const nums = [...new Set(input.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))];
    return nums.sort((a, b) => b - a);
  }
  if (typeof input === 'string' && input.trim()) {
    const nums = [
      ...new Set(
        input
          .split(/[,\s]+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365)
      ),
    ];
    return nums.length ? nums.sort((a, b) => b - a) : fallback;
  }
  return fallback;
}

export function formatNotifDaysCsv(input) {
  const arr = parseNotifDays(input, []);
  return arr.length ? arr.join(',') : '';
}

export const ALLOWED_CATEGORIES = [
  'Makan & Minum',
  'Transportasi',
  'Akademik',
  'Hiburan',
  'Lainnya',
];

export const INCOME_CATEGORIES = [
  'Uang Saku',
  'Gaji & Freelance',
  'Beasiswa',
  'Hadiah & Bonus',
  'Lainnya',
];

export function normalizeFinanceType(tipe) {
  const up = String(tipe || '').trim().toUpperCase();
  if (up === 'PEMASUKAN' || up === 'INCOME' || up === 'MASUK') return 'PEMASUKAN';
  return 'PENGELUARAN';
}

export function normalizeCategory(kategori) {
  if (!kategori || typeof kategori !== 'string') return 'Lainnya';
  const lower = kategori.trim().toLowerCase();
  if (lower.includes('makan') || lower.includes('minum') || lower.includes('food') || lower.includes('kopi')) {
    return 'Makan & Minum';
  }
  if (lower.includes('transport') || lower.includes('bensin') || lower.includes('ojek') || lower.includes('parkir') || lower.includes('grab') || lower.includes('gojek')) {
    return 'Transportasi';
  }
  if (lower.includes('akademik') || lower.includes('kuliah') || lower.includes('buku') || lower.includes('print') || lower.includes('fotokopi')) {
    return 'Akademik';
  }
  if (lower.includes('hibur') || lower.includes('game') || lower.includes('nonton') || lower.includes('jalan') || lower.includes('pacar') || lower.includes('date')) {
    return 'Hiburan';
  }
  const exact = ALLOWED_CATEGORIES.find((c) => c.toLowerCase() === lower);
  return exact || 'Lainnya';
}

export function normalizeIncomeCategory(kategori) {
  if (!kategori || typeof kategori !== 'string') return 'Lainnya';
  const lower = kategori.trim().toLowerCase();
  if (lower.includes('saku') || lower.includes('kiriman') || lower.includes('ortu') || lower.includes('orang tua') || lower.includes('jajan') || lower.includes('bulanan')) {
    return 'Uang Saku';
  }
  if (lower.includes('gaji') || lower.includes('freelance') || lower.includes('proyek') || lower.includes('project') || lower.includes('kerja') || lower.includes('honor') || lower.includes('upah') || lower.includes('jual')) {
    return 'Gaji & Freelance';
  }
  if (lower.includes('beasiswa') || lower.includes('kip') || lower.includes('bantuan') || lower.includes('hibah')) {
    return 'Beasiswa';
  }
  if (lower.includes('hadiah') || lower.includes('bonus') || lower.includes('thr') || lower.includes('cashback') || lower.includes('kado') || lower.includes('angpao') || lower.includes('menang')) {
    return 'Hadiah & Bonus';
  }
  const exact = INCOME_CATEGORIES.find((c) => c.toLowerCase() === lower);
  return exact || 'Lainnya';
}

/* ==================== APP STATE ==================== */
export const stateRepo = {
  get(key) {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, String(value));
  },
  getJson(key, fallback = null) {
    const raw = this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  setJson(key, obj) {
    this.set(key, JSON.stringify(obj));
  },
};

/* ==================== NOTIFICATION SETTINGS ==================== */
export const settingsRepo = {
  getNotificationSettings() {
    const saved = stateRepo.getJson('notification_settings', {}) || {};
    const momentDefaultDays = parseNotifDays(
      saved.momentDefaultDays,
      DEFAULT_NOTIFICATION_SETTINGS.momentDefaultDays
    );
    const momentDefaultTime =
      normalizeJam(saved.momentDefaultTime) || DEFAULT_NOTIFICATION_SETTINGS.momentDefaultTime;
    const morningBriefingTime =
      normalizeJam(saved.morningBriefingTime) || DEFAULT_NOTIFICATION_SETTINGS.morningBriefingTime;
    const weeklyBackupTime =
      normalizeJam(saved.weeklyBackupTime) || DEFAULT_NOTIFICATION_SETTINGS.weeklyBackupTime;

    const firstH = Number(saved.taskFirstReminderHours);
    const secondH = Number(saved.taskSecondReminderHours);
    const backupDay = Number(saved.weeklyBackupDay);

    return {
      momentDefaultDays: momentDefaultDays.length
        ? momentDefaultDays
        : [...DEFAULT_NOTIFICATION_SETTINGS.momentDefaultDays],
      momentDefaultTime,
      morningBriefingEnabled:
        saved.morningBriefingEnabled !== undefined
          ? Boolean(saved.morningBriefingEnabled)
          : DEFAULT_NOTIFICATION_SETTINGS.morningBriefingEnabled,
      morningBriefingTime,
      taskFirstReminderHours:
        Number.isFinite(firstH) && firstH >= 1 && firstH <= 168
          ? Math.round(firstH)
          : DEFAULT_NOTIFICATION_SETTINGS.taskFirstReminderHours,
      taskSecondReminderHours:
        Number.isFinite(secondH) && secondH >= 1 && secondH <= 72
          ? Math.round(secondH)
          : DEFAULT_NOTIFICATION_SETTINGS.taskSecondReminderHours,
      weeklyBackupEnabled:
        saved.weeklyBackupEnabled !== undefined
          ? Boolean(saved.weeklyBackupEnabled)
          : DEFAULT_NOTIFICATION_SETTINGS.weeklyBackupEnabled,
      weeklyBackupDay:
        Number.isInteger(backupDay) && backupDay >= 0 && backupDay <= 6
          ? backupDay
          : DEFAULT_NOTIFICATION_SETTINGS.weeklyBackupDay,
      weeklyBackupTime,
    };
  },

  updateNotificationSettings(patch = {}) {
    const current = this.getNotificationSettings();
    const next = { ...current };

    if (patch.momentDefaultDays !== undefined) {
      const parsed = parseNotifDays(patch.momentDefaultDays, []);
      if (!parsed.length) {
        throw new Error('Pilih minimal satu hari pengingat momen (misal H-7, H-3, H-1).');
      }
      next.momentDefaultDays = parsed;
    }
    if (patch.momentDefaultTime !== undefined) {
      const jam = normalizeJam(patch.momentDefaultTime);
      if (!jam) throw new Error('Format jam notifikasi momen tidak valid (HH:MM).');
      next.momentDefaultTime = jam;
    }
    if (patch.morningBriefingEnabled !== undefined) {
      next.morningBriefingEnabled = Boolean(patch.morningBriefingEnabled);
    }
    if (patch.morningBriefingTime !== undefined) {
      const jam = normalizeJam(patch.morningBriefingTime);
      if (!jam) throw new Error('Format jam Morning Briefing tidak valid (HH:MM).');
      next.morningBriefingTime = jam;
    }
    if (patch.taskFirstReminderHours !== undefined) {
      const h = Math.round(Number(patch.taskFirstReminderHours));
      if (!Number.isFinite(h) || h < 1 || h > 168) {
        throw new Error('Pengingat tugas pertama harus antara 1 sampai 168 jam.');
      }
      next.taskFirstReminderHours = h;
    }
    if (patch.taskSecondReminderHours !== undefined) {
      const h = Math.round(Number(patch.taskSecondReminderHours));
      if (!Number.isFinite(h) || h < 1 || h > 72) {
        throw new Error('Pengingat tugas kedua harus antara 1 sampai 72 jam.');
      }
      next.taskSecondReminderHours = h;
    }
    if (next.taskSecondReminderHours >= next.taskFirstReminderHours) {
      throw new Error('Jam pengingat tugas kedua (mendesak) harus lebih kecil dari pengingat pertama.');
    }
    if (patch.weeklyBackupEnabled !== undefined) {
      next.weeklyBackupEnabled = Boolean(patch.weeklyBackupEnabled);
    }
    if (patch.weeklyBackupDay !== undefined) {
      const d = Number(patch.weeklyBackupDay);
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        throw new Error('Hari auto-backup harus antara 0 (Minggu) hingga 6 (Sabtu).');
      }
      next.weeklyBackupDay = d;
    }
    if (patch.weeklyBackupTime !== undefined) {
      const jam = normalizeJam(patch.weeklyBackupTime);
      if (!jam) throw new Error('Format jam auto-backup tidak valid (HH:MM).');
      next.weeklyBackupTime = jam;
    }

    stateRepo.setJson('notification_settings', next);
    return next;
  },
};

/* ==================== MODUL 1: JADWAL ==================== */
export const jadwalRepo = {
  list({ aktif, is_rutin } = {}) {
    const conditions = [];
    const params = [];
    if (aktif !== undefined && aktif !== null && aktif !== '') {
      conditions.push('aktif = ?');
      params.push(Number(aktif) ? 1 : 0);
    }
    if (is_rutin !== undefined && is_rutin !== null && is_rutin !== '') {
      conditions.push('is_rutin = ?');
      params.push(Number(is_rutin) ? 1 : 0);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db
      .prepare(
        `SELECT * FROM jadwal ${where}
         ORDER BY aktif DESC, is_rutin DESC,
         CASE hari
           WHEN 'Senin' THEN 1 WHEN 'Selasa' THEN 2 WHEN 'Rabu' THEN 3
           WHEN 'Kamis' THEN 4 WHEN 'Jumat' THEN 5 WHEN 'Sabtu' THEN 6
           WHEN 'Minggu' THEN 7 ELSE 8 END,
         tanggal ASC, jam ASC`
      )
      .all(...params);
  },

  getById(id) {
    return db.prepare('SELECT * FROM jadwal WHERE id = ?').get(Number(id));
  },

  create({
    nama,
    hari = null,
    tanggal = null,
    jam,
    is_rutin = 1,
    aktif = 1,
    repeat_until_ok,
    repeat_interval_min = 20,
  }) {
    const cleanNama = String(nama || '').trim();
    const cleanJam = normalizeJam(jam);
    if (!cleanNama) throw new Error('Nama jadwal wajib diisi.');
    if (!cleanJam) throw new Error('Format jam tidak valid (gunakan HH:MM).');

    const rutinFlag = is_rutin === false || Number(is_rutin) === 0 ? 0 : 1;
    let cleanHari = normalizeHari(hari);
    let cleanTanggal = normalizeDateStr(tanggal);

    if (rutinFlag === 1) {
      if (!cleanHari) {
        cleanHari = cleanTanggal ? getHariFromDateStr(cleanTanggal) : getWibParts().hari;
      }
      cleanTanggal = null;
    } else {
      if (!cleanTanggal) {
        cleanTanggal = getWibParts().dateStr;
      }
      cleanHari = getHariFromDateStr(cleanTanggal);
    }

    const aktifFlag = aktif === false || Number(aktif) === 0 ? 0 : 1;
    const defaultRepeat = /\(Snooze\)/i.test(cleanNama) ? 0 : 1;
    const repeatFlag =
      repeat_until_ok === undefined || repeat_until_ok === null
        ? defaultRepeat
        : repeat_until_ok === false || Number(repeat_until_ok) === 0
          ? 0
          : 1;
    const rawInterval = Number(repeat_interval_min);
    const intervalMin = Number.isFinite(rawInterval) && rawInterval >= 1 && rawInterval <= 180 ? Math.round(rawInterval) : 20;

    const result = db
      .prepare(
        'INSERT INTO jadwal (nama, hari, tanggal, jam, is_rutin, aktif, repeat_until_ok, repeat_interval_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(cleanNama, cleanHari, cleanTanggal, cleanJam, rutinFlag, aktifFlag, repeatFlag, intervalMin);
    return this.getById(result.lastInsertRowid);
  },

  update(id, fields) {
    const existing = this.getById(id);
    if (!existing) return null;

    const nama = fields.nama !== undefined ? String(fields.nama).trim() : existing.nama;
    const jam = fields.jam !== undefined ? normalizeJam(fields.jam) : existing.jam;
    if (!nama) throw new Error('Nama jadwal wajib diisi.');
    if (!jam) throw new Error('Format jam tidak valid (gunakan HH:MM).');

    const is_rutin =
      fields.is_rutin !== undefined
        ? fields.is_rutin === false || Number(fields.is_rutin) === 0
          ? 0
          : 1
        : existing.is_rutin;

    const aktif =
      fields.aktif !== undefined
        ? fields.aktif === false || Number(fields.aktif) === 0
          ? 0
          : 1
        : existing.aktif;

    const repeat_until_ok =
      fields.repeat_until_ok !== undefined
        ? fields.repeat_until_ok === false || Number(fields.repeat_until_ok) === 0
          ? 0
          : 1
        : existing.repeat_until_ok !== undefined && existing.repeat_until_ok !== null
          ? Number(existing.repeat_until_ok)
          : 1;

    const rawInt = fields.repeat_interval_min !== undefined ? Number(fields.repeat_interval_min) : Number(existing.repeat_interval_min);
    const repeat_interval_min = Number.isFinite(rawInt) && rawInt >= 1 && rawInt <= 180 ? Math.round(rawInt) : 20;

    let hari = fields.hari !== undefined ? normalizeHari(fields.hari) : existing.hari;
    let tanggal = fields.tanggal !== undefined ? normalizeDateStr(fields.tanggal) : existing.tanggal;

    if (is_rutin === 1) {
      if (!hari) hari = tanggal ? getHariFromDateStr(tanggal) : getWibParts().hari;
      tanggal = null;
    } else {
      if (!tanggal) tanggal = getWibParts().dateStr;
      hari = getHariFromDateStr(tanggal);
    }

    db.prepare(
      'UPDATE jadwal SET nama = ?, hari = ?, tanggal = ?, jam = ?, is_rutin = ?, aktif = ?, repeat_until_ok = ?, repeat_interval_min = ? WHERE id = ?'
    ).run(nama, hari, tanggal, jam, is_rutin, aktif, repeat_until_ok, repeat_interval_min, Number(id));
    return this.getById(id);
  },

  deactivate(id) {
    db.prepare('UPDATE jadwal SET aktif = 0 WHERE id = ?').run(Number(id));
  },

  remove(id) {
    const res = db.prepare('DELETE FROM jadwal WHERE id = ?').run(Number(id));
    return res.changes > 0;
  },

  getDueSchedules(hari, tanggal, jam) {
    return db
      .prepare(
        `SELECT * FROM jadwal
         WHERE aktif = 1 AND jam = ?
         AND (
           (is_rutin = 1 AND lower(hari) = lower(?))
           OR (is_rutin = 0 AND tanggal = ?)
         )`
      )
      .all(jam, hari, tanggal);
  },

  getTodaySchedules(hari, tanggal) {
    return db
      .prepare(
        `SELECT * FROM jadwal
         WHERE aktif = 1
         AND (
           (is_rutin = 1 AND lower(hari) = lower(?))
           OR (is_rutin = 0 AND tanggal = ?)
         )
         ORDER BY jam ASC`
      )
      .all(hari, tanggal);
  },
};

/* ==================== PRESENSI BERULANG SAMPAI BALAS OK ==================== */
export const presensiPendingRepo = {
  listActive() {
    return db
      .prepare('SELECT * FROM presensi_pending WHERE acknowledged = 0 ORDER BY next_trigger_at ASC, id ASC')
      .all();
  },

  getById(id) {
    return db.prepare('SELECT * FROM presensi_pending WHERE id = ?').get(Number(id));
  },

  create({ jadwal_id = null, nama, tanggal, jam_awal, interval_menit = 20, next_trigger_at }) {
    const cleanNama = String(nama || '').trim();
    const cleanTanggal = normalizeDateStr(tanggal) || getWibParts().dateStr;
    const cleanJam = normalizeJam(jam_awal) || getWibParts().timeStr;
    const cleanNext = normalizeDeadline(next_trigger_at);
    const interval = Math.max(1, Math.min(180, Math.round(Number(interval_menit) || 20)));
    if (!cleanNama || !cleanNext) throw new Error('Data pengingat presensi berulang tidak valid.');

    // Prevent duplicate active pending loop for the same schedule on the same day
    if (jadwal_id) {
      const existing = db
        .prepare('SELECT * FROM presensi_pending WHERE jadwal_id = ? AND tanggal = ? AND acknowledged = 0')
        .get(Number(jadwal_id), cleanTanggal);
      if (existing) return existing;
    }

    const res = db
      .prepare(
        `INSERT INTO presensi_pending (jadwal_id, nama, tanggal, jam_awal, interval_menit, next_trigger_at, repeat_count, acknowledged)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
      )
      .run(jadwal_id ? Number(jadwal_id) : null, cleanNama, cleanTanggal, cleanJam, interval, cleanNext);
    return this.getById(res.lastInsertRowid);
  },

  getDue(nowDateTimeStr) {
    return db
      .prepare('SELECT * FROM presensi_pending WHERE acknowledged = 0 AND next_trigger_at <= ? ORDER BY next_trigger_at ASC, id ASC')
      .all(nowDateTimeStr);
  },

  bumpRepeat(id, nextTriggerAt, nextCount) {
    const cleanNext = normalizeDeadline(nextTriggerAt);
    if (!cleanNext) return null;
    db.prepare('UPDATE presensi_pending SET next_trigger_at = ?, repeat_count = ? WHERE id = ?').run(
      cleanNext,
      Math.max(1, Number(nextCount) || 1),
      Number(id)
    );
    return this.getById(id);
  },

  acknowledgeById(id, ackAt = getWibParts().dateTimeStr) {
    const existing = this.getById(id);
    if (!existing || existing.acknowledged) return null;
    db.prepare('UPDATE presensi_pending SET acknowledged = 1, acknowledged_at = ? WHERE id = ?').run(
      String(ackAt || ''),
      Number(id)
    );
    return this.getById(id);
  },

  acknowledgeAll(ackAt = getWibParts().dateTimeStr) {
    const active = this.listActive();
    if (!active.length) return [];
    db.prepare('UPDATE presensi_pending SET acknowledged = 1, acknowledged_at = ? WHERE acknowledged = 0').run(
      String(ackAt || '')
    );
    return active;
  },
};

/* ==================== MODUL 2: TUGAS ==================== */
export const tugasRepo = {
  list({ selesai } = {}) {
    if (selesai !== undefined && selesai !== null && selesai !== '') {
      const flag = Number(selesai) ? 1 : 0;
      return db
        .prepare('SELECT * FROM tugas WHERE selesai = ? ORDER BY deadline ASC, id DESC')
        .all(flag);
    }
    return db
      .prepare('SELECT * FROM tugas ORDER BY selesai ASC, deadline ASC, id DESC')
      .all();
  },

  getById(id) {
    return db.prepare('SELECT * FROM tugas WHERE id = ?').get(Number(id));
  },

  create({ judul, matkul = '', deadline }) {
    const cleanJudul = String(judul || '').trim();
    const cleanDeadline = normalizeDeadline(deadline);
    if (!cleanJudul) throw new Error('Judul tugas wajib diisi.');
    if (!cleanDeadline) throw new Error('Format deadline tidak valid (YYYY-MM-DD HH:MM).');

    const res = db
      .prepare('INSERT INTO tugas (judul, matkul, deadline) VALUES (?, ?, ?)')
      .run(cleanJudul, String(matkul || '').trim(), cleanDeadline);
    return this.getById(res.lastInsertRowid);
  },

  update(id, fields) {
    const existing = this.getById(id);
    if (!existing) return null;

    const judul = fields.judul !== undefined ? String(fields.judul).trim() : existing.judul;
    const matkul = fields.matkul !== undefined ? String(fields.matkul || '').trim() : existing.matkul;
    const deadline =
      fields.deadline !== undefined ? normalizeDeadline(fields.deadline) : existing.deadline;
    if (!judul) throw new Error('Judul tugas wajib diisi.');
    if (!deadline) throw new Error('Format deadline tidak valid.');

    const selesai =
      fields.selesai !== undefined
        ? fields.selesai === true || Number(fields.selesai) === 1
          ? 1
          : 0
        : existing.selesai;

    const notif_h1 =
      fields.deadline !== undefined && deadline !== existing.deadline
        ? 0
        : existing.notif_h1;
    const notif_h3jam =
      fields.deadline !== undefined && deadline !== existing.deadline
        ? 0
        : existing.notif_h3jam;

    db.prepare(
      'UPDATE tugas SET judul = ?, matkul = ?, deadline = ?, selesai = ?, notif_h1 = ?, notif_h3jam = ? WHERE id = ?'
    ).run(judul, matkul, deadline, selesai, notif_h1, notif_h3jam, Number(id));
    return this.getById(id);
  },

  markNotif(id, { notif_h1, notif_h3jam }) {
    const existing = this.getById(id);
    if (!existing) return;
    db.prepare('UPDATE tugas SET notif_h1 = ?, notif_h3jam = ? WHERE id = ?').run(
      notif_h1 !== undefined ? notif_h1 : existing.notif_h1,
      notif_h3jam !== undefined ? notif_h3jam : existing.notif_h3jam,
      Number(id)
    );
  },

  findActiveByKeywords(terms = []) {
    const active = this.list({ selesai: 0 });
    const cleaned = terms
      .filter(Boolean)
      .flatMap((t) => String(t).toLowerCase().split(/\s+/))
      .filter((w) => w.length >= 2 && !['tugas', 'yang', 'udah', 'sudah', 'kelar', 'selesai', 'matkul'].includes(w));

    if (!cleaned.length) return active;

    const scored = active
      .map((t) => {
        const hay = `${t.judul} ${t.matkul || ''}`.toLowerCase();
        let score = 0;
        for (const token of cleaned) {
          if (hay.includes(token)) score += token.length;
        }
        return { task: t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((x) => x.task);
  },

  remove(id) {
    const res = db.prepare('DELETE FROM tugas WHERE id = ?').run(Number(id));
    return res.changes > 0;
  },
};

/* ==================== MODUL 3A: MEMORI PACAR ==================== */
export const memoriRepo = {
  list({ tanggal, tanggal_mulai, tanggal_akhir, q, limit = 100 } = {}) {
    const conditions = [];
    const params = [];

    if (tanggal) {
      const norm = normalizeDateStr(tanggal);
      if (norm) {
        conditions.push('tanggal = ?');
        params.push(norm);
      }
    } else {
      if (tanggal_mulai) {
        const start = normalizeDateStr(tanggal_mulai);
        if (start) {
          conditions.push('tanggal >= ?');
          params.push(start);
        }
      }
      if (tanggal_akhir) {
        const end = normalizeDateStr(tanggal_akhir);
        if (end) {
          conditions.push('tanggal <= ?');
          params.push(end);
        }
      }
    }

    if (q && String(q).trim()) {
      const tokens = String(q)
        .trim()
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      if (tokens.length) {
        const tokenSql = tokens
          .map(() => '(lower(isi) LIKE ? OR lower(coalesce(deskripsi, \'\')) LIKE ? OR lower(hari) LIKE ?)')
          .join(' OR ');
        conditions.push(`(${tokenSql})`);
        for (const tok of tokens) {
          const pattern = `%${tok.toLowerCase()}%`;
          params.push(pattern, pattern, pattern);
        }
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit) || 100);

    return db
      .prepare(`SELECT * FROM memori_pacar ${where} ORDER BY tanggal DESC, id DESC LIMIT ?`)
      .all(...params);
  },

  getById(id) {
    return db.prepare('SELECT * FROM memori_pacar WHERE id = ?').get(Number(id));
  },

  create({ tanggal, hari, isi, deskripsi = '', media_path = null }) {
    const cleanIsi = String(isi || '').trim();
    if (!cleanIsi) throw new Error('Isi catatan memori wajib diisi.');

    const cleanTanggal = normalizeDateStr(tanggal) || getWibParts().dateStr;
    const cleanHari = normalizeHari(hari) || getHariFromDateStr(cleanTanggal);
    const cleanDeskripsi = String(deskripsi || '').trim();

    const res = db
      .prepare('INSERT INTO memori_pacar (tanggal, hari, isi, deskripsi, media_path) VALUES (?, ?, ?, ?, ?)')
      .run(cleanTanggal, cleanHari, cleanIsi, cleanDeskripsi, media_path || null);
    return this.getById(res.lastInsertRowid);
  },

  update(id, fields = {}) {
    const existing = this.getById(id);
    if (!existing) return null;

    const isi = fields.isi !== undefined ? String(fields.isi || '').trim() : existing.isi;
    if (!isi) throw new Error('Isi catatan memori wajib diisi.');

    const tanggal =
      fields.tanggal !== undefined
        ? normalizeDateStr(fields.tanggal) || existing.tanggal
        : existing.tanggal;
    const hari =
      fields.hari !== undefined
        ? normalizeHari(fields.hari) || getHariFromDateStr(tanggal)
        : getHariFromDateStr(tanggal);
    const deskripsi =
      fields.deskripsi !== undefined ? String(fields.deskripsi || '').trim() : existing.deskripsi || '';

    let media_path = existing.media_path;
    if (fields.media_path !== undefined) {
      if (existing.media_path && existing.media_path !== fields.media_path) {
        const oldAbs = path.join(PROJECT_ROOT, existing.media_path);
        if (oldAbs.startsWith(UPLOADS_DIR) && fs.existsSync(oldAbs)) {
          try {
            fs.unlinkSync(oldAbs);
          } catch {
            // ignore
          }
        }
      }
      media_path = fields.media_path;
    }

    db.prepare(
      'UPDATE memori_pacar SET tanggal = ?, hari = ?, isi = ?, deskripsi = ?, media_path = ? WHERE id = ?'
    ).run(tanggal, hari, isi, deskripsi, media_path, Number(id));
    return this.getById(id);
  },

  remove(id) {
    const existing = this.getById(id);
    if (!existing) return false;
    const res = db.prepare('DELETE FROM memori_pacar WHERE id = ?').run(Number(id));
    if (res.changes > 0 && existing.media_path) {
      const absPath = path.join(PROJECT_ROOT, existing.media_path);
      if (absPath.startsWith(UPLOADS_DIR) && fs.existsSync(absPath)) {
        try {
          fs.unlinkSync(absPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }
    return res.changes > 0;
  },
};

/* ==================== MODUL 3B: MOMEN & WISHLIST ==================== */
function enrichWishlistRow(row, settings, nowDate = new Date()) {
  if (!row) return null;
  const effDays = parseNotifDays(row.notif_days, settings.momentDefaultDays);
  const effJam = normalizeJam(row.notif_jam) || settings.momentDefaultTime;
  const ulang = normalizeRecurrence(row.ulang);

  if (row.tipe === 'MOMEN' && row.tanggal) {
    const calc = getDaysUntilMoment(row.tanggal, nowDate, ulang);
    return {
      ...row,
      ulang,
      next_date: calc?.nextDate || row.tanggal,
      days_until: calc?.daysUntil ?? null,
      milestone_count: calc?.milestoneCount ?? null,
      effective_notif_days: effDays,
      effective_notif_jam: effJam,
    };
  }
  return {
    ...row,
    ulang,
    next_date: null,
    days_until: null,
    milestone_count: null,
    effective_notif_days: effDays,
    effective_notif_jam: effJam,
  };
}

export const wishlistRepo = {
  list({ tipe } = {}) {
    const rows =
      tipe && ['WISHLIST', 'MOMEN'].includes(String(tipe).toUpperCase())
        ? db
            .prepare('SELECT * FROM momen_wishlist WHERE tipe = ? ORDER BY terpenuhi ASC, id DESC')
            .all(String(tipe).toUpperCase())
        : db
            .prepare('SELECT * FROM momen_wishlist ORDER BY tipe ASC, terpenuhi ASC, id DESC')
            .all();

    const settings = settingsRepo.getNotificationSettings();
    return rows.map((row) => enrichWishlistRow(row, settings));
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM momen_wishlist WHERE id = ?').get(Number(id));
    if (!row) return null;
    return enrichWishlistRow(row, settingsRepo.getNotificationSettings());
  },

  create({
    tipe = 'WISHLIST',
    judul,
    tanggal = null,
    catatan = '',
    terpenuhi = 0,
    notif_days = '',
    notif_jam = '',
    ulang = 'TAHUNAN',
  }) {
    const cleanTipe = String(tipe || 'WISHLIST').toUpperCase() === 'MOMEN' ? 'MOMEN' : 'WISHLIST';
    const cleanJudul = String(judul || '').trim();
    if (!cleanJudul) throw new Error('Judul wishlist/momen wajib diisi.');

    const cleanTanggal = tanggal ? normalizeDateStr(tanggal) || String(tanggal).trim() : null;
    const flag = terpenuhi === true || Number(terpenuhi) === 1 ? 1 : 0;
    const cleanNotifDays = cleanTipe === 'MOMEN' ? formatNotifDaysCsv(notif_days) : '';
    const cleanNotifJam = cleanTipe === 'MOMEN' ? normalizeJam(notif_jam) || '' : '';
    const cleanUlang = cleanTipe === 'MOMEN' ? normalizeRecurrence(ulang) : 'TAHUNAN';

    const res = db
      .prepare(
        'INSERT INTO momen_wishlist (tipe, judul, tanggal, catatan, terpenuhi, notif_days, notif_jam, ulang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        cleanTipe,
        cleanJudul,
        cleanTanggal,
        String(catatan || '').trim(),
        flag,
        cleanNotifDays,
        cleanNotifJam,
        cleanUlang
      );
    return this.getById(res.lastInsertRowid);
  },

  update(id, fields) {
    const existing = db.prepare('SELECT * FROM momen_wishlist WHERE id = ?').get(Number(id));
    if (!existing) return null;

    const tipe =
      fields.tipe !== undefined
        ? String(fields.tipe).toUpperCase() === 'MOMEN'
          ? 'MOMEN'
          : 'WISHLIST'
        : existing.tipe;
    const judul = fields.judul !== undefined ? String(fields.judul).trim() : existing.judul;
    if (!judul) throw new Error('Judul wajib diisi.');
    const tanggal =
      fields.tanggal !== undefined
        ? fields.tanggal
          ? normalizeDateStr(fields.tanggal) || String(fields.tanggal).trim()
          : null
        : existing.tanggal;
    const catatan =
      fields.catatan !== undefined ? String(fields.catatan || '').trim() : existing.catatan;
    const terpenuhi =
      fields.terpenuhi !== undefined
        ? fields.terpenuhi === true || Number(fields.terpenuhi) === 1
          ? 1
          : 0
        : existing.terpenuhi;

    const notif_days =
      fields.notif_days !== undefined
        ? tipe === 'MOMEN'
          ? formatNotifDaysCsv(fields.notif_days)
          : ''
        : existing.notif_days || '';
    const notif_jam =
      fields.notif_jam !== undefined
        ? tipe === 'MOMEN'
          ? normalizeJam(fields.notif_jam) || ''
          : ''
        : existing.notif_jam || '';
    const ulang =
      fields.ulang !== undefined
        ? tipe === 'MOMEN'
          ? normalizeRecurrence(fields.ulang)
          : 'TAHUNAN'
        : normalizeRecurrence(existing.ulang);

    db.prepare(
      'UPDATE momen_wishlist SET tipe = ?, judul = ?, tanggal = ?, catatan = ?, terpenuhi = ?, notif_days = ?, notif_jam = ?, ulang = ? WHERE id = ?'
    ).run(tipe, judul, tanggal, catatan, terpenuhi, notif_days, notif_jam, ulang, Number(id));
    return this.getById(id);
  },

  remove(id) {
    const res = db.prepare('DELETE FROM momen_wishlist WHERE id = ?').run(Number(id));
    return res.changes > 0;
  },

  getUpcomingMoments(maxDays = 7, nowDate = new Date()) {
    const moments = db
      .prepare("SELECT * FROM momen_wishlist WHERE tipe = 'MOMEN' AND terpenuhi = 0 AND tanggal IS NOT NULL")
      .all();
    const settings = settingsRepo.getNotificationSettings();

    return moments
      .map((m) => {
        const ulang = normalizeRecurrence(m.ulang);
        const calc = getDaysUntilMoment(m.tanggal, nowDate, ulang);
        if (!calc) return null;
        return {
          ...m,
          ulang,
          next_date: calc.nextDate,
          days_until: calc.daysUntil,
          milestone_count: calc.milestoneCount ?? null,
          effective_notif_days: parseNotifDays(m.notif_days, settings.momentDefaultDays),
          effective_notif_jam: normalizeJam(m.notif_jam) || settings.momentDefaultTime,
        };
      })
      .filter((m) => m && m.days_until >= 0 && m.days_until <= maxDays)
      .sort((a, b) => a.days_until - b.days_until);
  },
};

/* ==================== MODUL 5: QUICK VAULT ==================== */
export const vaultRepo = {
  list({ tipe, q } = {}) {
    const conditions = [];
    const params = [];
    if (tipe && ['LINK', 'FILE'].includes(String(tipe).toUpperCase())) {
      conditions.push('tipe = ?');
      params.push(String(tipe).toUpperCase());
    }
    if (q && String(q).trim()) {
      const pattern = `%${String(q).trim().toLowerCase()}%`;
      conditions.push('(lower(kata_kunci) LIKE ? OR lower(konten) LIKE ?)');
      params.push(pattern, pattern);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM vault ${where} ORDER BY created_at DESC, id DESC`).all(...params);
  },

  getById(id) {
    return db.prepare('SELECT * FROM vault WHERE id = ?').get(Number(id));
  },

  getLatest() {
    return db.prepare('SELECT * FROM vault ORDER BY id DESC LIMIT 1').get();
  },

  create({ kata_kunci, konten, tipe = 'LINK' }) {
    const cleanKey = String(kata_kunci || '').trim();
    const cleanKonten = String(konten || '').trim();
    const cleanTipe = String(tipe || 'LINK').toUpperCase() === 'FILE' ? 'FILE' : 'LINK';
    if (!cleanKey) throw new Error('Kata kunci vault wajib diisi.');
    if (!cleanKonten) throw new Error('Konten/file vault wajib diisi.');

    const res = db
      .prepare('INSERT INTO vault (kata_kunci, konten, tipe) VALUES (?, ?, ?)')
      .run(cleanKey, cleanKonten, cleanTipe);
    return this.getById(res.lastInsertRowid);
  },

  update(id, fields = {}) {
    const existing = this.getById(id);
    if (!existing) return null;

    const kata_kunci =
      fields.kata_kunci !== undefined ? String(fields.kata_kunci || '').trim() : existing.kata_kunci;
    if (!kata_kunci) throw new Error('Kata kunci vault wajib diisi.');

    const konten =
      fields.konten !== undefined && existing.tipe === 'LINK'
        ? String(fields.konten || '').trim() || existing.konten
        : existing.konten;

    db.prepare('UPDATE vault SET kata_kunci = ?, konten = ? WHERE id = ?').run(
      kata_kunci,
      konten,
      Number(id)
    );
    return this.getById(id);
  },

  search(query) {
    const all = db.prepare('SELECT * FROM vault ORDER BY id DESC').all();
    const q = String(query || '').trim().toLowerCase();
    if (!q) return all;

    const tokens = q
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !['minta', 'cari', 'tolong', 'link', 'file', 'dokumen', 'yang', 'dong'].includes(w));

    const effectiveTokens = tokens.length ? tokens : [q];

    return all
      .map((item) => {
        const keyLower = item.kata_kunci.toLowerCase();
        const contentLower = item.konten.toLowerCase();
        let score = 0;
        if (keyLower === q) score += 100;
        if (keyLower.includes(q)) score += 40;
        for (const tok of effectiveTokens) {
          if (keyLower.includes(tok)) score += 10 + tok.length;
          else if (contentLower.includes(tok)) score += 4;
        }
        return { item, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  },

  remove(id) {
    const existing = this.getById(id);
    if (!existing) return false;
    const res = db.prepare('DELETE FROM vault WHERE id = ?').run(Number(id));
    if (res.changes > 0 && existing.tipe === 'FILE' && existing.konten) {
      const absPath = path.join(PROJECT_ROOT, existing.konten);
      if (absPath.startsWith(UPLOADS_DIR) && fs.existsSync(absPath)) {
        try {
          fs.unlinkSync(absPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }
    return res.changes > 0;
  },
};

/* ==================== MODUL 6: KEUANGAN (PENGELUARAN & PEMASUKAN) ==================== */
export const pengeluaranRepo = {
  list({ tanggal_mulai, tanggal_akhir, month, kategori, tipe } = {}) {
    const conditions = [];
    const params = [];

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      conditions.push("substr(tanggal, 1, 7) = ?");
      params.push(month);
    } else {
      if (tanggal_mulai) {
        const start = normalizeDateStr(tanggal_mulai);
        if (start) {
          conditions.push('tanggal >= ?');
          params.push(start);
        }
      }
      if (tanggal_akhir) {
        const end = normalizeDateStr(tanggal_akhir);
        if (end) {
          conditions.push('tanggal <= ?');
          params.push(end);
        }
      }
    }

    if (tipe && ['PENGELUARAN', 'PEMASUKAN'].includes(String(tipe).toUpperCase())) {
      const cleanTipe = String(tipe).toUpperCase();
      if (cleanTipe === 'PEMASUKAN') {
        conditions.push("tipe = 'PEMASUKAN'");
      } else {
        conditions.push("(tipe IS NULL OR tipe != 'PEMASUKAN')");
      }
    }

    if (kategori && String(kategori).trim()) {
      conditions.push('kategori = ?');
      params.push(String(kategori).trim());
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db
      .prepare(`SELECT * FROM pengeluaran ${where} ORDER BY tanggal DESC, id DESC`)
      .all(...params)
      .map((row) => ({
        ...row,
        tipe: normalizeFinanceType(row.tipe),
      }));
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM pengeluaran WHERE id = ?').get(Number(id));
    if (!row) return null;
    return { ...row, tipe: normalizeFinanceType(row.tipe) };
  },

  create({ tanggal, item, nominal, kategori = 'Lainnya', tipe = 'PENGELUARAN' }) {
    const cleanTipe = normalizeFinanceType(tipe);
    const cleanItem = String(item || '').trim();
    const cleanNominal = Math.round(Number(nominal));
    if (!cleanItem) throw new Error(`Nama item ${cleanTipe === 'PEMASUKAN' ? 'pemasukan' : 'pengeluaran'} wajib diisi.`);
    if (!Number.isFinite(cleanNominal) || cleanNominal <= 0) {
      throw new Error('Nominal harus berupa angka positif.');
    }

    const cleanTanggal = normalizeDateStr(tanggal) || getWibParts().dateStr;
    const cleanKategori =
      cleanTipe === 'PEMASUKAN' ? normalizeIncomeCategory(kategori || cleanItem) : normalizeCategory(kategori || cleanItem);

    const res = db
      .prepare('INSERT INTO pengeluaran (tanggal, item, nominal, kategori, tipe) VALUES (?, ?, ?, ?, ?)')
      .run(cleanTanggal, cleanItem, cleanNominal, cleanKategori, cleanTipe);
    return this.getById(res.lastInsertRowid);
  },

  createMany(items, defaultTanggal, defaultTipe = 'PENGELUARAN') {
    const cleanDefaultTanggal = normalizeDateStr(defaultTanggal) || getWibParts().dateStr;
    const cleanDefaultTipe = normalizeFinanceType(defaultTipe);
    const insert = db.prepare(
      'INSERT INTO pengeluaran (tanggal, item, nominal, kategori, tipe) VALUES (?, ?, ?, ?, ?)'
    );
    const created = [];
    const tx = db.transaction((list) => {
      for (const entry of list) {
        const cleanItem = String(entry.item || '').trim();
        const cleanNominal = Math.round(Number(entry.nominal));
        if (!cleanItem || !Number.isFinite(cleanNominal) || cleanNominal <= 0) continue;
        const tgl = normalizeDateStr(entry.tanggal) || cleanDefaultTanggal;
        const tipe = entry.tipe ? normalizeFinanceType(entry.tipe) : cleanDefaultTipe;
        const kat =
          tipe === 'PEMASUKAN'
            ? normalizeIncomeCategory(entry.kategori || cleanItem)
            : normalizeCategory(entry.kategori || cleanItem);
        const res = insert.run(tgl, cleanItem, cleanNominal, kat, tipe);
        created.push(this.getById(res.lastInsertRowid));
      }
    });
    tx(items);
    return created;
  },

  getSummary({ tanggal_mulai, tanggal_akhir, month } = {}) {
    const rows = this.list({ tanggal_mulai, tanggal_akhir, month });
    let totalExpense = 0;
    let totalIncome = 0;
    let expenseCount = 0;
    let incomeCount = 0;

    const byCategory = {};
    for (const cat of ALLOWED_CATEGORIES) byCategory[cat] = 0;
    const incomeByCategory = {};
    for (const cat of INCOME_CATEGORIES) incomeByCategory[cat] = 0;

    for (const row of rows) {
      const val = Number(row.nominal) || 0;
      if (row.tipe === 'PEMASUKAN') {
        totalIncome += val;
        incomeCount += 1;
        const cat = incomeByCategory[row.kategori] !== undefined ? row.kategori : 'Lainnya';
        incomeByCategory[cat] += val;
      } else {
        totalExpense += val;
        expenseCount += 1;
        const cat = byCategory[row.kategori] !== undefined ? row.kategori : 'Lainnya';
        byCategory[cat] += val;
      }
    }

    return {
      total: totalExpense, // kept for backward compatibility
      totalExpense,
      totalIncome,
      balance: totalIncome - totalExpense,
      count: rows.length,
      expenseCount,
      incomeCount,
      byCategory,
      incomeByCategory,
      items: rows,
    };
  },

  remove(id) {
    const res = db.prepare('DELETE FROM pengeluaran WHERE id = ?').run(Number(id));
    return res.changes > 0;
  },
};

/* ==================== BUDGET BULANAN ==================== */
export const DEFAULT_BUDGET_CONFIG = {
  monthlyLimit: 0,
  byCategory: {
    'Makan & Minum': 0,
    Transportasi: 0,
    Akademik: 0,
    Hiburan: 0,
    Lainnya: 0,
  },
};

export const budgetRepo = {
  get() {
    const saved = stateRepo.getJson('finance_budgets', {}) || {};
    const byCategory = {};
    for (const cat of ALLOWED_CATEGORIES) {
      byCategory[cat] = Math.max(0, Math.round(Number(saved?.byCategory?.[cat]) || 0));
    }
    return {
      monthlyLimit: Math.max(0, Math.round(Number(saved?.monthlyLimit) || 0)),
      byCategory,
    };
  },

  update(patch = {}) {
    const current = this.get();
    const monthlyLimit =
      patch.monthlyLimit !== undefined
        ? Math.max(0, Math.round(Number(patch.monthlyLimit) || 0))
        : current.monthlyLimit;
    const byCategory = { ...current.byCategory };
    if (patch.byCategory && typeof patch.byCategory === 'object') {
      for (const cat of ALLOWED_CATEGORIES) {
        if (patch.byCategory[cat] !== undefined) {
          byCategory[cat] = Math.max(0, Math.round(Number(patch.byCategory[cat]) || 0));
        }
      }
    }
    const next = { monthlyLimit, byCategory };
    stateRepo.setJson('finance_budgets', next);
    return next;
  },
};

/* ==================== QUICK REMINDERS (/r) ==================== */
export const reminderRepo = {
  list({ selesai } = {}) {
    if (selesai !== undefined && selesai !== null && selesai !== '') {
      return db
        .prepare('SELECT * FROM quick_reminders WHERE selesai = ? ORDER BY trigger_at ASC, id ASC')
        .all(Number(selesai) ? 1 : 0);
    }
    return db
      .prepare('SELECT * FROM quick_reminders ORDER BY selesai ASC, trigger_at ASC, id DESC LIMIT 100')
      .all();
  },

  getById(id) {
    return db.prepare('SELECT * FROM quick_reminders WHERE id = ?').get(Number(id));
  },

  create({ pesan, trigger_at }) {
    const cleanPesan = String(pesan || '').trim();
    const cleanTrigger = normalizeDeadline(trigger_at);
    if (!cleanPesan) throw new Error('Pesan pengingat wajib diisi.');
    if (!cleanTrigger) throw new Error('Waktu pengingat tidak valid.');
    const res = db
      .prepare('INSERT INTO quick_reminders (pesan, trigger_at, selesai) VALUES (?, ?, 0)')
      .run(cleanPesan, cleanTrigger);
    return this.getById(res.lastInsertRowid);
  },

  getDue(nowDateTimeStr) {
    return db
      .prepare('SELECT * FROM quick_reminders WHERE selesai = 0 AND trigger_at <= ? ORDER BY trigger_at ASC')
      .all(nowDateTimeStr);
  },

  markDone(id) {
    db.prepare('UPDATE quick_reminders SET selesai = 1 WHERE id = ?').run(Number(id));
    return this.getById(id);
  },

  remove(id) {
    const res = db.prepare('DELETE FROM quick_reminders WHERE id = ?').run(Number(id));
    return res.changes > 0;
  },
};

/* ==================== HABIT TRACKER & STREAK GRID ==================== */
export const habitRepo = {
  list({ aktif = 1 } = {}) {
    if (aktif === 'all' || aktif === undefined || aktif === null) {
      return db.prepare('SELECT * FROM habits ORDER BY id ASC').all();
    }
    return db.prepare('SELECT * FROM habits WHERE aktif = ? ORDER BY id ASC').all(Number(aktif) ? 1 : 0);
  },

  getById(id) {
    return db.prepare('SELECT * FROM habits WHERE id = ?').get(Number(id));
  },

  create({ nama, target_harian = '' }) {
    const cleanNama = String(nama || '').trim();
    if (!cleanNama) throw new Error('Nama habit wajib diisi.');
    const res = db
      .prepare('INSERT INTO habits (nama, target_harian, aktif) VALUES (?, ?, 1)')
      .run(cleanNama, String(target_harian || '').trim());
    return this.getById(res.lastInsertRowid);
  },

  toggleDate(id, tanggal, forceState = null) {
    const habit = this.getById(id);
    if (!habit) return null;
    const cleanDate = normalizeDateStr(tanggal) || getWibParts().dateStr;
    const existing = db
      .prepare('SELECT id FROM habit_logs WHERE habit_id = ? AND tanggal = ?')
      .get(Number(id), cleanDate);

    let done = false;
    if (forceState === true) {
      if (!existing) {
        db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, tanggal) VALUES (?, ?)').run(Number(id), cleanDate);
      }
      done = true;
    } else if (forceState === false) {
      if (existing) {
        db.prepare('DELETE FROM habit_logs WHERE id = ?').run(existing.id);
      }
      done = false;
    } else if (existing) {
      db.prepare('DELETE FROM habit_logs WHERE id = ?').run(existing.id);
      done = false;
    } else {
      db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, tanggal) VALUES (?, ?)').run(Number(id), cleanDate);
      done = true;
    }
    return { habit, tanggal: cleanDate, done };
  },

  findByKeyword(keyword) {
    const q = String(keyword || '').trim().toLowerCase();
    if (!q) return null;
    const all = this.list({ aktif: 1 });
    return (
      all.find((h) => h.nama.toLowerCase() === q) ||
      all.find((h) => h.nama.toLowerCase().includes(q)) ||
      all.find((h) => q.includes(h.nama.toLowerCase())) ||
      null
    );
  },

  remove(id) {
    const res = db.prepare('DELETE FROM habits WHERE id = ?').run(Number(id));
    return res.changes > 0;
  },

  getDashboardData(days = 56, now = new Date()) {
    const todayStr = getWibParts(now).dateStr;
    const startStr = shiftDateStr(todayStr, -(days - 1));
    const habits = this.list({ aktif: 1 });
    const logs = db
      .prepare('SELECT habit_id, tanggal FROM habit_logs WHERE tanggal >= ? ORDER BY tanggal ASC')
      .all(shiftDateStr(todayStr, -365));

    const logsByHabit = new Map();
    const dailyTotals = new Map();
    for (const row of logs) {
      if (!logsByHabit.has(row.habit_id)) logsByHabit.set(row.habit_id, new Set());
      logsByHabit.get(row.habit_id).add(row.tanggal);
      if (row.tanggal >= startStr && row.tanggal <= todayStr) {
        dailyTotals.set(row.tanggal, (dailyTotals.get(row.tanggal) || 0) + 1);
      }
    }

    const enrichedHabits = habits.map((h) => {
      const set = logsByHabit.get(h.id) || new Set();
      const doneToday = set.has(todayStr);

      // Compute current streak (counting back from today if done today, else from yesterday)
      let streak = 0;
      let cursor = doneToday ? todayStr : shiftDateStr(todayStr, -1);
      while (set.has(cursor)) {
        streak += 1;
        cursor = shiftDateStr(cursor, -1);
      }

      // Compute 7-day mini history
      const last7 = [];
      for (let i = 6; i >= 0; i -= 1) {
        const d = shiftDateStr(todayStr, -i);
        last7.push({ tanggal: d, done: set.has(d) });
      }

      return {
        ...h,
        doneToday,
        streak,
        totalCheckins: set.size,
        last7,
      };
    });

    // Build 56-day monochrome contribution grid
    const totalHabits = habits.length;
    const grid = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = shiftDateStr(todayStr, -i);
      const count = dailyTotals.get(d) || 0;
      let level = 0;
      if (count > 0 && totalHabits > 0) {
        const ratio = count / totalHabits;
        if (ratio >= 0.99) level = 4;
        else if (ratio >= 0.66) level = 3;
        else if (ratio >= 0.33) level = 2;
        else level = 1;
      }
      grid.push({ tanggal: d, count, total: totalHabits, level });
    }

    const doneTodayCount = enrichedHabits.filter((h) => h.doneToday).length;
    const bestStreak = enrichedHabits.reduce((max, h) => Math.max(max, h.streak), 0);

    return {
      today: todayStr,
      habits: enrichedHabits,
      grid,
      summary: {
        totalHabits,
        doneTodayCount,
        bestStreak,
      },
    };
  },
};

/* ==================== FOCUS / POMODORO SESSIONS ==================== */
export const focusRepo = {
  getActive() {
    const active = stateRepo.getJson('active_focus_session', null);
    if (!active || !active.active) return null;
    return active;
  },

  start({ label = 'Sesi Fokus', durationMinutes = 25, now = new Date() }) {
    const dur = Math.max(1, Math.min(240, Math.round(Number(durationMinutes) || 25)));
    const cleanLabel = String(label || 'Sesi Fokus').trim() || 'Sesi Fokus';
    const endsAt = new Date(now.getTime() + dur * 60 * 1000);
    const session = {
      id: `focus-${Date.now()}`,
      label: cleanLabel,
      durationMinutes: dur,
      startedAtIso: now.toISOString(),
      endsAtIso: endsAt.toISOString(),
      endsAtDisplay: getWibParts(endsAt).timeStr,
      active: true,
    };
    stateRepo.setJson('active_focus_session', session);
    return session;
  },

  stop() {
    const prev = this.getActive();
    stateRepo.setJson('active_focus_session', { active: false });
    return prev;
  },

  completeActive(now = new Date()) {
    const active = this.getActive();
    if (!active) return null;
    const parts = getWibParts(now);
    db.prepare('INSERT INTO focus_sessions (label, durasi_menit, selesai_pada) VALUES (?, ?, ?)').run(
      active.label,
      active.durationMinutes,
      parts.dateTimeStr
    );
    stateRepo.setJson('active_focus_session', { active: false });
    return active;
  },

  getTodayStats(now = new Date()) {
    const todayStr = getWibParts(now).dateStr;
    const row = db
      .prepare(
        "SELECT COUNT(*) AS sessions, COALESCE(SUM(durasi_menit), 0) AS totalMinutes FROM focus_sessions WHERE substr(selesai_pada, 1, 10) = ?"
      )
      .get(todayStr);
    const recent = db.prepare('SELECT * FROM focus_sessions ORDER BY id DESC LIMIT 10').all();
    return {
      todaySessions: Number(row?.sessions) || 0,
      todayMinutes: Number(row?.totalMinutes) || 0,
      recent,
    };
  },
};

/* ==================== FITUR 1: CATATAN KULIAH & IDE (VOICE-TO-NOTES) ==================== */
const ALLOWED_NOTE_SOURCES = new Set(['TEXT', 'VOICE', 'IMAGE']);

export const catatanRepo = {
  list({ kategori, q } = {}) {
    const conditions = [];
    const params = [];

    if (kategori && kategori !== 'all' && String(kategori).trim()) {
      conditions.push('lower(kategori) = lower(?)');
      params.push(String(kategori).trim());
    }
    if (q && String(q).trim()) {
      const pat = `%${String(q).trim().toLowerCase()}%`;
      conditions.push('(lower(judul) LIKE ? OR lower(kategori) LIKE ? OR lower(ringkasan) LIKE ?)');
      params.push(pat, pat, pat);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM catatan_kuliah ${where} ORDER BY created_at DESC, id DESC`).all(...params);
  },

  getCategories() {
    const rows = db
      .prepare("SELECT DISTINCT kategori FROM catatan_kuliah WHERE trim(coalesce(kategori, '')) != '' ORDER BY kategori ASC")
      .all();
    return rows.map((r) => r.kategori);
  },

  getById(id) {
    return db.prepare('SELECT * FROM catatan_kuliah WHERE id = ?').get(Number(id));
  },

  create({ judul, kategori = 'Umum', ringkasan, sumber_tipe = 'TEXT' }) {
    const cleanJudul = String(judul || '').trim();
    const cleanRingkasan = String(ringkasan || '').trim();
    const cleanKategori = String(kategori || 'Umum').trim() || 'Umum';
    const upSource = String(sumber_tipe || 'TEXT').trim().toUpperCase();
    const cleanSource = ALLOWED_NOTE_SOURCES.has(upSource) ? upSource : 'TEXT';

    if (!cleanJudul) throw new Error('Judul catatan wajib diisi.');
    if (!cleanRingkasan) throw new Error('Isi ringkasan catatan wajib diisi.');

    const res = db
      .prepare('INSERT INTO catatan_kuliah (judul, kategori, ringkasan, sumber_tipe) VALUES (?, ?, ?, ?)')
      .run(cleanJudul, cleanKategori, cleanRingkasan, cleanSource);
    return this.getById(res.lastInsertRowid);
  },

  update(id, fields = {}) {
    const existing = this.getById(id);
    if (!existing) return null;

    const judul = fields.judul !== undefined ? String(fields.judul || '').trim() : existing.judul;
    const kategori = fields.kategori !== undefined ? String(fields.kategori || 'Umum').trim() || 'Umum' : existing.kategori;
    const ringkasan = fields.ringkasan !== undefined ? String(fields.ringkasan || '').trim() : existing.ringkasan;
    const upSource =
      fields.sumber_tipe !== undefined ? String(fields.sumber_tipe || 'TEXT').trim().toUpperCase() : existing.sumber_tipe;
    const sumber_tipe = ALLOWED_NOTE_SOURCES.has(upSource) ? upSource : existing.sumber_tipe;

    if (!judul) throw new Error('Judul catatan wajib diisi.');
    if (!ringkasan) throw new Error('Isi ringkasan catatan wajib diisi.');

    db.prepare('UPDATE catatan_kuliah SET judul = ?, kategori = ?, ringkasan = ?, sumber_tipe = ? WHERE id = ?').run(
      judul,
      kategori,
      ringkasan,
      sumber_tipe,
      Number(id)
    );
    return this.getById(id);
  },

  search(query) {
    const all = db.prepare('SELECT * FROM catatan_kuliah ORDER BY id DESC').all();
    const q = String(query || '').trim().toLowerCase();
    if (!q || q === 'semua' || q === 'all') return all;

    const stopWords = new Set(['cari', 'lihat', 'liat', 'cek', 'catatan', 'kuliah', 'materi', 'tentang', 'soal', 'yang', 'dong', 'tolong', 'minta']);
    const tokens = q.split(/\s+/).filter((w) => w.length >= 2 && !stopWords.has(w));
    const effectiveTokens = tokens.length ? tokens : [q];

    return all
      .map((item) => {
        const jLow = item.judul.toLowerCase();
        const kLow = (item.kategori || '').toLowerCase();
        const rLow = item.ringkasan.toLowerCase();
        let score = 0;
        if (jLow.includes(q)) score += 60;
        if (kLow.includes(q)) score += 45;
        if (rLow.includes(q)) score += 20;
        for (const tok of effectiveTokens) {
          if (kLow.includes(tok)) score += 18;
          if (jLow.includes(tok)) score += 15;
          if (rLow.includes(tok)) score += 6;
        }
        return { item, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  },

  remove(id) {
    const res = db.prepare('DELETE FROM catatan_kuliah WHERE id = ?').run(Number(id));
    return res.changes > 0;
  },
};

/* ==================== FITUR 2: AI TELEMETRY LOGS ==================== */
const GEMINI_DAILY_QUOTA = Number(process.env.GEMINI_DAILY_QUOTA) || 1500;
const GROQ_DAILY_QUOTA = Number(process.env.GROQ_DAILY_QUOTA) || 1000;

export const aiLogRepo = {
  record({ provider, status, latency_ms = 0, model = '', tanggal = null }) {
    const cleanDate = normalizeDateStr(tanggal) || getWibParts().dateStr;
    const cleanProvider = String(provider || 'GEMINI').toUpperCase() === 'GROQ' ? 'GROQ' : 'GEMINI';
    const rawStatus = String(status || 'SUCCESS').toUpperCase();
    const cleanStatus = ['SUCCESS', 'FALLBACK', 'ERROR'].includes(rawStatus) ? rawStatus : 'SUCCESS';
    const cleanLatency = Math.max(0, Math.round(Number(latency_ms) || 0));

    const res = db
      .prepare('INSERT INTO ai_logs (tanggal, provider, status, latency_ms, model) VALUES (?, ?, ?, ?, ?)')
      .run(cleanDate, cleanProvider, cleanStatus, cleanLatency, String(model || '').slice(0, 80));

    // Keep table bounded to latest 2000 rows
    db.prepare('DELETE FROM ai_logs WHERE id NOT IN (SELECT id FROM ai_logs ORDER BY id DESC LIMIT 2000)').run();
    return db.prepare('SELECT * FROM ai_logs WHERE id = ?').get(res.lastInsertRowid);
  },

  getTodayTelemetry(now = new Date()) {
    const today = getWibParts(now).dateStr;
    const rows = db.prepare('SELECT * FROM ai_logs WHERE tanggal = ? ORDER BY id DESC').all(today);

    const agg = (prov, quota) => {
      const list = rows.filter((r) => r.provider === prov);
      const ok = list.filter((r) => r.status !== 'ERROR');
      const errors = list.filter((r) => r.status === 'ERROR').length;
      const fallbacks = list.filter((r) => r.status === 'FALLBACK').length;
      const avgLatencyMs = ok.length
        ? Math.round(ok.reduce((sum, r) => sum + (Number(r.latency_ms) || 0), 0) / ok.length)
        : 0;
      const pct = quota > 0 ? Math.min(100, Math.round((list.length / quota) * 1000) / 10) : 0;
      return {
        todayRequests: list.length,
        successCount: ok.length,
        fallbackCount: fallbacks,
        errorCount: errors,
        dailyQuota: quota,
        pct,
        avgLatencyMs,
      };
    };

    const lastFallback =
      db.prepare("SELECT * FROM ai_logs WHERE status = 'FALLBACK' ORDER BY id DESC LIMIT 1").get() || null;
    const lastError =
      db.prepare("SELECT * FROM ai_logs WHERE status = 'ERROR' ORDER BY id DESC LIMIT 1").get() || null;
    const recentLogs = db.prepare('SELECT * FROM ai_logs ORDER BY id DESC LIMIT 12').all();

    return {
      tanggal: today,
      gemini: agg('GEMINI', GEMINI_DAILY_QUOTA),
      groq: agg('GROQ', GROQ_DAILY_QUOTA),
      lastFallback,
      lastError,
      recentLogs,
    };
  },
};

/* ==================== FITUR 4: CALENDAR FEED TOKEN ==================== */
export function getCalendarFeedToken() {
  const envTok = (process.env.CALENDAR_TOKEN || '').trim();
  if (envTok) return envTok;
  let stored = stateRepo.get('calendar_feed_token');
  if (!stored) {
    stored = crypto.randomBytes(12).toString('hex');
    stateRepo.set('calendar_feed_token', stored);
  }
  return stored;
}

/* ==================== GLOBAL SPOTLIGHT SEARCH ==================== */
export function globalSearch(query, limitPerGroup = 5) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    return {
      jadwal: [],
      tugas: [],
      memori: [],
      wishlist: [],
      vault: [],
      keuangan: [],
      habits: [],
      reminders: [],
      catatan: [],
      total: 0,
    };
  }
  const pat = `%${q}%`;
  const lim = Math.max(1, Math.min(15, Number(limitPerGroup) || 5));

  const jadwal = db
    .prepare("SELECT * FROM jadwal WHERE lower(nama) LIKE ? OR lower(coalesce(hari, '')) LIKE ? ORDER BY aktif DESC, id DESC LIMIT ?")
    .all(pat, pat, lim);
  const tugas = db
    .prepare("SELECT * FROM tugas WHERE lower(judul) LIKE ? OR lower(coalesce(matkul, '')) LIKE ? ORDER BY selesai ASC, deadline ASC LIMIT ?")
    .all(pat, pat, lim);
  const memori = db
    .prepare("SELECT * FROM memori_pacar WHERE lower(isi) LIKE ? OR lower(coalesce(deskripsi, '')) LIKE ? OR tanggal LIKE ? ORDER BY tanggal DESC, id DESC LIMIT ?")
    .all(pat, pat, pat, lim);
  const wishlist = db
    .prepare("SELECT * FROM momen_wishlist WHERE lower(judul) LIKE ? OR lower(coalesce(catatan, '')) LIKE ? OR coalesce(tanggal, '') LIKE ? ORDER BY id DESC LIMIT ?")
    .all(pat, pat, pat, lim);
  const vault = db
    .prepare('SELECT * FROM vault WHERE lower(kata_kunci) LIKE ? OR lower(konten) LIKE ? ORDER BY id DESC LIMIT ?')
    .all(pat, pat, lim);
  const keuangan = db
    .prepare('SELECT * FROM pengeluaran WHERE lower(item) LIKE ? OR lower(kategori) LIKE ? OR tanggal LIKE ? ORDER BY tanggal DESC, id DESC LIMIT ?')
    .all(pat, pat, pat, lim)
    .map((r) => ({ ...r, tipe: normalizeFinanceType(r.tipe) }));
  const habits = db
    .prepare("SELECT * FROM habits WHERE aktif = 1 AND (lower(nama) LIKE ? OR lower(coalesce(target_harian, '')) LIKE ?) ORDER BY id DESC LIMIT ?")
    .all(pat, pat, lim);
  const reminders = db
    .prepare('SELECT * FROM quick_reminders WHERE lower(pesan) LIKE ? ORDER BY selesai ASC, trigger_at ASC LIMIT ?')
    .all(pat, lim);
  const catatan = db
    .prepare("SELECT * FROM catatan_kuliah WHERE lower(judul) LIKE ? OR lower(coalesce(kategori, '')) LIKE ? OR lower(ringkasan) LIKE ? ORDER BY id DESC LIMIT ?")
    .all(pat, pat, pat, lim);

  const total =
    jadwal.length +
    tugas.length +
    memori.length +
    wishlist.length +
    vault.length +
    keuangan.length +
    habits.length +
    reminders.length +
    catatan.length;

  return { jadwal, tugas, memori, wishlist, vault, keuangan, habits, reminders, catatan, total };
}

/* ==================== SECURITY & ACCESS AUDIT LOGS ==================== */
export const auditRepo = {
  create({ waktu, event, ip = '', lokasi = 'Tidak diketahui', device = '', device_type = 'desktop', user_agent = '', path: reqPath = '' }) {
    const res = db
      .prepare(
        `INSERT INTO access_logs (waktu, event, ip, lokasi, device, device_type, user_agent, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(waktu || ''),
        String(event || 'AKSES'),
        String(ip || ''),
        String(lokasi || 'Tidak diketahui'),
        String(device || 'Perangkat tidak dikenal'),
        String(device_type || 'desktop'),
        String(user_agent || '').slice(0, 400),
        String(reqPath || '').slice(0, 200)
      );

    // Keep table bounded to latest 500 rows
    db.prepare(
      'DELETE FROM access_logs WHERE id NOT IN (SELECT id FROM access_logs ORDER BY id DESC LIMIT 500)'
    ).run();

    return db.prepare('SELECT * FROM access_logs WHERE id = ?').get(res.lastInsertRowid);
  },

  updateLocation(id, lokasi) {
    db.prepare('UPDATE access_logs SET lokasi = ? WHERE id = ?').run(String(lokasi || 'Tidak diketahui'), Number(id));
    return db.prepare('SELECT * FROM access_logs WHERE id = ?').get(Number(id));
  },

  list({ event, limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
    if (event && event !== 'all') {
      return db
        .prepare('SELECT * FROM access_logs WHERE event = ? ORDER BY id DESC LIMIT ?')
        .all(String(event).toUpperCase(), safeLimit);
    }
    return db.prepare('SELECT * FROM access_logs ORDER BY id DESC LIMIT ?').all(safeLimit);
  },

  getStats() {
    const row = db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN event = 'LOGIN_BERHASIL' THEN 1 ELSE 0 END) AS successCount,
          SUM(CASE WHEN event = 'PIN_SALAH' THEN 1 ELSE 0 END) AS failedCount,
          SUM(CASE WHEN event = 'AKSES_DITOLAK' THEN 1 ELSE 0 END) AS blockedCount,
          COUNT(DISTINCT ip) AS uniqueIps
         FROM access_logs`
      )
      .get();
    return {
      total: Number(row?.total) || 0,
      successCount: Number(row?.successCount) || 0,
      failedCount: Number(row?.failedCount) || 0,
      blockedCount: Number(row?.blockedCount) || 0,
      uniqueIps: Number(row?.uniqueIps) || 0,
    };
  },

  clear() {
    db.prepare('DELETE FROM access_logs').run();
    return true;
  },
};

/* ==================== PUSH SUBSCRIPTIONS ==================== */
export const pushRepo = {
  list() {
    return db.prepare('SELECT * FROM push_subscriptions ORDER BY id ASC').all();
  },

  upsert({ endpoint, keys }) {
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new Error('Objek PushSubscription tidak lengkap.');
    }
    db.prepare(`
      INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
      VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        keys_p256dh = excluded.keys_p256dh,
        keys_auth = excluded.keys_auth
    `).run(endpoint, keys.p256dh, keys.auth);
    return db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  },

  removeByEndpoint(endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },
};

/* ==================== STATS & BACKUP ==================== */
export function getDatabaseStats() {
  const counts = {
    jadwal: db.prepare('SELECT COUNT(*) AS c FROM jadwal').get().c,
    jadwal_aktif: db.prepare('SELECT COUNT(*) AS c FROM jadwal WHERE aktif = 1').get().c,
    tugas: db.prepare('SELECT COUNT(*) AS c FROM tugas').get().c,
    tugas_aktif: db.prepare('SELECT COUNT(*) AS c FROM tugas WHERE selesai = 0').get().c,
    memori_pacar: db.prepare('SELECT COUNT(*) AS c FROM memori_pacar').get().c,
    momen_wishlist: db.prepare('SELECT COUNT(*) AS c FROM momen_wishlist').get().c,
    vault: db.prepare('SELECT COUNT(*) AS c FROM vault').get().c,
    catatan_kuliah: db.prepare('SELECT COUNT(*) AS c FROM catatan_kuliah').get().c,
    pengeluaran: db.prepare('SELECT COUNT(*) AS c FROM pengeluaran').get().c,
    push_subscriptions: db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get().c,
  };
  counts.total_records =
    counts.jadwal +
    counts.tugas +
    counts.memori_pacar +
    counts.momen_wishlist +
    counts.vault +
    counts.catatan_kuliah +
    counts.pengeluaran;
  return counts;
}

export async function createConsistentBackup(destPath) {
  await db.backup(destPath);
  return destPath;
}
