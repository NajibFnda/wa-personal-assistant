import { auditRepo } from '../config/db.js';
import { getWibParts } from '../utils/time.js';
import { emitDataChange } from './events.js';
import { sendDualNotification } from './notifier.js';

const GEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const geoCache = new Map();
const blockedThrottle = new Map();
const alertThrottle = new Map();

export function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return 'unknown';
  if (ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  return ip;
}

export function extractClientIp(req) {
  const candidates = [
    req?.headers?.['cf-connecting-ip'],
    req?.headers?.['x-forwarded-for'],
    req?.headers?.['x-real-ip'],
    req?.ip,
    req?.socket?.remoteAddress,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) {
      return normalizeIp(c);
    }
  }
  return 'unknown';
}

export function isPrivateOrLocalIp(ip) {
  const s = normalizeIp(ip);
  if (
    !s ||
    s === 'unknown' ||
    s === '::1' ||
    s === 'localhost' ||
    s.startsWith('127.') ||
    s.startsWith('10.') ||
    s.startsWith('192.168.') ||
    s.startsWith('fe80:') ||
    s.startsWith('fc') ||
    s.startsWith('fd')
  ) {
    return true;
  }
  const m172 = s.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function parseDeviceInfo(userAgent = '') {
  const ua = String(userAgent || '').trim();
  if (!ua) {
    return { label: 'Perangkat tidak dikenal', deviceType: 'desktop' };
  }

  // Bot / CLI script check
  if (/(curl|wget|python|postman|insomnia|bot|crawler|spider|httpclient|node|undici)/i.test(ua)) {
    const botMatch = ua.match(/(curl\/[\d.]+|wget\/[\d.]+|python[^\s;)]*|postman[^\s;)]*|node[^\s;)]*|undici)/i);
    return {
      label: `${botMatch ? botMatch[1] : 'Script / Bot'} (Otomatis)`,
      deviceType: 'bot',
    };
  }

  // OS & Device model
  let os = 'OS Tidak Dikenal';
  let deviceType = 'desktop';
  let model = '';

  const androidMatch = ua.match(/Android\s*([\d.]+)?(?:;\s*([^;)]+))?/i);
  if (androidMatch) {
    deviceType = /tablet|ipad/i.test(ua) ? 'tablet' : 'mobile';
    os = androidMatch[1] ? `Android ${androidMatch[1]}` : 'Android';
    const rawModel = (androidMatch[2] || '').replace(/\s*Build\/.*$/i, '').trim();
    if (rawModel && !/^(K|Linux|wv|U|id|en-US)$/i.test(rawModel) && rawModel.length <= 32) {
      model = rawModel;
    }
  } else if (/iPhone/i.test(ua)) {
    deviceType = 'mobile';
    const iosM = ua.match(/OS\s+([\d_]+)/i);
    os = iosM ? `iPhone (iOS ${iosM[1].replace(/_/g, '.')})` : 'iPhone';
  } else if (/iPad/i.test(ua)) {
    deviceType = 'tablet';
    const iosM = ua.match(/OS\s+([\d_]+)/i);
    os = iosM ? `iPad (iPadOS ${iosM[1].replace(/_/g, '.')})` : 'iPad';
  } else if (/Windows NT 10\.0/i.test(ua)) {
    os = 'Windows 10/11';
  } else if (/Windows/i.test(ua)) {
    os = 'Windows';
  } else if (/Mac OS X/i.test(ua)) {
    os = 'macOS';
  } else if (/CrOS/i.test(ua)) {
    os = 'ChromeOS';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  // Browser
  let browser = 'Browser';
  let m;
  if ((m = ua.match(/EdgA?\/([\d]+)/i))) {
    browser = `Edge ${m[1]}`;
  } else if ((m = ua.match(/OPR\/([\d]+)/i))) {
    browser = `Opera ${m[1]}`;
  } else if ((m = ua.match(/SamsungBrowser\/([\d]+)/i))) {
    browser = `Samsung Browser ${m[1]}`;
  } else if ((m = ua.match(/MiuiBrowser\/([\d]+)/i))) {
    browser = `Mi Browser ${m[1]}`;
  } else if ((m = ua.match(/Firefox\/([\d]+)/i))) {
    browser = `Firefox ${m[1]}`;
  } else if ((m = ua.match(/CriOS\/([\d]+)/i)) || (m = ua.match(/Chrome\/([\d]+)/i))) {
    browser = `Chrome ${m[1]}`;
  } else if (/Safari/i.test(ua) && (m = ua.match(/Version\/([\d.]+)/i))) {
    browser = `Safari ${m[1]}`;
  } else if (/Safari/i.test(ua)) {
    browser = 'Safari';
  }

  const typeLabel = deviceType === 'mobile' ? 'HP' : deviceType === 'tablet' ? 'Tablet' : 'Desktop';
  const osPart = model ? `${os} (${model})` : os;
  return {
    label: `${osPart} • ${browser} • ${typeLabel}`,
    deviceType,
  };
}

