import fs from 'node:fs';
import path from 'node:path';
import {
  MEMORI_UPLOADS_DIR,
  VAULT_UPLOADS_DIR,
  auditRepo,
  focusRepo,
  habitRepo,
  jadwalRepo,
  memoriRepo,
  normalizeCategory,
  normalizeIncomeCategory,
  normalizeRecurrence,
  pengeluaranRepo,
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
import { emitDataChange } from './events.js';
import { generateMonthlyPartnerRecap, generatePartnerIdeas } from './gemini.js';
import { getLastReminder } from './notifier.js';

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

function isImagePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
}

function saveMediaFile(targetDir, relPrefix, buffer, mimeType, preferredName = '') {
  const ext = extensionFromMime(mimeType, preferredName);
  const base = preferredName
    ? path
        .basename(preferredName, path.extname(preferredName))
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 40)
    : 'media';
  const finalName = `${Date.now()}-${base || 'file'}${ext}`;
  const fullPath = path.join(targetDir, finalName);
  fs.writeFileSync(fullPath, buffer);
  return `${relPrefix}/${finalName}`;
}

function stripOuterQuotes(str) {
  return String(str || '')
    .trim()
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim();
}

function parsePipe(str) {
  const idx = str.indexOf('|');
  if (idx === -1) return [str.trim(), ''];
  return [str.slice(0, idx).trim(), str.slice(idx + 1).trim()];
}

function buildHelpText() {
  return [
    '⚡ *Daftar Perintah Cepat (0ms Instan)*',
    '',
    '💝 *Memori Pacar*',
    '• `/p <cerita>` _(bisa + foto)_',
    '• `/p <cerita> | <deskripsi>`',
    '• `/p <YYYY-MM-DD> <cerita>`',
    '• `/cp <kata kunci / tanggal>`',
    '',
    '🎁 *Wishlist & Momen Spesial*',
    '• `/w` — Lihat semua wishlist',
    '• `/w <judul> | <deskripsi>` — Tambah wishlist',
    '• `/m` — Lihat semua momen spesial',
    '• `/m <YYYY-MM-DD> <judul> [bulanan|tahunan|sekali]`',
    '',
    '🗂️ *Quick Vault*',
    '• `/v` — Lihat semua isi Vault',
    '• `/v <kata kunci>` — Ambil item Vault',
    '• `/v <kata kunci> | <isi/link>` — Simpan link/catatan',
    '• _(Kirim foto/file)_ caption `/v <kata kunci>`',
    '• `/rv <nama lama> | <nama baru>` — Ubah nama Vault',
    '• `/rv <nama baru>` — Ubah nama item terakhir',
    '',
    '📅 *Jadwal, Presensi & Snooze*',
    '• `/j` — Lihat jadwal hari ini',
    '• `/j <hari/YYYY-MM-DD> <HH:MM> <nama>`',
    '• `/s <menit>` — Snooze pengingat terakhir',
    '',
    '📝 *Tugas & Deadline*',
    '• `/t` — Lihat semua tugas aktif',
    '• `/t <YYYY-MM-DD> [HH:MM] <matkul> | <judul>`',
    '• `/td <kata kunci>` — Tandai tugas selesai',
    '',
    '💸 *Keuangan*',
    '• `/k <item> <nominal>, ...` — Catat pengeluaran',
    '• `/pm <sumber> <nominal>, ...` — Catat pemasukan',
    '• `/rk [hari|minggu|bulan]` — Rekap keuangan & saldo',
    '',
    '🔥 *Produktivitas & Pengingat Cepat*',
    '• `/r <30m|2j> <pesan>` — Pengingat instan (`/r` lihat daftar)',
    '• `/h` — Lihat habit hari ini & streak',
    '• `/h + <nama>` — Tambah habit baru',
    '• `/h <kata kunci>` — Centang habit hari ini',
    '• `/fokus [menit] [topik]` — Mulai Pomodoro (`/fokus stop`)',
    '',
    '💝 *AI Asisten Pacar*',
    '• `/ide [kado|date]` — Ide kado/date personal dari Memori & Wishlist',
    '• `/rekappacar` — Rangkuman memori pacar 30 hari terakhir',
    '',
    '🛠️ *Utilitas*',
    '• `/log` — Lihat riwayat login & keamanan web',
    '• `/briefing` — Kirim Morning Briefing sekarang',
    '• `/backup` — Kirim backup assistant.db ke WA',
    '• `/help` atau `/menu` — Tampilkan daftar ini',
  ].join('\n');
}

/**
 * 0ms deterministic Slash Command handler.
 * Returns null when message does not start with `/`, allowing natural AI processing.
 */
