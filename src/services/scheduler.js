import cron from 'node-cron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConsistentBackup,
  focusRepo,
  getDatabaseStats,
  habitRepo,
  jadwalRepo,
  memoriRepo,
  outboundAlarmRepo,
  outboundPendingRepo,
  presensiPendingRepo,
  reminderRepo,
  settingsRepo,
  stateRepo,
  tugasRepo,
  wishlistRepo,
} from '../config/db.js';
import {
  WIB_TIMEZONE,
  addMinutesWib,
  formatCountdown,
  getWibParts,
  parseWibDateTime,
  shiftDateStr,
} from '../utils/time.js';
import { emitDataChange } from './events.js';
import { generateMonthlyPartnerRecap } from './gemini.js';
import { sendDualNotification, sendWhatsAppToTarget } from './notifier.js';
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

  const settings = settingsRepo.getNotificationSettings();
  let triggered = 0;
  for (const item of dueList) {
    const dedupKey = `jadwal:${item.id}:${parts.dateStr}:${parts.timeStr}`;
    if (firedScheduleKeys.has(dedupKey)) continue;
    firedScheduleKeys.add(dedupKey);

    const tipeLabel = item.is_rutin ? `Rutin setiap ${item.hari}` : `Sekali jalan (${item.tanggal})`;
    const shouldRepeat = Number(item.repeat_until_ok) === 1 && !/\(Snooze\)/i.test(item.nama || '');
    const interval = Math.max(1, Math.min(180, Number(item.repeat_interval_min) || 20));
    const itemRing = Number(item.ring_loud) === 1;
    const ringLoud = Boolean(
      settings.ringEnabled &&
        (itemRing || (shouldRepeat ? settings.ringOnPresensi : settings.ringOnNormalAlarm))
    );

    const title = shouldRepeat ? `⏰ Presensi: ${item.nama}` : `⏰ Alarm: ${item.nama}`;
    const body = shouldRepeat
      ? `Waktunya presensi *${item.nama}*!\n🕐 ${item.jam} WIB (${tipeLabel})\n\n🔁 _Akan diingatkan berulang tiap *${interval} menit* sampai kamu balas *"ok"*._`
      : `Waktunya *${item.nama}*!\n🕐 ${item.jam} WIB (${tipeLabel})\n\n_Pengingat alarm biasa (1x). Balas "tunda 10 menit" untuk snooze._`;

    await sendDualNotification(title, body, '/#jadwal', {
      recordForSnooze: true,
      activityName: item.nama,
      tag: dedupKey,
      ringLoud,
    });

    if (shouldRepeat) {
      const nextTarget = addMinutesWib(interval, now);
      presensiPendingRepo.create({
        jadwal_id: item.id,
        nama: item.nama,
        tanggal: parts.dateStr,
        jam_awal: item.jam,
        interval_menit: interval,
        next_trigger_at: nextTarget.dateTimeStr,
        ring_loud: itemRing ? 1 : 0,
      });
      emitDataChange('jadwal', 'scheduler');
    }

    if (item.is_rutin === 0) {
      jadwalRepo.deactivate(item.id);
      emitDataChange('jadwal', 'scheduler');
    }
    triggered += 1;
  }

  return triggered;
}

const MAX_PRESENSI_REPEATS = 12; // 12 x 20 menit = 4 jam batas aman

/**
 * Modul 1B: Repeating presensi reminder every 20 minutes until user replies "ok".
 */