export async function lookupGeoIp(ip) {
  const cleanIp = normalizeIp(ip);
  if (isPrivateOrLocalIp(cleanIp)) {
    return 'Jaringan Lokal (Localhost)';
  }

  const cached = geoCache.get(cleanIp);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.location;
  }

  let location = 'Lokasi tidak tersedia';

  // Provider 1: ip-api.com (fast, includes ISP)
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=status,country,countryCode,regionName,city,isp`,
      { signal: AbortSignal.timeout(2500) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.status === 'success') {
        const place = [data.city, data.regionName, data.countryCode || data.country]
          .filter(Boolean)
          .join(', ');
        location = data.isp ? `${place} • ${data.isp}` : place || location;
      }
    }
  } catch {
    // Fallback below
  }

  // Provider 2 fallback: ipwho.is
  if (location === 'Lokasi tidak tersedia') {
    try {
      const res = await fetch(`https://ipwho.is/${encodeURIComponent(cleanIp)}`, {
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.success) {
          const place = [data.city, data.region, data.country_code || data.country]
            .filter(Boolean)
            .join(', ');
          const isp = data.connection?.isp || data.connection?.org || '';
          location = isp ? `${place} • ${isp}` : place || location;
        }
      }
    } catch {
      // ignore timeout
    }
  }

  geoCache.set(cleanIp, { location, expiresAt: Date.now() + GEO_CACHE_TTL_MS });
  return location;
}

function getWibDateTimeSec() {
  const d = new Date();
  const parts = getWibParts(d);
  const sec = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    second: '2-digit',
  }).format(d);
  return `${parts.dateStr} ${parts.timeStr}:${sec} WIB`;
}

/**
 * Record an access or security event to SQLite immediately (0ms) and asynchronously
 * enrich it with IP geolocation (+ send WhatsApp alert on wrong PIN attempts).
 */
export function recordAccessEvent(req, event, { notifyOnFail = false, pathOverride = null } = {}) {
  const ip = extractClientIp(req);
  const reqPath = pathOverride || req?.originalUrl || req?.path || '/';

  // Throttle repeated AKSES_DITOLAK noise from polling on same IP+path (30s window)
  if (event === 'AKSES_DITOLAK') {
    const key = `${ip}::${reqPath}`;
    const last = blockedThrottle.get(key) || 0;
    if (Date.now() - last < 30 * 1000) {
      return null;
    }
    blockedThrottle.set(key, Date.now());
  }

  const ua = req?.headers?.['user-agent'] || '';
  const deviceInfo = parseDeviceInfo(ua);
  const waktu = getWibDateTimeSec();
  const initialLocation = isPrivateOrLocalIp(ip) ? 'Jaringan Lokal (Localhost)' : 'Melacak lokasi...';

  const saved = auditRepo.create({
    waktu,
    event,
    ip,
    lokasi: initialLocation,
    device: deviceInfo.label,
    device_type: deviceInfo.deviceType,
    user_agent: ua,
    path: reqPath,
  });

  emitDataChange('audit', 'api');

  // Async background GeoIP enrichment + security alert (never blocks HTTP response)
  (async () => {
    let finalLoc = initialLocation;
    if (!isPrivateOrLocalIp(ip)) {
      finalLoc = await lookupGeoIp(ip);
      try {
        auditRepo.updateLocation(saved.id, finalLoc);
        emitDataChange('audit', 'api');
      } catch {
        // ignore if DB closed in tests
      }
    }

    if (notifyOnFail && event === 'PIN_SALAH' && process.env.NODE_ENV !== 'test') {
      const lastAlert = alertThrottle.get(ip) || 0;
      if (Date.now() - lastAlert >= 60 * 1000) {
        alertThrottle.set(ip, Date.now());
        await sendDualNotification(
          '🚨 Peringatan Keamanan: Percobaan PIN Salah!',
          `Seseorang mencoba masuk ke Web Dashboard dengan PIN salah.\n• Waktu: ${waktu}\n• IP: ${ip}\n• Perkiraan Lokasi: ${finalLoc}\n• Perangkat: ${deviceInfo.label}\n\nKetik */log* untuk melihat riwayat akses.`,
          '/',
          { recordForSnooze: false, tag: `sec-alert-${ip}` }
        ).catch(() => {});
      }
    }
  })();

  return saved;
}
