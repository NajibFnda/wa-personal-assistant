export const WIB_TIMEZONE = 'Asia/Jakarta';

export const HARI_ID = [
  'Minggu',
  'Senin',
  'Selasa',
  'Rabu',
  'Kamis',
  'Jumat',
  'Sabtu',
];

export const BULAN_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

const WEEKDAY_MAP = {
  Sun: 'Minggu',
  Mon: 'Senin',
  Tue: 'Selasa',
  Wed: 'Rabu',
  Thu: 'Kamis',
  Fri: 'Jumat',
  Sat: 'Sabtu',
};

/**
 * Extract Jakarta (WIB / UTC+7) date & time components safely regardless of OS timezone.
 */
export function getWibParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: WIB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const minute = Number(parts.minute);
  const second = Number(parts.second);

  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const min = String(minute).padStart(2, '0');
  const sec = String(second).padStart(2, '0');

  const hari = WEEKDAY_MAP[parts.weekday] || 'Senin';
  const bulanNama = BULAN_ID[month - 1] || '';

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    hari,
    bulanNama,
    dateStr: `${yyyy}-${mm}-${dd}`,
    monthStr: `${yyyy}-${mm}`,
    timeStr: `${hh}:${min}`,
    dateTimeStr: `${yyyy}-${mm}-${dd} ${hh}:${min}`,
    display: `${hari}, ${day} ${bulanNama} ${year}, ${hh}:${min} WIB`,
    displayDate: `${hari}, ${day} ${bulanNama} ${year}`,
    epochMs: date.getTime(),
  };
}

/**
 * Normalize Indonesian day name input (e.g. "jum'at", "senin", "ahad") to canonical Title Case.
 */