export async function checkPendingPresensi(now = new Date()) {
  const parts = getWibParts(now);
  const settings = settingsRepo.getNotificationSettings();
  const dueList = presensiPendingRepo.getDue(parts.dateTimeStr);
  let triggered = 0;

  for (const row of dueList) {
    // Auto-close stale items from previous days
    if (row.tanggal && row.tanggal < parts.dateStr) {
      presensiPendingRepo.acknowledgeById(row.id, parts.dateTimeStr);
      emitDataChange('jadwal', 'scheduler');
      continue;
    }

    const interval = Math.max(1, Math.min(180, Number(row.interval_menit) || 20));
    const nextCount = (Number(row.repeat_count) || 1) + 1;

    if (nextCount > MAX_PRESENSI_REPEATS) {
      presensiPendingRepo.acknowledgeById(row.id, parts.dateTimeStr);
      await sendDualNotification(
        `⏰ Pengingat Presensi Berakhir: ${row.nama}`,
        `Pengingat berulang untuk *${row.nama}* (jadwal ${row.jam_awal} WIB) dihentikan otomatis setelah ${MAX_PRESENSI_REPEATS}x pengingat.`,
        '/#jadwal',
        { recordForSnooze: false, tag: `presensi-end-${row.id}` }
      );
      emitDataChange('jadwal', 'scheduler');
      triggered += 1;
      continue;
    }

    const nextTarget = addMinutesWib(interval, now);
    presensiPendingRepo.bumpRepeat(row.id, nextTarget.dateTimeStr, nextCount);

    const body =
      `Kamu belum konfirmasi presensi *${row.nama}* (jadwal ${row.jam_awal} WIB)!\n` +
      `🔁 Pengingat ulang ke-${nextCount} (setiap ${interval} menit).\n\n` +
      `_Balas *"ok"* jika sudah presensi untuk menghentikan pengingat._`;

    const ringLoud = Boolean(settings.ringEnabled && (Number(row.ring_loud) === 1 || settings.ringOnPresensi));
    await sendDualNotification(`🔔 Pengingat Presensi #${nextCount}: ${row.nama}`, body, '/#jadwal', {
      recordForSnooze: true,
      activityName: row.nama,
      tag: `presensi-repeat-${row.id}-${nextCount}`,
      ringLoud,
    });
    emitDataChange('jadwal', 'scheduler');
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
        ringLoud: Boolean(settings.ringEnabled && settings.ringOnUrgentTask),
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

    // Feature 5B: On monthly moment Hari H (e.g. Mensiversary), also send AI Monthly Partner Recap!
    if (moment.ulang === 'BULANAN' && moment.days_until === 0 && process.env.NODE_ENV !== 'test') {
      const recapKey = `monthly_partner_recap:${moment.id}:${parts.monthStr}`;
      if (!stateRepo.get(recapKey)) {
        const sinceDate = shiftDateStr(parts.dateStr, -30);
        const recentMemories = memoriRepo.list({ tanggal_mulai: sinceDate, tanggal_akhir: parts.dateStr, limit: 30 });
        if (recentMemories.length > 0) {
          const recapText = await generateMonthlyPartnerRecap(recentMemories, moment.judul, now).catch(() => null);
          if (recapText) {
            await sendDualNotification(`💝 Rekap Bulanan — ${moment.judul}`, recapText, '/#memori', {
              recordForSnooze: false,
              tag: recapKey,
            }).catch(() => {});
            stateRepo.set(recapKey, parts.dateTimeStr);
          }
        }
      }
    }
  }

  return triggered;
}

/**
 * Feature 2: Quick Reminders (/r) minute-level check.
 */
export async function checkQuickReminders(now = new Date()) {
  const parts = getWibParts(now);
  const settings = settingsRepo.getNotificationSettings();
  const due = reminderRepo.getDue(parts.dateTimeStr);
  let triggered = 0;

  for (const rem of due) {
    reminderRepo.markDone(rem.id);
    const ringLoud = Boolean(
      settings.ringEnabled && (Number(rem.ring_loud) === 1 || settings.ringOnQuickReminder)
    );
    const body = `Waktunya: *${rem.pesan}*\n🕐 ${rem.trigger_at} WIB\n\n_Balas "/s 10" untuk tunda 10 menit lagi._`;
    await sendDualNotification(`⏰ Pengingat Cepat`, body, '/', {
      recordForSnooze: true,
      activityName: rem.pesan,
      tag: `quick-rem-${rem.id}`,
      ringLoud,
    });
    emitDataChange('reminder', 'scheduler');
    triggered += 1;
  }

  return triggered;
}

/**
 * Feature 7: Check if active Focus / Pomodoro session has reached its end time.
 */
