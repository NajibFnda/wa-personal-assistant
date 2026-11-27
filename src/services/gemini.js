import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { aiLogRepo, inferIsPresensi, normalizeCategory, normalizeIncomeCategory } from '../config/db.js';
import {
  HARI_ID,
  getWibParts,
  normalizeDateStr,
  normalizeHari,
  normalizeJam,
  shiftDateStr,
} from '../utils/time.js';

export const PRIMARY_GEMINI_MODEL = 'gemini-3.8-flash';

const DEFAULT_MODEL_CHAIN = [
  { model: 'gemini-3.8-flash', thinkingLevel: ThinkingLevel.LOW },
  { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
  { model: 'gemini-3.5-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
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

function safeRecordAiLog({ provider, status, latency_ms = 0, model = '' }) {
  try {
    aiLogRepo.record({ provider, status, latency_ms, model });
  } catch {
    // Telemetry logging must never interrupt AI responses
  }
}

/**
 * Hedged parallel model execution:
 * Starts the fastest available model immediately; if it hasn't responded within HEDGE_DELAY_MS (1.8s),
 * fires the second model in parallel and resolves with whichever finishes first, aborting the slower one.
 */
async function generateWithFallback(client, buildRequest, { isFallback = false } = {}) {
  const chain = getModelChain();
  const nowMs = Date.now();
  const t0 = Date.now();

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
      maxOutputTokens: 900,
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
      return { response, model: entry.model };
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

  const logSuccess = (outcome) => {
    safeRecordAiLog({
      provider: 'GEMINI',
      status: isFallback ? 'FALLBACK' : 'SUCCESS',
      latency_ms: Date.now() - t0,
      model: outcome.model,
    });
    return outcome.response;
  };

  // Round 1: Race top 2 healthy models with 1.8s hedge delay
  if (order.length >= 2) {
    try {
      return logSuccess(await racePair(order[0], order[1]));
    } catch {
      // Transient 503 spikes on Flash models are very brief (~1s); retry top 2 models once
      await delay(900);
      try {
        return logSuccess(await racePair(chain[0], chain[1]));
      } catch {
        // Proceed to remaining models
      }
    }
  } else if (order.length === 1) {
    try {
      return logSuccess(await callSingleModel(order[0], null));
    } catch {
      // fall through
    }
  }

  // Fallback: race remaining non-quota-blocked models in parallel
  const rest = order.slice(2).filter((e) => (modelCooldownUntil.get(e.model) || 0) <= Date.now());
  if (rest.length > 0) {
    const controllers = rest.map(() => new AbortController());
    try {
      const winner = await Promise.any(
        rest.map((entry, idx) =>
          callSingleModel(entry, controllers[idx]).then((res) => {
            controllers.forEach((c, j) => {
              if (j !== idx) c.abort();
            });
            return res;
          })
        )
      );
      return logSuccess(winner);
    } catch {
      // all fallback models failed
    }
  }

  safeRecordAiLog({
    provider: 'GEMINI',
    status: 'ERROR',
    latency_ms: Date.now() - t0,
    model: chain[0]?.model || PRIMARY_GEMINI_MODEL,
  });

  throw new Error('Server AI Google sedang padat atau lambat merespons. Silakan coba kirim ulang sebentar lagi (atau gunakan slash command seperti /t, /p, /v, /k, /n).');
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

function extractBudgetFromText(str) {
  const m = String(str || '').match(
    /(?:di\s*bawah|under|maks(?:imal)?|max|budget|anggaran|sekitar|kurang\s+dari)?\s*(?:rp\.?\s*)?(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)\b/i
  );
  if (!m) return null;
  const num = Number(String(m[1]).replace(',', '.'));
  const unit = String(m[2] || '').toLowerCase();
  if (!Number.isFinite(num) || num <= 0) return null;
  let mult = 1;
  if (unit === 'rb' || unit === 'ribu' || unit === 'k') mult = 1000;
  else if (unit === 'jt' || unit === 'juta') mult = 1000000;
  const val = Math.round(num * mult);
  return val >= 5000 ? val : null;
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
  const isOtherModuleHint = /\b(jadwal|presensi|krs|tugas|deadline|struk|pengeluaran|memori|pacar|wishlist|ultah|anniversary|momen|catatan\s+kuliah|catatan\s+ide|kuliah|rangkum|ringkas|kado|hadiah|kencan|weekend)\b/i.test(
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
    !/\b(tugas|deadline|jadwal|presensi|memori|cerita|pacar|aktivitas|kegiatan|dia|doi|riwayat|history|pengeluaran|jajan|biaya|rekap|wishlist|momen|kemarin|lalu|catatan|kuliah|materi|rangkum|ringkas|kado|hadiah|kencan|date|weekend|budget|rekomendasi)\b/i.test(
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

  // 4B. Quick Reminder ("ingetin 30 menit lagi angkat jemuran", "ingatkan 2 jam lagi bayar kos")
  const quickRemMatch = clean.match(
    /^(?:tolong\s+)?(?:ingetin|ingatkan|remind(?:\s+me)?)\s+(?:aku\s+)?(?:dalam\s+)?(\d{1,3})\s*(menit|mnt|m|jam|j)\s*(?:lagi\s+)?(?:untuk\s+|buat\s+)?(.+)$/i
  );
  if (quickRemMatch) {
    const qty = Number(quickRemMatch[1]);
    const unit = quickRemMatch[2].toLowerCase();
    const menit = unit.startsWith('j') ? qty * 60 : qty;
    const pesan = quickRemMatch[3].trim();
    if (menit >= 1 && menit <= 1440 && pesan) {
      return {
        intent: 'TAMBAH_REMINDER',
        reply_message: 'Siap, pengingat cepat dipasang!',
        payload: {
          menit_tunda: menit,
          judul: pesan,
          isi_catatan: pesan,
        },
      };
    }
  }

  // 4C. Focus / Pomodoro Timer ("mulai fokus 25 menit belajar PCD", "fokus 45 menit ngoding", "pomodoro 25")
  const focusStartMatch = clean.match(
    /^(?:mulai\s+)?(?:fokus|focus|pomodoro)(?:\s+(\d{1,3})\s*(?:menit|mnt|m)?)?(?:\s+(.+))?$/i
  );
  if (focusStartMatch && !/^(stop|batal|berhenti|cek|status)$/i.test((focusStartMatch[2] || '').trim())) {
    const durasi = Number(focusStartMatch[1]) || 25;
    const label = (focusStartMatch[2] || 'Sesi Fokus').trim();
    return {
      intent: 'MULAI_FOKUS',
      reply_message: 'Siap, mode fokus dimulai!',
      payload: {
        menit_tunda: Math.max(1, Math.min(240, durasi)),
        judul: label,
      },
    };
  }

  // 4D. Partner Smart Date & Gift Recommendations / Monthly Recap
  if (/\b(rekap|rangkum(?:an)?)\s+(?:memori|cerita|kenangan|aktivitas)\s+(?:pacar|dia|bulan\s+ini)\b/i.test(clean)) {
    return {
      intent: 'IDE_PACAR',
      reply_message: 'Menyusun rekap memori bulanan pacarmu...',
      payload: {
        kata_kunci: 'REKAP',
      },
    };
  }

  if (
    /\b(ide|saran|rekomendasi|kasih\s+(?:ide|rekomendasi|saran))\s+(?:kado|hadiah|kejutan|gift|date|kencan|jalan|nonton|makan|tempat\s+(?:kencan|date|jalan|makan))\b/i.test(
      clean
    ) ||
    /(?:weekend|akhir\s+pekan|libur|malam\s+minggu|besok).*(?:ngajak|ajak|kencan|date|jalan|hangout).*(?:dia|pacar|doi)/i.test(
      clean
    ) ||
    /(?:enaknya|bagusnya|mending)\s+(?:ngajak|ajak)\s+(?:dia|pacar|doi)\s+(?:ke\s*mana|ngapain)/i.test(clean)
  ) {
    const budget = extractBudgetFromText(clean);
    return {
      intent: 'REKOMENDASI_PACAR',
      reply_message: 'Menyiapkan rekomendasi personal buat pacarmu...',
      payload: {
        kata_kunci: clean,
        ...(budget ? { budget } : {}),
      },
    };
  }

  // 4E. Search / List Study & Project Notes ("cari catatan kuliah Kriptografi tentang enkripsi", "lihat catatan kuliah", "cek semua catatan")
  if (!/\b(pacar|dia|doi|memori)\b/i.test(clean)) {
    if (/^(?:cek|lih?at|daftar|list|buka|tampil(?:in|kan)?)\s+(?:semua\s+)?catatan(?:\s+(?:kuliah|ide|materi|proyek))?\??$/i.test(clean)) {
      return {
        intent: 'CARI_CATATAN',
        reply_message: 'Membuka daftar catatan kuliah & ide...',
        payload: { kata_kunci: 'SEMUA' },
      };
    }
    const noteSearchMatch = clean.match(
      /^(?:tolong\s+)?(?:cari(?:in|kan)?|cek|lih?at|buka|minta|tampil(?:in|kan)?)\s+catatan(?:\s+(?:kuliah|materi|ide|proyek))?\s+(.+?)\??$/i
    );
    if (noteSearchMatch && noteSearchMatch[1].trim()) {
      return {
        intent: 'CARI_CATATAN',
        reply_message: 'Mencari di catatan kuliah & ide...',
        payload: { kata_kunci: noteSearchMatch[1].trim() },
      };
    }
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
    /^(?:cari|cek|lih?at)\s+(?:(?:aktivitas|kegiatan|memori|cerita)\s+(?:pacar|dia|doi)?|catatan\s+(?:pacar|dia|doi))\s*(.+?)\??$/i
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

  // 6C. Natural Indonesian Add Schedule / Alarm ("Ingetin presensi tiap Selasa jam 07.50 matkul Sistem Terdistribusi" or "Pasang alarm besok jam 14:00 Mulai Percobaan Unet")
  if (
    /\b(ingetin|ingatkan|jadwal|presensi|absen|alarm)\b/i.test(clean) &&
    !/\b(tunda|snooze|menit\s+lagi)\b/i.test(clean)
  ) {
    const jamMatch = clean.match(/\b(?:jam|pukul|pkl)\s*(\d{1,2}[:.]\d{2})\b/i);
    const relDate = resolveRelativeIndonesianDate(clean, now);
    if (jamMatch && relDate) {
      const jam = normalizeJam(jamMatch[1]);
      if (jam) {
        const isRutin = /\b(tiap|setiap|rutin)\b/i.test(clean) && Boolean(relDate.hari);
        let nama = clean
          .replace(
            /^(?:tolong\s+)?(?:(?:pasang|buat(?:kan)?|bikin(?:in)?|set)\s+)?(?:ingetin|ingatkan|tambah(?:kan)?\s+(?:jadwal|alarm)|catat\s+jadwal|jadwal|alarm(?:\s+biasa)?)(?:\s+(?:aku|saya|dong))?\s+/i,
            ''
          )
          .replace(/\b(?:tiap|setiap|rutin)\b/gi, ' ')
          .replace(relDate.matchedText, ' ')
          .replace(jamMatch[0], ' ')
          .replace(/\b(?:matkul|mata\s+kuliah)\b/gi, ' ')
          .replace(/^(?:untuk|buat|soal)\s+/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (nama) {
          nama = nama.charAt(0).toUpperCase() + nama.slice(1);
          const isPresensi = inferIsPresensi({ nama, is_rutin: isRutin, rawText: clean });
          return {
            intent: 'TAMBAH_JADWAL',
            reply_message: isPresensi
              ? 'Siap, pengingat presensi langsung disimpan!'
              : 'Siap, alarm biasa langsung dipasang!',
            payload: {
              judul: nama,
              hari: relDate.hari || null,
              tanggal: isRutin ? null : relDate.dateStr,
              jam,
              is_rutin: isRutin,
              is_presensi: isPresensi,
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

  // 9. Simple Expense List ("Makan siang 18rb, bensin 25rb, kopi 20k", "beli nasi goreng 15000")
  if (
    !/\b(jam|pukul|besok|lusa|senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad|tugas|jadwal|ingetin|ingatkan|pacar\w*|doi|dia|lahir|ultah|ulang\s+tahun|anniv\w*|jadian|momen|wishlist|tanggal|tgl|tahun|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|pemasukan|income|masuk|dapat|dapet|terima|diterima|gaji|beasiswa|uang\s+saku|kiriman|transfer\s+ortu|bonus|thr|cashback|kado|hadiah|budget|catatan|kuliah|rangkum|ringkas|rekomendasi|weekend)\b/i.test(
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
          /^(?:(beli|bayar|jajan|keluar|pengeluaran)\s+)?([a-zA-Z0-9\s&()\-/]{2,40}?)\s+(?:(rp\.?)\s*)?(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?$/i
        );
        if (!m) {
          allMatched = false;
          break;
        }
        const leadVerb = (m[1] || '').toLowerCase();
        const itemName = m[2].trim();
        const hasRp = Boolean(m[3]);
        const rawNum = Number(m[4].replace(',', '.'));
        const unit = (m[5] || '').toLowerCase();
        let mult = 1;
        if (unit === 'rb' || unit === 'ribu' || unit === 'k') mult = 1000;
        else if (unit === 'jt' || unit === 'juta') mult = 1000000;
        const nominal = Math.round(rawNum * mult);

        // Guard against years (e.g. "2003", "2026") or random IDs without currency/unit
        const looksLikeYear = !unit && !hasRp && !leadVerb && rawNum >= 1900 && rawNum <= 2100;
        const oddBareNumber = !unit && !hasRp && nominal % 100 !== 0;

        if (!itemName || nominal < 500 || looksLikeYear || oddBareNumber) {
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
  'TAMBAH_REMINDER',
  'TAMBAH_TUGAS',
  'SELESAI_TUGAS',
  'CEK_TUGAS',
  'SIMPAN_MEMORI',
  'CARI_MEMORI',
  'IDE_PACAR',
  'REKOMENDASI_PACAR',
  'TAMBAH_WISHLIST_MOMEN',
  'CEK_WISHLIST_MOMEN',
  'SIMPAN_VAULT',
  'CARI_VAULT',
  'UBAH_VAULT',
  'SIMPAN_CATATAN',
  'CARI_CATATAN',
  'CATAT_PENGELUARAN',
  'CATAT_PEMASUKAN',
  'REKAP_PENGELUARAN',
  'HABIT_CHECKIN',
  'MULAI_FOKUS',
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
        judul: { type: Type.STRING, description: 'Nama jadwal, judul tugas, judul catatan kuliah/ide, atau judul wishlist/momen.' },
        matkul: { type: Type.STRING, description: 'Nama mata kuliah terkait tugas/jadwal/catatan.' },
        kategori: { type: Type.STRING, description: 'Kategori atau nama mata kuliah untuk SIMPAN_CATATAN / CARI_CATATAN (contoh: Kriptografi, Ide Proyek, Umum).' },
        ringkasan: { type: Type.STRING, description: 'Ringkasan terstruktur dalam format bullet points (- Poin 1\\n- Poin 2) untuk SIMPAN_CATATAN.' },
        budget: { type: Type.INTEGER, description: 'Batas anggaran dalam Rupiah (integer) untuk REKOMENDASI_PACAR jika disebut (misal 200rb -> 200000).' },
        hari: { type: Type.STRING, description: 'Nama hari Indonesia: Senin, Selasa, Rabu, Kamis, Jumat, Sabtu, Minggu.' },
        tanggal: { type: Type.STRING, description: 'Tanggal format YYYY-MM-DD.' },
        tanggal_mulai: { type: Type.STRING, description: 'Tanggal awal rentang query format YYYY-MM-DD.' },
        tanggal_akhir: { type: Type.STRING, description: 'Tanggal akhir rentang query format YYYY-MM-DD.' },
        jam: { type: Type.STRING, description: 'Jam format 24-jam HH:MM.' },
        is_rutin: { type: Type.BOOLEAN, description: 'true jika jadwal berulang mingguan, false jika sekali jalan.' },
        is_presensi: {
          type: Type.BOOLEAN,
          description: 'true HANYA jika ini jadwal presensi/absen/kuliah/kelas/praktikum/KRS yang harus diingatkan berulang tiap 20 menit sampai dibalas "ok". false untuk alarm biasa / pengingat kegiatan biasa (eksperimen, percobaan, rapat, bimbingan, bangun pagi, minum obat, dll) yang cukup berbunyi 1x.',
        },
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
              is_presensi: { type: Type.BOOLEAN },
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

export function isGeminiApiConfigured() {
  return Boolean(getClient());
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
    "judul": "string (nama jadwal/tugas/catatan kuliah/wishlist/momen)",
    "matkul": "string (nama matkul jika relevan)",
    "kategori": "string (mata kuliah atau 'Ide Proyek'/'Umum' khusus SIMPAN_CATATAN/CARI_CATATAN)",
    "ringkasan": "string (poin-poin terstruktur format '- Poin 1\\n- Poin 2' khusus SIMPAN_CATATAN)",
    "budget": integer_rupiah_opsional_khusus_REKOMENDASI_PACAR,
    "hari": "Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu (jika relevan)",
    "tanggal": "YYYY-MM-DD (jika relevan)",
    "tanggal_mulai": "YYYY-MM-DD (untuk rentang query)",
    "tanggal_akhir": "YYYY-MM-DD (untuk rentang query)",
    "jam": "HH:MM format 24 jam (jika relevan)",
    "is_rutin": true/false,
    "is_presensi": true/false (true HANYA untuk jadwal presensi/absen/kuliah/kelas/praktikum/KRS; false untuk alarm biasa/pengingat kegiatan umum),
    "menit_tunda": integer,
    "isi_catatan": "string (ringkasan memori / detail wishlist / isi link/teks bersih untuk vault)",
    "kata_kunci": "string (judul singkat Title Case 2-4 kata untuk vault / keyword pencarian)",
    "nama_baru": "string (khusus UBAH_VAULT)",
    "tipe_item": "WISHLIST|MOMEN|LINK|FILE",
    "ulang": "TAHUNAN|BULANAN|SEKALI",
    "expenses": [{ "item": "string", "nominal": integer_rupiah, "kategori": "Makan & Minum|Transportasi|Akademik|Hiburan|Uang Saku|Gaji & Freelance|Beasiswa|Hadiah & Bonus|Lainnya" }],
    "schedules": [{ "judul": "string", "hari": "string", "tanggal": "YYYY-MM-DD", "jam": "HH:MM", "is_rutin": true/false, "is_presensi": true/false }],
    "tasks": [{ "judul": "string", "matkul": "string", "tanggal": "YYYY-MM-DD", "jam": "HH:MM" }]
  }
}
Sertakan hanya field payload yang relevan (selalu isi kata_kunci & isi_catatan untuk SIMPAN_VAULT; selalu isi judul, kategori & ringkasan bullet points untuk SIMPAN_CATATAN).`;

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
  isFallback = false,
}) {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY belum dikonfigurasi.');
  }

  const t0 = Date.now();
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
      safeRecordAiLog({
        provider: 'GROQ',
        status: isFallback ? 'FALLBACK' : 'SUCCESS',
        latency_ms: Date.now() - t0,
        model: entry.model,
      });
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

  safeRecordAiLog({
    provider: 'GROQ',
    status: 'ERROR',
    latency_ms: Date.now() - t0,
    model: order[0]?.model || GROQ_TEXT_CHAIN[0].model,
  });

  throw lastErr || new Error('Semua model Groq sedang sibuk.');
}

async function transcribeAudioWithGroq(mediaBuffer, mimeType, fileName) {
  const apiKey = getGroqApiKey();
  if (!apiKey || !mediaBuffer) return null;

  const t0 = Date.now();
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
        safeRecordAiLog({
          provider: 'GROQ',
          status: 'SUCCESS',
          latency_ms: Date.now() - t0,
          model,
        });
        return transcript;
      }
    } catch (err) {
      modelCooldownUntil.set(cooldownKey, Date.now() + getCooldownDuration(err, 'groq'));
      if (Number(err?.status) === 401 || Number(err?.status) === 403) break;
    }
  }
  safeRecordAiLog({
    provider: 'GROQ',
    status: 'ERROR',
    latency_ms: Date.now() - t0,
    model: GROQ_WHISPER_MODELS[0],
  });
  return null;
}

async function analyzeWithGroq({
  promptText,
  imageBuffer = null,
  imageMimeType = null,
  nowParts,
  lastReminder,
  isFallback = false,
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
    maxTokens: 950,
    isFallback,
  });

  return parseJsonIntentResult(rawText, 'Groq');
}

async function analyzeWithGemini({
  promptText,
  mediaBuffer = null,
  mimeType = null,
  nowParts,
  lastReminder,
  isFallback = false,
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

  const response = await generateWithFallback(
    client,
    (model) => ({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: buildSystemInstruction(nowParts, lastReminder),
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.2,
      },
    }),
    { isFallback }
  );

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
1. TAMBAH_JADWAL: Pengguna meminta diingatkan jadwal kuliah/presensi/kegiatan rutin mingguan ("tiap Selasa jam 07.50") atau alarm/pengingat sekali jalan ("besok jam 14.00 mulai percobaan Unet", "nanti jam 19.30 rapat", "pasang alarm jam 05.30"), atau mengirim screenshot KRS/jadwal kuliah.
   - Jika rutin mingguan: is_rutin = true, isi hari (Senin-Minggu) & jam (HH:MM).
   - Jika sekali jalan: is_rutin = false, isi tanggal (YYYY-MM-DD) & jam (HH:MM).
   - WAJIB BEDAKAN ALARM PRESENSI vs ALARM BIASA lewat field payload.is_presensi:
     * Set is_presensi = true HANYA untuk jadwal PRESENSI / ABSEN / KULIAH / MATA KULIAH / KELAS / PRAKTIKUM / screenshot KRS (ini akan berulang tiap 20 menit sampai pengguna balas "ok").
     * Set is_presensi = false untuk ALARM BIASA / PENGINGAT KEGIATAN BIASA (contoh: "mulai percobaan Unet/DeepLab", "alarm bangun pagi", "rapat organisasi", "bimbingan skripsi", "minum obat", "olahraga", "bayar kos", "nonton"). Alarm biasa hanya berbunyi 1 kali tanpa pengulangan "ok"!
   - Jika gambar/teks memuat banyak jadwal sekaligus (misal KRS), isi array payload.schedules (dan sertakan is_presensi di tiap item)!
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
8. TAMBAH_WISHLIST_MOMEN: Pengguna menyimpan keinginan/wishlist pacar ("Masukin wishlist dia: tas selempang warna krem", atau dari screenshot barang) ATAU menyimpan tanggal penting/spesial/tanggal lahir ("pacarku lahir 12 desember 2003", "Ulang tahun dia 14 Mei", "Anniversary kita 17 Agustus 2024", "Ingetin tanggal jadian 24 tiap bulan").
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
14. TAMBAH_REMINDER: Pengingat cepat berbasis durasi ("ingetin 30 menit lagi matiin kompor", "ingatkan 2 jam lagi bayar kos"). Isi payload.menit_tunda (integer menit) & payload.judul (pesan pengingat).
15. REKOMENDASI_PACAR: Pengguna meminta rekomendasi tempat kencan/date ("Weekend ini enaknya ngajak dia ke mana?", "Saran tempat nongkrong buat date") atau rekomendasi kado/hadiah buat pacar ("Kasih rekomendasi kado buat dia di bawah 200rb", "Ide hadiah buat ultah pacar").
    - Isi payload.kata_kunci dengan konteks permintaan user.
    - Jika disebutkan batas anggaran/budget (misal "di bawah 200rb"), isi payload.budget sebagai integer Rupiah (200000).
15B. IDE_PACAR: Khusus untuk rangkuman/rekap kenangan bulanan pacar ("rekap memori bulan ini"). Isi payload.kata_kunci = "REKAP".
16. SIMPAN_CATATAN: Pengguna mengirim Voice Note, foto papan tulis/slide kuliah, atau teks materi/ide untuk dirangkum menjadi Catatan Kuliah atau Ide Proyek (misal "Rangkumin jadi catatan kuliah Kriptografi", "Catat ide proyek aplikasi kasir", atau foto slide/papan tulis dengan caption rangkum/catat).
    - Isi payload.judul (judul ringkas & jelas), payload.kategori (nama mata kuliah seperti "Kriptografi" atau "Ide Proyek" / "Umum"), dan payload.ringkasan berupa poin-poin terstruktur yang rapi menggunakan format bullet points ("- Poin 1\\n- Poin 2\\n- Poin 3").
17. CARI_CATATAN: Pengguna ingin mencari atau melihat catatan kuliah/ide yang tersimpan ("Cari catatan kuliah Kriptografi tentang enkripsi", "Lihat catatan kuliah", "Cek catatan ide proyek").
    - Isi payload.kata_kunci dengan kata kunci pencarian (atau "SEMUA" jika minta daftar semua catatan) dan payload.kategori jika mata kuliah disebut.
18. HABIT_CHECKIN: Pengguna melaporkan sudah menyelesaikan habit harian ("udah olahraga hari ini", "habit ngoding selesai"). Isi payload.kata_kunci dengan nama habit.
19. MULAI_FOKUS: Pengguna ingin memulai sesi fokus / Pomodoro ("mulai fokus 25 menit belajar PCD"). Isi payload.menit_tunda (durasi menit, default 25) & payload.judul (topik fokus).
20. OBROLAN_BIASA: Sapaan, pertanyaan umum, atau obrolan santai yang tidak masuk kategori di atas.

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
    let geminiTried = false;
    if (hasGemini) {
      geminiTried = true;
      try {
        return await analyzeWithGemini({
          promptText,
          mediaBuffer: effectiveMediaBuffer,
          mimeType: effectiveMimeType,
          nowParts,
          lastReminder,
          isFallback: false,
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
          isFallback: geminiTried,
        });
      } catch (err) {
        errors.push(`Groq: ${err.message}`);
      }
    }
  } else {
    // 3B. Text, Voice Note (transcribed), Image, or Generic Document:
    // Prefer Groq first (ultra-fast < 1s), seamlessly fallback to Gemini (gemini-3.8-flash)!
    const canUseGroqImage = isImage && effectiveMediaBuffer && effectiveMediaBuffer.length <= 4 * 1024 * 1024;
    const canUseGroqHere = hasGroq && (!effectiveMediaBuffer || canUseGroqImage || !isGeminiSupportedMime(effectiveMimeType));

    let groqTried = false;
    if (canUseGroqHere) {
      groqTried = true;
      try {
        return await analyzeWithGroq({
          promptText,
          imageBuffer: canUseGroqImage ? effectiveMediaBuffer : null,
          imageMimeType: canUseGroqImage ? effectiveMimeType : null,
          nowParts,
          lastReminder,
          isFallback: false,
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
          isFallback: groqTried,
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

  const prompt = `Hari ini: ${nowParts.display}.
Pertanyaan pengguna: "${userQuestion}"

Data catatan aktivitas PACAR pengguna (dari Brankas Memori):
${formattedRows}

ATURAN JAWABAN:
- Seluruh data di atas adalah catatan aktivitas/cerita PACAR pengguna (gunakan kata ganti "dia" atau "pacarmu"), BUKAN aktivitas pengguna sendiri.
- JANGAN pernah menyebut "Anda telah..." atau mengira itu aktivitas pengguna.
- Sapa pengguna secara santai dengan "kamu" (jangan kaku dengan "Anda").
- Jawab singkat, hangat, dan akurat hanya berdasarkan data di atas, serta sertakan hari & tanggalnya dengan jelas.`;

  const sysMsg =
    'Kamu adalah asisten pribadi yang hangat, santai, dan akurat dalam bahasa Indonesia. Semua catatan dari Brankas Memori adalah tentang PACAR pengguna ("dia" / "pacarmu"), bukan tentang pengguna sendiri.';

  let groqTried = false;
  if (isGroqConfigured()) {
    groqTried = true;
    try {
      const answer = await callGroqChat({
        messages: [
          { role: 'system', content: sysMsg },
          { role: 'user', content: prompt },
        ],
        chain: GROQ_TEXT_CHAIN,
        jsonMode: false,
        temperature: 0.3,
        maxTokens: 350,
        isFallback: false,
      });
      if (answer) return answer;
    } catch {
      // Fallback to Gemini
    }
  }

  const client = getClient();
  if (!client) {
    return `Berikut catatan memori pacarmu yang ditemukan:\n${formattedRows}`;
  }

  try {
    const response = await generateWithFallback(
      client,
      (model) => ({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction: sysMsg,
          temperature: 0.3,
        },
      }),
      { isFallback: groqTried }
    );
    return (response.text || '').trim() || `Berikut catatan memori pacarmu yang ditemukan:\n${formattedRows}`;
  } catch {
    return `Berikut catatan memori pacarmu yang ditemukan:\n${formattedRows}`;
  }
}

/**
 * Helper to generate natural text via Groq (primary) -> Gemini (fallback).
 */
async function generateFreeformText(systemPrompt, userPrompt, fallbackText, maxTokens = 650) {
  let groqTried = false;
  if (isGroqConfigured()) {
    groqTried = true;
    try {
      const text = await callGroqChat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        chain: GROQ_TEXT_CHAIN,
        jsonMode: false,
        temperature: 0.55,
        maxTokens,
        isFallback: false,
      });
      if (text) return text;
    } catch {
      // Fallback to Gemini
    }
  }

  const client = getClient();
  if (client) {
    try {
      const response = await generateWithFallback(
        client,
        (model) => ({
          model,
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.55,
            maxOutputTokens: maxTokens,
          },
        }),
        { isFallback: groqTried }
      );
      const out = (response.text || '').trim();
      if (out) return out;
    } catch {
      // fallback below
    }
  }
  return fallbackText;
}

/**
 * Feature 5A: Generate personalized gift or date ideas based on partner's Memories & Wishlist.
 */
export async function generatePartnerIdeas(userPrompt = 'ide kado dan ide date untuk pacar', { memories = [], wishlists = [], moments = [] } = {}, now = new Date()) {
  const nowParts = getWibParts(now);

  const memLines = memories.slice(0, 20).map((m) => `- [${m.tanggal}] ${m.isi}${m.deskripsi ? ` (${m.deskripsi})` : ''}`).join('\n') || '- Belum ada catatan memori.';
  const wishLines = wishlists.filter((w) => !w.terpenuhi).slice(0, 15).map((w) => `- ${w.judul}${w.catatan ? ` (${w.catatan})` : ''}`).join('\n') || '- Belum ada wishlist aktif.';
  const momentLines = moments.slice(0, 5).map((m) => `- ${m.judul} (${m.next_date || m.tanggal}, H-${m.days_until ?? '?'})`).join('\n') || '- Tidak ada momen dekat.';

  const sysMsg =
    'Kamu adalah asisten pribadi yang hangat, kreatif, dan perhatian dalam bahasa Indonesia. Berikan rekomendasi kado atau ide kencan/date yang benar-benar personal dengan mengaitkan detail nyata dari Brankas Memori dan Wishlist pacar pengguna. Format rapi dengan poin singkat tanpa bertele-tele.';

  const prompt = `Tanggal hari ini: ${nowParts.display}.
Permintaan pengguna: "${userPrompt}"

WISHLIST PACAR (belum terpenuhi):
${wishLines}

CATATAN MEMORI PACAR TERBARU:
${memLines}

MOMEN SPESIAL TERDEKAT:
${momentLines}

Berikan 3 sampai 5 rekomendasi ide kado atau ide date yang kreatif, realistis untuk mahasiswa, dan nyambung dengan detail memori/wishlist di atas. Jelaskan singkat kenapa ide tersebut cocok buat dia.`;

  const fallback =
    `Berikut ringkasan wishlist aktif yang bisa jadi inspirasi kado:\n${wishLines}\n\nCatatan terbaru tentang dia:\n${memLines}`;

  return generateFreeformText(sysMsg, prompt, fallback, 600);
}

/**
 * Feature 5B: Monthly Partner Memories Recap (on-demand or triggered automatically on monthly mensiversary!).
 */
export async function generateMonthlyPartnerRecap(memories = [], momentTitle = 'Bulan Ini', now = new Date()) {
  const nowParts = getWibParts(now);
  if (!memories.length) {
    return `Belum ada catatan memori pacar dalam 30 hari terakhir untuk dirangkum (${momentTitle}). Yuk mulai catat momen seru dengan */p <cerita>*!`;
  }

  const memLines = memories
    .slice(0, 30)
    .map((m) => `- [${m.hari}, ${m.tanggal}] ${m.isi}${m.deskripsi ? ` — ${m.deskripsi}` : ''}`)
    .join('\n');

  const sysMsg =
    'Kamu adalah asisten pribadi yang hangat dan santai dalam bahasa Indonesia. Buat rangkuman bulanan kenangan pacar pengguna ("dia" / "pacarmu", sapa pengguna dengan "kamu") secara menyentuh, ringkas, dan akurat berdasarkan catatan nyata.';

  const prompt = `Hari ini: ${nowParts.display}.
Konteks rekap: ${momentTitle}.

Catatan memori pacar selama 30 hari terakhir (${memories.length} catatan):
${memLines}

Susun rekap hangat berisi:
1. Sorotan momen terbaik & hal penting yang dialami pacarmu bulan ini.
2. Hal-hal kecil/kebiasaan/kesukaan dia yang muncul di catatan.
3. 1 kalimat penutup singkat yang hangat untuk merayakan kebersamaan kalian.`;

  const fallback = `💝 *Rekap Memori Pacar (${memories.length} catatan terbaru):*\n${memLines}`;
  return generateFreeformText(sysMsg, prompt, fallback, 550);
}

/**
 * FITUR 3: Smart Date & Gift Planner (REKOMENDASI_PACAR)
 * Uses latest 15 rows from memori_pacar + all unfulfilled (terpenuhi = 0) rows from momen_wishlist.
 */
export async function generatePartnerRecommendation(
  {
    prompt = '',
    mode = 'auto', // 'date' | 'gift' | 'auto'
    budget = null,
    memories = [],
    wishlists = [],
    moments = [],
    noEmoji = false,
  } = {},
  now = new Date()
) {
  const nowParts = getWibParts(now);
  const latestMemories = memories.slice(0, 15);
  const unfulfilledWish = wishlists.filter((w) => !w.terpenuhi && w.tipe !== 'MOMEN');
  const unfulfilledMoments = moments.filter((m) => !m.terpenuhi);

  const memLines =
    latestMemories
      .map((m) => `- [${m.hari}, ${m.tanggal}] ${m.isi}${m.deskripsi ? ` (${m.deskripsi})` : ''}`)
      .join('\n') || '- Belum ada catatan memori pacar.';
  const wishLines =
    unfulfilledWish
      .map((w) => `- ${w.judul}${w.catatan ? ` (${w.catatan})` : ''}`)
      .join('\n') || '- Belum ada wishlist aktif.';
  const momentLines =
    unfulfilledMoments
      .slice(0, 6)
      .map((m) => `- ${m.judul} (${m.next_date || m.tanggal || '-'}${m.days_until != null ? `, H-${m.days_until}` : ''})`)
      .join('\n') || '- Tidak ada momen spesial terdekat.';

  const parsedBudget = Number(budget);
  const budgetText =
    Number.isFinite(parsedBudget) && parsedBudget > 0
      ? `Rp ${Math.round(parsedBudget).toLocaleString('id-ID')}`
      : 'Fleksibel (ramah kantong mahasiswa)';

  const effectivePrompt =
    String(prompt || '').trim() ||
    (mode === 'date'
      ? 'Berikan rekomendasi ide kencan weekend yang seru dan segar untuk pacar saya.'
      : mode === 'gift'
        ? 'Berikan rekomendasi hadiah/kado terbaik untuk pacar saya berdasarkan wishlist dan memorinya.'
        : 'Berikan rekomendasi ide kencan atau hadiah terbaik untuk pacar saya.');

  const focusDirective =
    mode === 'date'
      ? 'Fokus utama: 3-4 rekomendasi IDE KENCAN / TEMPAT DATE WEEKEND yang segar. WAJIB hindari tempat atau aktivitas yang baru saja dikunjungi/dilakukan pada catatan memori terbaru di atas!'
      : mode === 'gift'
        ? 'Fokus utama: 3-5 rekomendasi HADIAH / KADO yang memprioritaskan wishlist yang belum terpenuhi dan selaras dengan selera pacar di memori terbaru serta batas budget.'
        : 'Analisis pertanyaan pengguna apakah meminta ide kencan/tempat date (wajib hindari tempat yang baru saja dikunjungi di memori terbaru) atau rekomendasi kado/hadiah (prioritaskan wishlist belum terpenuhi & sesuaikan budget).';

  const sysMsg =
    `Kamu adalah asisten pribadi cerdas dan perhatian dalam bahasa Indonesia. Sapa pengguna dengan "kamu" dan sebut pacar pengguna sebagai "dia" atau "pacarmu". ${
      noEmoji ? 'WAJIB: Jangan gunakan emoji atau simbol ikon unicode sama sekali, cukup teks rapi dan bullet points "-".' : ''
    }`;

  const userPrompt = `Waktu sekarang: ${nowParts.display}.
Permintaan pengguna: "${effectivePrompt}"
Batas Budget: ${budgetText}

15 MEMORI PACAR TERBARU (perhatikan tempat/aktivitas yang baru dikunjungi agar tidak diulang):
${memLines}

WISHLIST BELUM TERPENUHI (terpenuhi = 0):
${wishLines}

MOMEN SPESIAL AKTIF:
${momentLines}

INSTRUKSI:
- ${focusDirective}
- Jika budget disebutkan (${budgetText}), pastikan setiap ide menyertakan estimasi biaya yang masuk akal dan berada dalam batas budget tersebut.
- Berikan format poin-poin terstruktur yang ringkas, jelas, dan menyertakan alasan personal dari data memori/wishlist di atas.${
    noEmoji ? '\n- Jangan gunakan emoji sama sekali.' : ''
  }`;

  const fallback =
    `Rekomendasi Berdasarkan Data Memori & Wishlist:\n` +
    `Budget: ${budgetText}\n\n` +
    `Wishlist Belum Terpenuhi:\n${wishLines}\n\n` +
    `Catatan Memori Terbaru:\n${memLines}`;

  return generateFreeformText(sysMsg, userPrompt, fallback, 750);
}

/**
 * FITUR 2: Live AI Engine Diagnostic (Gemini 3.8 Flash <-> Groq Companion/Fallback)
 * Tests both providers independently and logs latency/status into ai_logs.
 */
export async function testAiEngines() {
  const client = getClient();
  const groqKey = getGroqApiKey();

  const testGemini = async () => {
    if (!client) {
      return {
        configured: false,
        ok: false,
        status: 'UNCONFIGURED',
        model: PRIMARY_GEMINI_MODEL,
        latencyMs: 0,
        error: 'GEMINI_API_KEY belum diatur',
      };
    }

    const candidates = [
      { model: PRIMARY_GEMINI_MODEL, thinkingLevel: ThinkingLevel.LOW, isFallback: false },
      { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL, isFallback: true },
    ];

    let lastErr = null;
    for (const c of candidates) {
      const t0 = Date.now();
      try {
        const res = await client.models.generateContent({
          model: c.model,
          contents: [{ role: 'user', parts: [{ text: 'Balas tepat satu kata: OK' }] }],
          config: {
            maxOutputTokens: 16,
            temperature: 0,
            thinkingConfig: { thinkingLevel: c.thinkingLevel },
            abortSignal: AbortSignal.timeout(6500),
          },
        });
        const latencyMs = Date.now() - t0;
        const reply = String(res.text || 'OK').trim().slice(0, 40);
        const status = c.isFallback ? 'FALLBACK' : 'SUCCESS';
        safeRecordAiLog({ provider: 'GEMINI', status, latency_ms: latencyMs, model: c.model });
        return {
          configured: true,
          ok: true,
          status,
          model: c.model,
          primaryModel: PRIMARY_GEMINI_MODEL,
          latencyMs,
          reply,
          error: lastErr ? `Primary ${PRIMARY_GEMINI_MODEL} lambat/error (${lastErr.message}), fallback berhasil` : null,
        };
      } catch (err) {
        lastErr = err;
        safeRecordAiLog({
          provider: 'GEMINI',
          status: 'ERROR',
          latency_ms: Date.now() - t0,
          model: c.model,
        });
      }
    }

    return {
      configured: true,
      ok: false,
      status: 'ERROR',
      model: PRIMARY_GEMINI_MODEL,
      latencyMs: 0,
      error: lastErr?.message || 'Gemini tidak merespons',
    };
  };

  const testGroq = async () => {
    if (!groqKey) {
      return {
        configured: false,
        ok: false,
        status: 'UNCONFIGURED',
        model: GROQ_TEXT_CHAIN[0].model,
        latencyMs: 0,
        error: 'GROQ_API_KEY belum diatur',
      };
    }

    let lastErr = null;
    for (let i = 0; i < Math.min(2, GROQ_TEXT_CHAIN.length); i += 1) {
      const entry = GROQ_TEXT_CHAIN[i];
      const t0 = Date.now();
      try {
        const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${groqKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: entry.model,
            messages: [{ role: 'user', content: 'Balas tepat satu kata: OK' }],
            max_tokens: 16,
            temperature: 0,
            ...(entry.reasoning_effort ? { reasoning_effort: entry.reasoning_effort } : {}),
          }),
          signal: AbortSignal.timeout(6500),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error?.message || `HTTP ${res.status}`);
        }
        const latencyMs = Date.now() - t0;
        const reply = String(data?.choices?.[0]?.message?.content || 'OK').trim().slice(0, 40);
        const status = i > 0 ? 'FALLBACK' : 'SUCCESS';
        safeRecordAiLog({ provider: 'GROQ', status, latency_ms: latencyMs, model: entry.model });
        return {
          configured: true,
          ok: true,
          status,
          model: entry.model,
          latencyMs,
          reply,
          error: null,
        };
      } catch (err) {
        lastErr = err;
        safeRecordAiLog({
          provider: 'GROQ',
          status: 'ERROR',
          latency_ms: Date.now() - t0,
          model: entry.model,
        });
      }
    }

    return {
      configured: true,
      ok: false,
      status: 'ERROR',
      model: GROQ_TEXT_CHAIN[0].model,
      latencyMs: 0,
      error: lastErr?.message || 'Groq tidak merespons',
    };
  };

  const [gemini, groq] = await Promise.all([testGemini(), testGroq()]);
  const fallbackReady = Boolean(gemini.ok && groq.ok);

  let summary = 'Semua jalur AI tidak tersedia.';
  if (fallbackReady) {
    summary = `Jalur ganda aktif: Gemini (${gemini.model}, ${gemini.latencyMs}ms) & Groq (${groq.model}, ${groq.latencyMs}ms).`;
  } else if (groq.ok) {
    summary = `Groq aktif (${groq.latencyMs}ms); Gemini sedang gangguan/fallback (${gemini.error || gemini.status}).`;
  } else if (gemini.ok) {
    summary = `Gemini aktif (${gemini.latencyMs}ms); Groq sedang gangguan (${groq.error || groq.status}).`;
  }

  return {
    testedAt: getWibParts().display,
    gemini,
    groq,
    fallbackReady,
    summary,
  };
}