export function normalizeHari(input) {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.trim().toLowerCase().replace(/['`’\s]/g, '');
  const map = {
    senin: 'Senin',
    selasa: 'Selasa',
    rabu: 'Rabu',
    kamis: 'Kamis',
    jumat: 'Jumat',
    sabtu: 'Sabtu',
    minggu: 'Minggu',
    ahad: 'Minggu',
    monday: 'Senin',
    tuesday: 'Selasa',
    wednesday: 'Rabu',
    thursday: 'Kamis',
    friday: 'Jumat',
    saturday: 'Sabtu',
    sunday: 'Minggu',
  };
  return map[cleaned] || null;
}

/**
 * Normalize time string into HH:MM (24-hour).
 */
export function normalizeJam(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().replace('.', ':');
  const match = trimmed.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Normalize YYYY-MM-DD date string.
 */
export function normalizeDateStr(input) {
  if (!input || typeof input !== 'string') return null;
  const match = input.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Get Indonesian weekday name from a YYYY-MM-DD date string.
 */
export function getHariFromDateStr(dateStr) {
  const norm = normalizeDateStr(dateStr);
  if (!norm) return getWibParts().hari;
  const dt = new Date(`${norm}T12:00:00+07:00`);
  if (Number.isNaN(dt.getTime())) return getWibParts().hari;
  return getWibParts(dt).hari;
}

/**
 * Parse a WIB datetime string ("YYYY-MM-DD HH:MM", "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD") into Date.
 */
export function parseWibDateTime(dateTimeStr) {
  if (!dateTimeStr || typeof dateTimeStr !== 'string') return null;
  const cleaned = dateTimeStr.trim().replace('T', ' ');
  const fullMatch = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (fullMatch) {
    const [, y, m, d, hh, mm, ss = '00'] = fullMatch;
    const iso = `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}+07:00`;
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const dateOnly = normalizeDateStr(cleaned);
  if (dateOnly) {
    const dt = new Date(`${dateOnly}T23:59:00+07:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  return null;
}

/**
 * Normalize deadline to canonical "YYYY-MM-DD HH:MM".
 */
export function normalizeDeadline(input, fallbackJam = '23:59') {
  if (!input || typeof input !== 'string') return null;
  const dt = parseWibDateTime(input);
  if (!dt) return null;
  const hasTime = /\d{1,2}:\d{2}/.test(input);
  const parts = getWibParts(dt);
  if (!hasTime) {
    return `${parts.dateStr} ${normalizeJam(fallbackJam) || '23:59'}`;
  }
  return parts.dateTimeStr;
}

/**
 * Add N minutes to a Date and return WIB parts.
 */
export function addMinutesWib(minutes, fromDate = new Date()) {
  const target = new Date(fromDate.getTime() + Number(minutes) * 60 * 1000);
  return getWibParts(target);
}

/**
 * Shift a YYYY-MM-DD date string by N days.
 */
export function shiftDateStr(dateStr, deltaDays) {
  const norm = normalizeDateStr(dateStr) || getWibParts().dateStr;
  const dt = new Date(`${norm}T12:00:00+07:00`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return getWibParts(dt).dateStr;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysBetweenDateStrs(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / (24 * 60 * 60 * 1000));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Calculate days until a special moment.
 * Supports recurrence modes:
 * - 'TAHUNAN' (default): repeats every year on the same month & day
 * - 'BULANAN': repeats every month on the same day-of-month (clamped to month length, e.g. 31 -> 28/29 Feb)
 * - 'SEKALI': fires once on the exact stored date (returns null once passed)
 */
export function getDaysUntilMoment(dateStr, nowDate = new Date(), recurrence = 'TAHUNAN') {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const today = getWibParts(nowDate);
  const todayStr = today.dateStr;
  const mode = ['BULANAN', 'SEKALI', 'TAHUNAN'].includes(String(recurrence || '').toUpperCase())
    ? String(recurrence).toUpperCase()
    : 'TAHUNAN';

  const full = dateStr.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const mmdd = dateStr.trim().match(/^(\d{1,2})-(\d{1,2})$/);

  let year = null;
  let month;
  let day;

  if (full) {
    year = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
  } else if (mmdd) {
    month = Number(mmdd[1]);
    day = Number(mmdd[2]);
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const exactStr =
    year !== null
      ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : null;

  if (mode === 'SEKALI') {
    if (!exactStr || exactStr < todayStr) return null;
    return {
      nextDate: exactStr,
      daysUntil: daysBetweenDateStrs(todayStr, exactStr),
      recurrence: 'SEKALI',
      milestoneCount: null,
    };
  }

  if (mode === 'BULANAN') {
    if (exactStr && exactStr >= todayStr) {
      return {
        nextDate: exactStr,
        daysUntil: daysBetweenDateStrs(todayStr, exactStr),
        recurrence: 'BULANAN',
        milestoneCount: 0,
      };
    }

    let targetYear = today.year;
    let targetMonth = today.month;
    let targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    let candidate = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;

    if (candidate < todayStr) {
      targetMonth += 1;
      if (targetMonth > 12) {
        targetMonth = 1;
        targetYear += 1;
      }
      targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
      candidate = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
    }

    const milestoneCount =
      year !== null ? Math.max(0, (targetYear - year) * 12 + (targetMonth - month)) : null;

    return {
      nextDate: candidate,
      daysUntil: daysBetweenDateStrs(todayStr, candidate),
      recurrence: 'BULANAN',
      milestoneCount,
    };
  }

  // Default: TAHUNAN
  if (exactStr && exactStr >= todayStr) {
    return {
      nextDate: exactStr,
      daysUntil: daysBetweenDateStrs(todayStr, exactStr),
      recurrence: 'TAHUNAN',
      milestoneCount: 0,
    };
  }

  let targetYear = today.year;
  let targetDay = month === 2 && day === 29 && !isLeapYear(targetYear) ? 28 : day;
  let candidate = `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;

  if (candidate < todayStr) {
    targetYear += 1;
    targetDay = month === 2 && day === 29 && !isLeapYear(targetYear) ? 28 : day;
    candidate = `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  }

  const milestoneCount = year !== null ? Math.max(0, targetYear - year) : null;

  return {
    nextDate: candidate,
    daysUntil: daysBetweenDateStrs(todayStr, candidate),
    recurrence: 'TAHUNAN',
    milestoneCount,
  };
}

/**
 * Format Indonesian Rupiah currency.
 */
export function formatRupiah(amount) {
  const n = Math.round(Number(amount) || 0);
  return 'Rp ' + n.toLocaleString('id-ID');
}

/**
 * Format countdown string from WIB deadline string.
 */
export function formatCountdown(deadlineStr, now = new Date()) {
  const dt = parseWibDateTime(deadlineStr);
  if (!dt) return { diffMs: 0, label: 'Tanggal tidak valid', urgency: 'normal' };

  const diffMs = dt.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const totalMinutes = Math.floor(absMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} hari`);
  if (hours > 0) parts.push(`${hours} jam`);
  if (days === 0 && minutes > 0) parts.push(`${minutes} menit`);
  if (parts.length === 0) parts.push('< 1 menit');

  if (diffMs <= 0) {
    return {
      diffMs,
      label: `Lewat ${parts.join(' ')}`,
      urgency: 'overdue',
    };
  }

  const urgency =
    diffMs <= 3 * 60 * 60 * 1000
      ? 'critical'
      : diffMs <= 24 * 60 * 60 * 1000
      ? 'warning'
      : 'normal';

  return {
    diffMs,
    label: `${parts.join(' ')} lagi`,
    urgency,
  };
}
