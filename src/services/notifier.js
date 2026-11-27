import * as webpush from 'web-push';
import { MACRODROID_RING_TAG, pushRepo, settingsRepo, stateRepo } from '../config/db.js';
import { getWibParts } from '../utils/time.js';

let vapidConfigured = false;
let waSenderFn = null;
let targetWaSenderFn = null;
let ntfyPublisherFn = null;
let lastReminderCache = null;

export function initWebPush() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || 'mailto:admin@localhost').trim();

  if (publicKey && privateKey) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      vapidConfigured = true;
      console.log('[Notifier] Web Push VAPID configured.');
    } catch (err) {
      vapidConfigured = false;
      console.error('[Notifier] Invalid VAPID keys:', err.message);
    }
  } else {
    vapidConfigured = false;
    console.warn('[Notifier] VAPID keys not set. Browser push notifications are disabled.');
  }

  // Restore last reminder from SQLite on startup
  lastReminderCache = stateRepo.getJson('last_reminder', null);
  return vapidConfigured;
}

export function isWebPushConfigured() {
  return vapidConfigured;
}

export function registerWhatsAppSender(fn) {
  waSenderFn = fn;
}

export function registerTargetWhatsAppSender(fn) {
  targetWaSenderFn = fn;
}

export async function sendWhatsAppToTarget(phoneNumber, text) {
  if (typeof targetWaSenderFn !== 'function') {
    throw new Error('WhatsApp belum siap mengirim pesan ke nomor tujuan.');
  }
  return targetWaSenderFn(phoneNumber, text);
}

export function registerNtfyPublisher(fn) {
  ntfyPublisherFn = fn;
}

function stripWaMarkdown(str = '') {
  return String(str || '')
    .replace(/[*_`]/g, '')
    .trim();
}

/**
 * Publish an Urgent (priority 5) alert to ntfy so Android ntfy app rings continuously like an alarm/call.
 */
export async function sendNtfyUrgentAlert({
  title,
  body,
  priority = 5,
  tags = ['alarm_clock', 'rotating_light'],
}) {
  const settings = settingsRepo.getNotificationSettings();
  if (!settings.ntfyEnabled || !settings.ntfyTopic) {
    return { sent: false, skipped: true, topic: settings.ntfyTopic || null };
  }

  const serverUrl = String(settings.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
  const payload = {
    topic: settings.ntfyTopic,
    title: stripWaMarkdown(title) || 'Alarm Personal Assistant',
    message: stripWaMarkdown(body) || 'Waktunya pengingat!',
    priority: Math.max(1, Math.min(5, Number(priority) || 5)),
    tags,
  };

  if (typeof ntfyPublisherFn === 'function') {
    try {
      await ntfyPublisherFn(payload, serverUrl);
      return { sent: true, skipped: false, topic: settings.ntfyTopic, priority: payload.priority };
    } catch (err) {
      return { sent: false, skipped: false, topic: settings.ntfyTopic, error: err?.message || String(err) };
    }
  }

  try {
    const res = await fetch(`${serverUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(errText || `ntfy HTTP ${res.status}`);
    }
    return { sent: true, skipped: false, topic: settings.ntfyTopic, priority: payload.priority };
  } catch (err) {
    console.error('[Notifier] ntfy delivery failed:', err?.message || err);
    return { sent: false, skipped: false, topic: settings.ntfyTopic, error: err?.message || String(err) };
  }
}

export function setLastReminder({ title, body, activityName }) {
  const entry = {
    title: title || '',
    body: body || '',
    activityName: activityName || title || 'Pengingat',
    timestamp: getWibParts().display,
  };
  lastReminderCache = entry;
  stateRepo.setJson('last_reminder', entry);
  return entry;
}

export function getLastReminder() {
  if (!lastReminderCache) {
    lastReminderCache = stateRepo.getJson('last_reminder', null);
  }
  return lastReminderCache;
}

/**
 * Send Web Push notification to all stored subscriptions.
 * Automatically prunes expired (HTTP 410 / 404) subscriptions.
 */
export async function sendWebPushNotification(title, body, url = '/', tag = null) {
  if (!vapidConfigured) {
    return { sent: 0, failed: 0, removed: 0, skipped: true };
  }

  const subscriptions = pushRepo.list();
  if (!subscriptions.length) {
    return { sent: 0, failed: 0, removed: 0, skipped: false };
  }

  const payload = JSON.stringify({
    title,
    body,
    url,
    tag: tag || `assistant-${Date.now()}`,
  });

  let sent = 0;
  let failed = 0;
  let removed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys_p256dh,
          auth: sub.keys_auth,
        },
      };

      try {
        await webpush.sendNotification(pushSubscription, payload, { TTL: 3600 });
        sent += 1;
      } catch (err) {
        failed += 1;
        const statusCode = err?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushRepo.removeByEndpoint(sub.endpoint);
          removed += 1;
          console.log(`[Notifier] Removed expired push subscription (${statusCode}).`);
        } else {
          console.error('[Notifier] Push delivery error:', err?.message || err);
        }
      }
    })
  );

  return { sent, failed, removed, skipped: false };
}

/**
 * Centralized Dual-Channel Notification Engine (PRD Section 6.1):
 * 1. Sends WhatsApp message to NOMOR_UTAMA and saves lastReminder for Snooze support.
 * 2. Sends Web Push notification to all subscribed browsers / PWA Service Workers.
 */
export async function sendDualNotification(title, body, url = '/', options = {}) {
  const { recordForSnooze = true, activityName = null, tag = null, ringLoud = false } = options;

  if (recordForSnooze) {
    setLastReminder({
      title,
      body,
      activityName: activityName || title,
    });
  }

  const waPrefix = ringLoud ? `${MACRODROID_RING_TAG}\n` : '';
  const waResult = { sent: false, error: null };
  if (typeof waSenderFn === 'function') {
    try {
      await waSenderFn(`${waPrefix}*${title}*\n${body}`);
      waResult.sent = true;
    } catch (err) {
      waResult.error = err?.message || String(err);
      console.error('[Notifier] WhatsApp delivery failed:', waResult.error);
    }
  } else {
    waResult.error = 'WhatsApp sender not registered';
  }

  const pushTitle = ringLoud ? `${MACRODROID_RING_TAG} ${title}` : title;
  const [webPushResult, ntfyResult] = await Promise.all([
    sendWebPushNotification(pushTitle, body, url, tag),
    ringLoud
      ? sendNtfyUrgentAlert({ title, body, priority: 5 })
      : Promise.resolve({ sent: false, skipped: true }),
  ]);

  return {
    whatsapp: waResult,
    webPush: webPushResult,
    ntfy: ntfyResult,
    ringLoud: Boolean(ringLoud),
  };
}

/**
 * Send a direct loud ring test alert (WhatsApp [ALARM-RING] + ntfy Urgent priority 5 + Web Push).
 */
export async function sendRingTestNotification(label = 'Test Dering Keras HP (ntfy Urgent)') {
  const parts = getWibParts();
  return sendDualNotification(
    `🔔 ${label}`,
    `Sinyal dering keras (WA + ntfy Urgent) dikirim pada *${parts.display}*.\nJika ntfy sudah terpasang dengan "Keep alerting for highest priority", HP akan berdering keras terus-menerus sekarang!`,
    '/#jadwal',
    {
      recordForSnooze: false,
      tag: `ring-test-${Date.now()}`,
      ringLoud: true,
    }
  );
}
