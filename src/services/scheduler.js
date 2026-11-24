import cron from 'node-cron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConsistentBackup,
  getDatabaseStats,
  jadwalRepo,
  settingsRepo,
  stateRepo,
  tugasRepo,
  wishlistRepo,
} from '../config/db.js';
import {
  WIB_TIMEZONE,
  formatCountdown,
  getWibParts,
  parseWibDateTime,
  shiftDateStr,
} from '../utils/time.js';
import { emitDataChange } from './events.js';
import { sendDualNotification } from './notifier.js';
import { sendDocumentToOwner } from './whatsapp.js';

const firedScheduleKeys = new Set();
let minuteTask = null;
let briefingTask = null;
let backupTask = null;

/**
 * Modul 1: Check due routine & one-shot schedules for the current WIB minute.
 */
export async function checkSchedules(now = new Date()) {
  const parts = getWibParts(now);
  const dueList = jadwalRepo.getDueSchedules(parts.hari, parts.dateStr, parts.timeStr);

  if (firedScheduleKeys.size > 500) {
    firedScheduleKeys.clear();
  }

  let triggered = 0;
  for (const item of dueList) {
    const dedupKey = `jadwal:${item.id}:${parts.dateStr}:${parts.timeStr}`;
    if (firedScheduleKeys.has(dedupKey)) continue;
    firedScheduleKeys.add(dedupKey);

    const tipeLabel = item.is_rutin ? `Rutin setiap ${item.hari}` : `Sekali jalan (${item.tanggal})`;
    const body = `Waktunya *${item.nama}*!\n🕐 ${item.jam} WIB (${tipeLabel})\n\n_Balas "tunda 10 menit" untuk snooze._`;

    await sendDualNotification(`⏰ ${item.nama}`, body, '/#jadwal', {
      recordForSnooze: true,
      activityName: item.nama,
      tag: dedupKey,
    });

    if (item.is_rutin === 0) {
      jadwalRepo.deactivate(item.id);
      emitDataChange('jadwal', 'scheduler');
    }
    triggered += 1;
  }

  return triggered;
}

/**
 * Modul 2: Tiered deadline reminders (configurable, default H-24 Jam and H-3 Jam).
 */
export async function checkTaskDeadlines(now = new Date()) {
  const settings = settingsRepo.getNotificationSettings();
  const firstHours = settings.taskFirstReminderHours || 24;
  const secondHours = settings.taskSecondReminderHours || 3;

  const active = tugasRepo.list({ selesai: 0 });
  let triggered = 0;

  for (const task of active) {
    const deadlineDt = parseWibDateTime(task.deadline);
    if (!deadlineDt) continue;

    const diffMs = deadlineDt.getTime() - now.getTime();
    if (diffMs <= 0) continue;

    const secondMs = secondHours * 60 * 60 * 1000;
    const firstMs = firstHours * 60 * 60 * 1000;

    if (diffMs <= secondMs && task.notif_h3jam === 0) {
      const cd = formatCountdown(task.deadline, now);
      const body = `Tugas *${task.judul}*${task.matkul ? ` (${task.matkul})` : ''} deadline *${cd.label}*!\n📅 ${task.deadline} WIB\n\n_Segera kumpulkan, balas "tugas ${task.judul} udah kelar" jika sudah selesai._`;

      await sendDualNotification(`🚨 Deadline Tugas < ${secondHours} Jam!`, body, '/#tugas', {
        recordForSnooze: true,
        activityName: `Tugas ${task.judul}`,
        tag: `tugas-h3-${task.id}`,
      });

      tugasRepo.markNotif(task.id, { notif_h1: 1, notif_h3jam: 1 });
      emitDataChange('tugas', 'scheduler');
      triggered += 1;
    } else if (diffMs <= firstMs && task.notif_h1 === 0) {
      const cd = formatCountdown(task.deadline, now);
      const label = firstHours === 24 ? 'H-1' : `${firstHours} Jam Lagi`;
      const body = `Pengingat ${label} untuk tugas *${task.judul}*${task.matkul ? ` (${task.matkul})` : ''}.\n📅 Deadline: ${task.deadline} WIB (${cd.label}).`;

      await sendDualNotification(`📌 Pengingat Tugas (${label})`, body, '/#tugas', {
        recordForSnooze: true,
        activityName: `Tugas ${task.judul}`,
        tag: `tugas-h1-${task.id}`,
      });

      tugasRepo.markNotif(task.id, { notif_h1: 1 });
      emitDataChange('tugas', 'scheduler');
      triggered += 1;
    }
  }

  return triggered;
}

