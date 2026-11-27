import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  MEMORI_UPLOADS_DIR,
  PROJECT_ROOT,
  VAULT_UPLOADS_DIR,
  catatanRepo,
  contactRepo,
  focusRepo,
  habitRepo,
  inferIsPresensi,
  inferRingLoud,
  jadwalRepo,
  memoriRepo,
  normalizeOutboundMode,
  normalizeWaPhone,
  outboundAlarmRepo,
  outboundPendingRepo,
  pengeluaranRepo,
  presensiPendingRepo,
  reminderRepo,
  resolveUploadPath,
  tugasRepo,
  vaultRepo,
  wishlistRepo,
} from '../config/db.js';
import {
  addMinutesWib,
  formatCountdown,
  formatRupiah,
  getHariFromDateStr,
  getWibParts,
  normalizeDateStr,
  normalizeDeadline,
  normalizeHari,
  normalizeJam,
  shiftDateStr,
} from '../utils/time.js';
import { checkBudgetThresholds } from './budget.js';
import {
  analyzeMessage,
  generateMonthlyPartnerRecap,
  generatePartnerIdeas,
  generatePartnerRecommendation,
  synthesizeMemoryAnswer,
} from './gemini.js';
import { handleSlashCommand } from './commands.js';
import { emitDataChange } from './events.js';
import {
  getLastReminder,
  registerTargetWhatsAppSender,
  registerWhatsAppSender,
  sendDualNotification,
} from './notifier.js';

const AUTH_DIR = path.join(PROJECT_ROOT, 'auth_info_baileys');
const baileysLogger = pino({ level: 'silent' });

let sock = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isInitializing = false;

const waState = {
  status: 'disconnected', // 'disconnected' | 'connecting' | 'qr' | 'connected'
  qrCodeDataUrl: null,
  connectedPhone: null,
  lastConnectedAt: null,
  lastError: null,
};

export function getOwnerNumber() {
  return String(process.env.NOMOR_UTAMA || '').replace(/\D/g, '');
}

export function getOwnerJid() {
  const num = getOwnerNumber();
  return num ? `${num}@s.whatsapp.net` : null;
}

/**
 * PRD Section 2.2 Strict Single-User Whitelist & Silent Drop check.
 * Rejects all non-owner private chats, groups, broadcasts, newsletters, and fromMe messages.
 */
export function isAllowedSender(msgKey, nomorUtama = process.env.NOMOR_UTAMA) {
  const cleanNomor = String(nomorUtama || '').replace(/\D/g, '');
  if (!cleanNomor) return false;
  if (!msgKey || msgKey.fromMe !== false) return false;

  const allowedJid = `${cleanNomor}@s.whatsapp.net`;
  const remoteJid = msgKey.remoteJid || '';
  const remoteJidAlt = msgKey.remoteJidAlt || '';

  if (
    !remoteJid ||
    remoteJid.endsWith('@g.us') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@newsletter')
  ) {
    return false;
  }

  if (remoteJid === allowedJid) return true;
  if (remoteJid.endsWith('@lid') && remoteJidAlt === allowedJid) return true;

  return false;
}

export function getWhatsAppStatus() {
  return {
    ...waState,
    ownerConfigured: Boolean(getOwnerNumber()),
    ownerMasked: getOwnerNumber()
      ? `${getOwnerNumber().slice(0, 4)}****${getOwnerNumber().slice(-3)}`
      : null,
  };
}

export async function sendTextToOwner(text) {
  const jid = getOwnerJid();
  if (!jid) throw new Error('NOMOR_UTAMA belum dikonfigurasi di .env');
  if (!sock || waState.status !== 'connected') {
    throw new Error('WhatsApp belum terhubung.');
  }
  return sock.sendMessage(jid, { text });
}

export async function sendTextToNumber(phoneNumber, text) {
  const clean = normalizeWaPhone(phoneNumber);
  if (!clean) throw new Error('Nomor WhatsApp tujuan tidak valid.');
  if (!sock || waState.status !== 'connected') {
    throw new Error('WhatsApp belum terhubung.');
  }
  return sock.sendMessage(`${clean}@s.whatsapp.net`, { text });
}

export function resolveOutboundTarget(query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const saved = contactRepo.findByNameOrNumber(raw);
  if (saved) {
    return { target_nama: saved.nama, target_nomor: saved.nomor };
  }
  const phone = normalizeWaPhone(raw);
  if (phone) {
    return { target_nama: phone, target_nomor: phone };
  }
  return null;
}

export async function sendDocumentToOwner(filePath, fileName, caption = '', mimetype = 'application/octet-stream') {
  const jid = getOwnerJid();
  if (!jid) throw new Error('NOMOR_UTAMA belum dikonfigurasi di .env');
  if (!sock || waState.status !== 'connected') {
    throw new Error('WhatsApp belum terhubung.');
  }
  const buffer = fs.readFileSync(filePath);
  return sock.sendMessage(jid, {
    document: buffer,
    fileName,
    mimetype,
    caption,
  });
}

function unwrapMessageContent(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessageContent(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessageContent(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(message.documentWithCaptionMessage.message);
  }
  return message;
}

function extractMessagePayload(rawMsg) {
  const content = unwrapMessageContent(rawMsg.message);
  if (!content) return null;

  let text = '';
  let mediaType = null;
  let mimeType = null;
  let fileName = null;

  if (content.conversation) {
    text = content.conversation;
  } else if (content.extendedTextMessage?.text) {
    text = content.extendedTextMessage.text;
  } else if (content.imageMessage) {
    text = content.imageMessage.caption || '';
    mediaType = 'image';
    mimeType = content.imageMessage.mimetype || 'image/jpeg';
  } else if (content.documentMessage) {
    text = content.documentMessage.caption || '';
    mediaType = 'document';
    mimeType = content.documentMessage.mimetype || 'application/octet-stream';
    fileName = content.documentMessage.fileName || 'dokumen';
  } else if (content.audioMessage) {
    text = '';
    mediaType = 'audio';
    mimeType = content.audioMessage.mimetype || 'audio/ogg; codecs=opus';
    fileName = 'voice-note.ogg';
  } else {
    return null;
  }

  return { content, text: text.trim(), mediaType, mimeType, fileName };
}

function extensionFromMime(mimeType, fallbackFileName = '') {
  if (fallbackFileName && path.extname(fallbackFileName)) {
    return path.extname(fallbackFileName).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  }
  const clean = (mimeType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/zip': '.zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/plain': '.txt',
  };
  return map[clean] || '.bin';
}

function guessMimeFromFilename(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.db': 'application/x-sqlite3',
  };
  return map[ext] || 'application/octet-stream';
}

function saveMediaBuffer(targetDir, relPrefix, buffer, mimeType, originalFileName = '') {
  const ext = extensionFromMime(mimeType, originalFileName);
  const baseName = originalFileName
    ? path
        .basename(originalFileName, path.extname(originalFileName))
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 40)
    : 'media';
  const finalName = `${Date.now()}-${baseName || 'file'}${ext}`;
  const fullPath = path.join(targetDir, finalName);
  fs.writeFileSync(fullPath, buffer);
  return `${relPrefix}/${finalName}`;
}

function extractFirstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