export async function checkFocusSessions(now = new Date()) {
  const active = focusRepo.getActive();
  if (!active || !active.endsAtIso) return 0;

  const endMs = new Date(active.endsAtIso).getTime();
  if (!Number.isFinite(endMs) || now.getTime() < endMs) return 0;

  const finished = focusRepo.completeActive(now);
  if (!finished) return 0;

  const stats = focusRepo.getTodayStats(now);
  const body =
    `Sesi fokus *${finished.label}* (${finished.durationMinutes} menit) selesai!\n` +
    `Saatnya istirahat sebentar 5 menit.\n` +
    `📊 Total fokus hari ini: *${stats.todaySessions} sesi (${stats.todayMinutes} menit)*.`;

  await sendDualNotification('🍅 Sesi Fokus Selesai!', body, '/', {
    recordForSnooze: false,
    tag: `focus-done-${finished.id}`,
  });
  emitDataChange('focus', 'scheduler');
  return 1;
}

/**
 * Feature 6: Evening habit reminder at 21:00 WIB if active habits remain unchecked today.
 */
export async function checkEveningHabitReminder(now = new Date()) {
  const parts = getWibParts(now);
  if (parts.timeStr < '21:00' || parts.timeStr > '21:15') return 0;

  const key = `habit_evening_notif:${parts.dateStr}`;
  if (stateRepo.get(key)) return 0;

  const data = habitRepo.getDashboardData(7, now);
  const remaining = data.habits.filter((h) => !h.doneToday);
  if (!remaining.length) return 0;

  const lines = remaining.map((h) => `• ${h.nama} _(streak: ${h.streak} hari)_`).join('\n');
  await sendDualNotification(
    `🔥 Pengingat Habit Harian (${remaining.length} tersisa)`,
    `Jangan putus streak hari ini! Habit yang belum diceklis:\n${lines}\n\n_Ketik \`/h <nama habit>\` untuk langsung centang._`,
    '/',
    { recordForSnooze: false, tag: key }
  );
  stateRepo.set(key, parts.dateTimeStr);
  return 1;
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

/**
 * Modul 1C: Immediately fire an outbound alarm to another WhatsApp number and queue repeats if repeat_until_ok=1.
 */
export async function triggerOutboundAlarmNow(
  {
    alarm_id = null,
    target_nama,
    target_nomor,
    pesan,
    repeat_until_ok = 1,
    interval_menit = 10,
    max_repeats = 20,
  },
  now = new Date()
) {
  const parts = getWibParts(now);
  const shouldRepeat = repeat_until_ok === true || Number(repeat_until_ok) === 1;
  const interval = Math.max(2, Math.min(180, Math.round(Number(interval_menit) || 10)));
  const maxRep = Math.max(1, Math.min(60, Math.round(Number(max_repeats) || 20)));

  const body = shouldRepeat
    ? `⏰ *Pengingat:*\n${pesan}\n\n🔁 _Akan diingatkan lagi tiap *${interval} menit* sampai kamu balas *"ok"*._`
    : `⏰ *Pengingat:*\n${pesan}`;

  await sendWhatsAppToTarget(target_nomor, body);

  let pending = null;
  if (shouldRepeat) {
    const nextTarget = addMinutesWib(interval, now);
    pending = outboundPendingRepo.create({
      alarm_id,
      target_nama: target_nama || target_nomor,
      target_nomor,
      pesan,
      tanggal: parts.dateStr,
      jam_awal: parts.timeStr,
      interval_menit: interval,
      max_repeats: maxRep,
      next_trigger_at: nextTarget.dateTimeStr,
    });
  }

  emitDataChange('outbound', 'scheduler');
  return { sent: true, pending };
}

/**
 * Modul 1D: Check due scheduled outbound alarms (SEKALI / HARIAN / MINGGUAN).
 */
export async function checkOutboundAlarms(now = new Date()) {
  const parts = getWibParts(now);
  const dueList = outboundAlarmRepo.getDueAlarms(parts.hari, parts.dateStr, parts.timeStr);

  if (firedScheduleKeys.size > 500) {
    firedScheduleKeys.clear();
  }

  let triggered = 0;
  for (const item of dueList) {
    const dedupKey = `outbound:${item.id}:${parts.dateStr}:${parts.timeStr}`;
    if (firedScheduleKeys.has(dedupKey)) continue;
    firedScheduleKeys.add(dedupKey);

    try {
      await triggerOutboundAlarmNow(
        {
          alarm_id: item.id,
          target_nama: item.target_nama,
          target_nomor: item.target_nomor,
          pesan: item.pesan,
          repeat_until_ok: item.repeat_until_ok,
          interval_menit: item.interval_menit,
          max_repeats: item.max_repeats,
        },
        now
      );

      if (item.mode === 'SEKALI') {
        outboundAlarmRepo.deactivate(item.id);
        emitDataChange('outbound', 'scheduler');
      }
      triggered += 1;
    } catch (err) {
      console.error(`[Scheduler] Failed sending outbound alarm #${item.id}:`, err?.message || err);
    }
  }

  return triggered;
}

/**
 * Modul 1E: Repeating outbound alarms until the target number replies "ok" (or hits max_repeats / day rollover).
 */
export async function checkOutboundPending(now = new Date()) {
  const parts = getWibParts(now);
  const dueList = outboundPendingRepo.getDue(parts.dateTimeStr);
  let triggered = 0;

  for (const row of dueList) {
    if (row.tanggal && row.tanggal < parts.dateStr) {
      outboundPendingRepo.acknowledgeById(row.id, parts.dateTimeStr, 'DAY_ROLLOVER');
      emitDataChange('outbound', 'scheduler');
      continue;
    }

    const interval = Math.max(2, Math.min(180, Number(row.interval_menit) || 10));
    const maxRepeats = Math.max(1, Math.min(60, Number(row.max_repeats) || 20));
    const nextCount = (Number(row.repeat_count) || 1) + 1;

    if (nextCount > maxRepeats) {
      outboundPendingRepo.acknowledgeById(row.id, parts.dateTimeStr, 'AUTO_LIMIT');
      await sendDualNotification(
        `⏰ Alarm Nomor Lain Berakhir: ${row.target_nama}`,
        `Pengingat berulang ke *${row.target_nama}* (\`${row.target_nomor}\`) untuk *"${row.pesan}"* dihentikan otomatis setelah ${maxRepeats}x kirim tanpa balasan "ok".`,
        '/#jadwal',
        { recordForSnooze: false, tag: `outbound-end-${row.id}` }
      ).catch(() => {});
      emitDataChange('outbound', 'scheduler');
      triggered += 1;
      continue;
    }

    const nextTarget = addMinutesWib(interval, now);
    outboundPendingRepo.bumpRepeat(row.id, nextTarget.dateTimeStr, nextCount);

    const msg =
      `🔔 *Pengingat #${nextCount}:*\n${row.pesan}\n\n` +
      `🔁 _Pengingat ulang ke-${nextCount} (setiap ${interval} menit). Balas *"ok"* untuk menghentikan._`;

    try {
      await sendWhatsAppToTarget(row.target_nomor, msg);
    } catch (err) {
      console.error(`[Scheduler] Failed outbound repeat #${row.id}:`, err?.message || err);
    }

    emitDataChange('outbound', 'scheduler');
    triggered += 1;
  }

  return triggered;
}

export async function runMinuteTick(now = new Date()) {
  const [schedules, presensiRepeats, outboundAlarms, outboundRepeats, tasks, moments, reminders, focus, habits] =
    await Promise.all([
      checkSchedules(now).catch((err) => {
        console.error('[Scheduler] checkSchedules error:', err);
        return 0;
      }),
      checkPendingPresensi(now).catch((err) => {
        console.error('[Scheduler] checkPendingPresensi error:', err);
        return 0;
      }),
      checkOutboundAlarms(now).catch((err) => {
        console.error('[Scheduler] checkOutboundAlarms error:', err);
        return 0;
      }),
      checkOutboundPending(now).catch((err) => {
        console.error('[Scheduler] checkOutboundPending error:', err);
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
      checkQuickReminders(now).catch((err) => {
        console.error('[Scheduler] checkQuickReminders error:', err);
        return 0;
      }),
      checkFocusSessions(now).catch((err) => {
        console.error('[Scheduler] checkFocusSessions error:', err);
        return 0;
      }),
      checkEveningHabitReminder(now).catch((err) => {
        console.error('[Scheduler] checkEveningHabitReminder error:', err);
        return 0;
      }),
    ]);
  return { schedules, presensiRepeats, outboundAlarms, outboundRepeats, tasks, moments, reminders, focus, habits };
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