/**
 * Modul 3: Special Moment reminders using per-item or global notification days & WIB time.
 */
export async function checkSpecialMoments(now = new Date(), { ignoreHourGate = false } = {}) {
  const parts = getWibParts(now);
  const upcoming = wishlistRepo.getUpcomingMoments(365, now);
  let triggered = 0;

  for (const moment of upcoming) {
    const allowedDays = new Set(moment.effective_notif_days || [7, 3, 1]);
    if (!allowedDays.has(moment.days_until)) continue;

    const targetJam = moment.effective_notif_jam || '08:00';
    if (!ignoreHourGate && parts.timeStr < targetJam) continue;

    const stateKey = `momen_notif:${moment.id}:${moment.next_date}:H-${moment.days_until}`;
    if (stateRepo.get(stateKey)) continue;

    const hLabel = moment.days_until === 0 ? 'HARI INI!' : `H-${moment.days_until}`;
    const cycleNote =
      moment.ulang === 'BULANAN'
        ? moment.milestone_count > 0
          ? ` (Bulanan • Bulan ke-${moment.milestone_count})`
          : ' (Pengingat Bulanan)'
        : moment.ulang === 'TAHUNAN' && moment.milestone_count > 0
        ? ` (Tahun ke-${moment.milestone_count})`
        : '';
    const body =
      moment.days_until === 0
        ? `Hari ini adalah *${moment.judul}*${cycleNote} (${moment.next_date})!${
            moment.catatan ? `\nDeskripsi: ${moment.catatan}` : ''
          }\nSelamat merayakan momen spesialmu 💝`
        : `*${moment.judul}*${cycleNote} tinggal *${hLabel}* lagi (${moment.next_date})!${
            moment.catatan ? `\nDeskripsi: ${moment.catatan}` : ''
          }\nYuk siapkan kejutan atau hadiah terbaikmu 💝`;

    await sendDualNotification(`🎉 Pengingat Momen Spesial (${hLabel})`, body, '/#memori', {
      recordForSnooze: false,
      tag: stateKey,
    });

    stateRepo.set(stateKey, parts.dateTimeStr);
    triggered += 1;
  }

  return triggered;
}

/**
 * Modul 4: Automated Morning Briefing (configurable time, default 06:00 WIB daily).
 */
export async function runMorningBriefing(now = new Date()) {
  const parts = getWibParts(now);
  const tomorrowStr = shiftDateStr(parts.dateStr, 1);

  const todaySchedules = jadwalRepo.getTodaySchedules(parts.hari, parts.dateStr);
  const jadwalSection = todaySchedules.length
    ? todaySchedules.map((j) => `• ${j.jam} WIB — *${j.nama}*`).join('\n')
    : '• Tidak ada jadwal kuliah/presensi hari ini.';

  const activeTasks = tugasRepo.list({ selesai: 0 });
  const urgentTasks = activeTasks.filter((t) => {
    const d = (t.deadline || '').slice(0, 10);
    return d === parts.dateStr || d === tomorrowStr;
  });
  const tugasSection = urgentTasks.length
    ? urgentTasks
        .map((t) => {
          const cd = formatCountdown(t.deadline, now);
          return `• *${t.judul}*${t.matkul ? ` (${t.matkul})` : ''} — ${t.deadline} _(${cd.label})_`;
        })
        .join('\n')
    : '• Aman! Tidak ada deadline tugas hari ini atau besok.';

  const moments = wishlistRepo.getUpcomingMoments(7, now);
  const momenSection = moments.length
    ? moments
        .map(
          (m) =>
            `• *${m.judul}* (${m.next_date}) — *${m.days_until === 0 ? 'HARI INI!' : `H-${m.days_until}`}*`
        )
        .join('\n')
    : '• Tidak ada momen spesial dalam 7 hari ke depan.';

  const title = `☀️ Morning Briefing — ${parts.displayDate}`;
  const body = `1️⃣ *Jadwal & Presensi Hari Ini:*\n${jadwalSection}\n\n2️⃣ *Tugas Deadline Hari Ini / Besok:*\n${tugasSection}\n\n3️⃣ *Momen Spesial (7 Hari Ke Depan):*\n${momenSection}\n\nSemangat menjalani hari ini! 🚀`;

  const res = await sendDualNotification(title, body, '/', {
    recordForSnooze: false,
    tag: `briefing-${parts.dateStr}`,
  });

  return { title, body, delivery: res };
}