export async function handleSlashCommand({
  text = '',
  mediaBuffer = null,
  mediaType = null,
  mimeType = null,
  fileName = null,
  now = new Date(),
}) {
  const clean = String(text || '').trim();
  if (!clean.startsWith('/')) return null;

  const match = clean.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const cmd = match[1].toLowerCase();
  const args = (match[2] || '').trim();
  const nowParts = getWibParts(now);

  switch (cmd) {
    /* ==================== HELP / MENU ==================== */
    case 'help':
    case 'menu':
      return { text: buildHelpText() };

    /* ==================== MEMORI PACAR ==================== */
    case 'p': {
      if (!args && !(mediaBuffer && mediaType === 'image')) {
        return {
          text: 'Format: `/p <cerita>` atau `/p <cerita> | <deskripsi>` atau `/p <YYYY-MM-DD> <cerita>` (bisa disertai foto).',
        };
      }

      let tanggal = nowParts.dateStr;
      let rest = args;
      const datePrefix = rest.match(/^(\d{4}-\d{1,2}-\d{1,2})\s+([\s\S]+)$/);
      if (datePrefix && normalizeDateStr(datePrefix[1])) {
        tanggal = normalizeDateStr(datePrefix[1]);
        rest = datePrefix[2].trim();
      }

      const [isiRaw, deskripsi] = parsePipe(rest);
      const isi = isiRaw || 'Foto kenangan';

      let mediaPath = null;
      if (mediaBuffer && mediaType === 'image') {
        mediaPath = saveMediaFile(MEMORI_UPLOADS_DIR, 'uploads/memori', mediaBuffer, mimeType, fileName || 'memori');
      }

      const saved = memoriRepo.create({
        tanggal,
        hari: getHariFromDateStr(tanggal),
        isi,
        deskripsi,
        media_path: mediaPath,
      });

      emitDataChange('memori', 'whatsapp');
      return {
        text:
          `💝 *Tersimpan di Brankas Memori*\n` +
          `📅 ${saved.hari}, ${saved.tanggal}\n` +
          `📝 ${saved.isi}` +
          (saved.deskripsi ? `\n📌 Deskripsi: ${saved.deskripsi}` : '') +
          (saved.media_path ? '\n🖼️ Foto ikut tersimpan di galeri.' : ''),
      };
    }

    case 'cp': {
      let rows;
      const dateQuery = normalizeDateStr(args);
      if (!args) {
        rows = memoriRepo.list({ limit: 5 });
      } else if (dateQuery) {
        rows = memoriRepo.list({ tanggal: dateQuery, limit: 15 });
      } else {
        rows = memoriRepo.list({ q: args, limit: 15 });
      }

      if (!rows.length) {
        return {
          text: args
            ? `Belum ada catatan memori yang cocok dengan *"${args}"*.`
            : 'Brankas memori masih kosong. Gunakan `/p <cerita>` untuk mulai mencatat.',
        };
      }

      const lines = rows.map(
        (m, i) =>
          `${i + 1}. *${m.hari}, ${m.tanggal}*\n   ${m.isi}${m.deskripsi ? `\n   _${m.deskripsi}_` : ''}`
      );
      const withImage = rows.find((r) => {
        const p = resolveUploadPath(r.media_path);
        return p && fs.existsSync(p);
      });

      const header = args ? `💝 *Hasil Pencarian Memori "${args}" (${rows.length}):*` : `💝 *${rows.length} Memori Terbaru:*`;
      return {
        text: `${header}\n\n${lines.join('\n\n')}`,
        imagePath: withImage ? resolveUploadPath(withImage.media_path) : null,
      };
    }

    /* ==================== WISHLIST & MOMEN ==================== */
    case 'w': {
      if (!args) {
        const items = wishlistRepo.list({ tipe: 'WISHLIST' });
        if (!items.length) {
          return { text: 'Wishlist masih kosong. Tambah dengan `/w <judul> | <deskripsi>`.' };
        }
        const lines = items.map(
          (w, i) => `${i + 1}. ${w.terpenuhi ? '✅' : '⬜'} *${w.judul}*${w.catatan ? `\n    _${w.catatan}_` : ''}`
        );
        return { text: `🎁 *Daftar Wishlist (${items.length}):*\n\n${lines.join('\n')}` };
      }

      const [judul, catatan] = parsePipe(args);
      if (!judul) {
        return { text: 'Format: `/w <judul>` atau `/w <judul> | <deskripsi>`.' };
      }
      const saved = wishlistRepo.create({ tipe: 'WISHLIST', judul, catatan });
      emitDataChange('wishlist', 'whatsapp');
      return {
        text: `🎁 *Wishlist Tersimpan:*\n• *${saved.judul}*${saved.catatan ? `\n• Deskripsi: ${saved.catatan}` : ''}`,
      };
    }

    case 'm': {
      if (!args) {
        const items = wishlistRepo.list({ tipe: 'MOMEN' });
        if (!items.length) {
          return { text: 'Belum ada momen spesial. Tambah dengan `/m <YYYY-MM-DD> <judul> [bulanan|tahunan|sekali]`.' };
        }
        const lines = items.map((m, i) => {
          const ulangLabel =
            m.ulang === 'BULANAN' ? 'Tiap Bulan' : m.ulang === 'SEKALI' ? 'Sekali' : 'Tiap Tahun';
          const cd = m.days_until !== null ? (m.days_until === 0 ? 'HARI INI!' : `H-${m.days_until}`) : 'Selesai';
          return `${i + 1}. *${m.judul}* — *${cd}*\n    📅 ${m.tanggal || '-'} (${ulangLabel})${m.catatan ? `\n    _${m.catatan}_` : ''}`;
        });
        return { text: `🎉 *Daftar Momen Spesial (${items.length}):*\n\n${lines.join('\n\n')}` };
      }

      const [leftPart, catatan] = parsePipe(args);
      const mMatch = leftPart.match(/^(\d{4}-\d{1,2}-\d{1,2})\s+([\s\S]+)$/);
      if (!mMatch || !normalizeDateStr(mMatch[1])) {
        return {
          text: 'Format: `/m <YYYY-MM-DD> <judul> [bulanan|tahunan|sekali] [| deskripsi]`\nContoh: `/m 2026-09-24 Tanggal Pacaran bulanan`',
        };
      }

      const tanggal = normalizeDateStr(mMatch[1]);
      let titlePart = mMatch[2].trim();
      let ulang = 'TAHUNAN';
      const recMatch = titlePart.match(/\s+(bulanan|tahunan|sekali)$/i);
      if (recMatch) {
        ulang = normalizeRecurrence(recMatch[1]);
        titlePart = titlePart.slice(0, recMatch.index).trim();
      }

      const saved = wishlistRepo.create({
        tipe: 'MOMEN',
        judul: titlePart,
        tanggal,
        catatan,
        ulang,
      });
      emitDataChange('wishlist', 'whatsapp');

      const ulangLabel =
        saved.ulang === 'BULANAN' ? 'Tiap Bulan' : saved.ulang === 'SEKALI' ? 'Sekali Saja' : 'Tiap Tahun';
      const daysLabel = (saved.effective_notif_days || [7, 3, 1])
        .map((d) => (d === 0 ? 'Hari H' : `H-${d}`))
        .join(', ');

      return {
        text:
          `🎉 *Momen Spesial Tersimpan:*\n` +
          `• *${saved.judul}*\n` +
          `• Tanggal: ${saved.tanggal} (${ulangLabel})` +
          (saved.catatan ? `\n• Deskripsi: ${saved.catatan}` : '') +
          `\n_Pengingat aktif pada ${daysLabel} pukul ${saved.effective_notif_jam || '08:00'} WIB._`,
      };
    }

    /* ==================== QUICK VAULT ==================== */
    case 'v': {
      // Save attached media (image/document/audio)
      if (mediaBuffer && (mediaType === 'document' || mediaType === 'image' || mediaType === 'audio')) {
        const key =
          args ||
          (fileName ? path.basename(fileName, path.extname(fileName)) : `File ${nowParts.dateStr} ${nowParts.timeStr}`);
        const relPath = saveMediaFile(VAULT_UPLOADS_DIR, 'uploads/vault', mediaBuffer, mimeType, fileName || key);
        const saved = vaultRepo.create({
          kata_kunci: key,
          konten: relPath,
          tipe: 'FILE',
        });
        emitDataChange('vault', 'whatsapp');
        return {
          text: `🗂️ *File Tersimpan di Quick Vault:*\n• Kata Kunci: *${saved.kata_kunci}*\n• File: \`${path.basename(saved.konten)}\``,
        };
      }

      // Empty `/v` -> list all vault items
      if (!args) {
        const all = vaultRepo.list();
        if (!all.length) {
          return { text: 'Quick Vault masih kosong. Simpan dengan `/v <kata kunci> | <isi>` atau kirim foto dengan caption `/v <kata kunci>`.' };
        }
        const lines = all.map((item, i) => `${i + 1}. [${item.tipe}] *${item.kata_kunci}*`);
        return {
          text: `🗂️ *Daftar Isi Quick Vault (${all.length}):*\n\n${lines.join('\n')}\n\n_Ketik \`/v <kata kunci>\` untuk mengambil item._`,
        };
      }

      // Save with pipe separator: `/v <kata kunci> | <isi>`
      if (args.includes('|')) {
        const [key, contentRaw] = parsePipe(args);
        const content = stripOuterQuotes(contentRaw);
        if (!key || !content) {
          return { text: 'Format simpan: `/v <kata kunci> | <isi atau URL>`.' };
        }
        const saved = vaultRepo.create({
          kata_kunci: key,
          konten: content,
          tipe: 'LINK',
        });
        emitDataChange('vault', 'whatsapp');
        return {
          text: `🔗 *Tersimpan di Quick Vault:*\n• Judul / Kata Kunci: *${saved.kata_kunci}*\n• Isi: ${saved.konten}`,
        };
      }

      // Save URL without pipe: `/v <kata kunci> https://...`
      const urlMatch = args.match(/https?:\/\/[^\s]+/i);
      if (urlMatch) {
        const url = urlMatch[0];
        const key = args.replace(url, '').trim() || 'Link Vault';
        const saved = vaultRepo.create({
          kata_kunci: key,
          konten: url,
          tipe: 'LINK',
        });
        emitDataChange('vault', 'whatsapp');
        return {
          text: `🔗 *Link Tersimpan di Quick Vault:*\n• Kata Kunci: *${saved.kata_kunci}*\n• URL: ${saved.konten}`,
        };
      }

      // Otherwise retrieve matching vault item(s): `/v <kata kunci>`
      const matches = vaultRepo.search(args);
      if (!matches.length) {
        return {
          text: `Tidak ditemukan item Quick Vault dengan kata kunci *"${args}"*.\nKetik \`/v\` untuk melihat semua daftar atau \`/v ${args} | <isi>\` untuk menyimpannya.`,
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
          if (isImagePath(fullPath)) {
            return { text: `🖼️ *${best.kata_kunci}*${othersNote}`, imagePath: fullPath };
          }
          return {
            text: `📂 *${best.kata_kunci}*${othersNote}`,
            documentPath: fullPath,
            documentName: path.basename(fullPath),
            documentMime: guessMimeFromFilename(fullPath),
          };
        }
        return { text: `Item *${best.kata_kunci}* ditemukan, tetapi file fisiknya tidak ada di server.` };
      }

      const linkMatches = matches.filter((m) => m.tipe !== 'FILE').slice(0, 15);
      if (linkMatches.length > 1) {
        const lines = linkMatches
          .map((m, i) => `${i + 1}. *${m.kata_kunci}*\n    ${m.konten}`)
          .join('\n');
        return { text: `🔗 *Hasil Quick Vault "${args}" (${linkMatches.length}):*\n\n${lines}` };
      }

      return { text: `🔗 *${best.kata_kunci}*\n${best.konten}${othersNote}` };
    }

    case 'rv': {
      if (!args) {
        return {
          text: 'Format: `/rv <nama baru>` (ubah item terakhir) atau `/rv <nama lama> | <nama baru>`.',
        };
      }

      let oldKey = '';
      let newName = '';
      if (args.includes('|')) {
        [oldKey, newName] = parsePipe(args);
      } else if (args.includes('>')) {
        const idx = args.indexOf('>');
        oldKey = args.slice(0, idx).trim();
        newName = args.slice(idx + 1).trim();
      } else {
        newName = args.trim();
      }

      newName = stripOuterQuotes(newName);
      if (!newName) {
        return { text: 'Nama baru tidak boleh kosong. Contoh: `/rv deca | Foto Deca`' };
      }

      const target = oldKey ? vaultRepo.search(oldKey)[0] : vaultRepo.getLatest();
      if (!target) {
        return { text: `Item Quick Vault *"${oldKey || 'terakhir'}"* tidak ditemukan.` };
      }

      const oldName = target.kata_kunci;
      const updated = vaultRepo.update(target.id, { kata_kunci: newName });
      emitDataChange('vault', 'whatsapp');
      return {
        text: `✅ *Nama Quick Vault Diperbarui*\n• Sebelumnya: *${oldName}*\n• Sekarang: *${updated.kata_kunci}*`,
      };
    }

    /* ==================== JADWAL & SNOOZE ==================== */
    case 'j': {
      if (!args) {
        const today = jadwalRepo.getTodaySchedules(nowParts.hari, nowParts.dateStr);
        if (!today.length) {
          return {
            text: `📅 Tidak ada jadwal aktif hari ini (${nowParts.hari}, ${nowParts.dateStr}).\nTambah dengan \`/j selasa 07:50 Presensi Matkul\`.`,
          };
        }
        const lines = today.map(
          (j, i) => `${i + 1}. *${j.jam} WIB* — ${j.nama} _(${j.is_rutin ? 'Rutin' : 'Sekali'})_`
        );
        return {
          text: `📅 *Jadwal Hari Ini (${nowParts.hari}, ${nowParts.dateStr}):*\n\n${lines.join('\n')}`,
        };
      }

      const jMatch = args.match(/^(\S+)\s+(\d{1,2}[:.]\d{2})\s+([\s\S]+)$/);
      if (!jMatch) {
        return {
          text: 'Format: `/j <hari/YYYY-MM-DD> <HH:MM> <nama>`\nContoh: `/j selasa 07:50 Presensi Sistem Terdistribusi` atau `/j 2026-11-25 14:00 Bimbingan`',
        };
      }

      const dayOrDate = jMatch[1];
      const jam = normalizeJam(jMatch[2]);
      const nama = jMatch[3].trim();
      if (!jam) {
        return { text: 'Format jam tidak valid. Gunakan format 24 jam seperti `07:50` atau `14:00`.' };
      }

      const asDate = normalizeDateStr(dayOrDate);
      const asHari = normalizeHari(dayOrDate);
      if (!asDate && !asHari) {
        return { text: `Hari/tanggal *"${dayOrDate}"* tidak dikenali. Gunakan Senin–Minggu atau \`YYYY-MM-DD\`.` };
      }

      const rec = jadwalRepo.create({
        nama,
        hari: asHari || getHariFromDateStr(asDate),
        tanggal: asDate || null,
        jam,
        is_rutin: asDate ? 0 : 1,
        aktif: 1,
      });
      emitDataChange('jadwal', 'whatsapp');
      return {
        text: rec.is_rutin
          ? `📅 *Jadwal Rutin Tersimpan:*\n• *${rec.nama}*\n• Setiap ${rec.hari} pukul ${rec.jam} WIB`
          : `📅 *Jadwal Sekali Jalan Tersimpan:*\n• *${rec.nama}*\n• ${rec.hari}, ${rec.tanggal} pukul ${rec.jam} WIB`,
      };
    }

    case 's': {
      const menit = Math.max(1, Math.min(720, Number(args) || 10));
      const target = addMinutesWib(menit, now);
      const last = getLastReminder();
      const baseName = last?.activityName || last?.title || 'Pengingat';
      const nama = baseName.includes('(Snooze)') ? baseName : `${baseName} (Snooze)`;

      const rec = jadwalRepo.create({
        nama,
        hari: target.hari,
        tanggal: target.dateStr,
        jam: target.timeStr,
        is_rutin: 0,
        aktif: 1,
      });
      emitDataChange('jadwal', 'whatsapp');
      return {
        text: `⏰ *Snooze ${menit} menit!*\n*${rec.nama}* akan diingatkan lagi pukul *${rec.jam} WIB* (${rec.tanggal}).`,
      };
    }

    /* ==================== TUGAS & DEADLINE ==================== */
    case 't': {
      if (!args) {
        const active = tugasRepo.list({ selesai: 0 });
        if (!active.length) {
          return { text: '🎉 Tidak ada tugas aktif saat ini! Tambah dengan `/t 2026-11-26 23:59 Matkul | Judul`.' };
        }
        const lines = active.map((t, i) => {
          const cd = formatCountdown(t.deadline, now);
          const icon = cd.urgency === 'overdue' || cd.urgency === 'critical' ? '🔴' : cd.urgency === 'warning' ? '🟡' : '🟢';
          return `${i + 1}. ${icon} *${t.judul}*${t.matkul ? ` (${t.matkul})` : ''}\n    Deadline: ${t.deadline} WIB _(${cd.label})_`;
        });
        return { text: `📝 *Tugas Aktif (${active.length}):*\n\n${lines.join('\n\n')}` };
      }

      const tMatch = args.match(/^(\d{4}-\d{1,2}-\d{1,2})(?:\s+(\d{1,2}[:.]\d{2}))?\s+([\s\S]+)$/);
      if (!tMatch || !normalizeDateStr(tMatch[1])) {
        return {
          text: 'Format: `/t <YYYY-MM-DD> [HH:MM] <matkul> | <judul>`\nContoh: `/t 2026-11-26 23:59 Kriptografi | Laporan RSA`',
        };
      }

      const dateStr = normalizeDateStr(tMatch[1]);
      const jamStr = tMatch[2] ? normalizeJam(tMatch[2]) || '23:59' : '23:59';
      const deadline = normalizeDeadline(`${dateStr} ${jamStr}`);
      const restText = tMatch[3].trim();

      let matkul = '';
      let judul = restText;
      if (restText.includes('|')) {
        [matkul, judul] = parsePipe(restText);
      }

      const saved = tugasRepo.create({ judul, matkul, deadline });
      emitDataChange('tugas', 'whatsapp');
      return {
        text: `📝 *Tugas Tersimpan:*\n• *${saved.judul}*${saved.matkul ? ` (${saved.matkul})` : ''}\n• Deadline: ${saved.deadline} WIB\n_Pengingat otomatis aktif sebelum tenggat._`,
      };
    }

    case 'td': {
      if (!args) {
        return { text: 'Format: `/td <kata kunci tugas>` (contoh: `/td kriptografi`).' };
      }
      const matches = tugasRepo.findActiveByKeywords([args]);
      if (!matches.length) {
        return { text: `Tidak ditemukan tugas aktif yang cocok dengan *"${args}"*. Ketik \`/t\` untuk melihat daftar tugas.` };
      }
      const target = matches[0];
      tugasRepo.update(target.id, { selesai: 1 });
      emitDataChange('tugas', 'whatsapp');
      return {
        text: `✅ Tugas *${target.judul}*${target.matkul ? ` (${target.matkul})` : ''} ditandai *SELESAI*!`,
      };
    }

    /* ==================== KEUANGAN ==================== */
    case 'k':
    case 'pm': {
      const isIncome = cmd === 'pm';
      if (!args) {
        return {
          text: isIncome
            ? 'Format: `/pm <sumber> <nominal>, ...`\nContoh: `/pm uang saku 500rb, freelance 1.5jt`'
            : 'Format: `/k <item> <nominal>, ...`\nContoh: `/k makan siang 18rb, bensin 25rb, kopi 20k`',
        };
      }

      const segments = args
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedItems = [];

      for (const seg of segments) {
        const m = seg.match(/^([a-zA-Z0-9\s&()\-/]+?)\s+(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?$/i);
        if (!m) continue;
        const item = m[1].trim();
        const rawNum = Number(m[2].replace(',', '.'));
        const unit = (m[3] || '').toLowerCase();
        let mult = 1;
        if (unit === 'rb' || unit === 'ribu' || unit === 'k') mult = 1000;
        else if (unit === 'jt' || unit === 'juta') mult = 1000000;
        const nominal = Math.round(rawNum * mult);
        if (!item || !Number.isFinite(nominal) || nominal <= 0) continue;
        parsedItems.push({
          item: item.charAt(0).toUpperCase() + item.slice(1),
          nominal,
          kategori: isIncome ? normalizeIncomeCategory(item) : normalizeCategory(item),
          tipe: isIncome ? 'PEMASUKAN' : 'PENGELUARAN',
        });
      }

      if (!parsedItems.length) {
        return {
          text: isIncome
            ? 'Nominal belum terbaca. Contoh: `/pm uang saku 500rb, cashback 25k`.'
            : 'Nominal belum terbaca. Contoh: `/k makan siang 18rb, kopi 20k`.',
        };
      }

      const created = pengeluaranRepo.createMany(parsedItems, nowParts.dateStr, isIncome ? 'PEMASUKAN' : 'PENGELUARAN');
      emitDataChange('pengeluaran', 'whatsapp');
      if (!isIncome) {
        checkBudgetThresholds(nowParts.monthStr).catch(() => {});
      }
      const total = created.reduce((sum, x) => sum + x.nominal, 0);
      const sign = isIncome ? '+' : '-';
      const lines = created
        .map((e) => `• ${e.item} — *${sign}${formatRupiah(e.nominal)}* _(${e.kategori})_`)
        .join('\n');

      return {
        text: isIncome
          ? `💰 *Pemasukan Tercatat (${nowParts.dateStr}):*\n${lines}\n\n*Total Masuk:* ${formatRupiah(total)}`
          : `💸 *Pengeluaran Tercatat (${nowParts.dateStr}):*\n${lines}\n\n*Total Keluar:* ${formatRupiah(total)}`,
      };
    }

    case 'rk': {
      const mode = args.toLowerCase();
      let start = nowParts.dateStr;
      const end = nowParts.dateStr;
      let label = `Hari Ini (${nowParts.dateStr})`;

      if (mode.startsWith('minggu')) {
        start = shiftDateStr(nowParts.dateStr, -6);
        label = `7 Hari Terakhir (${start} s/d ${end})`;
      } else if (mode.startsWith('bulan')) {
        start = `${nowParts.monthStr}-01`;
        label = `Bulan Ini (${nowParts.monthStr})`;
      }

      const summary = pengeluaranRepo.getSummary({ tanggal_mulai: start, tanggal_akhir: end });
      if (!summary.count) {
        return { text: `📊 Belum ada catatan keuangan untuk *${label}*.` };
      }

      const incLines = Object.entries(summary.incomeByCategory || {})
        .filter(([, val]) => val > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, val]) => `• ${cat}: *${formatRupiah(val)}*`)
        .join('\n');

      const expLines = Object.entries(summary.byCategory)
        .filter(([, val]) => val > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, val]) => `• ${cat}: *${formatRupiah(val)}*`)
        .join('\n');

      const saldoPrefix = summary.balance > 0 ? '+' : summary.balance < 0 ? '-' : '';
      const saldoStr = `${saldoPrefix}${formatRupiah(Math.abs(summary.balance))}`;

      const parts = [
        `📊 *Rekap Keuangan — ${label}*`,
        `Transaksi: ${summary.count}`,
        `🟢 *Pemasukan:* ${formatRupiah(summary.totalIncome)}`,
        `🔴 *Pengeluaran:* ${formatRupiah(summary.totalExpense)}`,
        `💰 *Saldo Bersih:* ${saldoStr}`,
      ];
      if (incLines) parts.push(`\n*Rincian Pemasukan:*\n${incLines}`);
      if (expLines) parts.push(`\n*Rincian Pengeluaran:*\n${expLines}`);

      return { text: parts.join('\n') };
    }

    /* ==================== QUICK REMINDER (/r) ==================== */
    case 'r': {
      if (!args) {
        const active = reminderRepo.list({ selesai: 0 });
        if (!active.length) {
          return {
            text: '⏰ Tidak ada pengingat cepat aktif.\nPasang dengan `/r 30m angkat jemuran` atau `/r 2j bayar kos`.',
          };
        }
        const lines = active.map((r, i) => `${i + 1}. *${r.pesan}* — ${r.trigger_at} WIB`);
        return { text: `⏰ *Pengingat Cepat Aktif (${active.length}):*\n\n${lines.join('\n')}` };
      }

      const rMatch = args.match(/^(\d{1,3})\s*(m|mnt|menit|j|jam)?\s+([\s\S]+)$/i);
      if (!rMatch) {
        return {
          text: 'Format: `/r <durasi> <pesan>`\nContoh: `/r 30m angkat jemuran`, `/r 2j minum obat`, atau `/r 15 matiin kompor`.',
        };
      }
      const qty = Number(rMatch[1]);
      const unit = (rMatch[2] || 'm').toLowerCase();
      const mins = unit.startsWith('j') ? qty * 60 : qty;
      const pesan = rMatch[3].trim();
      if (mins < 1 || mins > 1440) {
        return { text: 'Durasi pengingat cepat harus antara 1 menit sampai 24 jam.' };
      }
      const target = addMinutesWib(mins, now);
      const saved = reminderRepo.create({ pesan, trigger_at: target.dateTimeStr });
      emitDataChange('reminder', 'whatsapp');
      return {
        text: `⏰ *Pengingat Cepat Dipasang!*\n• Pesan: *${saved.pesan}*\n• Akan berbunyi: *${target.timeStr} WIB* (${target.dateStr}, ${mins} menit lagi)`,
      };
    }

    /* ==================== HABIT TRACKER (/h) ==================== */
    case 'h': {
      if (!args) {
        const data = habitRepo.getDashboardData(14, now);
        if (!data.habits.length) {
          return {
            text: '🔥 Belum ada habit yang terdaftar.\nTambah habit baru dengan `/h + Olahraga 30 menit` atau dari Web Dashboard.',
          };
        }
        const lines = data.habits.map(
          (h, i) => `${i + 1}. ${h.doneToday ? '✅' : '⬜'} *${h.nama}* — 🔥 ${h.streak} hari`
        );
        return {
          text: `🔥 *Habit Harian (${data.summary.doneTodayCount}/${data.summary.totalHabits} selesai):*\n\n${lines.join('\n')}\n\n_Ketik \`/h <nama habit>\` untuk centang, atau \`/h + <habit baru>\` untuk menambah._`,
        };
      }

      if (args.startsWith('+')) {
        const raw = args.slice(1).trim();
        const [nama, target] = parsePipe(raw);
        if (!nama) {
          return { text: 'Format tambah habit: `/h + <nama habit>` atau `/h + Olahraga | 30 menit`' };
        }
        const created = habitRepo.create({ nama, target_harian: target });
        emitDataChange('habits', 'whatsapp');
        return {
          text: `🔥 *Habit Baru Ditambahkan:*\n• *${created.nama}*${created.target_harian ? ` (${created.target_harian})` : ''}\nKetik \`/h ${created.nama.split(' ')[0].toLowerCase()}\` setiap hari untuk menjaga streak!`,
        };
      }

      const found = habitRepo.findByKeyword(args);
      if (!found) {
        return {
          text: `Habit *"${args}"* belum terdaftar.\nKetik \`/h + ${args}\` untuk menambahkannya, atau \`/h\` untuk lihat daftar habit.`,
        };
      }
      habitRepo.toggleDate(found.id, nowParts.dateStr, true);
      emitDataChange('habits', 'whatsapp');
      const updated = habitRepo.getDashboardData(14, now).habits.find((x) => x.id === found.id);
      return {
        text: `✅ Mantap! Habit *${found.nama}* tercatat selesai hari ini!\n🔥 Streak saat ini: *${updated?.streak || 1} hari berturut-turut*.`,
      };
    }

    /* ==================== FOCUS / POMODORO (/fokus) ==================== */
    case 'fokus':
    case 'focus': {
      if (!args) {
        const active = focusRepo.getActive();
        const stats = focusRepo.getTodayStats(now);
        if (!active) {
          return {
            text: `🍅 Tidak ada sesi fokus berjalan.\n📊 Hari ini: *${stats.todaySessions} sesi (${stats.todayMinutes} menit)*.\nMulai dengan \`/fokus 25 belajar PCD\`.`,
          };
        }
        const remMin = Math.max(0, Math.ceil((new Date(active.endsAtIso).getTime() - now.getTime()) / 60000));
        return {
          text: `🍅 *Sesi Fokus Sedang Berjalan:*\n• Topik: *${active.label}*\n• Sisa waktu: *±${remMin} menit* (selesai ${active.endsAtDisplay} WIB)\n\n_Ketik \`/fokus stop\` untuk menghentikan._`,
        };
      }

      if (/^(stop|batal|berhenti|off)$/i.test(args)) {
        const stopped = focusRepo.stop();
        emitDataChange('focus', 'whatsapp');
        return {
          text: stopped ? `⏹️ Sesi fokus *${stopped.label}* dihentikan.` : 'Tidak ada sesi fokus yang sedang berjalan.',
        };
      }

      const fMatch = args.match(/^(\d{1,3})\s*(?:m|mnt|menit)?(?:\s+([\s\S]+))?$/i);
      const dur = fMatch ? Number(fMatch[1]) : 25;
      const label = fMatch ? (fMatch[2] || 'Sesi Fokus').trim() : args.trim();
      const session = focusRepo.start({ label, durationMinutes: dur, now });
      emitDataChange('focus', 'whatsapp');
      return {
        text: `🍅 *Mode Fokus Dimulai (${session.durationMinutes} menit)!*\n• Topik: *${session.label}*\n• Selesai pukul: *${session.endsAtDisplay} WIB*\n\nFokus dulu ya, nanti aku kabari pas waktunya istirahat!`,
      };
    }

    /* ==================== AI PARTNER IDEAS & MONTHLY RECAP ==================== */
    case 'ide': {
      const prompt = args || 'Berikan rekomendasi ide kado dan ide date untuk pacar saya';
      const memories = memoriRepo.list({ limit: 25 });
      const wishlists = wishlistRepo.list({ tipe: 'WISHLIST' });
      const moments = wishlistRepo.getUpcomingMoments(60, now);
      const answer = await generatePartnerIdeas(prompt, { memories, wishlists, moments }, now);
      return { text: `💝 *Rekomendasi Personal untuk Pacarmu:*\n\n${answer}` };
    }

    case 'rekappacar': {
      const sinceDate = shiftDateStr(nowParts.dateStr, -30);
      const memories = memoriRepo.list({ tanggal_mulai: sinceDate, tanggal_akhir: nowParts.dateStr, limit: 35 });
      const recap = await generateMonthlyPartnerRecap(memories, `30 Hari Terakhir (${sinceDate} s/d ${nowParts.dateStr})`, now);
      return { text: `💝 *Rekap Memori Pacar (30 Hari Terakhir):*\n\n${recap}` };
    }

    /* ==================== UTILITAS ==================== */
    case 'log':
    case 'logs': {
      const logs = auditRepo.list({ limit: 10 });
      const stats = auditRepo.getStats();
      if (!logs.length) {
        return { text: '🛡️ Belum ada riwayat akses Web Dashboard yang tercatat.' };
      }
      const badgeMap = {
        LOGIN_BERHASIL: '✅ Login Berhasil',
        PIN_SALAH: '🚨 PIN Salah',
        AKSES_DITOLAK: '⛔ Akses Ditolak',
        LOGOUT: '🔒 Logout',
      };
      const lines = logs.map(
        (l, i) =>
          `${i + 1}. *${badgeMap[l.event] || l.event}* — ${l.waktu}\n    IP: \`${l.ip || '-'}\` | ${l.lokasi || '-'}\n    Perangkat: ${l.device || '-'}`
      );
      return {
        text: `🛡️ *Log Keamanan Web Dashboard*\nTotal: ${stats.total} | Berhasil: ${stats.successCount} | PIN Salah: ${stats.failedCount} | IP Unik: ${stats.uniqueIps}\n\n${lines.join('\n\n')}`,
      };
    }

    case 'briefing': {
      const { runMorningBriefing } = await import('./scheduler.js');
      await runMorningBriefing(now);
      return { skipReply: true };
    }

    case 'backup': {
      const { runWeeklyBackup } = await import('./scheduler.js');
      await runWeeklyBackup(now);
      return { skipReply: true };
    }

    default:
      return {
        text: `Perintah */${cmd}* tidak dikenali.\nKetik */help* untuk melihat daftar semua perintah cepat.`,
      };
  }
}
