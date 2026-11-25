import { HARI_ID, getWibParts, normalizeDateStr, normalizeHari, normalizeJam, shiftDateStr } from '../utils/time.js';

const HARI_TO_BYDAY = {
  Senin: 'MO',
  Selasa: 'TU',
  Rabu: 'WE',
  Kamis: 'TH',
  Jumat: 'FR',
  Sabtu: 'SA',
  Minggu: 'SU',
};

function escapeIcsText(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function toIcsLocalStamp(dateStr, jamStr = '08:00') {
  const cleanDate = normalizeDateStr(dateStr);
  const cleanJam = normalizeJam(jamStr) || '08:00';
  if (!cleanDate) return null;
  const [y, m, d] = cleanDate.split('-');
  const [hh, mm] = cleanJam.split(':');
  return `${y}${m}${d}T${hh}${mm}00`;
}

function addMinutesLocalStamp(dateStr, jamStr, addMins = 60) {
  const cleanDate = normalizeDateStr(dateStr);
  const cleanJam = normalizeJam(jamStr) || '08:00';
  if (!cleanDate) return null;
  const [hh, mm] = cleanJam.split(':').map(Number);
  const total = hh * 60 + mm + addMins;
  const dayShift = Math.floor(total / 1440);
  const rem = ((total % 1440) + 1440) % 1440;
  const endDate = dayShift !== 0 ? shiftDateStr(cleanDate, dayShift) : cleanDate;
  const endH = String(Math.floor(rem / 60)).padStart(2, '0');
  const endM = String(rem % 60).padStart(2, '0');
  return toIcsLocalStamp(endDate, `${endH}:${endM}`);
}

function toUtcStamp(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '');
  return `${iso.slice(0, 15)}Z`;
}

/**
 * Find the nearest anchor date (on or before today, or within current week) for a routine weekday
 * so Apple Calendar & Google Calendar render recurring RRULE events starting smoothly immediately.
 */
function resolveAnchorDateForHari(hariName, todayDateStr, todayHariName) {
  const targetIdx = HARI_ID.indexOf(hariName);
  const todayIdx = HARI_ID.indexOf(todayHariName);
  if (targetIdx === -1 || todayIdx === -1) return todayDateStr;
  // Anchor on the occurrence of this weekday in the current week (or up to 6 days prior)
  const deltaBack = (todayIdx - targetIdx + 7) % 7;
  return shiftDateStr(todayDateStr, -deltaBack);
}

/**
 * Build RFC 5545 compliant iCalendar (.ics) payload for active schedules & active tasks.
 * Timezone: Asia/Jakarta (WIB, UTC+07:00, no DST).
 */
export function generateCalendarIcs({ schedules = [], tasks = [], now = new Date() }) {
  const nowParts = getWibParts(now);
  const dtStamp = toUtcStamp(now);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//All-in-One Personal Assistant//Calendar Sync//ID',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Personal Assistant (Kuliah & Tugas)',
    'X-WR-CALDESC:Sinkronisasi otomatis jadwal kuliah, presensi, dan deadline tugas.',
    'X-WR-TIMEZONE:Asia/Jakarta',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Jakarta',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0700',
    'TZOFFSETTO:+0700',
    'TZNAME:WIB',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  // 1. Active schedules (Routine weekly RRULE + one-shot specific dates)
  for (const item of schedules) {
    if (!item || Number(item.aktif) === 0) continue;
    const cleanJam = normalizeJam(item.jam);
    if (!cleanJam) continue;

    if (Number(item.is_rutin) === 1) {
      const cleanHari = normalizeHari(item.hari) || nowParts.hari;
      const byDay = HARI_TO_BYDAY[cleanHari] || 'MO';
      const anchorDate = resolveAnchorDateForHari(cleanHari, nowParts.dateStr, nowParts.hari);
      const dtStart = toIcsLocalStamp(anchorDate, cleanJam);
      const dtEnd = addMinutesLocalStamp(anchorDate, cleanJam, 50);
      if (!dtStart || !dtEnd) continue;

      lines.push(
        'BEGIN:VEVENT',
        `UID:jadwal-rutin-${item.id}@personal-assistant.local`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART;TZID=Asia/Jakarta:${dtStart}`,
        `DTEND;TZID=Asia/Jakarta:${dtEnd}`,
        `RRULE:FREQ=WEEKLY;BYDAY=${byDay}`,
        `SUMMARY:${escapeIcsText(item.nama)}`,
        `DESCRIPTION:${escapeIcsText(`Jadwal rutin setiap ${cleanHari} pukul ${cleanJam} WIB (Personal Assistant).`)}`,
        'CATEGORIES:Jadwal Kuliah',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT10M',
        `DESCRIPTION:${escapeIcsText(`Pengingat 10 menit sebelum ${item.nama}`)}`,
        'END:VALARM',
        'END:VEVENT'
      );
    } else {
      const cleanDate = normalizeDateStr(item.tanggal);
      if (!cleanDate) continue;
      const dtStart = toIcsLocalStamp(cleanDate, cleanJam);
      const dtEnd = addMinutesLocalStamp(cleanDate, cleanJam, 60);
      if (!dtStart || !dtEnd) continue;

      lines.push(
        'BEGIN:VEVENT',
        `UID:jadwal-sekali-${item.id}@personal-assistant.local`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART;TZID=Asia/Jakarta:${dtStart}`,
        `DTEND;TZID=Asia/Jakarta:${dtEnd}`,
        `SUMMARY:${escapeIcsText(item.nama)}`,
        `DESCRIPTION:${escapeIcsText(`Jadwal sekali jalan pada ${cleanDate} pukul ${cleanJam} WIB (Personal Assistant).`)}`,
        'CATEGORIES:Jadwal',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT15M',
        `DESCRIPTION:${escapeIcsText(`Pengingat 15 menit sebelum ${item.nama}`)}`,
        'END:VALARM',
        'END:VEVENT'
      );
    }
  }

  // 2. Unfinished Tasks (Deadline VEVENT with H-24h & H-3h VALARM)
  for (const task of tasks) {
    if (!task || Number(task.selesai) === 1 || !task.deadline) continue;
    const [datePart, timePart = '23:59'] = String(task.deadline).trim().split(/\s+/);
    const cleanDate = normalizeDateStr(datePart);
    const cleanJam = normalizeJam(timePart) || '23:59';
    if (!cleanDate) continue;

    // Place 30-min block ending at deadline (or starting 30 min prior)
    const dtStart = addMinutesLocalStamp(cleanDate, cleanJam, -30);
    const dtEnd = toIcsLocalStamp(cleanDate, cleanJam);
    if (!dtStart || !dtEnd) continue;

    const summary = `[Deadline] ${task.judul}${task.matkul ? ` (${task.matkul})` : ''}`;
    const desc = `Tugas${task.matkul ? ` Mata Kuliah ${task.matkul}` : ''}: ${task.judul}. Tenggat: ${cleanDate} ${cleanJam} WIB.`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:tugas-${task.id}@personal-assistant.local`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;TZID=Asia/Jakarta:${dtStart}`,
      `DTEND;TZID=Asia/Jakarta:${dtEnd}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(desc)}`,
      'CATEGORIES:Tugas Kuliah',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-P1D',
      `DESCRIPTION:${escapeIcsText(`Pengingat H-1 deadline: ${task.judul}`)}`,
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT3H',
      `DESCRIPTION:${escapeIcsText(`Pengingat 3 jam sebelum deadline: ${task.judul}`)}`,
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}