/**
 * Modul 7: Automated Weekly Database Backup (configurable day & time, default Sunday 23:00 WIB).
 */
export async function runWeeklyBackup(now = new Date()) {
  const parts = getWibParts(now);
  const fileName = `assistant-backup-${parts.dateStr}.db`;
  const tempPath = path.join(os.tmpdir(), `backup-${Date.now()}-${fileName}`);

  await createConsistentBackup(tempPath);
  const stats = getDatabaseStats();

  const caption =
    `💾 *Auto-Backup Database Mingguan*\n` +
    `📅 Tanggal: ${parts.display}\n` +
    `📊 Total Record: *${stats.total_records}*\n` +
    `• Jadwal: ${stats.jadwal}\n` +
    `• Tugas: ${stats.tugas}\n` +
    `• Memori Pacar: ${stats.memori_pacar}\n` +
    `• Wishlist & Momen: ${stats.momen_wishlist}\n` +
    `• Quick Vault: ${stats.vault}\n` +
    `• Pengeluaran: ${stats.pengeluaran}`;

  try {
    await sendDocumentToOwner(tempPath, fileName, caption, 'application/x-sqlite3');
    return { sent: true, fileName, stats };
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

export async function runMinuteTick(now = new Date()) {
  const [schedules, tasks, moments] = await Promise.all([
    checkSchedules(now).catch((err) => {
      console.error('[Scheduler] checkSchedules error:', err);
      return 0;
    }),
    checkTaskDeadlines(now).catch((err) => {
      console.error('[Scheduler] checkTaskDeadlines error:', err);
      return 0;
    }),
    checkSpecialMoments(now).catch((err) => {
      console.error('[Scheduler] checkSpecialMoments error:', err);
      return 0;
    }),
  ]);
  return { schedules, tasks, moments };
}

function scheduleDynamicJobs() {
  if (briefingTask) {
    try {
      briefingTask.stop();
    } catch {
      // ignore
    }
    briefingTask = null;
  }
  if (backupTask) {
    try {
      backupTask.stop();
    } catch {
      // ignore
    }
    backupTask = null;
  }

  const settings = settingsRepo.getNotificationSettings();

  if (settings.morningBriefingEnabled) {
    const [bHour, bMin] = settings.morningBriefingTime.split(':').map(Number);
    const expr = `${bMin} ${bHour} * * *`;
    briefingTask = cron.schedule(
      expr,
      () => {
        console.log(`[Scheduler] Menjalankan Morning Briefing ${settings.morningBriefingTime} WIB...`);
        runMorningBriefing().catch((err) => console.error('[Scheduler] Morning briefing failed:', err));
      },
      { timezone: WIB_TIMEZONE }
    );
  }

  if (settings.weeklyBackupEnabled) {
    const [kHour, kMin] = settings.weeklyBackupTime.split(':').map(Number);
    const expr = `${kMin} ${kHour} * * ${settings.weeklyBackupDay}`;
    backupTask = cron.schedule(
      expr,
      () => {
        console.log('[Scheduler] Menjalankan Auto-Backup Mingguan...');
        runWeeklyBackup().catch((err) => console.error('[Scheduler] Auto-backup failed:', err));
      },
      { timezone: WIB_TIMEZONE }
    );
  }
}

export function reloadScheduler() {
  if (!minuteTask) return;
  scheduleDynamicJobs();
  console.log('[Scheduler] Pengaturan jadwal notifikasi diperbarui.');
}

export function startScheduler() {
  stopScheduler();

  minuteTask = cron.schedule(
    '* * * * *',
    () => {
      runMinuteTick().catch((err) => console.error('[Scheduler] Tick failed:', err));
    },
    { timezone: WIB_TIMEZONE }
  );

  scheduleDynamicJobs();
  console.log('[Scheduler] Cron jobs aktif (timezone: Asia/Jakarta).');
}

export function stopScheduler() {
  for (const task of [minuteTask, briefingTask, backupTask]) {
    if (!task) continue;
    try {
      task.stop();
    } catch {
      // ignore
    }
  }
  minuteTask = null;
  briefingTask = null;
  backupTask = null;
}
