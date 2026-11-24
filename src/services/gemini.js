import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { normalizeCategory, normalizeIncomeCategory } from '../config/db.js';
import {
  HARI_ID,
  getWibParts,
  normalizeDateStr,
  normalizeHari,
  normalizeJam,
  shiftDateStr,
} from '../utils/time.js';

const DEFAULT_MODEL_CHAIN = [
  { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
  { model: 'gemini-3.5-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
  { model: 'gemini-3.8-flash', thinkingLevel: ThinkingLevel.LOW },
  { model: 'gemini-3.6-flash', thinkingLevel: ThinkingLevel.LOW },
  { model: 'gemini-3.5-flash', thinkingLevel: ThinkingLevel.LOW },
];

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_TEXT_CHAIN = [
  { model: 'qwen/qwen3.8-27b', reasoning_effort: 'none' },
  { model: 'openai/gpt-oss-20b', reasoning_effort: 'low' },
  { model: 'openai/gpt-oss-120b', reasoning_effort: 'low' },
];
const GROQ_VISION_CHAIN = [
  { model: 'qwen/qwen3.8-27b', reasoning_effort: 'none' },
];
const GROQ_WHISPER_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];

const TRANSIENT_COOLDOWN_MS = 12 * 1000; // Brief 12s cooldown for 503 spikes / timeouts
const GROQ_RATE_LIMIT_COOLDOWN_MS = 65 * 1000; // 65s cooldown for Groq per-minute RPM/TPM 429
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000; // Long 30m cooldown for Gemini daily quota 429 / 404 retired
const REQUEST_TIMEOUT_MS = 12000;
const GROQ_TIMEOUT_MS = 10000;
const HEDGE_DELAY_MS = 1800;
const modelCooldownUntil = new Map();
let lastUsedModel = null;

function getGroqApiKey() {
  const key = (process.env.GROQ_API_KEY || '').trim();
  if (!key || key === 'your_groq_api_key_here') return null;
  return key;
}

export function isGroqConfigured() {
  return Boolean(getGroqApiKey());
}

function getCooldownDuration(err, provider = 'gemini') {
  const status = Number(err?.status || err?.statusCode);
  const msg = String(err?.message || '');
  if (provider === 'groq') {
    if (status === 404 || /model_not_found|decommissioned/i.test(msg)) return QUOTA_COOLDOWN_MS;
    if (status === 429) {
      if (/tokens per day|requests per day|TPD|RPD/i.test(msg)) return QUOTA_COOLDOWN_MS;
      return GROQ_RATE_LIMIT_COOLDOWN_MS;
    }
    return TRANSIENT_COOLDOWN_MS;
  }
  if (status === 404 || status === 429) return QUOTA_COOLDOWN_MS;
  if (/(RESOURCE_EXHAUSTED|exceeded your current quota|NOT_FOUND|no longer available)/i.test(msg)) {
    return QUOTA_COOLDOWN_MS;
  }
  return TRANSIENT_COOLDOWN_MS;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function getModelChain() {
  const configured = (process.env.GEMINI_MODEL || '').trim();
  if (!configured) return [...DEFAULT_MODEL_CHAIN];
  const matched = DEFAULT_MODEL_CHAIN.find((entry) => entry.model === configured);
  const first = matched || { model: configured, thinkingLevel: null };
  return [first, ...DEFAULT_MODEL_CHAIN.filter((entry) => entry.model !== configured)];
}

export function getActiveModelName() {
  if (lastUsedModel) return lastUsedModel;
  if (isGroqConfigured()) return `groq:${GROQ_TEXT_CHAIN[0].model}`;
  return getModelChain()[0].model;
}

function isRetryableModelError(err) {
  const name = String(err?.name || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const status = Number(err?.status || err?.statusCode);
  if ([404, 429, 500, 503, 504].includes(status)) return true;
  const msg = String(err?.message || '');
  if (status === 400 && /thinking level/i.test(msg)) return true;
  if (/(NOT_FOUND|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|no longer available|overloaded|timed out|aborted)/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Hedged parallel model execution:
 * Starts the fastest available model immediately; if it hasn't responded within HEDGE_DELAY_MS (1.8s),
 * fires the second model in parallel and resolves with whichever finishes first, aborting the slower one.
 */
async function generateWithFallback(client, buildRequest) {
  const chain = getModelChain();
  const nowMs = Date.now();

  const available = chain.filter((e) => (modelCooldownUntil.get(e.model) || 0) <= nowMs);
  const inCooldown = chain.filter((e) => (modelCooldownUntil.get(e.model) || 0) > nowMs);
  const order = [...available, ...inCooldown];

  const callSingleModel = async (entry, externalController) => {
    const req = buildRequest(entry.model);
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = externalController
      ? AbortSignal.any([timeoutSignal, externalController.signal])
      : timeoutSignal;

    req.config = {
      maxOutputTokens: 500,
      ...(req.config || {}),
      ...(entry.thinkingLevel
        ? { thinkingConfig: { thinkingLevel: entry.thinkingLevel } }
        : {}),
      abortSignal: signal,
    };

    try {
      const response = await client.models.generateContent(req);
      modelCooldownUntil.delete(entry.model);
      lastUsedModel = entry.model;
      return response;
    } catch (err) {
      if (!externalController?.signal.aborted && isRetryableModelError(err)) {
        modelCooldownUntil.set(entry.model, Date.now() + getCooldownDuration(err));
      }
      throw err;
    }
  };

  const racePair = async (primary, secondary) => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    let hedgeTimer = null;
    let triggerSecondaryNow = null;

    const p2 = new Promise((resolve, reject) => {
      let started = false;
      const startSecondary = () => {
        if (started) return;
        started = true;
        if (hedgeTimer) clearTimeout(hedgeTimer);
        callSingleModel(secondary, ac2)
          .then((res) => {
            ac1.abort();
            resolve(res);
          })
          .catch(reject);
      };
      triggerSecondaryNow = startSecondary;
      hedgeTimer = setTimeout(startSecondary, HEDGE_DELAY_MS);
    });

    const p1 = callSingleModel(primary, ac1)
      .then((res) => {
        if (hedgeTimer) clearTimeout(hedgeTimer);
        ac2.abort();
        return res;
      })
      .catch((err) => {
        if (triggerSecondaryNow) triggerSecondaryNow();
        throw err;
      });

    try {
      return await Promise.any([p1, p2]);
    } finally {
      if (hedgeTimer) clearTimeout(hedgeTimer);
    }
  };

  // Round 1: Race top 2 healthy models with 1.8s hedge delay
  if (order.length >= 2) {
    try {
      return await racePair(order[0], order[1]);
    } catch {
      // Transient 503 spikes on both Flash Lite models are very brief (~1s); retry top 2 Lite models once!
      await delay(900);
      try {
        return await racePair(chain[0], chain[1]);
      } catch {
        // Proceed to remaining models
      }
    }
  }

  // Fallback: race remaining non-quota-blocked models in parallel
  const rest = order.slice(2).filter((e) => (modelCooldownUntil.get(e.model) || 0) <= Date.now());
  if (rest.length > 0) {
    const controllers = rest.map(() => new AbortController());
    try {
      return await Promise.any(
        rest.map((entry, idx) =>
          callSingleModel(entry, controllers[idx]).then((res) => {
            controllers.forEach((c, j) => {
              if (j !== idx) c.abort();
            });
            return res;
          })
        )
      );
    } catch {
      // all fallback models failed
    }
  }

  throw new Error('Server AI Google sedang padat atau lambat merespons. Silakan coba kirim ulang sebentar lagi (atau gunakan slash command seperti /t, /p, /v, /k).');
}

function resolveRelativeIndonesianDate(text, now = new Date()) {
  const parts = getWibParts(now);
  const str = String(text || '');

  const isoMatch = str.match(/\b(\d{4}-\d{1,2}-\d{1,2})\b/);
  if (isoMatch && normalizeDateStr(isoMatch[1])) {
    return { dateStr: normalizeDateStr(isoMatch[1]), matchedText: isoMatch[0] };
  }

  // Specific weekday (e.g. "hari kamis besok", "kamis depan", "selasa")
  const dayMatch = str.match(/\b(?:hari\s+)?(senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad)(?:\s+(?:besok|depan|ini))?\b/i);
  if (dayMatch) {
    const targetHari = normalizeHari(dayMatch[1]);
    const todayIdx = HARI_ID.indexOf(parts.hari);
    const targetIdx = HARI_ID.indexOf(targetHari);
    if (todayIdx !== -1 && targetIdx !== -1) {
      let delta = (targetIdx - todayIdx + 7) % 7;
      if (delta === 0 && /\b(besok|depan)\b/i.test(dayMatch[0])) delta = 7;
      return { dateStr: shiftDateStr(parts.dateStr, delta), matchedText: dayMatch[0], hari: targetHari };
    }
  }

  if (/\blusa\b/i.test(str)) {
    return { dateStr: shiftDateStr(parts.dateStr, 2), matchedText: 'lusa' };
  }
  if (/\bbesok\b/i.test(str)) {
    return { dateStr: shiftDateStr(parts.dateStr, 1), matchedText: 'besok' };
  }
  if (/\bhari\s+ini\b/i.test(str)) {
    return { dateStr: parts.dateStr, matchedText: 'hari ini' };
  }

  return null;
}

/**
 * 0ms Local Fast-Path Classifier for unambiguous commands.
 * Bypasses LLM network latency completely for common deterministic patterns.
 */
export function tryLocalFastIntent({ text = '', hasMedia = false, fileName = null, now = new Date() }) {
  const clean = String(text || '').trim();
  const nowParts = getWibParts(now);

  // 1. Explicit Vault Save with user-supplied title (fast-path 0ms)
  // Note: If user writes only "simpan ini" (without a title) or 'simpan ini "..."' (without a title),
  // we intentionally return null so Gemini AI proactively invents a smart descriptive title!
  const isOtherModuleHint = /\b(jadwal|presensi|krs|tugas|deadline|struk|pengeluaran|memori|pacar|wishlist|ultah|anniversary|momen)\b/i.test(
    clean
  );

  // 1A. Quoted text save with explicit title outside quotes: e.g. `simpan judul anime ini "great of the fireflies"`
  if (!hasMedia && !isOtherModuleHint) {
    const quotedMatch = clean.match(
      /^(?:tolong\s+)?(?:simpan(?:in|kan)?|save|masukin|masukkan|taruh|catat)(?:\s+(?:ke|di)\s+(?:quick\s+)?vault)?\s+(.+?)\s*["“'‘]([^"”'’]+)["”'’]\s*$/i
    );
    if (quotedMatch) {
      const beforeQuote = quotedMatch[1]
        .replace(/\b(?:ini|itu|ke\s+(?:quick\s+)?vault|di\s+(?:quick\s+)?vault|sebagai|dengan\s+nama|nama|label|kata\s+kunci)\b/gi, ' ')
        .replace(/[:;,.\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const insideQuote = quotedMatch[2].trim();
      if (beforeQuote && insideQuote && !/^(file|gambar|foto|link|dokumen|vault|catatan|teks)$/i.test(beforeQuote)) {
        const titleCaseKey = beforeQuote.replace(/\b\w/g, (c) => c.toUpperCase());
        return {
          intent: 'SIMPAN_VAULT',
          reply_message: 'Siap, langsung disimpan ke Quick Vault!',
          payload: {
            kata_kunci: titleCaseKey,
            isi_catatan: insideQuote,
            tipe_item: 'LINK',
          },
        };
      }
    }
  }

  // 1B. Media or URL save with explicit non-trivial title: e.g. "simpan ini, pengumpulan paper"
  const vaultSaveMatch = clean.match(
    /^(?:tolong\s+)?(?:simpan(?:in|kan)?|save|masukin|masukkan|taruh)(?:\s+(?:ini|itu|file|dokumen|gambar|foto|screenshot|ss|link))?(?:\s+(?:ke|di)\s+(?:quick\s+)?vault)?(?:\s+(?:sebagai|dengan\s+(?:nama|label|kata\s+kunci)|nama|label|kata\s+kunci))?[\s,.:;\-]+(.+)$/i
  );
  if (vaultSaveMatch && !isOtherModuleHint && (hasMedia || /https?:\/\//i.test(clean))) {
    const rawRest = vaultSaveMatch[1].trim();
    const urlMatch = rawRest.match(/https?:\/\/[^\s]+/i);
    const label = rawRest
      .replace(/https?:\/\/[^\s]+/gi, '')
      .replace(/^(?:ini|itu|file|gambar|foto|link|dokumen)[\s,.:;\-]*/i, '')
      .replace(/[\s,.:;\-]+(?:ke|di)\s+(?:quick\s+)?vault$/i, '')
      .trim();
    const isTrivial = !label || /^(ini|itu|file|gambar|foto|link|dokumen|vault)$/i.test(label);
    if (!isTrivial) {
      return {
        intent: 'SIMPAN_VAULT',
        reply_message: 'Siap, langsung disimpan ke Quick Vault!',
        payload: {
          kata_kunci: label,
          isi_catatan: urlMatch ? urlMatch[0] : rawRest,
          tipe_item: hasMedia ? 'FILE' : 'LINK',
        },
      };
    }
  }

  // Remaining fast-paths are text-only commands
  if (hasMedia || !clean) return null;

  // 1B. Rename Vault Item ("ubah nama di vault ini menjadi deca", "ganti nama kripto jadi tugas kripto", "rename jadi deca")
  const vaultRenameMatch = clean.match(
    /^(?:tolong\s+)?(?:ubah|ganti|edit|rename)\s+(?:nama|judul|label|kata\s+kunci)?\s*(?:(?:item|file|foto|gambar|link)\s+)?(?:(?:di|pada|dalam)\s+(?:quick\s+)?vault\s+)?(.*?)\s*(?:menjadi|jadi|ke)\s+(.+)$/i
  );
  if (vaultRenameMatch) {
    let targetKey = vaultRenameMatch[1]
      .replace(/^(?:di|pada|dalam)\s+(?:quick\s+)?vault\b/i, '')
      .replace(/\b(?:di|pada|dalam)\s+(?:quick\s+)?vault\b/i, '')
      .replace(/^(?:vault|item|file|foto|gambar|link)\s+/i, '')
      .trim();
    const newName = vaultRenameMatch[2].replace(/^["'`]+|["'`]+$/g, '').trim();
    if (newName) {
      return {
        intent: 'UBAH_VAULT',
        reply_message: 'Siap, nama item di Quick Vault diubah!',
        payload: {
          kata_kunci: targetKey || 'terakhir',
          nama_baru: newName,
          judul: newName,
        },
      };
    }
  }

  // 2. List all Vault items ("lihat semua isi vault", "liat vault", "daftar vault", "isi vault apa aja")
  if (
    /^(?:lih?at|cek|daftar|list|tampil(?:in|kan)?)\s+(?:semua\s+)?(?:isi\s+)?(?:quick\s+)?vault\b/i.test(clean) ||
    /^(?:isi\s+)?(?:quick\s+)?vault\s+(?:apa\s+aja|apa\s+saja|semua)\??$/i.test(clean)
  ) {
    return {
      intent: 'CARI_VAULT',
      reply_message: 'Berikut daftar isi Quick Vault:',
      payload: { kata_kunci: 'SEMUA' },
    };
  }

  // 3. Retrieve Vault item ("liat anime", "lihat kripto", "minta pengumpulan paper", "kirim file modul")
  const vaultGetMatch = clean.match(
    /^(?:tolong\s+)?(?:minta|ambil(?:in|kan)?|kirim(?:in|kan)?|cari(?:in|kan)?|lih?at|cek|buka|tunjuk(?:in|kan)?|tampil(?:in|kan)?)\s+(?:(?:link|file|dokumen|gambar|foto|ss|item|vault)\s+)?(.+?)(?:\s+(?:di|dari)\s+vault)?\??$/i
  );
  if (
    vaultGetMatch &&
    !/\b(tugas|deadline|jadwal|presensi|memori|cerita|pacar|aktivitas|kegiatan|dia|doi|riwayat|history|pengeluaran|jajan|biaya|rekap|wishlist|momen|kemarin|lalu)\b/i.test(
      clean
    )
  ) {
    return {
      intent: 'CARI_VAULT',
      reply_message: 'Mencari di Quick Vault...',
      payload: { kata_kunci: vaultGetMatch[1].trim() },
    };
  }

  // 4. Snooze ("tunda 10 menit", "ingetin lagi 15 menit", "snooze 5 menit")
  const snoozeMatch = clean.match(
    /^(?:tolong\s+)?(?:tunda|snooze|ingetin\s+lagi|ingatkan\s+lagi)(?:\s+selama)?\s+(\d{1,3})\s*menit(?:\s+lagi)?$/i
  );
  if (snoozeMatch) {
    return {
      intent: 'SNOOZE_JADWAL',
      reply_message: 'Siap, pengingat ditunda!',
      payload: { menit_tunda: Number(snoozeMatch[1]) },
    };
  }

  // 5. Check Tasks ("cek tugas", "lihat tugas", "daftar tugas", "ada tugas apa aja?")
  if (
    /^(?:cek|lih?at|daftar|list|info|tampil(?:in|kan)?)\s+(?:semua\s+)?(?:tugas|deadline)(?:\s+aktif)?\??$/i.test(clean) ||
    /^ada\s+(?:tugas|deadline)\s+apa(?:\s+aja|\s+saja)?\??$/i.test(clean)
  ) {
    return {
      intent: 'CEK_TUGAS',
      reply_message: 'Mengecek daftar tugas aktif...',
      payload: {},
    };
  }

  // 5B. Check Schedules ("cek jadwal", "lihat jadwal", "jadwal hari ini", "jadwal besok", "jadwal selasa")
  if (
    /^(?:cek|lih?at|daftar|list|info|tampil(?:in|kan)?)\s+(?:semua\s+)?jadwal(?:\s+(?:kuliah|presensi|aktif|hari\s+ini|besok|lusa|senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad))?\??$/i.test(clean) ||
    /^jadwal(?:\s+(?:kuliah|presensi))?\s+(?:hari\s+ini|besok|lusa|senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad|apa\s+aja|apa\s+saja)\??$/i.test(clean) ||
    /^ada\s+jadwal\s+apa(?:\s+(?:aja|saja|hari\s+ini|besok))?\??$/i.test(clean)
  ) {
    const relDate = resolveRelativeIndonesianDate(clean, now);
    return {
      intent: 'CEK_JADWAL',
      reply_message: 'Mengecek daftar jadwal...',
      payload: {
        hari: relDate?.hari || null,
        tanggal: relDate?.dateStr || null,
      },
    };
  }

  // 5C. Check Partner Memories / Activities ("cek pacar", "cek aktivitas pacar", "aktivitas pacar", "cek memori", "catatan pacar")
  if (
    /^(?:cek|lih?at|daftar|list|info|buka|tampil(?:in|kan)?)\s+(?:semua\s+)?(?:aktivitas|kegiatan|memori|catatan|cerita|riwayat|history|keseharian)?\s*(?:pacar|dia|doi|brankas\s+memori)\??$/i.test(clean) ||
    /^(?:cek|lih?at|daftar|list|info|buka|tampil(?:in|kan)?)\s+(?:semua\s+)?(?:memori|brankas\s+memori|aktivitas\s+pacar|catatan\s+pacar|cerita\s+pacar)\??$/i.test(clean) ||
    /^(?:aktivitas|kegiatan|memori|catatan|cerita|riwayat|keseharian)\s+(?:pacar|dia|doi)\??$/i.test(clean)
  ) {
    return {
      intent: 'CARI_MEMORI',
      reply_message: 'Mengecek brankas memori pacar...',
      payload: { kata_kunci: '' },
    };
  }

  // 5D. Search Partner Memory with explicit topic ("cari memori matcha", "cek aktivitas pacar kemarin", "cek memori pacar sakit")
  const memSearchMatch = clean.match(
    /^(?:cari|cek|lih?at)\s+(?:aktivitas|kegiatan|memori|catatan|cerita)\s+(?:pacar|dia|doi)?\s*(.+?)\??$/i
  );
  if (memSearchMatch && !/\b(wishlist|momen|ultah|ulang\s+tahun|anniversary|jadian)\b/i.test(clean)) {
    const queryText = memSearchMatch[1].trim();
    const relDate = resolveRelativeIndonesianDate(queryText, now);
    if (queryText) {
      const remainingKey = relDate
        ? queryText.replace(relDate.matchedText, '').trim()
        : queryText;
      return {
        intent: 'CARI_MEMORI',
        reply_message: 'Mencari di brankas memori...',
        payload: {
          tanggal: relDate ? relDate.dateStr : undefined,
          kata_kunci: remainingKey,
        },
      };
    }
  }

  // 6. Complete Task ("tugas Kriptografi udah kelar", "selesai tugas basis data")
  const taskDone1 = clean.match(/^tugas\s+(.+?)\s+(?:udah|sudah)\s+(?:kelar|selesai|beres|done)\b/i);
  const taskDone2 = clean.match(/^(?:selesai(?:in|kan)?|kelar(?:in|kan)?|beres(?:in|kan)?)\s+tugas\s+(.+)$/i);
  if (taskDone1 || taskDone2) {
    const target = (taskDone1 ? taskDone1[1] : taskDone2[1]).trim();
    return {
      intent: 'SELESAI_TUGAS',
      reply_message: 'Siap, tugas ditandai selesai!',
      payload: { judul: target, kata_kunci: target },
    };
  }

  // 6B. Natural Indonesian Add Task ("tugas matkul pcd mempelajari segmentasi hari kamis besok")
  if (
    /^(?:tolong\s+)?(?:(?:catat|tambah(?:kan)?|simpan|ada)\s+)?tugas\b/i.test(clean) &&
    !/\b(udah|sudah|kelar|selesai|beres|done|apa\s+aja|apa\s+saja)\b/i.test(clean)
  ) {
    const relDate = resolveRelativeIndonesianDate(clean, now);
    if (relDate) {
      const jamMatch = clean.match(/\b(?:jam|pukul|pkl)\s*(\d{1,2}[:.]\d{2})\b/i);
      const jam = jamMatch ? normalizeJam(jamMatch[1]) || '23:59' : '23:59';

      let body = clean
        .replace(/^(?:tolong\s+)?(?:(?:catat|tambah(?:kan)?|simpan|ada)\s+)?tugas\b/i, '')
        .replace(relDate.matchedText, ' ');
      if (jamMatch) body = body.replace(jamMatch[0], ' ');
      body = body.replace(/\b(?:deadline|dl|tenggat|maksimal|max|sampai|pada|untuk)\b/gi, ' ');

      let matkul = '';
      const matkulMatch = body.match(/\b(?:matkul|mata\s+kuliah)\s+([a-zA-Z0-9_-]+)/i);
      if (matkulMatch) {
        matkul = matkulMatch[1].length <= 4 ? matkulMatch[1].toUpperCase() : matkulMatch[1];
        body = body.replace(matkulMatch[0], ' ');
      }

      const judul = body.replace(/^[\s,.:;\-]+|[\s,.:;\-]+$/g, '').replace(/\s+/g, ' ').trim();
      if (judul) {
        const cleanJudul = judul.charAt(0).toUpperCase() + judul.slice(1);
        return {
          intent: 'TAMBAH_TUGAS',
          reply_message: 'Siap, tugas langsung dicatat!',
          payload: {
            judul: cleanJudul,
            matkul,
            tanggal: relDate.dateStr,
            jam,
            kata_kunci: cleanJudul,
            isi_catatan: cleanJudul,
          },
        };
      }
    }
  }

  // 6C. Natural Indonesian Add Schedule ("Ingetin presensi tiap Selasa jam 07.50 matkul Sistem Terdistribusi")
  if (
    /\b(ingetin|ingatkan|jadwal|presensi|absen)\b/i.test(clean) &&
    !/\b(tunda|snooze|menit\s+lagi)\b/i.test(clean)
  ) {
    const jamMatch = clean.match(/\b(?:jam|pukul|pkl)\s*(\d{1,2}[:.]\d{2})\b/i);
    const relDate = resolveRelativeIndonesianDate(clean, now);
    if (jamMatch && relDate) {
      const jam = normalizeJam(jamMatch[1]);
      if (jam) {
        const isRutin = /\b(tiap|setiap|rutin)\b/i.test(clean) && Boolean(relDate.hari);
        let nama = clean
          .replace(/^(?:tolong\s+)?(?:ingetin|ingatkan|tambah(?:kan)?\s+jadwal|catat\s+jadwal|jadwal)\s+/i, '')
          .replace(/\b(?:tiap|setiap|rutin)\b/gi, ' ')
          .replace(relDate.matchedText, ' ')
          .replace(jamMatch[0], ' ')
          .replace(/\b(?:matkul|mata\s+kuliah)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (nama) {
          nama = nama.charAt(0).toUpperCase() + nama.slice(1);
          return {
            intent: 'TAMBAH_JADWAL',
            reply_message: 'Siap, jadwal langsung disimpan!',
            payload: {
              judul: nama,
              hari: relDate.hari || null,
              tanggal: isRutin ? null : relDate.dateStr,
              jam,
              is_rutin: isRutin,
              kata_kunci: nama,
              isi_catatan: nama,
            },
          };
        }
      }
    }
  }

  // 7. Check Wishlist / Moments ("cek wishlist", "lihat momen spesial")
  const wishCheck = clean.match(/^(?:cek|lihat|daftar|list)\s+(?:semua\s+)?(wishlist|momen(?:\s+spesial)?)\??$/i);
  if (wishCheck) {
    const word = wishCheck[1].toLowerCase();
    return {
      intent: 'CEK_WISHLIST_MOMEN',
      reply_message: 'Mengecek daftar...',
      payload: {
        tipe_item: word.startsWith('momen') ? 'MOMEN' : 'WISHLIST',
      },
    };
  }

  // 8. Finance Summary ("rekap pengeluaran hari ini", "rekap keuangan bulan ini", "saldo bulan ini", "pemasukan minggu ini")
  const rekapMatch = clean.match(
    /^(?:rekap|total|cek|lih?at)?\s*(?:pengeluaran|pemasukan|keuangan|saldo|jajan|biaya)(?:\s+(hari\s+ini|minggu\s+ini|bulan\s+ini))?\??$/i
  );
  if (rekapMatch && (rekapMatch[1] || /\b(rekap|cek|lih?at|saldo|keuangan)\b/i.test(clean))) {
    const period = (rekapMatch[1] || 'bulan ini').toLowerCase();
    let start = nowParts.dateStr;
    const end = nowParts.dateStr;
    if (period.includes('minggu')) {
      start = shiftDateStr(nowParts.dateStr, -6);
    } else if (period.includes('bulan')) {
      start = `${nowParts.monthStr}-01`;
    }
    return {
      intent: 'REKAP_PENGELUARAN',
      reply_message: 'Berikut rekap keuanganmu:',
      payload: { tanggal_mulai: start, tanggal_akhir: end },
    };
  }

  // 8B. Simple Income List ("masuk 20k", "pemasukan 50rb", "pemasukan uang saku 500rb", "masuk 20k dari ortu", "dapat transfer ortu 1jt")
  const incomeLeadMatch = clean.match(
    /^(?:catat\s+)?(?:pemasukan|income|(?:uang|duit)\s+masuk|masuk(?:\s+duit|\s+uang)?|dapat|dapet|terima|diterima)\s+(.+)$/i
  );
  if (
    incomeLeadMatch &&
    !/\b(jam|pukul|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu|minggu|tugas|jadwal|ingetin|pacar|dia)\b/i.test(clean)
  ) {
    const parseNominal = (numStr, unitStr) => {
      const rawNum = Number(String(numStr).replace(',', '.'));
      const unit = String(unitStr || '').toLowerCase();
      let mult = 1;
      if (unit === 'rb' || unit === 'ribu' || unit === 'k') mult = 1000;
      else if (unit === 'jt' || unit === 'juta') mult = 1000000;
      return Math.round(rawNum * mult);
    };

    const segments = incomeLeadMatch[1]
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const incomes = [];
    let allMatched = segments.length >= 1 && segments.length <= 10;
    for (const seg of segments) {
      let itemName = '';
      let nominal = 0;

      // Pattern A: bare nominal only ("masuk 20k", "pemasukan 50rb")
      const bareNum = seg.match(/^(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?$/i);
      // Pattern B: nominal first then optional label ("masuk 20k dari ortu", "pemasukan 500rb uang saku")
      const numFirst = seg.match(/^(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?\s+(?:dari\s+|untuk\s+|buat\s+)?([a-zA-Z0-9\s&()\-/]{2,45})$/i);
      // Pattern C: label first then nominal ("uang saku 500rb", "gaji freelance 1.5jt")
      const labelFirst = seg.match(/^(?:dari\s+)?([a-zA-Z0-9\s&()\-/]{2,45}?)\s+(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?$/i);

      if (bareNum) {
        itemName = 'Uang Masuk';
        nominal = parseNominal(bareNum[1], bareNum[2]);
      } else if (numFirst) {
        itemName = numFirst[3].trim();
        nominal = parseNominal(numFirst[1], numFirst[2]);
      } else if (labelFirst) {
        itemName = labelFirst[1].trim();
        nominal = parseNominal(labelFirst[2], labelFirst[3]);
      } else {
        allMatched = false;
        break;
      }

      if (!itemName || nominal < 500) {
        allMatched = false;
        break;
      }
      incomes.push({
        item: itemName.charAt(0).toUpperCase() + itemName.slice(1),
        nominal,
        kategori: normalizeIncomeCategory(itemName),
      });
    }
    if (allMatched && incomes.length > 0) {
      return {
        intent: 'CATAT_PEMASUKAN',
        reply_message: 'Mantap, pemasukan langsung dicatat!',
        payload: {
          tanggal: nowParts.dateStr,
          expenses: incomes,
        },
      };
    }
  }

  // 9. Simple Expense List ("Makan siang 18rb, bensin 25rb, kopi 20k")
  if (
    !/\b(jam|pukul|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu|minggu|tugas|jadwal|ingetin|pacar|dia|pemasukan|income|masuk|dapat|dapet|terima|diterima|gaji|beasiswa|uang\s+saku|kiriman|transfer\s+ortu|bonus|thr|cashback)\b/i.test(
      clean
    )
  ) {
    const segments = clean
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length >= 1 && segments.length <= 10) {
      const expenses = [];
      let allMatched = true;
      for (const seg of segments) {
        const m = seg.match(
          /^(?:beli|bayar|jajan)?\s*([a-zA-Z0-9\s&()\-/]{2,40}?)\s+(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?$/i
        );
        if (!m) {
          allMatched = false;
          break;
        }
        const itemName = m[1].trim();
        const rawNum = Number(m[2].replace(',', '.'));
        const unit = (m[3] || '').toLowerCase();
        let mult = 1;
        if (unit === 'rb' || unit === 'ribu' || unit === 'k') mult = 1000;
        else if (unit === 'jt' || unit === 'juta') mult = 1000000;
        const nominal = Math.round(rawNum * mult);
        if (!itemName || nominal < 500) {
          allMatched = false;
          break;
        }
        expenses.push({
          item: itemName.charAt(0).toUpperCase() + itemName.slice(1),
          nominal,
          kategori: normalizeCategory(itemName),
        });
      }
      if (allMatched && expenses.length > 0) {
        return {
          intent: 'CATAT_PENGELUARAN',
          reply_message: 'Siap, pengeluaran langsung dicatat!',
          payload: {
            tanggal: nowParts.dateStr,
            expenses,
          },
        };
      }
    }
  }

  return null;
}

export const INTENTS = [
  'TAMBAH_JADWAL',
  'CEK_JADWAL',
  'SNOOZE_JADWAL',
  'TAMBAH_TUGAS',
  'SELESAI_TUGAS',
  'CEK_TUGAS',
  'SIMPAN_MEMORI',
  'CARI_MEMORI',
  'TAMBAH_WISHLIST_MOMEN',
  'CEK_WISHLIST_MOMEN',
  'SIMPAN_VAULT',
  'CARI_VAULT',
  'UBAH_VAULT',
  'CATAT_PENGELUARAN',
  'CATAT_PEMASUKAN',
  'REKAP_PENGELUARAN',
  'OBROLAN_BIASA',
];

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: INTENTS,
      description: 'Kategori intent utama dari pesan pengguna.',
    },
    reply_message: {
      type: Type.STRING,
      description: 'Balasan singkat dan natural dalam bahasa Indonesia.',
    },
    payload: {
      type: Type.OBJECT,
      properties: {
        judul: { type: Type.STRING, description: 'Nama jadwal, judul tugas, atau judul wishlist/momen.' },
        matkul: { type: Type.STRING, description: 'Nama mata kuliah terkait tugas/jadwal.' },
        hari: { type: Type.STRING, description: 'Nama hari Indonesia: Senin, Selasa, Rabu, Kamis, Jumat, Sabtu, Minggu.' },
        tanggal: { type: Type.STRING, description: 'Tanggal format YYYY-MM-DD.' },
        tanggal_mulai: { type: Type.STRING, description: 'Tanggal awal rentang query format YYYY-MM-DD.' },
        tanggal_akhir: { type: Type.STRING, description: 'Tanggal akhir rentang query format YYYY-MM-DD.' },
        jam: { type: Type.STRING, description: 'Jam format 24-jam HH:MM.' },
        is_rutin: { type: Type.BOOLEAN, description: 'true jika jadwal berulang mingguan, false jika sekali jalan.' },
        menit_tunda: { type: Type.INTEGER, description: 'Jumlah menit tunda untuk SNOOZE_JADWAL.' },
        isi_catatan: { type: Type.STRING, description: 'Ringkasan memori pacar, catatan wishlist/momen, atau konten URL/teks untuk vault.' },
        kata_kunci: { type: Type.STRING, description: 'Kata kunci pencarian memori, tugas, atau label item vault.' },
        nama_baru: { type: Type.STRING, description: 'Nama/kata kunci baru untuk intent UBAH_VAULT.' },
        tipe_item: {
          type: Type.STRING,
          enum: ['WISHLIST', 'MOMEN', 'LINK', 'FILE'],
          description: 'Tipe item untuk wishlist/momen atau vault.',
        },
        ulang: {
          type: Type.STRING,
          enum: ['TAHUNAN', 'BULANAN', 'SEKALI'],
          description: 'Pola pengulangan untuk MOMEN spesial (BULANAN jika disebut tiap bulan/mensiversary, SEKALI jika tidak berulang, default TAHUNAN).',
        },
        expenses: {
          type: Type.ARRAY,
          description: 'Daftar item pengeluaran yang diekstrak dari teks, voice note, atau foto struk.',
          items: {
            type: Type.OBJECT,
            properties: {
              item: { type: Type.STRING },
              nominal: { type: Type.INTEGER },
              kategori: {
                type: Type.STRING,
                enum: [
                  'Makan & Minum',
                  'Transportasi',
                  'Akademik',
                  'Hiburan',
                  'Uang Saku',
                  'Gaji & Freelance',
                  'Beasiswa',
                  'Hadiah & Bonus',
                  'Lainnya',
                ],
              },
            },
            required: ['item', 'nominal', 'kategori'],
          },
        },
        schedules: {
          type: Type.ARRAY,
          description: 'Opsional: isi jika input (misal screenshot KRS) berisi lebih dari satu jadwal.',
          items: {
            type: Type.OBJECT,
            properties: {
              judul: { type: Type.STRING },
              hari: { type: Type.STRING },
              tanggal: { type: Type.STRING },
              jam: { type: Type.STRING },
              is_rutin: { type: Type.BOOLEAN },
            },
            required: ['judul', 'jam'],
          },
        },
        tasks: {
          type: Type.ARRAY,
          description: 'Opsional: isi jika input (misal PDF silabus atau screenshot) berisi lebih dari satu tugas.',
          items: {
            type: Type.OBJECT,
            properties: {
              judul: { type: Type.STRING },
              matkul: { type: Type.STRING },
              tanggal: { type: Type.STRING },
              jam: { type: Type.STRING },
            },
            required: ['judul', 'tanggal'],
          },
        },
      },
      required: ['kata_kunci', 'isi_catatan'],
    },
  },
  required: ['intent', 'reply_message', 'payload'],
};

const GEMINI_SUPPORTED_MIME_PREFIXES = ['image/', 'audio/', 'text/'];
const GEMINI_SUPPORTED_EXACT_MIMES = new Set(['application/pdf']);

export function isGeminiSupportedMime(mimeType) {
  if (!mimeType) return false;
  const clean = mimeType.split(';')[0].trim().toLowerCase();
  if (GEMINI_SUPPORTED_EXACT_MIMES.has(clean)) return true;
  return GEMINI_SUPPORTED_MIME_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

let aiClient = null;
let cachedKey = null;

function getClient() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return null;
  }
  if (!aiClient || cachedKey !== apiKey) {
    aiClient = new GoogleGenAI({ apiKey });
    cachedKey = apiKey;
  }
  return aiClient;
}

export function isGeminiConfigured() {
  return Boolean(getClient() || getGroqApiKey());
}

const GROQ_JSON_SCHEMA_HINT = `
FORMAT OUTPUT JSON WAJIB (hanya keluarkan 1 objek JSON valid tanpa teks tambahan):
{
  "intent": salah satu dari [${INTENTS.map((i) => `"${i}"`).join(', ')}],
  "reply_message": "Balasan singkat & natural bahasa Indonesia",
  "payload": {
    "judul": "string (nama jadwal/tugas/wishlist/momen)",
    "matkul": "string (nama matkul jika relevan)",
    "hari": "Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu (jika relevan)",
    "tanggal": "YYYY-MM-DD (jika relevan)",
    "tanggal_mulai": "YYYY-MM-DD (untuk rentang query)",
    "tanggal_akhir": "YYYY-MM-DD (untuk rentang query)",
    "jam": "HH:MM format 24 jam (jika relevan)",
    "is_rutin": true/false,
    "menit_tunda": integer,
    "isi_catatan": "string (ringkasan memori / detail wishlist / isi link/teks bersih untuk vault)",
    "kata_kunci": "string (judul singkat Title Case 2-4 kata untuk vault / keyword pencarian)",
    "nama_baru": "string (khusus UBAH_VAULT)",
    "tipe_item": "WISHLIST|MOMEN|LINK|FILE",
    "ulang": "TAHUNAN|BULANAN|SEKALI",
    "expenses": [{ "item": "string", "nominal": integer_rupiah, "kategori": "Makan & Minum|Transportasi|Akademik|Hiburan|Uang Saku|Gaji & Freelance|Beasiswa|Hadiah & Bonus|Lainnya" }],
    "schedules": [{ "judul": "string", "hari": "string", "tanggal": "YYYY-MM-DD", "jam": "HH:MM", "is_rutin": true/false }],
    "tasks": [{ "judul": "string", "matkul": "string", "tanggal": "YYYY-MM-DD", "jam": "HH:MM" }]
  }
}
Sertakan hanya field payload yang relevan (selalu isi kata_kunci & isi_catatan untuk SIMPAN_VAULT).`;

function parseJsonIntentResult(rawText, providerLabel = 'AI') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error(`${providerLabel} tidak mengembalikan respons JSON.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Gagal mem-parsing respons JSON dari ${providerLabel}.`);
    }
    parsed = JSON.parse(jsonMatch[0]);
  }

  return {
    intent: INTENTS.includes(parsed.intent) ? parsed.intent : 'OBROLAN_BIASA',
    reply_message: parsed.reply_message || 'Siap, sudah diproses!',
    payload: parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {},
  };
}

async function callGroqChat({
  messages,
  chain = GROQ_TEXT_CHAIN,
  jsonMode = true,
  temperature = 0.2,
  maxTokens = 650,
}) {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY belum dikonfigurasi.');
  }

  const nowMs = Date.now();
  const available = chain.filter((e) => (modelCooldownUntil.get(`groq:${e.model}`) || 0) <= nowMs);
  const inCooldown = chain.filter((e) => (modelCooldownUntil.get(`groq:${e.model}`) || 0) > nowMs);
  const order = available.length > 0 ? available : inCooldown;

  let lastErr = null;
  for (const entry of order) {
    const cooldownKey = `groq:${entry.model}`;
    const body = {
      model: entry.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(entry.reasoning_effort ? { reasoning_effort: entry.reasoning_effort } : {}),
    };

    try {
      const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data?.error?.message || `Groq HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const content = (data?.choices?.[0]?.message?.content || '').trim();
      if (!content) {
        throw new Error('Groq mengembalikan konten kosong.');
      }

      modelCooldownUntil.delete(cooldownKey);
      lastUsedModel = cooldownKey;
      return content;
    } catch (err) {
      lastErr = err;
      const status = Number(err?.status || err?.statusCode);
      if (status !== 401 && status !== 403) {
        modelCooldownUntil.set(cooldownKey, Date.now() + getCooldownDuration(err, 'groq'));
      }
      if (status === 401 || status === 403) {
        break; // invalid key, don't waste retries
      }
    }
  }

  throw lastErr || new Error('Semua model Groq sedang sibuk.');
}

async function transcribeAudioWithGroq(mediaBuffer, mimeType, fileName) {
  const apiKey = getGroqApiKey();
  if (!apiKey || !mediaBuffer) return null;

  const cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim().toLowerCase();
  const extMap = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/flac': 'flac',
  };
  const ext = extMap[cleanMime] || 'ogg';
  const safeName = fileName && /\.[a-z0-9]+$/i.test(fileName) ? fileName : `voice_note.${ext}`;

  for (const model of GROQ_WHISPER_MODELS) {
    const cooldownKey = `groq:${model}`;
    if ((modelCooldownUntil.get(cooldownKey) || 0) > Date.now()) continue;

    try {
      const form = new FormData();
      form.append('file', new Blob([mediaBuffer], { type: cleanMime }), safeName);
      form.append('model', model);
      form.append('language', 'id');
      form.append('response_format', 'json');

      const res = await fetch(`${GROQ_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data?.error?.message || `Groq Whisper HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const transcript = (data?.text || '').trim();
      if (transcript) {
        modelCooldownUntil.delete(cooldownKey);
        return transcript;
      }
    } catch (err) {
      modelCooldownUntil.set(cooldownKey, Date.now() + getCooldownDuration(err, 'groq'));
      if (Number(err?.status) === 401 || Number(err?.status) === 403) break;
    }
  }
  return null;
}

async function analyzeWithGroq({
  promptText,
  imageBuffer = null,
  imageMimeType = null,
  nowParts,
  lastReminder,
}) {
  const systemPrompt = `${buildSystemInstruction(nowParts, lastReminder)}\n${GROQ_JSON_SCHEMA_HINT}`;
  const isVision = Boolean(imageBuffer && imageMimeType);

  const userContent = isVision
    ? [
        { type: 'text', text: promptText },
        {
          type: 'image_url',
          image_url: {
            url: `data:${imageMimeType};base64,${imageBuffer.toString('base64')}`,
          },
        },
      ]
    : promptText;

  const rawText = await callGroqChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    chain: isVision ? GROQ_VISION_CHAIN : GROQ_TEXT_CHAIN,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 700,
  });

  return parseJsonIntentResult(rawText, 'Groq');
}

async function analyzeWithGemini({
  promptText,
  mediaBuffer = null,
  mimeType = null,
  nowParts,
  lastReminder,
}) {
  const client = getClient();
  if (!client) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi di file .env.');
  }

  const parts = [];
  if (mediaBuffer && mimeType && isGeminiSupportedMime(mimeType)) {
    const cleanMime = mimeType.split(';')[0].trim().toLowerCase();
    parts.push({
      inlineData: {
        data: mediaBuffer.toString('base64'),
        mimeType: cleanMime,
      },
    });
  }
  parts.push({ text: promptText });

  const response = await generateWithFallback(client, (model) => ({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: buildSystemInstruction(nowParts, lastReminder),
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  }));

  return parseJsonIntentResult(response.text, 'Gemini');
}

function buildSystemInstruction(nowParts, lastReminder) {
  const reminderCtx = lastReminder
    ? `Pengingat terakhir yang dikirim bot: "${lastReminder.activityName || lastReminder.title}" pada ${lastReminder.timestamp || '-'}.`
    : 'Belum ada pengingat terakhir yang tersimpan.';

  return `Kamu adalah asisten pribadi cerdas berbahasa Indonesia yang terhubung dengan WhatsApp pengguna.
Tugasmu adalah mengklasifikasikan intent pesan pengguna (dari teks, voice note, gambar/screenshot, atau PDF) dan mengekstrak data terstruktur dalam format JSON sesuai skema.

KONTEKS WAKTU SAAT INI (WIB / Asia/Jakarta):
- Waktu Lengkap: ${nowParts.display}
- Hari ini: ${nowParts.hari}
- Tanggal ISO (YYYY-MM-DD): ${nowParts.dateStr}
- Jam saat ini (HH:MM): ${nowParts.timeStr}
- ${reminderCtx}

ATURAN KLASIFIKASI INTENT:
1. TAMBAH_JADWAL: Pengguna meminta diingatkan jadwal kuliah/presensi/kegiatan rutin mingguan ("tiap Selasa jam 07.50") atau sekali jalan ("besok jam 14.00", "nanti jam 19.30"), atau mengirim screenshot KRS/jadwal kuliah.
   - Jika rutin mingguan: is_rutin = true, isi hari (Senin-Minggu) & jam (HH:MM).
   - Jika sekali jalan: is_rutin = false, isi tanggal (YYYY-MM-DD) & jam (HH:MM).
   - Jika gambar/teks memuat banyak jadwal sekaligus (misal KRS), isi array payload.schedules!
1B. CEK_JADWAL: Pengguna ingin melihat daftar jadwal kuliah/presensi/kegiatan ("cek jadwal", "jadwal hari ini apa?", "jadwal besok", "jadwal hari Selasa").
   - Jika spesifik hari/tanggal, isi payload.hari atau payload.tanggal; jika umum ("cek jadwal"), kosongkan keduanya.
2. SNOOZE_JADWAL: Pengguna membalas pengingat untuk menunda/mengingatkan lagi ("ingetin lagi 10 menit lagi", "tunda 15 menit", "snooze 5 menit").
   - Isi menit_tunda (integer, default 10 jika tidak disebut) dan judul dari pengingat terakhir bila relevan.
3. TAMBAH_TUGAS: Pengguna mencatat tugas kuliah/deadline dari teks, copy-paste pengumuman grup, screenshot, voice note, atau PDF.
   - Isi judul, matkul, tanggal (YYYY-MM-DD), jam (HH:MM, default "23:59" jika tidak disebut).
   - Jika ada lebih dari satu tugas, isi array payload.tasks.
4. SELESAI_TUGAS: Pengguna mengabarkan tugas sudah selesai/kelar ("Tugas Kriptografi udah kelar", "selesaiin tugas basis data").
   - Isi judul / matkul / kata_kunci agar backend dapat mencocokkan tugas aktif.
5. CEK_TUGAS: Pengguna bertanya daftar tugas / deadline yang masih aktif ("Ada tugas apa aja?", "deadline minggu ini apa?").
6. SIMPAN_MEMORI: HANYA jika pengguna MENCERITAKAN kejadian/aktivitas/keseharian nyata tentang pacar (ada cerita/peristiwa spesifik, misal "tadi dia makan mie ayam", "dia lagi sakit perut"), forward chat pacar, atau mengirim foto kenangan pacar untuk dicatat.
   - Rangkum poin-poin penting ke payload.isi_catatan, sertakan tanggal (YYYY-MM-DD, default hari ini ${nowParts.dateStr}) dan hari.
   - PENTING: JANGAN gunakan SIMPAN_MEMORI untuk permintaan singkat seperti "cek pacar", "aktivitas pacar", "cek aktivitas pacar", "catatan pacar" — itu adalah CARI_MEMORI!
7. CARI_MEMORI: Pengguna ingin melihat, mengecek, atau menanyakan catatan/aktivitas/keseharian/cerita pacar — baik secara umum ("cek pacar", "cek aktivitas pacar", "aktivitas pacar", "catatan pacar", "pacar ngapain aja akhir-akhir ini") maupun spesifik tanggal/topik ("Minggu kemarin hari Selasa dia ngelakuin apa?", "3 hari lalu dia cerita apa?", "Kapan terakhir kali dia beli matcha?").
   - Jika pengguna meminta daftar umum/terbaru tanpa topik spesifik, KOSONGKAN payload.kata_kunci (JANGAN isi "pacar" atau "aktivitas pacar").
   - Hitung tanggal absolut (YYYY-MM-DD) secara akurat dari ${nowParts.dateStr} (${nowParts.hari}):
     - Jika menunjuk satu hari spesifik, isi payload.tanggal.
     - Jika menunjuk rentang (misal "minggu lalu", "bulan ini"), isi payload.tanggal_mulai dan payload.tanggal_akhir.
     - Jika mencari topik/kata spesifik ("matcha", "sakit", "kafe"), isi payload.kata_kunci.
8. TAMBAH_WISHLIST_MOMEN: Pengguna menyimpan keinginan/wishlist pacar ("Masukin wishlist dia: tas selempang warna krem", atau dari screenshot barang) ATAU menyimpan tanggal penting/spesial ("Ulang tahun dia 14 Mei", "Anniversary kita 17 Agustus 2024", "Ingetin tanggal jadian 24 tiap bulan").
   - Set tipe_item = "WISHLIST" untuk barang/keinginan, atau "MOMEN" untuk tanggal spesial (isi tanggal YYYY-MM-DD).
   - Untuk MOMEN: set payload.ulang = "BULANAN" jika disebut tiap bulan/bulanan/mensiversary, "SEKALI" jika sekali saja, atau "TAHUNAN" secara default.
   - Isi judul dan isi_catatan (jika ada detail tambahan).
9. CEK_WISHLIST_MOMEN: HANYA jika pengguna secara eksplisit menanyakan WISHLIST (barang keinginan/kado) atau MOMEN SPESIAL / TANGGAL PENTING (ultah, anniversary, jadian). JANGAN gunakan intent ini untuk "cek pacar" atau "cek aktivitas pacar" (itu masuk CARI_MEMORI!).
   - Isi tipe_item ("WISHLIST" atau "MOMEN") hanya jika spesifik menanyakan salah satunya.
10. SIMPAN_VAULT: Pengguna ingin menyimpan link (presensi, Zoom, Google Drive), catatan teks/judul dalam tanda petik ("simpan ini \"great of the fireflies\"", "simpan judul anime ini \"great of the fireflies\""), atau file/foto/dokumen (PDF/DOCX/ZIP/screenshot).
    - INISIATIF JUDUL (WAJIB): Selalu buat payload.kata_kunci yang singkat, rapi, dan deskriptif (Title Case, 2-4 kata). Jika pengguna tidak menyebutkan judul (misal hanya menulis "simpan ini" + foto, atau "simpan ini \"great of the fireflies\""), BERINISIATIFLAH membuat judul terbaik berdasarkan isi gambar atau teksnya (contoh: "Judul Anime", "Bukti Pengumpulan Paper", "Kode Kelas Zoom"). JANGAN biarkan payload.kata_kunci kosong dan JANGAN masukkan kata perintah ("simpan", "ini") ke dalam judul!
    - KONTEN BERSIH (payload.isi_catatan): Untuk link/teks, simpan HANYA isi intinya saja! Jika ada tanda petik ("..."), ekstrak HANYA teks di dalam tanda petik tersebut tanpa tanda petik dan tanpa kalimat perintahnya (contoh: dari 'simpan judul anime ini "great of the fireflies"' -> kata_kunci: "Judul Anime", isi_catatan: "great of the fireflies").
    - Jika ada lampiran file/gambar/dokumen: tipe_item = "FILE".
    - Jika berupa URL/teks tanpa lampiran file: tipe_item = "LINK".
11. CARI_VAULT: Pengguna meminta kembali link atau file yang pernah disimpan ("Minta link presensi kripto", "kirim file modul jaringan", "lihat semua isi vault").
    - Isi payload.kata_kunci dengan kata kunci yang dicari (atau "SEMUA" jika pengguna meminta melihat daftar seluruh isi vault).
11B. UBAH_VAULT: Pengguna ingin mengganti/mengubah nama atau kata kunci item di Quick Vault ("ubah nama di vault ini menjadi deca", "ganti nama kripto jadi tugas kripto").
    - Isi payload.kata_kunci dengan nama lama (atau "terakhir" jika menunjuk item terbaru) dan payload.nama_baru dengan nama barunya.
12. CATAT_PENGELUARAN: Pengguna mencatat pengeluaran ("Makan siang 18rb, bensin 25rb, kopi 20k") atau mengirim foto struk belanja.
    - Ekstrak semua item ke payload.expenses: [{ item, nominal (integer Rupiah), kategori }].
    - Konversi singkatan: 18rb/18k -> 18000, 1.5jt -> 1500000.
    - Kategori wajib salah satu dari: "Makan & Minum", "Transportasi", "Akademik", "Hiburan", "Lainnya".
    - Isi payload.tanggal jika tanggal transaksi disebutkan/tertera di struk, selain itu gunakan ${nowParts.dateStr}.
12B. CATAT_PEMASUKAN: Pengguna mencatat pemasukan/uang masuk ("Dapat uang saku 500rb", "Baru gajian freelance 1.5jt", "Transferan ortu masuk 1jt", "Dapat cashback 25rb").
    - Ekstrak semua item ke payload.expenses: [{ item, nominal (integer Rupiah), kategori }].
    - Kategori wajib salah satu dari: "Uang Saku", "Gaji & Freelance", "Beasiswa", "Hadiah & Bonus", "Lainnya".
    - Isi payload.tanggal (default ${nowParts.dateStr}).
13. REKAP_PENGELUARAN: Pengguna meminta rekap keuangan, saldo, pemasukan, atau pengeluaran ("Pengeluaran hari ini berapa?", "rekap keuangan bulan ini", "saldo bulan ini berapa?", "rekap jajan minggu ini").
    - Hitung payload.tanggal_mulai dan payload.tanggal_akhir (YYYY-MM-DD) secara tepat berdasarkan ${nowParts.dateStr}.
14. OBROLAN_BIASA: Sapaan, pertanyaan umum, atau obrolan santai yang tidak masuk kategori di atas.

Selalu berikan JSON yang valid dan akurat.`;
}

/**
 * Classify user intent and extract structured payload from text and/or multimodal media.
 * Priority: 0ms Local Fast-Path -> Groq (Primary < 1s) -> Google Gemini (Auto-Fallback).
 */
export async function analyzeMessage({
  text = '',
  mediaBuffer = null,
  mimeType = null,
  fileName = null,
  lastReminder = null,
  now = new Date(),
}) {
  // 1. 0ms Local Fast-Path for deterministic commands
  const fastResult = tryLocalFastIntent({
    text,
    hasMedia: Boolean(mediaBuffer),
    fileName,
    now,
  });
  if (fastResult) {
    return fastResult;
  }

  const hasGroq = isGroqConfigured();
  const hasGemini = Boolean(getClient());
  if (!hasGroq && !hasGemini) {
    throw new Error('GROQ_API_KEY maupun GEMINI_API_KEY belum dikonfigurasi di file .env.');
  }

  const nowParts = getWibParts(now);
  const cleanMime = mimeType ? mimeType.split(';')[0].trim().toLowerCase() : '';
  const isAudio = Boolean(mediaBuffer && cleanMime.startsWith('audio/'));
  const isImage = Boolean(mediaBuffer && cleanMime.startsWith('image/'));
  const isPdf = Boolean(mediaBuffer && cleanMime === 'application/pdf');

  let effectiveText = (text || '').trim();
  let effectiveMediaBuffer = mediaBuffer;
  let effectiveMimeType = cleanMime;

  // 2. If Audio (Voice Note) and Groq is configured, transcribe ultra-fast via Groq Whisper
  if (isAudio && hasGroq) {
    const transcript = await transcribeAudioWithGroq(mediaBuffer, cleanMime, fileName);
    if (transcript) {
      effectiveText = effectiveText ? `${effectiveText}\n[Transkrip Voice Note]: ${transcript}` : transcript;

      // Re-check 0ms Local Fast-Path on the transcribed voice note!
      const voiceFastResult = tryLocalFastIntent({
        text: transcript,
        hasMedia: false,
        fileName: null,
        now,
      });
      if (voiceFastResult) {
        return voiceFastResult;
      }

      effectiveMediaBuffer = null;
      effectiveMimeType = '';
    }
  }

  let promptText = effectiveText;
  if (fileName && (!effectiveMimeType || !isGeminiSupportedMime(effectiveMimeType))) {
    promptText = `[Pengguna melampirkan file dokumen: "${fileName}" (${mimeType || 'application/octet-stream'})]\n${promptText}`.trim();
  } else if (fileName && effectiveMimeType) {
    promptText = `[Lampiran: "${fileName}" (${effectiveMimeType})]\n${promptText}`.trim();
  }

  if (!promptText) {
    promptText = 'Analisis media lampiran ini dan tentukan intent serta data terstruktur yang paling tepat.';
  }

  const errors = [];

  // 3A. PDF files: prefer Gemini first (native PDF reading), fallback to Groq text context
  if (isPdf) {
    if (hasGemini) {
      try {
        return await analyzeWithGemini({
          promptText,
          mediaBuffer: effectiveMediaBuffer,
          mimeType: effectiveMimeType,
          nowParts,
          lastReminder,
        });
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
    if (hasGroq) {
      try {
        return await analyzeWithGroq({
          promptText,
          nowParts,
          lastReminder,
        });
      } catch (err) {
        errors.push(`Groq: ${err.message}`);
      }
    }
  } else {
    // 3B. Text, Voice Note (transcribed), Image, or Generic Document:
    // Prefer Groq first (ultra-fast < 1s), seamlessly fallback to Gemini!
    const canUseGroqImage = isImage && effectiveMediaBuffer && effectiveMediaBuffer.length <= 4 * 1024 * 1024;
    const canUseGroqHere = hasGroq && (!effectiveMediaBuffer || canUseGroqImage || !isGeminiSupportedMime(effectiveMimeType));

    if (canUseGroqHere) {
      try {
        return await analyzeWithGroq({
          promptText,
          imageBuffer: canUseGroqImage ? effectiveMediaBuffer : null,
          imageMimeType: canUseGroqImage ? effectiveMimeType : null,
          nowParts,
          lastReminder,
        });
      } catch (err) {
        errors.push(`Groq: ${err.message}`);
      }
    }

    if (hasGemini) {
      try {
        return await analyzeWithGemini({
          promptText,
          mediaBuffer: effectiveMediaBuffer,
          mimeType: effectiveMimeType,
          nowParts,
          lastReminder,
        });
      } catch (err) {
        errors.push(`Gemini: ${err.message}`);
      }
    }
  }

  throw new Error(
    `Server AI sedang sibuk (${errors.join(' | ') || 'semua provider gagal'}). Silakan coba sebentar lagi atau pakai slash command (/t, /p, /v, /k).`
  );
}

/**
 * Second-pass AI call for CARI_MEMORI to synthesize a natural, accurate answer from SQLite rows.
 * Uses Groq primary (ultra-fast) -> Gemini fallback -> clean formatted rows fallback.
 */
export async function synthesizeMemoryAnswer(userQuestion, memories, now = new Date()) {
  const nowParts = getWibParts(now);

  if (!memories || memories.length === 0) {
    return 'Aku sudah cek di brankas memori, tapi belum menemukan catatan yang cocok untuk pertanyaan itu.';
  }

  const formattedRows = memories
    .map(
      (m, idx) =>
        `${idx + 1}. [${m.hari}, ${m.tanggal}] ${m.isi}${m.deskripsi ? ` | Deskripsi: ${m.deskripsi}` : ''}${m.media_path ? ' (ada foto tersimpan)' : ''}`
    )
    .join('\n');

  const prompt = `Hari ini: ${nowParts.display}.\nPertanyaan pengguna: "${userQuestion}"\n\nData memori dari database:\n${formattedRows}\n\nSusun jawaban singkat, hangat, dan akurat dalam bahasa Indonesia hanya berdasarkan data memori di atas. Sertakan hari & tanggalnya dengan jelas.`;

  if (isGroqConfigured()) {
    try {
      const answer = await callGroqChat({
        messages: [
          { role: 'system', content: 'Kamu adalah asisten pribadi yang hangat, ringkas, dan akurat dalam bahasa Indonesia.' },
          { role: 'user', content: prompt },
        ],
        chain: GROQ_TEXT_CHAIN,
        jsonMode: false,
        temperature: 0.3,
        maxTokens: 350,
      });
      if (answer) return answer;
    } catch {
      // Fallback to Gemini
    }
  }

  const client = getClient();
  if (!client) {
    return `Berikut catatan memori yang ditemukan:\n${formattedRows}`;
  }

  try {
    const response = await generateWithFallback(client, (model) => ({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.3,
      },
    }));
    return (response.text || '').trim() || `Berikut catatan memori yang ditemukan:\n${formattedRows}`;
  } catch {
    return `Berikut catatan memori yang ditemukan:\n${formattedRows}`;
  }
}