export function extractQuotedText(text) {
  const str = String(text || '');
  const doubleQuoted = str.match(/["“]([^"”]+)["”]/);
  if (doubleQuoted && doubleQuoted[1].trim()) return doubleQuoted[1].trim();
  const singleQuoted = str.match(/(?:^|\s)['‘]([^'’]{2,})['’](?:\s|$|[.,!?])/);
  if (singleQuoted && singleQuoted[1].trim()) return singleQuoted[1].trim();
  return null;
}

function toCleanTitle(str) {
  return String(str || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const GENERIC_VAULT_LABELS = new Set([
  '',
  'ini',
  'itu',
  'item vault',
  'vault',
  'file',
  'dokumen',
  'gambar',
  'foto',
  'link',
  'media',
  'catatan',
]);

export function resolveVaultKeyword(payload = {}, rawText = '', fileName = null) {
  const candidates = [payload.kata_kunci, payload.judul, payload.matkul];
  for (const cand of candidates) {
    const clean = String(cand || '')
      .replace(/^["“'‘]+|["”'’]+$/g, '')
      .trim();
    // Skip if Gemini accidentally echoed the raw command with quotes
    const looksLikeRawCmd = /^simpan\b/i.test(clean) || /["“][^"”]+["”]/.test(clean);
    if (clean && !looksLikeRawCmd && !GENERIC_VAULT_LABELS.has(clean.toLowerCase())) {
      return clean;
    }
  }

  // Fallback: extract meaningful keyword directly from user's caption/text (excluding quoted content & URLs)
  let fromText = String(rawText || '')
    .replace(/https?:\/\/[^\s]+/gi, ' ')
    .replace(/["“][^"”]+["”]/g, ' ')
    .replace(/(?:^|\s)['‘][^'’]{2,}['’](?:\s|$)/g, ' ')
    .replace(
      /^(?:tolong\s+)?(?:simpan(?:in|kan)?|save|masukin|masukkan|taruh|catat|simpen)(?:\s+(?:ini|itu|file|dokumen|gambar|foto|screenshot|ss|link))?(?:\s+(?:ke|di)\s+(?:quick\s+)?vault)?(?:\s+(?:sebagai|dengan\s+(?:nama|label|kata\s+kunci)|nama|label|kata\s+kunci))?[\s,.:;\-]*/i,
      ''
    )
    .replace(/\b(?:ini|itu)\b/gi, ' ')
    .replace(/[\s,.:;\-]+(?:ke|di)\s+(?:quick\s+)?vault$/i, '')
    .replace(/[:;,.\-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (fromText && !GENERIC_VAULT_LABELS.has(fromText.toLowerCase())) {
    return toCleanTitle(fromText.slice(0, 80));
  }

  if (fileName) {
    const base = path.basename(fileName, path.extname(fileName)).trim();
    if (base && !GENERIC_VAULT_LABELS.has(base.toLowerCase())) {
      return base;
    }
  }

  const quoted = extractQuotedText(rawText);
  if (quoted) {
    return toCleanTitle(quoted.slice(0, 50));
  }

  const note = String(payload.isi_catatan || '')
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim();
  if (note && !GENERIC_VAULT_LABELS.has(note.toLowerCase())) {
    return note.slice(0, 60);
  }

  return 'Item Vault';
}

export function resolveVaultContent(payload = {}, rawText = '') {
  const url = extractFirstUrl(payload.isi_catatan) || extractFirstUrl(rawText);
  if (url) return url;

  // Always prefer exact text inside quotation marks if user wrapped the content in quotes
  const quotedFromRaw = extractQuotedText(rawText);
  if (quotedFromRaw) return quotedFromRaw;

  const quotedFromPayload = extractQuotedText(payload.isi_catatan);
  if (quotedFromPayload) return quotedFromPayload;

  const payloadContent = String(payload.isi_catatan || '')
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim();
  if (payloadContent && !/^(?:tolong\s+)?(?:simpan(?:in|kan)?|save|masukin|masukkan|catat)\b/i.test(payloadContent)) {
    return payloadContent;
  }

  const strippedRaw = String(rawText || '')
    .replace(
      /^(?:tolong\s+)?(?:simpan(?:in|kan)?|save|masukin|masukkan|taruh|catat|simpen)(?:\s+(?:ini|itu|link|catatan|teks))?(?:\s+(?:ke|di)\s+(?:quick\s+)?vault)?[\s,.:;\-]*/i,
      ''
    )
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim();

  return strippedRaw || String(rawText || '').trim();
}

function isImageFilePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
}

/**
 * Execute the classified intent against SQLite and build outgoing WhatsApp message(s).
 * Separated cleanly so it can be called from Baileys listener AND automated tests.
 */
export async function executeIntent({
  result,
  rawText = '',
  mediaBuffer = null,
  mediaType = null,
  mimeType = null,
  fileName = null,
  now = new Date(),
}) {
  const { intent, reply_message, payload = {} } = result;
  const nowParts = getWibParts(now);

  switch (intent) {
    case 'TAMBAH_JADWAL': {
      const items =
        Array.isArray(payload.schedules) && payload.schedules.length > 0
          ? payload.schedules
          : [
              {
                judul: payload.judul || payload.matkul || rawText,
                hari: payload.hari,
                tanggal: payload.tanggal,
                jam: payload.jam,
                is_rutin: payload.is_rutin,
                is_presensi: payload.is_presensi,
                ring_loud: payload.ring_loud,
              },
            ];

      const created = [];
      const rawStr = String(rawText || '');
      const fallbackJamMatch = rawStr.match(/\b(?:jam|pukul|pkl)\s*(\d{1,2}[:.]\d{2})\b/i) ||
        rawStr.match(/\b(\d{1,2}[:.]\d{2})\b/);
      const fallbackHariMatch = rawStr.match(/\b(senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad)\b/i);
      const fallbackIsRutin = /\b(tiap|setiap|rutin)\b/i.test(rawStr);
      const explicitNoPresensi = /\b(alarm\s+biasa|bukan\s+presensi|tanpa\s+ulang|jangan\s+ulang|sekali\s+saja)\b/i.test(rawStr);
      const inferredRingFromRaw = inferRingLoud(rawStr);

      for (const item of items) {
        const cleanJam = normalizeJam(item.jam) || (fallbackJamMatch ? normalizeJam(fallbackJamMatch[1]) : null);
        if (!cleanJam) continue;
        const isRutin = item.is_rutin !== undefined ? item.is_rutin !== false : (fallbackIsRutin || Boolean(item.hari || fallbackHariMatch));
        const resolvedHari =
          normalizeHari(item.hari) ||
          (fallbackHariMatch ? normalizeHari(fallbackHariMatch[1]) : null) ||
          (item.tanggal ? getHariFromDateStr(item.tanggal) : nowParts.hari);
        const itemNama = item.judul || payload.matkul || 'Jadwal Baru';
        const explicitPresensi = /\b(presensi|absen|absensi)\b/i.test(`${itemNama} ${rawStr}`);

        let isPresensi;
        if (explicitNoPresensi) {
          isPresensi = false;
        } else if (explicitPresensi) {
          isPresensi = true;
        } else if (typeof item.is_presensi === 'boolean') {
          isPresensi = item.is_presensi;
        } else if (typeof payload.is_presensi === 'boolean') {
          isPresensi = payload.is_presensi;
        } else {
          isPresensi = inferIsPresensi({ nama: itemNama, is_rutin: isRutin, rawText: rawStr });
        }

        const ringLoud =
          inferredRingFromRaw !== null
            ? inferredRingFromRaw
            : typeof item.ring_loud === 'boolean'
              ? item.ring_loud
              : Boolean(payload.ring_loud);

        const rec = jadwalRepo.create({
          nama: itemNama,
          hari: resolvedHari,
          tanggal: isRutin ? null : normalizeDateStr(item.tanggal) || nowParts.dateStr,
          jam: cleanJam,
          is_rutin: isRutin ? 1 : 0,
          aktif: 1,
          repeat_until_ok: isPresensi ? 1 : 0,
          ring_loud: ringLoud ? 1 : 0,
        });
        created.push(rec);
      }

      if (!created.length) {
        return {
          text: 'Maaf, aku belum menangkap jam jadwalnya (format HH:MM). Bisa sebutkan lagi jam pengingatnya?',
        };
      }

      const summary = created
        .map((j) => {
          const ringTagNote = Number(j.ring_loud) === 1 ? ' • Dering Keras [RING]' : '';
          const modeNote = j.repeat_until_ok
            ? ` _(Presensi • ulang tiap ${Number(j.repeat_interval_min) || 20}m sampai balas "ok"${ringTagNote})_`
            : ` _(Alarm Biasa • 1x pengingat${ringTagNote})_`;
          return j.is_rutin
            ? `• *${j.nama}* — Rutin tiap ${j.hari} pukul ${j.jam} WIB${modeNote}`
            : `• *${j.nama}* — ${j.hari}, ${j.tanggal} pukul ${j.jam} WIB${modeNote}`;
        })
        .join('\n');

      emitDataChange('jadwal', 'whatsapp');
      return {
        text: `${reply_message}\n\n📅 *Jadwal Tersimpan (${created.length}):*\n${summary}`,
      };
    }

    case 'SNOOZE_JADWAL': {
      const menit = Math.max(1, Math.min(720, Number(payload.menit_tunda) || 10));
      const target = addMinutesWib(menit, now);
      const last = getLastReminder();
      const namaKegiatan =
        payload.judul ||
        last?.activityName ||
        last?.title ||
        'Pengingat (Snooze)';

      const rec = jadwalRepo.create({
        nama: namaKegiatan.includes('(Snooze)') ? namaKegiatan : `${namaKegiatan} (Snooze)`,
        hari: target.hari,
        tanggal: target.dateStr,
        jam: target.timeStr,
        is_rutin: 0,
        aktif: 1,
        repeat_until_ok: 0,
      });

      emitDataChange('jadwal', 'whatsapp');
      return {
        text: `⏰ Siap! *${rec.nama}* ditunda *${menit} menit* dan akan diingatkan lagi pukul *${rec.jam} WIB* (${rec.tanggal}).`,
      };
    }

    case 'TAMBAH_TUGAS': {
      const items =
        Array.isArray(payload.tasks) && payload.tasks.length > 0
          ? payload.tasks
          : [
              {
                judul: payload.judul || rawText,
                matkul: payload.matkul || '',
                tanggal: payload.tanggal,
                jam: payload.jam,
              },
            ];

      const created = [];
      for (const item of items) {
        const datePart = normalizeDateStr(item.tanggal);
        if (!datePart) continue;
        const jamPart = normalizeJam(item.jam) || '23:59';
        const deadline = normalizeDeadline(`${datePart} ${jamPart}`);
        if (!deadline) continue;
        const rec = tugasRepo.create({
          judul: item.judul || 'Tugas Baru',
          matkul: item.matkul || payload.matkul || '',
          deadline,
        });
        created.push(rec);
      }

      if (!created.length) {
        return {
          text: 'Maaf, tanggal deadline tugasnya belum terbaca jelas. Bisa sebutkan tanggal deadlinenya?',
        };
      }

      const lines = created
        .map((t) => `• *${t.judul}*${t.matkul ? ` (${t.matkul})` : ''}\n  ⏳ Deadline: ${t.deadline} WIB`)
        .join('\n');

      emitDataChange('tugas', 'whatsapp');
      return {
        text: `${reply_message}\n\n📝 *Tugas Tercatat (${created.length}):*\n${lines}\n\n_Pengingat otomatis aktif pada H-24 jam & H-3 jam._`,
      };
    }

    case 'SELESAI_TUGAS': {
      const matches = tugasRepo.findActiveByKeywords([
        payload.judul,
        payload.matkul,
        payload.kata_kunci,
        rawText,
      ]);

      if (!matches.length) {
        return {
          text: 'Tidak ditemukan tugas aktif yang cocok dengan kata kunci tersebut. Ketik *"cek tugas"* untuk melihat daftar tugas aktif.',
        };
      }

      const target = matches[0];
      tugasRepo.update(target.id, { selesai: 1 });
      emitDataChange('tugas', 'whatsapp');
      return {
        text: `✅ Mantap! Tugas *${target.judul}*${target.matkul ? ` (${target.matkul})` : ''} ditandai *SELESAI*. Pengingat selanjutnya sudah dihentikan.`,
      };
    }

    case 'CEK_TUGAS': {
      const active = tugasRepo.list({ selesai: 0 });
      if (!active.length) {
        return { text: '🎉 Keren! Tidak ada tugas aktif saat ini. Semua sudah beres!' };
      }

      const lines = active.map((t, i) => {
        const cd = formatCountdown(t.deadline, now);
        const icon = cd.urgency === 'overdue' || cd.urgency === 'critical' ? '🔴' : cd.urgency === 'warning' ? '🟡' : '🟢';
        return `${i + 1}. ${icon} *${t.judul}*${t.matkul ? ` (${t.matkul})` : ''}\n    Deadline: ${t.deadline} WIB _(${cd.label})_`;
      });

      return {
        text: `📋 *Daftar Tugas Aktif (${active.length}):*\n\n${lines.join('\n\n')}`,
      };
    }

    case 'SIMPAN_MEMORI': {
      let mediaPath = null;
      if (mediaBuffer && mediaType === 'image') {
        mediaPath = saveMediaBuffer(MEMORI_UPLOADS_DIR, 'uploads/memori', mediaBuffer, mimeType, fileName || 'memori');
      }
      const tanggal = normalizeDateStr(payload.tanggal) || nowParts.dateStr;
      const hari = normalizeHari(payload.hari) || getHariFromDateStr(tanggal);
      const isi = payload.isi_catatan || rawText || 'Catatan foto kenangan';

      const saved = memoriRepo.create({
        tanggal,
        hari,
        isi,
        deskripsi: payload.deskripsi || '',
        media_path: mediaPath,
      });

      emitDataChange('memori', 'whatsapp');
      return {
        text: `${reply_message}\n\n💝 *Tersimpan di Brankas Memori*\n📅 ${saved.hari}, ${saved.tanggal}\n📝 ${saved.isi}${saved.media_path ? '\n🖼️ Foto ikut tersimpan di galeri dashboard.' : ''}`,
      };
    }

    case 'CEK_JADWAL': {
      const allActive = jadwalRepo.list({ aktif: 1 });
      if (!allActive.length) {
        return { text: '📅 Belum ada jadwal aktif yang tersimpan.' };
      }

      let filtered = allActive;
      let headerLabel = 'Semua Jadwal Aktif';
      if (payload.hari || payload.tanggal) {
        const targetHari = normalizeHari(payload.hari) || (payload.tanggal ? getHariFromDateStr(payload.tanggal) : null);
        const targetTanggal = normalizeDateStr(payload.tanggal);
        filtered = allActive.filter(
          (j) =>
            (j.is_rutin === 1 && targetHari && j.hari === targetHari) ||
            (j.is_rutin === 0 && targetTanggal && j.tanggal === targetTanggal)
        );
        headerLabel = targetTanggal
          ? `Jadwal ${targetHari || ''}, ${targetTanggal}`
          : `Jadwal Hari ${targetHari}`;
      }

      if (!filtered.length) {
        return {
          text: `📅 Tidak ada jadwal untuk *${headerLabel}*.\nKetik *"cek jadwal"* untuk melihat seluruh jadwal aktif (${allActive.length}).`,
        };
      }

      const lines = filtered.map((j, i) =>
        j.is_rutin
          ? `${i + 1}. *${j.nama}* — Tiap ${j.hari} pukul ${j.jam} WIB`
          : `${i + 1}. *${j.nama}* — ${j.hari}, ${j.tanggal} pukul ${j.jam} WIB`
      );
      return {
        text: `📅 *${headerLabel} (${filtered.length}):*\n\n${lines.join('\n')}`,
      };
    }

    case 'CARI_MEMORI': {
      const rawKey = String(payload.kata_kunci || '').trim();
      const isGenericMemoryKey =
        !rawKey ||
        /^(semua|all|terbaru|list|daftar|pacar|dia|doi|aktivitas|kegiatan|memori|catatan|cerita|keseharian|riwayat|history|aktivitas\s+pacar|kegiatan\s+pacar|memori\s+pacar|catatan\s+pacar|cerita\s+pacar|brankas\s+memori)$/i.test(
          rawKey
        );
      const effectiveKeyword = isGenericMemoryKey ? undefined : rawKey;

      const searchParams = {
        tanggal: payload.tanggal || undefined,
        tanggal_mulai: payload.tanggal_mulai || undefined,
        tanggal_akhir: payload.tanggal_akhir || undefined,
        q: effectiveKeyword,
        limit: 25,
      };

      let rows = memoriRepo.list(searchParams);

      // Smart fallback if combined date + keyword is too narrow
      if (!rows.length && searchParams.q && (searchParams.tanggal || searchParams.tanggal_mulai)) {
        rows = memoriRepo.list({
          tanggal: searchParams.tanggal,
          tanggal_mulai: searchParams.tanggal_mulai,
          tanggal_akhir: searchParams.tanggal_akhir,
          limit: 25,
        });
      }
      if (!rows.length && searchParams.q) {
        rows = memoriRepo.list({ q: searchParams.q, limit: 25 });
      }

      // If user asked for general list of partner memories/activities (no specific date/topic), show clean structured list directly
      const isGeneralListRequest =
        !searchParams.tanggal && !searchParams.tanggal_mulai && !searchParams.tanggal_akhir && !searchParams.q;
      if (isGeneralListRequest) {
        if (!rows.length) {
          return {
            text: '💝 Belum ada catatan aktivitas pacar di Brankas Memori.\nContoh catat cepat: */p hari ini dia habis ujian praktikum* atau cerita langsung di chat.',
          };
        }
        const shown = rows.slice(0, 10);
        const lines = shown.map(
          (m, i) =>
            `${i + 1}. *[${m.hari}, ${m.tanggal}]* ${m.isi}${m.deskripsi ? `\n    _${m.deskripsi}_` : ''}${m.media_path ? ' 📷' : ''}`
        );
        const moreNote = rows.length > 10 ? `\n\n_Menampilkan 10 terbaru dari ${rows.length} catatan._` : '';
        return {
          text: `💝 *Aktivitas & Memori Pacar (${rows.length}):*\n\n${lines.join('\n\n')}${moreNote}`,
        };
      }

      const answer = await synthesizeMemoryAnswer(rawText || effectiveKeyword || 'catatan memori', rows, now);
      const withImage = rows.find((r) => {
        const p = resolveUploadPath(r.media_path);
        return p && fs.existsSync(p);
      });

      return {
        text: answer,
        imagePath: withImage ? resolveUploadPath(withImage.media_path) : null,
      };
    }

    case 'TAMBAH_WISHLIST_MOMEN': {
      const tipe = payload.tipe_item === 'MOMEN' || (!payload.tipe_item && payload.tanggal) ? 'MOMEN' : 'WISHLIST';
      const judul = payload.judul || payload.isi_catatan || rawText;
      if (!judul) {
        return { text: 'Apa nama wishlist atau momen spesial yang ingin disimpan?' };
      }

      const saved = wishlistRepo.create({
        tipe,
        judul,
        tanggal: payload.tanggal || null,
        catatan: payload.isi_catatan && payload.isi_catatan !== judul ? payload.isi_catatan : '',
        ulang: payload.ulang || 'TAHUNAN',
      });

      emitDataChange('wishlist', 'whatsapp');
      if (saved.tipe === 'MOMEN') {
        const daysLabel = (saved.effective_notif_days || [7, 3, 1])
          .map((d) => (d === 0 ? 'Hari H' : `H-${d}`))
          .join(', ');
        const ulangLabel =
          saved.ulang === 'BULANAN' ? 'Tiap Bulan' : saved.ulang === 'SEKALI' ? 'Sekali Saja' : 'Tiap Tahun';
        return {
          text: `${reply_message}\n\n🎉 *Momen Spesial Tersimpan:*\n• *${saved.judul}*\n• Tanggal: ${saved.tanggal || '-'} (${ulangLabel})${saved.catatan ? `\n• Deskripsi: ${saved.catatan}` : ''}\n_Pengingat otomatis aktif pada ${daysLabel} pukul ${saved.effective_notif_jam || '08:00'} WIB._`,
        };
      }
      return {
        text: `${reply_message}\n\n🎁 *Wishlist Tersimpan:*\n• *${saved.judul}*${saved.catatan ? `\n• Deskripsi: ${saved.catatan}` : ''}`,
      };
    }

    case 'CEK_WISHLIST_MOMEN': {
      const filterTipe =
        payload.tipe_item === 'WISHLIST' || payload.tipe_item === 'MOMEN'
          ? payload.tipe_item
          : undefined;
      const items = wishlistRepo.list({ tipe: filterTipe });
      if (!items.length) {
        return { text: 'Belum ada data wishlist atau momen spesial tersimpan.' };
      }

      const wishlists = items.filter((i) => i.tipe === 'WISHLIST');
      const moments = items.filter((i) => i.tipe === 'MOMEN');
      const sections = [];

      if (moments.length) {
        sections.push(
          '🎉 *Momen Spesial:*\n' +
            moments
              .map(
                (m) =>
                  `• *${m.judul}* (${m.tanggal || '-'})${
                    m.days_until !== null ? ` — *${m.days_until === 0 ? 'HARI INI!' : `H-${m.days_until}`}*` : ''
                  }${m.catatan ? ` _(${m.catatan})_` : ''}`
              )
              .join('\n')
        );
      }

      if (wishlists.length) {
        sections.push(
          '🎁 *Wishlist Pacar:*\n' +
            wishlists
              .map(
                (w) =>
                  `• ${w.terpenuhi ? '✅' : '⬜'} *${w.judul}*${w.catatan ? ` — ${w.catatan}` : ''}`
              )
              .join('\n')
        );
      }

      return { text: sections.join('\n\n') };
    }

    case 'SIMPAN_VAULT': {
      const kataKunci = resolveVaultKeyword(payload, rawText, fileName);

      if (mediaBuffer && (mediaType === 'document' || mediaType === 'image' || mediaType === 'audio')) {
        const relPath = saveMediaBuffer(VAULT_UPLOADS_DIR, 'uploads/vault', mediaBuffer, mimeType, fileName || kataKunci);
        const saved = vaultRepo.create({
          kata_kunci: kataKunci,
          konten: relPath,
          tipe: 'FILE',
        });
        emitDataChange('vault', 'whatsapp');
        return {
          text: `${reply_message}\n\n🗂️ *File Tersimpan di Quick Vault:*\n• Kata Kunci: *${saved.kata_kunci}*\n• File: \`${path.basename(saved.konten)}\``,
        };
      }

      const konten = resolveVaultContent(payload, rawText);
      if (!konten) {
        return { text: 'Lampirkan URL, teks catatan, atau dokumen yang ingin disimpan ke Quick Vault.' };
      }

      const saved = vaultRepo.create({
        kata_kunci: kataKunci,
        konten,
        tipe: 'LINK',
      });

      emitDataChange('vault', 'whatsapp');
      return {
        text: `${reply_message}\n\n🔗 *Tersimpan di Quick Vault:*\n• Judul / Kata Kunci: *${saved.kata_kunci}*\n• Isi: ${saved.konten}`,
      };
    }

    case 'CARI_VAULT': {
      const rawQuery = String(payload.kata_kunci || payload.judul || rawText || '').trim();
      const wantsAll =
        /^semua$/i.test(rawQuery) ||
        /\b(semua|daftar|list|apa\s+aja|apa\s+saja)\b.*\bvault\b|\bvault\b.*\b(semua|apa\s+aja|apa\s+saja)\b/i.test(
          rawText || rawQuery
        );

      if (wantsAll) {
        const all = vaultRepo.list();
        if (!all.length) {
          return { text: 'Quick Vault masih kosong. Kirim link atau file dengan caption untuk menyimpannya.' };
        }
        const listText = all
          .map((item, idx) => `${idx + 1}. [${item.tipe}] *${item.kata_kunci}*`)
          .join('\n');
        return {
          text: `🗂️ *Daftar Isi Quick Vault (${all.length}):*\n\n${listText}\n\n_Ketik "minta <kata kunci>" untuk mengambil itemnya._`,
        };
      }

      const matches = vaultRepo.search(rawQuery);
      if (!matches.length) {
        return {
          text: `Maaf, tidak ditemukan link atau dokumen dengan kata kunci *"${rawQuery}"* di Quick Vault.`,
        };
      }

      const best = matches[0];
      const othersNote =
        matches.length > 1
          ? `\n\n_Item lain yang mirip: ${matches
              .slice(1, 5)
              .map((m) => m.kata_kunci)
              .join(', ')}_`
          : '';

      if (best.tipe === 'FILE') {
        const fullPath = resolveUploadPath(best.konten);
        if (fullPath && fs.existsSync(fullPath)) {
          if (isImageFilePath(fullPath)) {
            return {
              text: `🖼️ Ini gambar untuk *${best.kata_kunci}*:${othersNote}`,
              imagePath: fullPath,
            };
          }
          return {
            text: `📂 Ini dokumen untuk *${best.kata_kunci}*:${othersNote}`,
            documentPath: fullPath,
            documentName: path.basename(fullPath),
            documentMime: guessMimeFromFilename(fullPath),
          };
        }
        return {
          text: `Catatan *${best.kata_kunci}* ditemukan, tetapi file fisiknya tidak lagi tersedia di server.`,
        };
      }

      // If multiple LINK/note items match (e.g. multiple "Anime" entries), list ALL matching entries cleanly!
      const linkMatches = matches.filter((m) => m.tipe !== 'FILE').slice(0, 15);
      if (linkMatches.length > 1) {
        const lines = linkMatches
          .map((m, idx) => `${idx + 1}. *${m.kata_kunci}*\n    ${m.konten}`)
          .join('\n');
        return {
          text: `🔗 *Daftar Quick Vault untuk "${rawQuery}" (${linkMatches.length}):*\n\n${lines}`,
        };
      }

      return {
        text: `🔗 *${best.kata_kunci}*\n${best.konten}${othersNote}`,
      };
    }

    case 'UBAH_VAULT': {
      const oldQuery = String(payload.kata_kunci || '').trim();
      const newName = String(payload.nama_baru || payload.judul || '').trim();
      if (!newName) {
        return { text: 'Sebutkan nama baru yang diinginkan, contoh: *"ubah nama di vault ini menjadi deca"*.' };
      }

      let target = null;
      const refersLatest =
        !oldQuery || /^(ini|itu|terakhir|tadi|baru|terbaru|barusan)$/i.test(oldQuery);

      if (refersLatest) {
        // Check if an item is literally named oldQuery (e.g., 'ini') first, else use most recent item
        const exactMatch = oldQuery
          ? vaultRepo.list().find((v) => v.kata_kunci.toLowerCase() === oldQuery.toLowerCase())
          : null;
        target = exactMatch || vaultRepo.getLatest();
      } else {
        const matches = vaultRepo.search(oldQuery);
        target = matches[0] || null;
      }

      if (!target) {
        return {
          text: `Tidak ditemukan item Quick Vault yang cocok dengan *"${oldQuery || 'terakhir'}"*. Ketik *"lihat semua isi vault"* untuk melihat daftarnya.`,
        };
      }

      const oldName = target.kata_kunci;
      const updated = vaultRepo.update(target.id, { kata_kunci: newName });
      emitDataChange('vault', 'whatsapp');

      return {
        text: `✅ Nama item di Quick Vault berhasil diubah!\n• Sebelumnya: *${oldName}*\n• Sekarang: *${updated.kata_kunci}*`,
      };
    }

    case 'CATAT_PENGELUARAN': {
      const items = Array.isArray(payload.expenses) ? payload.expenses : [];
      if (!items.length) {
        return {
          text: 'Nominal pengeluaran belum terbaca. Contoh: *"Makan siang 18rb, bensin 25rb"* atau kirim foto struk.',
        };
      }

      const tanggal = normalizeDateStr(payload.tanggal) || nowParts.dateStr;
      const created = pengeluaranRepo.createMany(items, tanggal, 'PENGELUARAN');
      if (!created.length) {
        return {
          text: 'Tidak ada item pengeluaran valid yang berhasil dicatat.',
        };
      }

      const total = created.reduce((sum, x) => sum + x.nominal, 0);
      const lines = created
        .map((e) => `• ${e.item} — *-${formatRupiah(e.nominal)}* _(${e.kategori})_`)
        .join('\n');

      emitDataChange('pengeluaran', 'whatsapp');
      checkBudgetThresholds(tanggal.slice(0, 7)).catch(() => {});
      return {
        text: `${reply_message}\n\n💸 *Pengeluaran Tercatat (${tanggal}):*\n${lines}\n\n*Total Keluar:* ${formatRupiah(total)}`,
      };
    }

    case 'CATAT_PEMASUKAN': {
      const items = Array.isArray(payload.expenses) ? payload.expenses : [];
      if (!items.length) {
        return {
          text: 'Nominal pemasukan belum terbaca. Contoh: *"Dapat uang saku 500rb"* atau `/pm uang saku 500rb`.',
        };
      }

      const tanggal = normalizeDateStr(payload.tanggal) || nowParts.dateStr;
      const created = pengeluaranRepo.createMany(items, tanggal, 'PEMASUKAN');
      if (!created.length) {
        return {
          text: 'Tidak ada item pemasukan valid yang berhasil dicatat.',
        };
      }

      const total = created.reduce((sum, x) => sum + x.nominal, 0);
      const lines = created
        .map((e) => `• ${e.item} — *+${formatRupiah(e.nominal)}* _(${e.kategori})_`)
        .join('\n');

      emitDataChange('pengeluaran', 'whatsapp');
      return {
        text: `${reply_message}\n\n💰 *Pemasukan Tercatat (${tanggal}):*\n${lines}\n\n*Total Masuk:* ${formatRupiah(total)}`,
      };
    }

    case 'REKAP_PENGELUARAN': {
      const start = normalizeDateStr(payload.tanggal_mulai || payload.tanggal) || nowParts.dateStr;
      const end = normalizeDateStr(payload.tanggal_akhir || payload.tanggal) || nowParts.dateStr;
      const summary = pengeluaranRepo.getSummary({ tanggal_mulai: start, tanggal_akhir: end });

      const periodLabel = start === end ? start : `${start} s/d ${end}`;
      if (!summary.count) {
        return {
          text: `📊 Belum ada catatan keuangan pada periode *${periodLabel}*.`,
        };
      }

      const expCatLines = Object.entries(summary.byCategory)
        .filter(([, val]) => val > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, val]) => `• ${cat}: *${formatRupiah(val)}*`)
        .join('\n');

      const incCatLines = Object.entries(summary.incomeByCategory || {})
        .filter(([, val]) => val > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, val]) => `• ${cat}: *${formatRupiah(val)}*`)
        .join('\n');

      const saldoPrefix = summary.balance > 0 ? '+' : summary.balance < 0 ? '-' : '';
      const saldoStr = `${saldoPrefix}${formatRupiah(Math.abs(summary.balance))}`;

      const parts = [
        `📊 *Rekap Keuangan (${periodLabel})*`,
        `Total Transaksi: ${summary.count}`,
        `🟢 *Pemasukan:* ${formatRupiah(summary.totalIncome)}`,
        `🔴 *Pengeluaran:* ${formatRupiah(summary.totalExpense)}`,
        `💰 *Saldo Bersih:* ${saldoStr}`,
      ];
      if (incCatLines) parts.push(`\n*Rincian Pemasukan:*\n${incCatLines}`);
      if (expCatLines) parts.push(`\n*Rincian Pengeluaran:*\n${expCatLines}`);

      return { text: parts.join('\n') };
    }

    case 'TAMBAH_REMINDER': {
      const menit = Math.max(1, Math.min(1440, Math.round(Number(payload.menit_tunda) || 15)));
      const pesan = String(payload.judul || payload.isi_catatan || rawText || 'Pengingat').trim();
      const inferredRing = inferRingLoud(rawText);
      const ringLoud = inferredRing !== null ? inferredRing : Boolean(payload.ring_loud);
      const target = addMinutesWib(menit, now);
      const saved = reminderRepo.create({ pesan, trigger_at: target.dateTimeStr, ring_loud: ringLoud ? 1 : 0 });
      emitDataChange('reminder', 'whatsapp');
      const modeLine = saved.ring_loud ? '\n• Mode: _Dering Keras [RING] (MacroDroid)_' : '';
      return {
        text: `⏰ *Pengingat Cepat Dipasang!*\n• Pesan: *${saved.pesan}*\n• Akan berbunyi: *${target.timeStr} WIB* (${target.dateStr}, ${menit} menit lagi)${modeLine}`,
      };
    }

    case 'SIMPAN_KONTAK': {
      const nama = String(payload.target_kontak || payload.judul || '').trim();
      const nomorRaw = String(payload.kata_kunci || payload.isi_catatan || rawText || '').trim();
      const cleanNomor = normalizeWaPhone(nomorRaw);
      if (!nama || !cleanNomor) {
        return {
          text: 'Format simpan kontak belum lengkap. Contoh: *"simpan kontak pacar 08123456789"* atau `/kontak pacar 08123456789`.',
        };
      }
      const saved = contactRepo.upsert({ nama, nomor: cleanNomor });
      emitDataChange('outbound', 'whatsapp');
      return {
        text: `✅ *Kontak Tersimpan:*\n• Nama: *${saved.nama}*\n• Nomor WA: \`${saved.nomor}\`\n\nSekarang kamu bisa kirim alarm cukup dengan menyebut namanya, misal:\n_"Setiap hari jam 06:00 kirim alarm ke ${saved.nama} Bangun pagi tiap 10 menit sampai balas ok"_`,
      };
    }

    case 'KIRIM_ALARM_ORANG': {
      const rawTarget = String(payload.target_kontak || payload.kata_kunci || '').trim();
      const resolved = resolveOutboundTarget(rawTarget);
      if (!resolved) {
        return {
          text:
            `Kontak *"${rawTarget || '-'}"* belum terdaftar dan bukan nomor WA valid.\n` +
            `Simpan dulu dengan \`/kontak ${rawTarget || 'pacar'} 0812xxxxxxxx\` atau sebutkan langsung nomor HP-nya!`,
        };
      }

      const pesan = String(payload.isi_catatan || payload.judul || '').trim() || 'Jangan lupa ya!';
      const modeRaw = String(payload.mode_jadwal || 'SEKALI').trim().toUpperCase();
      const repeatUntilOk = payload.ulang_sampai_ok === false ? 0 : 1;
      const intervalMenit = Math.max(2, Math.min(180, Math.round(Number(payload.interval_menit) || 10)));
      const maxRepeats = Math.max(1, Math.min(60, Math.round(Number(payload.max_repeats) || 20)));

      if (modeRaw === 'SEKARANG') {
        const { triggerOutboundAlarmNow } = await import('./scheduler.js');
        await triggerOutboundAlarmNow(
          {
            target_nama: resolved.target_nama,
            target_nomor: resolved.target_nomor,
            pesan,
            repeat_until_ok: repeatUntilOk,
            interval_menit: intervalMenit,
            max_repeats: maxRepeats,
          },
          now
        );
        const modeInfo = repeatUntilOk
          ? `Ulang tiap *${intervalMenit} menit* sampai dia balas *"ok"* (maks ${maxRepeats}x)`
          : 'Kirim 1x saja';
        return {
          text:
            `📤 *Alarm Terkirim Sekarang!*\n` +
            `• Tujuan: *${resolved.target_nama}* (\`${resolved.target_nomor}\`)\n` +
            `• Pesan: *${pesan}*\n` +
            `• Mode: ${modeInfo}\n\n` +
            `_Ketik \`/stopkirim\` kapan saja untuk menghentikan manual._`,
        };
      }

      const cleanJam = normalizeJam(payload.jam);
      if (!cleanJam) {
        return {
          text: 'Jam mulai alarm ke nomor tujuan belum terbaca. Contoh: *"jam 06:00 pagi"* atau *"sekarang"*.',
        };
      }

      const dbMode = normalizeOutboundMode(modeRaw);
      const saved = outboundAlarmRepo.create({
        target_nama: resolved.target_nama,
        target_nomor: resolved.target_nomor,
        pesan,
        mode: dbMode,
        hari: payload.hari || nowParts.hari,
        tanggal: dbMode === 'SEKALI' ? normalizeDateStr(payload.tanggal) || nowParts.dateStr : null,
        jam: cleanJam,
        repeat_until_ok: repeatUntilOk,
        interval_menit: intervalMenit,
        max_repeats: maxRepeats,
        aktif: 1,
      });

      emitDataChange('outbound', 'whatsapp');
      const jadwalDesc =
        saved.mode === 'HARIAN'
          ? `Setiap Hari mulai pukul *${saved.jam} WIB*`
          : saved.mode === 'MINGGUAN'
            ? `Tiap ${saved.hari} mulai pukul *${saved.jam} WIB*`
            : `${saved.hari}, ${saved.tanggal} mulai pukul *${saved.jam} WIB*`;
      const repeatDesc = saved.repeat_until_ok
        ? `Ulang tiap *${saved.interval_menit} menit* sampai dia balas *"ok"* (maks ${saved.max_repeats}x)`
        : '1x kirim saja (tanpa ulang)';

      return {
        text:
          `${reply_message}\n\n` +
          `📤 *Alarm Nomor Lain Tersimpan:*\n` +
          `• Tujuan: *${saved.target_nama}* (\`${saved.target_nomor}\`)\n` +
          `• Pesan: *${saved.pesan}*\n` +
          `• Jadwal: ${jadwalDesc}\n` +
          `• Pengulangan: ${repeatDesc}`,
      };
    }

    case 'STOP_ALARM_ORANG': {
      const rawTarget = String(payload.target_kontak || payload.kata_kunci || '').trim();
      const stopAll = !rawTarget || /^semua$/i.test(rawTarget);
      let stopped = [];
      if (stopAll) {
        stopped = outboundPendingRepo.acknowledgeAll(nowParts.dateTimeStr, 'OWNER');
      } else {
        const resolved = resolveOutboundTarget(rawTarget);
        if (resolved) {
          stopped = outboundPendingRepo.acknowledgeByPhone(resolved.target_nomor, nowParts.dateTimeStr, 'OWNER');
        } else {
          const allActive = outboundPendingRepo.listActive();
          const low = rawTarget.toLowerCase();
          for (const row of allActive) {
            if (row.target_nama.toLowerCase().includes(low) || row.pesan.toLowerCase().includes(low)) {
              const s = outboundPendingRepo.acknowledgeById(row.id, nowParts.dateTimeStr, 'OWNER');
              if (s) stopped.push(s);
            }
          }
        }
      }

      if (!stopped.length) {
        return { text: '✅ Tidak ada alarm nomor lain yang sedang berulang aktif saat ini.' };
      }
      emitDataChange('outbound', 'whatsapp');
      const lines = stopped.map((s) => `• *${s.target_nama}* (\`${s.target_nomor}\`) — ${s.pesan}`).join('\n');
      return {
        text: `🛑 *Alarm Nomor Lain Dihentikan (${stopped.length}):*\n${lines}`,
      };
    }

    case 'SIMPAN_CATATAN': {
      const sumberTipe =
        mediaType === 'audio' ? 'VOICE' : mediaType === 'image' ? 'IMAGE' : 'TEXT';
      const kategori = String(payload.kategori || payload.matkul || 'Umum').trim() || 'Umum';
      const judul =
        String(payload.judul || payload.kata_kunci || '').trim() ||
        (kategori !== 'Umum' ? `Ringkasan ${kategori}` : 'Catatan Baru');
      const ringkasan = String(payload.ringkasan || payload.isi_catatan || rawText || '').trim();
      if (!ringkasan) {
        return {
          text: 'Isi catatan atau materi yang ingin dirangkum belum terbaca. Kirim voice note, foto slide, atau teks materinya ya.',
        };
      }

      const saved = catatanRepo.create({
        judul,
        kategori,
        ringkasan,
        sumber_tipe: sumberTipe,
      });

      emitDataChange('catatan', 'whatsapp');
      return {
        text: `${reply_message}\n\n📚 *Catatan Kuliah / Ide Tersimpan*\n• Judul: *${saved.judul}*\n• Kategori: *${saved.kategori}* _(${saved.sumber_tipe})_\n\n*Ringkasan:*\n${saved.ringkasan}`,
      };
    }

    case 'CARI_CATATAN': {
      const rawQuery = String(payload.kata_kunci || payload.kategori || payload.matkul || payload.judul || '').trim();
      const wantsAll = !rawQuery || /^semua$/i.test(rawQuery);
      const matches = wantsAll ? catatanRepo.list() : catatanRepo.search(rawQuery);

      if (!matches.length) {
        return {
          text: wantsAll
            ? '📚 Belum ada catatan kuliah atau ide tersimpan.\nKirim voice note/teks dengan perintah *"Rangkumin jadi catatan kuliah Kriptografi"* atau pakai `/n`.'
            : `📚 Tidak ditemukan catatan yang cocok dengan *"${rawQuery}"*.\nKetik *"lihat catatan kuliah"* atau \`/n\` untuk melihat seluruh catatan.`,
        };
      }

      if (wantsAll && matches.length > 5) {
        const listLines = matches
          .slice(0, 12)
          .map((n, i) => `${i + 1}. *[${n.kategori}]* ${n.judul} _(${n.sumber_tipe})_`);
        return {
          text: `📚 *Daftar Catatan Kuliah & Ide (${matches.length}):*\n\n${listLines.join('\n')}\n\n_Ketik "cari catatan <topik/matkul>" untuk membaca detail ringkasannya._`,
        };
      }

      const shown = matches.slice(0, 4);
      const blocks = shown.map((n, i) => {
        const preview = n.ringkasan.length > 420 ? `${n.ringkasan.slice(0, 420)}...` : n.ringkasan;
        return `${i + 1}. *${n.judul}* _[${n.kategori} · ${n.sumber_tipe}]_\n${preview}`;
      });
      const header = wantsAll
        ? `📚 *Catatan Terbaru (${matches.length}):*`
        : `📚 *Hasil Pencarian Catatan "${rawQuery}" (${matches.length}):*`;

      return {
        text: `${header}\n\n${blocks.join('\n\n')}`,
      };
    }

    case 'REKOMENDASI_PACAR':
    case 'IDE_PACAR': {
      const key = String(payload.kata_kunci || '').trim();
      if (intent === 'IDE_PACAR' && key.toUpperCase() === 'REKAP') {
        const sinceDate = shiftDateStr(nowParts.dateStr, -30);
        const memories = memoriRepo.list({ tanggal_mulai: sinceDate, tanggal_akhir: nowParts.dateStr, limit: 35 });
        const recap = await generateMonthlyPartnerRecap(memories, `30 Hari Terakhir (${sinceDate} s/d ${nowParts.dateStr})`, now);
        return { text: `💝 *Rekap Memori Pacar (30 Hari Terakhir):*\n\n${recap}` };
      }
      const memories = memoriRepo.list({ limit: 15 });
      const unfulfilledAll = wishlistRepo.list().filter((item) => !item.terpenuhi);
      const wishlists = unfulfilledAll.filter((item) => item.tipe === 'WISHLIST');
      const moments = unfulfilledAll.filter((item) => item.tipe === 'MOMEN');
      const combinedQuery = rawText || key || 'rekomendasi kencan dan hadiah buat pacar';
      const isGift = /\b(kado|hadiah|gift|wishlist|beli(?:in|kan)?)\b/i.test(combinedQuery);
      const isDate = /\b(date|kencan|weekend|akhir\s+pekan|ngajak|ajak|ke\s*mana|jalan|nongkrong|makan)\b/i.test(combinedQuery);
      const mode = isGift && !isDate ? 'gift' : isDate && !isGift ? 'date' : 'auto';
      const budget = Number(payload.budget) > 0 ? Number(payload.budget) : null;

      const recommendation = await generatePartnerRecommendation(
        {
          prompt: combinedQuery,
          mode,
          budget,
          memories,
          wishlists,
          moments,
          noEmoji: false,
        },
        now
      );
      return { text: `💝 *Smart Date & Gift Assistant:*\n\n${recommendation}` };
    }

    case 'HABIT_CHECKIN': {
      const targetKey = String(payload.kata_kunci || payload.judul || rawText || '').trim();
      const found = habitRepo.findByKeyword(targetKey);
      if (!found) {
        return {
          text: `Habit *"${targetKey}"* belum ditemukan di daftarmu.\nTambah dulu dengan \`/h + ${targetKey}\` atau cek daftar habit dengan \`/h\`.`,
        };
      }
      habitRepo.toggleDate(found.id, nowParts.dateStr, true);
      emitDataChange('habits', 'whatsapp');
      const updated = habitRepo.getDashboardData(14, now).habits.find((x) => x.id === found.id);
      return {
        text: `✅ Mantap! Habit *${found.nama}* tercatat selesai hari ini!\n🔥 Streak: *${updated?.streak || 1} hari berturut-turut*.`,
      };
    }

    case 'MULAI_FOKUS': {
      const dur = Math.max(1, Math.min(240, Math.round(Number(payload.menit_tunda) || 25)));
      const label = String(payload.judul || 'Sesi Fokus').trim() || 'Sesi Fokus';
      const session = focusRepo.start({ label, durationMinutes: dur, now });
      emitDataChange('focus', 'whatsapp');
      return {
        text: `🍅 *Mode Fokus Dimulai (${session.durationMinutes} menit)!*\n• Topik: *${session.label}*\n• Selesai pukul: *${session.endsAtDisplay} WIB*\n\nFokus dulu ya, nanti aku kabari pas waktunya istirahat!`,
      };
    }

    default:
      return { text: reply_message || 'Halo! Ada yang bisa aku bantu hari ini?' };
  }
}

const PRESENSI_OK_RE =
  /^(?:ok|oke|okey|okay|sip|siap|udah|sudah|done|beres|aman|acc|(?:udah|sudah|ok|oke)\s+(?:presensi|absen))[.!\s👍✅👌]*$/i;

const TARGET_OK_RE =
  /^(?:ok|oke|okey|okay|sip|siap|udah|sudah|done|beres|aman|iya|ya|udah\s+bangun|sudah\s+bangun|ok\s+makasih|oke\s+makasih|makasih\s+ok|makasih\s+oke)[.!\s👍✅👌🙏]*$/i;

/**
 * Extract normalized WhatsApp phone number from a private non-owner incoming message key.
 * Rejects fromMe, groups, broadcasts, and newsletters.
 */
export function extractSenderPhone(msgKey) {
  if (!msgKey || msgKey.fromMe !== false) return null;
  const remoteJid = msgKey.remoteJid || '';
  const remoteJidAlt = msgKey.remoteJidAlt || '';
  if (
    !remoteJid ||
    remoteJid.endsWith('@g.us') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@newsletter')
  ) {
    return null;
  }

  const candidate = remoteJid.endsWith('@s.whatsapp.net')
    ? remoteJid
    : remoteJidAlt.endsWith('@s.whatsapp.net')
      ? remoteJidAlt
      : '';
  if (!candidate) return null;

  const rawDigits = candidate.split('@')[0].split(':')[0];
  return normalizeWaPhone(rawDigits);
}

/**
 * Strict Zero-Leak handler for non-owner target numbers replying "ok" to an active outbound alarm.
 * Returns null (Silent Drop) if the sender has no active repeating outbound alarm OR message is not "ok".
 */
export function handleTargetOkReply(msgKey, text, now = new Date()) {
  const senderPhone = extractSenderPhone(msgKey);
  if (!senderPhone) return null;

  const ownerNum = getOwnerNumber();
  if (ownerNum && senderPhone === ownerNum) return null;

  const activeForPhone = outboundPendingRepo.listActiveByPhone(senderPhone);
  if (!activeForPhone.length) return null;

  const clean = String(text || '').trim();
  if (!clean || !TARGET_OK_RE.test(clean)) return null;

  const nowParts = getWibParts(now);
  const acked = outboundPendingRepo.acknowledgeByPhone(senderPhone, nowParts.dateTimeStr, 'TARGET');
  if (!acked.length) return null;

  emitDataChange('outbound', 'whatsapp');

  const first = acked[0];
  const msgSummary = acked.map((a) => `*"${a.pesan}"*`).join(', ');
  return {
    targetPhone: senderPhone,
    targetNama: first.target_nama,
    ackedCount: acked.length,
    targetReply: '✅ Terima kasih sudah konfirmasi! Pengingat berulang sudah dihentikan.',
    ownerReport:
      `✅ *Alarm Nomor Lain Dikonfirmasi!*\n` +
      `• Penerima: *${first.target_nama}* (\`${senderPhone}\`)\n` +
      `• Pesan: ${msgSummary}\n` +
      `• Balasan: "${clean}" (${nowParts.timeStr} WIB)\n` +
      `Pengingat berulang sudah dihentikan otomatis.`,
  };
}

async function processTargetOkMessage(rawMsg) {
  const extracted = extractMessagePayload(rawMsg);
  if (!extracted || !extracted.text) return;

  const outcome = handleTargetOkReply(rawMsg.key, extracted.text);
  if (!outcome) return; // Strict Silent Drop

  try {
    await sock.sendMessage(rawMsg.key.remoteJid, { text: outcome.targetReply }, { quoted: rawMsg });
  } catch (err) {
    console.error('[WhatsApp] Failed replying target OK ack:', err?.message || err);
  }

  try {
    await sendDualNotification(
      `✅ Konfirmasi Alarm: ${outcome.targetNama}`,
      outcome.ownerReport,
      '/#jadwal',
      { recordForSnooze: false, tag: `outbound-ack-${outcome.targetPhone}-${Date.now()}` }
    );
  } catch (err) {
    console.error('[WhatsApp] Failed sending owner ack report:', err?.message || err);
  }
}

/**
 * 0ms instant acknowledgment for repeating presensi reminders when user replies "ok".
 * Only intercepts when at least one pending presensi loop is active.
 */
export function tryAcknowledgePendingPresensi(text, now = new Date()) {
  const clean = String(text || '').trim();
  if (!clean || !PRESENSI_OK_RE.test(clean)) return null;

  const active = presensiPendingRepo.listActive();
  if (!active.length) return null;

  const acked = presensiPendingRepo.acknowledgeAll(getWibParts(now).dateTimeStr);
  emitDataChange('jadwal', 'whatsapp');

  const names = acked.map((a) => `*${a.nama}* (${a.jam_awal} WIB)`).join(', ');
  return {
    text: `✅ *Presensi Dikonfirmasi!*\nPengingat berulang untuk ${names} sudah dihentikan. Semangat kuliahnya!`,
  };
}

async function processAllowedMessage(rawMsg) {
  const extracted = extractMessagePayload(rawMsg);
  if (!extracted) return;

  const replyJid = rawMsg.key.remoteJid;
  let mediaBuffer = null;

  try {
    if (extracted.mediaType) {
      const unwrappedForDownload = {
        ...rawMsg,
        message: extracted.content,
      };
      mediaBuffer = await downloadMediaMessage(
        unwrappedForDownload,
        'buffer',
        {},
        {
          logger: baileysLogger,
          reuploadRequest: sock.updateMediaMessage,
        }
      );
    }

    // 0ms Slash Commands (bypass Gemini AI completely when message starts with `/`)
    let outcome = await handleSlashCommand({
      text: extracted.text,
      mediaBuffer,
      mediaType: extracted.mediaType,
      mimeType: extracted.mimeType,
      fileName: extracted.fileName,
    });

    if (outcome?.skipReply) {
      return;
    }

    // 0ms Instant "ok" acknowledgment for active repeating presensi reminders
    if (!outcome && !extracted.mediaType) {
      outcome = tryAcknowledgePendingPresensi(extracted.text);
    }

    if (!outcome) {
      const analysis = await analyzeMessage({
        text: extracted.text,
        mediaBuffer,
        mimeType: extracted.mimeType,
        fileName: extracted.fileName,
        lastReminder: getLastReminder(),
      });

      outcome = await executeIntent({
        result: analysis,
        rawText: extracted.text,
        mediaBuffer,
        mediaType: extracted.mediaType,
        mimeType: extracted.mimeType,
        fileName: extracted.fileName,
      });
    }

    if (outcome.documentPath) {
      const docBuf = fs.readFileSync(outcome.documentPath);
      await sock.sendMessage(
        replyJid,
        {
          document: docBuf,
          fileName: outcome.documentName,
          mimetype: outcome.documentMime,
          caption: outcome.text,
        },
        { quoted: rawMsg }
      );
    } else if (outcome.imagePath) {
      const imgBuf = fs.readFileSync(outcome.imagePath);
      await sock.sendMessage(
        replyJid,
        {
          image: imgBuf,
          caption: outcome.text,
        },
        { quoted: rawMsg }
      );
    } else if (outcome.text) {
      await sock.sendMessage(replyJid, { text: outcome.text }, { quoted: rawMsg });
    }
  } catch (err) {
    console.error('[WhatsApp] Error handling message:', err);
    let readableError = err?.message || 'Kesalahan internal';
    try {
      const parsedErr = JSON.parse(readableError);
      if (parsedErr?.error?.message) readableError = parsedErr.error.message;
    } catch {
      // keep plain message
    }
    try {
      await sock.sendMessage(
        replyJid,
        {
          text: `⚠️ Maaf, terjadi kendala saat memproses pesanmu: ${readableError}`,
        },
        { quoted: rawMsg }
      );
    } catch {
      // ignore send failure
    }
  }
}

export async function initWhatsApp() {
  if (isInitializing) return;
  isInitializing = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    waState.status = 'connecting';
    waState.lastError = null;
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = undefined;
    }

    sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      browser: ['Personal Assistant', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    registerWhatsAppSender(sendTextToOwner);
    registerTargetWhatsAppSender(sendTextToNumber);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        waState.status = 'qr';
        try {
          waState.qrCodeDataUrl = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
          });
        } catch (err) {
          console.error('[WhatsApp] Failed to encode QR DataURL:', err.message);
        }
        console.log('[WhatsApp] QR Code siap discan melalui Web Dashboard.');
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        waState.status = 'connected';
        waState.qrCodeDataUrl = null;
        waState.lastError = null;
        waState.lastConnectedAt = getWibParts().display;
        waState.connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : null;
        console.log(`[WhatsApp] Terhubung sebagai ${waState.connectedPhone || 'bot'}`);
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        waState.status = 'disconnected';
        waState.qrCodeDataUrl = null;
        waState.connectedPhone = null;
        waState.lastError = loggedOut
          ? 'Sesi WhatsApp logout. Silakan scan ulang QR Code.'
          : lastDisconnect?.error?.message || `Koneksi terputus (kode ${statusCode || 'unknown'})`;

        if (loggedOut) {
          console.warn('[WhatsApp] Session logged out. Clearing auth folder and restarting QR flow...');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {
            // ignore
          }
          reconnectAttempts = 0;
          reconnectTimer = setTimeout(() => {
            initWhatsApp().catch(() => {});
          }, 2500);
        } else {
          reconnectAttempts += 1;
          const delayMs = Math.min(30000, 2000 * Math.pow(1.5, reconnectAttempts - 1));
          console.log(`[WhatsApp] Reconnecting in ${Math.round(delayMs / 1000)}s...`);
          reconnectTimer = setTimeout(() => {
            initWhatsApp().catch(() => {});
          }, delayMs);
        }
      }
    });

    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;

      for (const msg of upsert.messages || []) {
        if (!msg.message) continue;

        // STRICT SINGLE-USER WHITELIST + SILENT DROP (PRD Section 2.2)
        if (isAllowedSender(msg.key)) {
          processAllowedMessage(msg).catch((err) => {
            console.error('[WhatsApp] Uncaught message handler error:', err);
          });
          continue;
        }

        // NARROW ZERO-LEAK EXCEPTION: Only allow active outbound alarm targets to reply "ok" to stop their own reminder
        processTargetOkMessage(msg).catch((err) => {
          console.error('[WhatsApp] Uncaught target ok handler error:', err);
        });
      }
    });
  } catch (err) {
    waState.status = 'disconnected';
    waState.lastError = err.message;
    console.error('[WhatsApp] Initialization failed:', err.message);
    reconnectTimer = setTimeout(() => {
      initWhatsApp().catch(() => {});
    }, 10000);
  } finally {
    isInitializing = false;
  }
}

export async function logoutWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock.end(undefined);
    }
  } catch {
    // ignore
  }
  sock = null;
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  waState.status = 'disconnected';
  waState.qrCodeDataUrl = null;
  waState.connectedPhone = null;
  waState.lastError = null;

  setTimeout(() => {
    initWhatsApp().catch(() => {});
  }, 1000);
}
