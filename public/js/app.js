/* ==================== STATE & HELPERS ==================== */
const state = {
  activeTab: 'overview',
  jadwalFilter: 'all',
  tugasFilter: '0',
  vaultFilter: 'all',
  financeFilter: 'all',
  financeChartMode: 'PEMASUKAN',
  financePeriod: 'this_month',
  financePeriodLabel: '',
  financePeriodQuery: '',
  auditFilter: 'all',
  habitData: null,
  reminderList: [],
  focusData: null,
  focusPreset: 25,
  focusTickTimer: null,
  spotlightTimer: null,
  jadwalList: [],
  tugasList: [],
  catatanList: [],
  catatanCategories: [],
  catatanCategory: 'all',
  activeCatatanDetail: null,
  telemetryData: null,
  calendarInfo: null,
  lastPacarRecText: '',
  memoriList: [],
  wishlistList: [],
  vaultList: [],
  expenseData: null,
  statusData: null,
  notifSettings: null,
  statusPollTimer: null,
  eventSource: null,
  sseConnected: false,
  renderCache: {},
  authenticated: false,
  pinRequired: false,
  pushSubscribed: false,
};

const CATEGORY_COLORS_DARK = {
  'Makan & Minum': '#ffffff',
  Transportasi: '#d4d4d8',
  Akademik: '#a1a1aa',
  Hiburan: '#71717a',
  'Uang Saku': '#ffffff',
  'Gaji & Freelance': '#d4d4d8',
  Beasiswa: '#a1a1aa',
  'Hadiah & Bonus': '#71717a',
  Lainnya: '#3f3f46',
};

const CATEGORY_COLORS_LIGHT = {
  'Makan & Minum': '#09090b',
  Transportasi: '#3f3f46',
  Akademik: '#71717a',
  Hiburan: '#a1a1aa',
  'Uang Saku': '#09090b',
  'Gaji & Freelance': '#3f3f46',
  Beasiswa: '#71717a',
  'Hadiah & Bonus': '#a1a1aa',
  Lainnya: '#d4d4d8',
};

function getCurrentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function getCategoryColors() {
  return getCurrentTheme() === 'dark' ? CATEGORY_COLORS_DARK : CATEGORY_COLORS_LIGHT;
}

function applyTheme(theme, persist = true) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  const meta = $('#meta-theme-color');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#161618' : '#f5f5f7');
  if (persist) {
    try {
      localStorage.setItem('assistant_sonoma_theme', next);
    } catch {
      // ignore storage errors
    }
  }
  const btn = $('#btn-toggle-theme');
  if (btn) {
    const isDark = next === 'dark';
    btn.title = isDark ? 'Ubah ke macOS Sonoma Light' : 'Ubah ke macOS Sonoma Dark';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = `<i data-lucide="${isDark ? 'sun' : 'moon'}" class="icon-15"></i>`;
    renderIcons();
  }
}

function initThemeToggle() {
  applyTheme(getCurrentTheme(), false);
  $('#btn-toggle-theme')?.addEventListener('click', () => {
    applyTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark', true);
  });
}

const EXPENSE_CATEGORIES = ['Makan & Minum', 'Transportasi', 'Akademik', 'Hiburan', 'Lainnya'];
const INCOME_CATEGORIES = ['Uang Saku', 'Gaji & Freelance', 'Beasiswa', 'Hadiah & Bonus', 'Lainnya'];

const HARI_BACKUP_LABELS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let iconRenderQueued = false;
function renderIcons() {
  if (iconRenderQueued) return;
  iconRenderQueued = true;
  requestAnimationFrame(() => {
    iconRenderQueued = false;
    if (!window.lucide || typeof window.lucide.createIcons !== 'function') return;
    if (!document.querySelector('[data-lucide]')) return;
    window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } });
  });
}

function hasSnapshotChanged(cacheKey, payload) {
  let next = '';
  try {
    next = JSON.stringify(payload);
  } catch {
    return true;
  }
  if (state.renderCache[cacheKey] === next) return false;
  state.renderCache[cacheKey] = next;
  return true;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRupiah(num) {
  return 'Rp ' + Math.round(Number(num) || 0).toLocaleString('id-ID');
}

function formatSignedRupiah(num) {
  const n = Math.round(Number(num) || 0);
  if (n > 0) return '+' + formatRupiah(n);
  if (n < 0) return '-' + formatRupiah(Math.abs(n));
  return formatRupiah(0);
}

function getTodayWibStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function getCurrentMonthWibStr() {
  return getTodayWibStr().slice(0, 7);
}

function toast(message, type = 'info') {
  const container = $('#toast-container');
  const iconName = type === 'success' ? 'check-circle-2' : type === 'error' ? 'alert-circle' : 'info';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon"><i data-lucide="${iconName}" class="icon-16"></i></span><span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  renderIcons();

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s ease';
    setTimeout(() => el.remove(), 260);
  }, 3400);
}

async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = isFormData
    ? { ...(options.headers || {}) }
    : { 'Content-Type': 'application/json', ...(options.headers || {}) };

  const res = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers,
  });

  if (res.status === 401) {
    showPinOverlay();
    throw new Error('Autentikasi PIN diperlukan.');
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    throw new Error(data?.error || `Request gagal (${res.status})`);
  }
  return data;
}

/* ==================== LIVE WIB CLOCK ==================== */
const wibClockFormatter = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function startClock() {
  let lastRendered = '';
  const update = () => {
    const timeStr = wibClockFormatter.format(new Date()).replace(/\./g, ':');
    if (timeStr === lastRendered) return;
    lastRendered = timeStr;
    const el = $('#island-clock');
    if (el) el.textContent = `${timeStr} WIB`;
  };
  update();
  setInterval(update, 10000);
}

/* ==================== NAVIGATION & SLIDING PILL INDICATOR ==================== */
const TAB_ORDER = ['overview', 'jadwal', 'tugas', 'memori', 'catatan', 'vault', 'keuangan'];

function moveSlider(sliderEl, activeBtn, animate = true) {
  if (!sliderEl || !activeBtn) return;
  const width = activeBtn.offsetWidth;
  const left = activeBtn.offsetLeft;
  if (width <= 0) return;

  if (!animate) {
    sliderEl.classList.add('no-transition');
  }

  sliderEl.style.width = `${width}px`;
  sliderEl.style.transform = `translate3d(${left}px, 0, 0)`;
  sliderEl.classList.add('ready');

  if (!animate) {
    // Force layout flush before re-enabling transitions
    void sliderEl.offsetWidth;
    sliderEl.classList.remove('no-transition');
  }
}

function updateNavSliders(animate = true) {
  const activePill = $('.floating-pill-nav .pill-nav-item.active');
  const activeDock = $('.mobile-pill-dock .dock-item.active');
  moveSlider($('#pill-nav-slider'), activePill, animate);
  moveSlider($('#dock-nav-slider'), activeDock, animate);

  if (animate && activePill && typeof activePill.scrollIntoView === 'function') {
    activePill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
}

function switchTab(tabName) {
  const target = TAB_ORDER.includes(tabName) ? tabName : 'overview';
  const prevIdx = TAB_ORDER.indexOf(state.activeTab);
  const nextIdx = TAB_ORDER.indexOf(target);
  const directionClass =
    nextIdx > prevIdx ? 'slide-from-right' : nextIdx < prevIdx ? 'slide-from-left' : '';

  state.activeTab = target;

  $$('.tab-panel').forEach((p) => {
    const isTarget = p.id === `tab-${target}`;
    p.classList.remove('slide-from-right', 'slide-from-left');
    p.classList.toggle('active', isTarget);
    if (isTarget && directionClass) {
      // Restart animation cleanly
      void p.offsetWidth;
      p.classList.add(directionClass);
    }
  });

  $$('.pill-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
  $$('.dock-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));

  requestAnimationFrame(() => updateNavSliders(true));

  if (window.location.hash !== `#${target}`) {
    history.replaceState(null, '', `#${target}`);
  }

  if (target === 'overview') {
    loadStatus();
    loadTelemetry();
    loadHabits();
    loadReminders();
    loadFocus();
  }
  if (target === 'jadwal') {
    loadJadwal();
    loadCalendarInfo();
  }
  if (target === 'tugas') loadTugas();
  if (target === 'catatan') loadCatatan();
  if (target === 'memori') {
    loadMemori();
    loadWishlist();
  }
  if (target === 'vault') loadVault();
  if (target === 'keuangan') loadPengeluaran();
}

function bindNavigation() {
  $$('.pill-nav-item, .dock-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $$('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.goto));
  });
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash) switchTab(hash);
  });
  window.addEventListener('resize', () => updateNavSliders(false));
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => updateNavSliders(false));
  }
  requestAnimationFrame(() => updateNavSliders(false));
}

/* ==================== MODALS & LIGHTBOX ==================== */
function openModal(id) {
  $(`#${id}`)?.classList.remove('hidden');
  renderIcons();
}

function closeModal(id) {
  $(`#${id}`)?.classList.add('hidden');
}

function bindModals() {
  $$('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', () => closeModal(el.dataset.closeModal));
  });
  $('#lightbox-close')?.addEventListener('click', () => $('#lightbox').classList.add('hidden'));
  $('#lightbox-x')?.addEventListener('click', () => $('#lightbox').classList.add('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal').forEach((m) => m.classList.add('hidden'));
      $('#lightbox')?.classList.add('hidden');
    }
  });
}

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').classList.remove('hidden');
  renderIcons();
}

function openQrModal() {
  updateQrModalContent(state.statusData?.whatsapp);
  openModal('modal-qr');
}

function updateQrModalContent(whatsapp) {
  const frame = $('#modal-qr-frame');
  const img = $('#modal-qr-img');
  const stateEl = $('#modal-qr-state');
  if (!frame || !img || !stateEl) return;

  if (!whatsapp) {
    frame.classList.add('hidden');
    stateEl.textContent = 'Memeriksa status koneksi WhatsApp...';
    return;
  }

  if (whatsapp.status === 'qr' && whatsapp.qrCodeDataUrl) {
    frame.classList.remove('hidden');
    img.src = whatsapp.qrCodeDataUrl;
    stateEl.textContent = 'Buka WhatsApp di ponsel bot, pilih Perangkat Tertaut lalu Tautkan Perangkat dan pindai QR Code di atas.';
  } else if (whatsapp.status === 'connected') {
    frame.classList.add('hidden');
    stateEl.textContent = `WhatsApp sudah terhubung (${whatsapp.connectedPhone || 'bot aktif'}).`;
  } else if (whatsapp.status === 'connecting') {
    frame.classList.add('hidden');
    stateEl.textContent = 'Sedang menghubungkan ke server WhatsApp...';
  } else {
    frame.classList.add('hidden');
    stateEl.textContent = whatsapp.lastError || 'WhatsApp terputus. Tekan Muat Ulang Koneksi untuk menghasilkan QR Code baru.';
  }
}

/* ==================== PIN AUTH ==================== */
function showPinOverlay() {
  $('#pin-overlay')?.classList.remove('hidden');
  renderIcons();
  $('#pin-input')?.focus();
}

function hidePinOverlay() {
  $('#pin-overlay')?.classList.add('hidden');
}

async function checkAuthAndBoot() {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
    const data = await res.json();
    state.pinRequired = Boolean(data.required);
    state.authenticated = Boolean(data.authenticated);

    if (state.pinRequired) {
      $('#btn-lock-app')?.classList.remove('hidden');
    }

    if (state.pinRequired && !state.authenticated) {
      showPinOverlay();
      return;
    }

    hidePinOverlay();
    await bootDashboard();
  } catch (err) {
    toast(`Gagal terhubung ke server: ${err.message}`, 'error');
  }
}

function bindPinForm() {
  $('#pin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('#pin-input').value.trim();
    const errEl = $('#pin-error');
    errEl.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || 'PIN salah.';
        errEl.classList.remove('hidden');
        return;
      }
      $('#pin-input').value = '';
      state.authenticated = true;
      hidePinOverlay();
      await bootDashboard();
      toast('Dashboard berhasil dibuka.', 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  $('#btn-lock-app')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    state.authenticated = false;
    if (state.statusPollTimer) clearInterval(state.statusPollTimer);
    disconnectLiveEvents();
    showPinOverlay();
  });
}

/* ==================== SERVICE WORKER & WEB PUSH ==================== */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'NAVIGATE' && event.data.url) {
        const hash = event.data.url.split('#')[1];
        if (hash) switchTab(hash);
      }
    });
    const sub = await reg.pushManager.getSubscription();
    updatePushButtonState(Boolean(sub));
  } catch (err) {
    console.warn('SW registration skipped:', err.message);
  }
}

function updatePushButtonState(isSubscribed) {
  state.pushSubscribed = Boolean(isSubscribed);
  const btn = $('#btn-enable-push');
  if (!btn) return;
  if (isSubscribed) {
    btn.classList.add('push-active');
    btn.title = 'Notifikasi Browser Aktif';
    btn.innerHTML = `<i data-lucide="bell-ring" class="icon-15"></i><span class="island-action-text">Notif Aktif</span>`;
  } else {
    btn.classList.remove('push-active');
    btn.title = 'Aktifkan Notifikasi Browser';
    btn.innerHTML = `<i data-lucide="bell" class="icon-15"></i><span class="island-action-text">Aktifkan Notifikasi</span>`;
  }
  renderIcons();
}

async function subscribeBrowserPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Browser ini belum mendukung Web Push Notification.', 'error');
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Izin notifikasi ditolak oleh browser.', 'error');
      return;
    }

    const vapid = await api('/api/push/vapid-key');
    if (!vapid.publicKey) {
      toast('VAPID_PUBLIC_KEY belum dikonfigurasi di server.', 'error');
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const appServerKey = urlBase64ToUint8Array(vapid.publicKey);
    let sub = await reg.pushManager.getSubscription();

    const trySubscribe = async () =>
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });

    if (!sub) {
      try {
        sub = await trySubscribe();
      } catch (firstErr) {
        // Retry once after refreshing SW registration (fixes stale Android push state)
        try {
          await reg.update();
          const stale = await reg.pushManager.getSubscription();
          if (stale) await stale.unsubscribe().catch(() => {});
          sub = await trySubscribe();
        } catch {
          throw firstErr;
        }
      }
    }

    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(sub.toJSON()),
    });

    updatePushButtonState(true);
    toast('Notifikasi browser berhasil diaktifkan.', 'success');
    loadStatus();
  } catch (err) {
    const msg = String(err?.message || '');
    if (/push service error/i.test(msg)) {
      toast(
        'Push service diblokir browser/jaringan HP. Pastikan pakai Google Chrome (atau aktifkan Google Push di Brave) & matikan AdGuard/VPN/Private DNS sebentar.',
        'error'
      );
    } else {
      toast(`Gagal mengaktifkan notifikasi: ${msg}`, 'error');
    }
  }
}

/* ==================== TAB 1: OVERVIEW & STATUS ==================== */
async function loadStatus() {
  try {
    const data = await api('/api/status');
    state.statusData = data;
    renderOverview(data);
  } catch (err) {
    console.error(err);
  }
}

function formatNotifDaysLabel(days = []) {
  if (!Array.isArray(days) || !days.length) return 'H-7, H-3, H-1';
  return days.map((d) => (Number(d) === 0 ? 'Hari H' : `H-${d}`)).join(', ');
}

function formatRecurrenceLabel(ulang, milestoneCount) {
  if (ulang === 'BULANAN') {
    return milestoneCount > 0 ? `Tiap Bulan (Bulan ke-${milestoneCount})` : 'Tiap Bulan';
  }
  if (ulang === 'SEKALI') return 'Sekali Saja';
  return milestoneCount > 0 ? `Tiap Tahun (Tahun ke-${milestoneCount})` : 'Tiap Tahun';
}

function renderOverview(data) {
  const {
    whatsapp,
    stats,
    overview,
    serverTime,
    geminiConfigured,
    geminiModel,
    webPushConfigured,
    notificationSettings,
  } = data;

  if (notificationSettings) {
    state.notifSettings = notificationSettings;
    const badge = $('#momen-default-notif-badge');
    if (badge) {
      badge.textContent = `Default: ${formatNotifDaysLabel(notificationSettings.momentDefaultDays)} • ${notificationSettings.momentDefaultTime} WIB`;
    }
    const autoSub = $('#overview-automation-sub');
    if (autoSub) {
      const bText = notificationSettings.morningBriefingEnabled
        ? `Briefing ${notificationSettings.morningBriefingTime} WIB`
        : 'Briefing nonaktif';
      const kDay = HARI_BACKUP_LABELS[notificationSettings.weeklyBackupDay ?? 0] || 'Minggu';
      const kText = notificationSettings.weeklyBackupEnabled
        ? `Backup ${kDay} ${notificationSettings.weeklyBackupTime} WIB`
        : 'Backup nonaktif';
      autoSub.textContent = `${bText} • ${kText}`;
    }
  }

  $('#overview-date-label').textContent = `${serverTime.display} • Sinkronisasi Real-Time`;
  $('#badge-jadwal').textContent = stats.jadwal_aktif;
  $('#badge-tugas').textContent = stats.tugas_aktif;
  if ($('#badge-catatan')) $('#badge-catatan').textContent = stats.catatan_kuliah || 0;
  if (hasSnapshotChanged('nav-badges', [stats.jadwal_aktif, stats.tugas_aktif, stats.catatan_kuliah || 0])) {
    requestAnimationFrame(() => updateNavSliders(false));
  }

  // KPI cards
  $('#kpi-jadwal').textContent = overview.todaySchedules.length;
  $('#kpi-jadwal-sub').textContent = `${stats.jadwal_aktif} jadwal aktif total`;
  $('#kpi-tugas').textContent = stats.tugas_aktif;
  $('#kpi-tugas-sub').textContent = `${stats.tugas} total tugas tercatat`;
  $('#kpi-expense').textContent = formatSignedRupiah(overview.monthBalance ?? -overview.monthExpenseTotal);
  $('#kpi-expense-today').textContent = `Masuk: ${formatRupiah(overview.monthIncomeTotal || 0)} • Keluar: ${formatRupiah(overview.monthExpenseTotal || 0)}`;
  $('#kpi-total-records').textContent = stats.total_records;
  $('#kpi-vault-sub').textContent = `${stats.memori_pacar} memori • ${stats.catatan_kuliah || 0} catatan • ${stats.vault} vault`;

  // Overview Finance Summary Card
  const ovInc = Number(overview.monthIncomeTotal) || 0;
  const ovExp = Number(overview.monthExpenseTotal) || 0;
  const ovBal = Number(overview.monthBalance ?? ovInc - ovExp) || 0;
  if ($('#ov-fin-income')) $('#ov-fin-income').textContent = formatRupiah(ovInc);
  if ($('#ov-fin-expense')) $('#ov-fin-expense').textContent = formatRupiah(ovExp);
  if ($('#ov-fin-balance')) $('#ov-fin-balance').textContent = formatSignedRupiah(ovBal);
  const ovRatio = ovInc > 0 ? Math.round((ovExp / ovInc) * 100) : ovExp > 0 ? 100 : 0;
  if ($('#ov-fin-ratio-label')) $('#ov-fin-ratio-label').textContent = `${ovRatio}%`;
  const ovBar = $('#ov-fin-ratio-bar');
  if (ovBar) {
    ovBar.style.width = `${Math.min(100, ovRatio)}%`;
    ovBar.className = `budget-bar-fill ${ovRatio >= 100 ? 'is-over' : ovRatio >= 80 ? 'is-warn' : 'bar-blue'}`;
  }

  // Top Bar & Overview WA Status
  const islandDot = $('#island-wa-dot');
  const islandLabel = $('#island-wa-label');
  const islandQrCue = $('#island-qr-cue');
  const pill = $('#wa-status-pill');
  const qrBox = $('#wa-qr-container');
  const connBox = $('#wa-connected-info');
  const discBox = $('#wa-disconnected-info');

  qrBox.classList.add('hidden');
  connBox.classList.add('hidden');
  discBox.classList.add('hidden');
  islandQrCue.classList.add('hidden');

  if (whatsapp.status === 'connected') {
    islandDot.className = 'status-dot dot-green';
    islandLabel.textContent = 'Bot Online';
    pill.className = 'pill pill-green';
    pill.textContent = 'Bot Online';
    connBox.classList.remove('hidden');
    $('#wa-connected-meta').textContent = `Bot: ${whatsapp.connectedPhone || '-'} • Aktif sejak ${whatsapp.lastConnectedAt || '-'}`;
  } else if (whatsapp.status === 'qr' && whatsapp.qrCodeDataUrl) {
    islandDot.className = 'status-dot dot-amber';
    islandLabel.textContent = 'Scan QR';
    islandQrCue.classList.remove('hidden');
    pill.className = 'pill pill-amber';
    pill.textContent = 'Menunggu Scan QR';
    qrBox.classList.remove('hidden');
    $('#wa-qr-img').src = whatsapp.qrCodeDataUrl;
  } else if (whatsapp.status === 'connecting') {
    islandDot.className = 'status-dot dot-amber';
    islandLabel.textContent = 'Menghubungkan';
    pill.className = 'pill pill-blue';
    pill.textContent = 'Menghubungkan';
    discBox.classList.remove('hidden');
    $('#wa-error-text').textContent = 'Menghubungkan ke server WhatsApp (Baileys)...';
  } else {
    islandDot.className = 'status-dot dot-red';
    islandLabel.textContent = 'Bot Offline';
    islandQrCue.classList.remove('hidden');
    pill.className = 'pill pill-red';
    pill.textContent = 'Offline';
    discBox.classList.remove('hidden');
    $('#wa-error-text').textContent = whatsapp.lastError || 'Belum terhubung ke WhatsApp.';
  }

  updateQrModalContent(whatsapp);

  // Readiness chips (only mutate DOM when status actually changes)
  if (
    hasSnapshotChanged('overview-chips', [
      geminiConfigured,
      geminiModel,
      whatsapp.ownerConfigured,
      whatsapp.ownerMasked,
      webPushConfigured,
      stats.push_subscriptions,
    ])
  ) {
    const chipGemini = $('#chip-gemini');
    chipGemini.innerHTML = `<i data-lucide="cpu" class="icon-13"></i><span>${escapeHtml(
      geminiConfigured ? `Gemini (${geminiModel || 'flash'}): Siap` : 'Gemini API Key Belum Diisi'
    )}</span>`;
    chipGemini.className = `chip ${geminiConfigured ? 'ok' : 'warn'}`;

    const chipOwner = $('#chip-owner');
    chipOwner.innerHTML = `<i data-lucide="shield-check" class="icon-13"></i><span>${escapeHtml(
      whatsapp.ownerConfigured ? `Whitelist: ${whatsapp.ownerMasked}` : 'NOMOR_UTAMA Belum Diisi'
    )}</span>`;
    chipOwner.className = `chip ${whatsapp.ownerConfigured ? 'ok' : 'warn'}`;

    const chipPush = $('#chip-push');
    chipPush.innerHTML = `<i data-lucide="bell" class="icon-13"></i><span>${escapeHtml(
      webPushConfigured ? `Web Push: ${stats.push_subscriptions} perangkat` : 'VAPID Belum Diisi'
    )}</span>`;
    chipPush.className = `chip ${webPushConfigured ? 'ok' : 'warn'}`;
    renderIcons();
  }

  // Today's schedules
  if (hasSnapshotChanged('overview-schedules', overview.todaySchedules)) {
    const schedWrap = $('#overview-schedules');
    if (!overview.todaySchedules.length) {
      schedWrap.innerHTML = `<div class="muted text-sm">Tidak ada jadwal kuliah atau presensi hari ini.</div>`;
    } else {
      schedWrap.innerHTML = overview.todaySchedules
        .map(
          (j) => `
      <div class="mini-item">
        <div>
          <div class="fw-600">${escapeHtml(j.nama)}</div>
          <div class="text-xs muted">${j.is_rutin ? `Rutin setiap ${escapeHtml(j.hari)}` : `Sekali jalan (${escapeHtml(j.tanggal)})`}</div>
        </div>
        <span class="pill pill-blue mono">${escapeHtml(j.jam)} WIB</span>
      </div>`
        )
        .join('');
    }
  }

  // Urgent tasks & moments
  if (hasSnapshotChanged('overview-urgent', [overview.upcomingMoments.slice(0, 2), overview.urgentTasks])) {
    const urgentWrap = $('#overview-urgent');
    const itemsHtml = [];

    for (const m of overview.upcomingMoments.slice(0, 2)) {
      itemsHtml.push(`
      <div class="mini-item">
        <div>
          <div class="fw-600">${escapeHtml(m.judul)}</div>
          <div class="text-xs muted">Momen Spesial • ${escapeHtml(m.next_date)}</div>
        </div>
        <span class="pill pill-cyan mono">${m.days_until === 0 ? 'HARI INI' : `H-${m.days_until}`}</span>
      </div>`);
    }

    for (const t of overview.urgentTasks) {
      const pillClass =
        t.countdown.urgency === 'overdue' || t.countdown.urgency === 'critical'
          ? 'pill-red'
          : t.countdown.urgency === 'warning'
          ? 'pill-amber'
          : 'pill-green';
      itemsHtml.push(`
      <div class="mini-item">
        <div>
          <div class="fw-600">${escapeHtml(t.judul)}</div>
          <div class="text-xs muted">${escapeHtml(t.matkul || 'Umum')} • ${escapeHtml(t.deadline)}</div>
        </div>
        <span class="pill ${pillClass}">${escapeHtml(t.countdown.label)}</span>
      </div>`);
    }

    urgentWrap.innerHTML = itemsHtml.length
      ? itemsHtml.join('')
      : `<div class="muted text-sm">Aman. Tidak ada tugas mendesak atau momen terdekat.</div>`;
  }

  renderPendingPresensiBanner(overview.pendingPresensi || []);
}

function renderPendingPresensiBanner(list = []) {
  const box = $('#presensi-pending-banner');
  if (!box) return;
  if (!hasSnapshotChanged('pending-presensi', list)) return;

  if (!list.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="card-header compact-head">
      <div class="card-title-group">
        <span class="title-icon"><i data-lucide="bell-ring" class="icon-18"></i></span>
        <div>
          <h3>Menunggu Konfirmasi Presensi (${list.length})</h3>
          <p class="muted text-xs">Akan terus diingatkan setiap interval sampai kamu balas "ok" di WhatsApp atau klik OK di sini</p>
        </div>
      </div>
      <button id="btn-ack-all-presensi" class="btn btn-primary btn-sm" type="button">
        <i data-lucide="check-circle-2" class="icon-14"></i>
        <span>Sudah Presensi (OK)</span>
      </button>
    </div>
    <div class="list-stack">
      ${list
        .map(
          (p) => `
        <div class="mini-item">
          <div>
            <div class="fw-600">${escapeHtml(p.nama)}</div>
            <div class="text-xs muted mono">Jadwal ${escapeHtml(p.jam_awal)} WIB • Pengingat ke-${Number(p.repeat_count) || 1} • Berikutnya ${escapeHtml(String(p.next_trigger_at || '').slice(11, 16))} WIB (tiap ${Number(p.interval_menit) || 20}m)</div>
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-ack-presensi="${p.id}">
            <i data-lucide="check" class="icon-14"></i>
            <span>OK</span>
          </button>
        </div>`
        )
        .join('')}
    </div>
  `;

  $('#btn-ack-all-presensi')?.addEventListener('click', async () => {
    try {
      await api('/api/jadwal/pending/ack', { method: 'POST', body: JSON.stringify({}) });
      toast('Pengingat presensi berulang dihentikan.', 'success');
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  box.querySelectorAll('[data-ack-presensi]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/jadwal/pending/ack', {
          method: 'POST',
          body: JSON.stringify({ id: Number(btn.dataset.ackPresensi) }),
        });
        toast('Presensi dikonfirmasi (OK).', 'success');
        loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

/* ==================== TAB 2: JADWAL ==================== */
async function loadJadwal() {
  try {
    const query = state.jadwalFilter === 'all' ? '' : `?is_rutin=${state.jadwalFilter}`;
    state.jadwalList = await api(`/api/jadwal${query}`);
    renderJadwal();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderJadwal() {
  const tbody = $('#jadwal-tbody');
  const empty = $('#jadwal-empty');
  if (!state.jadwalList.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    renderIcons();
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = state.jadwalList
    .map(
      (j) => `
    <tr>
      <td>
        <strong>${escapeHtml(j.nama)}</strong>
        ${
          Number(j.repeat_until_ok) === 1 && !/\(Snooze\)/i.test(j.nama || '')
            ? `<div class="text-xs muted" style="margin-top:3px;">Presensi • Ulang tiap ${Number(j.repeat_interval_min) || 20}m sampai balas OK</div>`
            : `<div class="text-xs muted" style="margin-top:3px;">Alarm Biasa • 1x pengingat</div>`
        }
      </td>
      <td><span class="pill ${j.is_rutin ? 'pill-blue' : 'pill-cyan'}">${j.is_rutin ? 'Rutin' : 'Sekali Jalan'}</span></td>
      <td>${j.is_rutin ? escapeHtml(j.hari || '-') : `${escapeHtml(j.hari || '')}, ${escapeHtml(j.tanggal || '-')}`}</td>
      <td class="mono fw-600">${escapeHtml(j.jam)}</td>
      <td>
        <label class="switch" title="Aktif / Nonaktif">
          <input type="checkbox" ${j.aktif ? 'checked' : ''} data-toggle-jadwal="${j.id}" />
          <span class="slider"></span>
        </label>
      </td>
      <td class="text-right">
        <button class="btn btn-ghost btn-sm" type="button" data-edit-jadwal="${j.id}">
          <i data-lucide="pencil" class="icon-14"></i>
          <span>Edit</span>
        </button>
        <button class="btn btn-danger-ghost btn-sm" type="button" data-del-jadwal="${j.id}">
          <i data-lucide="trash-2" class="icon-14"></i>
          <span>Hapus</span>
        </button>
      </td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('[data-toggle-jadwal]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await api(`/api/jadwal/${cb.dataset.toggleJadwal}`, {
          method: 'PUT',
          body: JSON.stringify({ aktif: cb.checked ? 1 : 0 }),
        });
        toast(cb.checked ? 'Jadwal diaktifkan.' : 'Jadwal dinonaktifkan.', 'success');
        loadStatus();
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message, 'error');
      }
    });
  });

  tbody.querySelectorAll('[data-edit-jadwal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.jadwalList.find((x) => x.id === Number(btn.dataset.editJadwal));
      if (!item) return;
      $('#modal-jadwal-title').textContent = 'Edit Jadwal';
      $('#jadwal-id').value = item.id;
      $('#jadwal-nama').value = item.nama;
      $('#jadwal-rutin').value = String(item.is_rutin);
      $('#jadwal-hari').value = item.hari || 'Senin';
      $('#jadwal-tanggal').value = item.tanggal || getTodayWibStr();
      $('#jadwal-jam').value = item.jam;
      if ($('#jadwal-repeat-ok')) $('#jadwal-repeat-ok').checked = Number(item.repeat_until_ok) === 1;
      if ($('#jadwal-repeat-interval')) $('#jadwal-repeat-interval').value = Number(item.repeat_interval_min) || 20;
      toggleJadwalFields(false);
      openModal('modal-jadwal');
    });
  });

  tbody.querySelectorAll('[data-del-jadwal]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus jadwal ini?')) return;
      try {
        await api(`/api/jadwal/${btn.dataset.delJadwal}`, { method: 'DELETE' });
        toast('Jadwal dihapus.', 'success');
        loadJadwal();
        loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

function syncJadwalRepeatField() {
  const isPresensi = Boolean($('#jadwal-repeat-ok')?.checked);
  $('#field-jadwal-repeat-interval')?.classList.toggle('hidden', !isPresensi);
}

function toggleJadwalFields(autoAdjustRepeat = false) {
  const isRutin = $('#jadwal-rutin').value === '1';
  $('#field-jadwal-hari').classList.toggle('hidden', !isRutin);
  $('#field-jadwal-tanggal').classList.toggle('hidden', isRutin);
  if (autoAdjustRepeat && !$('#jadwal-id').value && $('#jadwal-repeat-ok')) {
    $('#jadwal-repeat-ok').checked = isRutin;
  }
  syncJadwalRepeatField();
}

/* ==================== TAB 3: TUGAS ==================== */
async function loadTugas() {
  try {
    const query = state.tugasFilter === 'all' ? '' : `?selesai=${state.tugasFilter}`;
    state.tugasList = await api(`/api/tugas${query}`);
    renderTugas();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderTugas() {
  const wrap = $('#tugas-list');
  const empty = $('#tugas-empty');
  if (!state.tugasList.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    renderIcons();
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = state.tugasList
    .map((t) => {
      const cd = t.countdown || { label: '-', urgency: 'normal' };
      const pillClass = t.selesai
        ? 'pill-muted'
        : cd.urgency === 'overdue' || cd.urgency === 'critical'
        ? 'pill-red'
        : cd.urgency === 'warning'
        ? 'pill-amber'
        : 'pill-green';

      return `
      <article class="task-card ${t.selesai ? 'done' : ''}">
        <div class="task-top">
          <input type="checkbox" class="task-checkbox" ${t.selesai ? 'checked' : ''} data-toggle-tugas="${t.id}" aria-label="Tandai selesai" />
          <div style="flex:1;min-width:0;">
            <div class="task-title">${escapeHtml(t.judul)}</div>
            <div class="text-sm muted">${escapeHtml(t.matkul || 'Mata kuliah umum')}</div>
          </div>
        </div>
        <div class="task-meta">
          <span class="pill ${pillClass}">
            <i data-lucide="${t.selesai ? 'check' : 'clock'}" class="icon-13"></i>
            <span>${t.selesai ? 'Selesai' : escapeHtml(cd.label)}</span>
          </span>
          <span class="pill pill-muted mono">${escapeHtml(t.deadline)} WIB</span>
          ${t.notif_h1 ? '<span class="pill pill-blue"><i data-lucide="bell-ring" class="icon-13"></i><span>H-1</span></span>' : ''}
          ${t.notif_h3jam ? '<span class="pill pill-red"><i data-lucide="bell-ring" class="icon-13"></i><span>H-3j</span></span>' : ''}
        </div>
        <div class="task-footer">
          <button class="btn btn-ghost btn-sm" type="button" data-edit-tugas="${t.id}">
            <i data-lucide="pencil" class="icon-14"></i>
            <span>Edit</span>
          </button>
          <button class="btn btn-danger-ghost btn-sm" type="button" data-del-tugas="${t.id}">
            <i data-lucide="trash-2" class="icon-14"></i>
            <span>Hapus</span>
          </button>
        </div>
      </article>`;
    })
    .join('');

  wrap.querySelectorAll('[data-toggle-tugas]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await api(`/api/tugas/${cb.dataset.toggleTugas}`, {
          method: 'PATCH',
          body: JSON.stringify({ selesai: cb.checked ? 1 : 0 }),
        });
        toast(cb.checked ? 'Tugas ditandai selesai.' : 'Tugas dibuka kembali.', 'success');
        loadTugas();
        loadStatus();
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message, 'error');
      }
    });
  });

  wrap.querySelectorAll('[data-edit-tugas]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.tugasList.find((x) => x.id === Number(btn.dataset.editTugas));
      if (!item) return;
      $('#modal-tugas-title').textContent = 'Edit Tugas';
      $('#tugas-id').value = item.id;
      $('#tugas-judul').value = item.judul;
      $('#tugas-matkul').value = item.matkul || '';
      $('#tugas-deadline').value = (item.deadline || '').replace(' ', 'T').slice(0, 16);
      openModal('modal-tugas');
    });
  });

  wrap.querySelectorAll('[data-del-tugas]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus tugas ini?')) return;
      try {
        await api(`/api/tugas/${btn.dataset.delTugas}`, { method: 'DELETE' });
        toast('Tugas dihapus.', 'success');
        loadTugas();
        loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

/* ==================== TAB 4: MEMORI & WISHLIST ==================== */
async function loadMemori() {
  try {
    const params = new URLSearchParams();
    const q = $('#memori-search-q')?.value.trim();
    const tgl = $('#memori-search-date')?.value;
    if (q) params.set('q', q);
    if (tgl) params.set('tanggal', tgl);
    const qs = params.toString() ? `?${params.toString()}` : '';
    state.memoriList = await api(`/api/memori${qs}`);
    renderMemori();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderMemori() {
  const wrap = $('#memori-timeline');
  const empty = $('#memori-empty');
  if (!state.memoriList.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    renderIcons();
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = state.memoriList
    .map(
      (m) => `
    <article class="memori-card">
      <div class="memori-head">
        <span class="pill pill-blue">
          <i data-lucide="calendar" class="icon-13"></i>
          <span>${escapeHtml(m.hari)}, ${escapeHtml(m.tanggal)}</span>
        </span>
        <div class="memori-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-edit-memori="${m.id}">
            <i data-lucide="pencil" class="icon-14"></i>
            <span>${m.deskripsi ? 'Edit' : 'Tambah Deskripsi'}</span>
          </button>
          <button class="btn btn-danger-ghost btn-sm" type="button" data-del-memori="${m.id}">
            <i data-lucide="trash-2" class="icon-14"></i>
            <span>Hapus</span>
          </button>
        </div>
      </div>
      <div class="memori-body">${escapeHtml(m.isi)}</div>
      ${
        m.deskripsi
          ? `<div class="memori-desc"><div class="memori-desc-label">Deskripsi Hari Itu</div>${escapeHtml(m.deskripsi)}</div>`
          : ''
      }
      ${
        m.media_path
          ? `<img class="memori-thumb" src="/${encodeURI(m.media_path)}" alt="Foto memori ${escapeHtml(m.tanggal)}" data-zoom-img="/${encodeURI(m.media_path)}" />`
          : ''
      }
    </article>`
    )
    .join('');

  wrap.querySelectorAll('[data-zoom-img]').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.dataset.zoomImg));
  });

  wrap.querySelectorAll('[data-edit-memori]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.memoriList.find((x) => x.id === Number(btn.dataset.editMemori));
      if (!item) return;
      $('#modal-memori-title').textContent = 'Edit Memori & Deskripsi';
      $('#form-memori').reset();
      $('#memori-id').value = item.id;
      $('#memori-tanggal').value = item.tanggal || getTodayWibStr();
      $('#memori-isi').value = item.isi || '';
      $('#memori-deskripsi').value = item.deskripsi || '';
      openModal('modal-memori');
    });
  });

  wrap.querySelectorAll('[data-del-memori]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus catatan memori ini?')) return;
      try {
        await api(`/api/memori/${btn.dataset.delMemori}`, { method: 'DELETE' });
        toast('Memori dihapus.', 'success');
        loadMemori();
        loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

async function loadWishlist() {
  try {
    state.wishlistList = await api('/api/wishlist');
    renderWishlist();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderWishlist() {
  const moments = state.wishlistList.filter((i) => i.tipe === 'MOMEN');
  const wishlists = state.wishlistList.filter((i) => i.tipe !== 'MOMEN');

  const momenWrap = $('#momen-list');
  if (!moments.length) {
    momenWrap.innerHTML = `<div class="muted text-sm">Belum ada tanggal spesial tersimpan.</div>`;
  } else {
    momenWrap.innerHTML = moments
      .map(
        (m) => `
      <div class="wishlist-row">
        <div class="wishlist-left">
          <div style="min-width:0;flex:1;">
            <div class="fw-600">${escapeHtml(m.judul)}</div>
            <div class="wishlist-meta-line">
              <i data-lucide="calendar" class="icon-13"></i>
              <span>${escapeHtml(m.tanggal || '-')}</span>
              <span>•</span>
              <i data-lucide="repeat" class="icon-13"></i>
              <span>${escapeHtml(formatRecurrenceLabel(m.ulang, m.milestone_count))}</span>
              ${
                m.next_date && m.next_date !== m.tanggal
                  ? `<span>• Berikutnya ${escapeHtml(m.next_date)}</span>`
                  : ''
              }
            </div>
            ${m.catatan ? `<div class="wishlist-desc">${escapeHtml(m.catatan)}</div>` : ''}
            <div class="wishlist-notif-meta">
              <i data-lucide="bell" class="icon-13"></i>
              <span>${escapeHtml(formatNotifDaysLabel(m.effective_notif_days))} • ${escapeHtml(m.effective_notif_jam || '08:00')} WIB</span>
            </div>
          </div>
        </div>
        <div class="wishlist-actions">
          ${
            m.days_until !== null
              ? `<span class="pill ${m.days_until <= 7 ? 'pill-red' : 'pill-cyan'} mono">${m.days_until === 0 ? 'HARI INI' : `H-${m.days_until}`}</span>`
              : '<span class="pill pill-muted">Selesai</span>'
          }
          <button class="icon-btn" type="button" title="Edit deskripsi & waktu notif" aria-label="Edit" data-edit-wish="${m.id}">
            <i data-lucide="pencil" class="icon-14"></i>
          </button>
          <button class="icon-btn danger" type="button" title="Hapus" aria-label="Hapus" data-del-wish="${m.id}">
            <i data-lucide="trash-2" class="icon-14"></i>
          </button>
        </div>
      </div>`
      )
      .join('');
  }

  const wishWrap = $('#wishlist-list');
  if (!wishlists.length) {
    wishWrap.innerHTML = `<div class="muted text-sm">Belum ada wishlist tersimpan.</div>`;
  } else {
    wishWrap.innerHTML = wishlists
      .map(
        (w) => `
      <div class="wishlist-row">
        <div class="wishlist-left">
          <input type="checkbox" class="task-checkbox" ${w.terpenuhi ? 'checked' : ''} data-toggle-wish="${w.id}" aria-label="Tandai terpenuhi" />
          <div class="${w.terpenuhi ? 'wishlist-done' : ''}" style="min-width:0;flex:1;">
            <div class="fw-600">${escapeHtml(w.judul)}</div>
            ${w.catatan ? `<div class="wishlist-desc">${escapeHtml(w.catatan)}</div>` : ''}
          </div>
        </div>
        <div class="wishlist-actions">
          <button class="icon-btn" type="button" title="Edit deskripsi" aria-label="Edit" data-edit-wish="${w.id}">
            <i data-lucide="pencil" class="icon-14"></i>
          </button>
          <button class="icon-btn danger" type="button" title="Hapus" aria-label="Hapus" data-del-wish="${w.id}">
            <i data-lucide="trash-2" class="icon-14"></i>
          </button>
        </div>
      </div>`
      )
      .join('');
  }

  $$('[data-toggle-wish]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        await api(`/api/wishlist/${cb.dataset.toggleWish}`, {
          method: 'PATCH',
          body: JSON.stringify({ terpenuhi: cb.checked ? 1 : 0 }),
        });
        toast(cb.checked ? 'Wishlist ditandai terpenuhi.' : 'Wishlist dibuka kembali.', 'success');
        loadWishlist();
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message, 'error');
      }
    });
  });

  $$('[data-edit-wish]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.wishlistList.find((x) => x.id === Number(btn.dataset.editWish));
      if (!item) return;
      openWishlistEditModal(item);
    });
  });

  $$('[data-del-wish]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus item ini?')) return;
      try {
        await api(`/api/wishlist/${btn.dataset.delWish}`, { method: 'DELETE' });
        toast('Item dihapus.', 'success');
        loadWishlist();
        loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

function setDayCheckboxes(groupSelector, customInputSelector, daysArray = []) {
  const presets = new Set(['30', '14', '7', '3', '1', '0']);
  const selectedSet = new Set((daysArray || []).map((d) => String(d)));
  $$(`${groupSelector} input[type="checkbox"]`).forEach((cb) => {
    cb.checked = selectedSet.has(cb.value);
  });
  const customDays = (daysArray || []).filter((d) => !presets.has(String(d)));
  const customInput = $(customInputSelector);
  if (customInput) customInput.value = customDays.join(', ');
}

function readDayCheckboxes(groupSelector, customInputSelector) {
  const days = [];
  $$(`${groupSelector} input[type="checkbox"]:checked`).forEach((cb) => {
    days.push(Number(cb.value));
  });
  const customRaw = $(customInputSelector)?.value || '';
  for (const part of customRaw.split(/[,\s]+/)) {
    if (!part.trim()) continue;
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 365) days.push(n);
  }
  return [...new Set(days)].sort((a, b) => b - a);
}

function toggleWishlistFields() {
  const isMomen = $('#wishlist-tipe').value === 'MOMEN';
  $('#field-wishlist-tanggal').classList.toggle('hidden', !isMomen);
  $('#field-wishlist-notif').classList.toggle('hidden', !isMomen);
}

function openWishlistEditModal(item) {
  $('#modal-wishlist-title').textContent = item.tipe === 'MOMEN' ? 'Edit Momen Spesial' : 'Edit Wishlist';
  $('#form-wishlist').reset();
  $('#wishlist-id').value = item.id;
  $('#wishlist-tipe').value = item.tipe;
  $('#wishlist-judul').value = item.judul || '';
  $('#wishlist-tanggal').value = item.tanggal || '';
  $('#wishlist-ulang').value = item.ulang || 'TAHUNAN';
  $('#wishlist-catatan').value = item.catatan || '';
  const customDays = item.notif_days
    ? String(item.notif_days)
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n))
    : [];
  setDayCheckboxes('#wishlist-notif-days-group', '#wishlist-notif-custom', customDays);
  $('#wishlist-notif-jam').value = item.notif_jam || '';
  toggleWishlistFields();
  openModal('modal-wishlist');
}

async function openNotifSettingsModal() {
  try {
    const s = await api('/api/settings/notifications');
    state.notifSettings = s;
    setDayCheckboxes('#settings-moment-days-group', '#settings-moment-custom', s.momentDefaultDays);
    $('#settings-moment-time').value = s.momentDefaultTime || '08:00';
    $('#settings-briefing-enabled').checked = Boolean(s.morningBriefingEnabled);
    $('#settings-briefing-time').value = s.morningBriefingTime || '06:00';
    $('#settings-task-first').value = s.taskFirstReminderHours ?? 24;
    $('#settings-task-second').value = s.taskSecondReminderHours ?? 3;
    $('#settings-backup-enabled').checked = Boolean(s.weeklyBackupEnabled);
    $('#settings-backup-day').value = String(s.weeklyBackupDay ?? 0);
    $('#settings-backup-time').value = s.weeklyBackupTime || '23:00';
    openModal('modal-notif-settings');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ==================== TAB 5: QUICK VAULT ==================== */
async function loadVault() {
  try {
    const params = new URLSearchParams();
    if (state.vaultFilter !== 'all') params.set('tipe', state.vaultFilter);
    const q = $('#vault-search-q')?.value.trim();
    if (q) params.set('q', q);
    const qs = params.toString() ? `?${params.toString()}` : '';
    state.vaultList = await api(`/api/vault${qs}`);
    renderVault();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function isSafeHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '';
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function pickDocIcon(ext = '') {
  const up = String(ext).toUpperCase();
  if (['XLS', 'XLSX', 'CSV'].includes(up)) return 'file-spreadsheet';
  if (['ZIP', 'RAR', '7Z', 'TAR', 'GZ'].includes(up)) return 'file-archive';
  if (['MP3', 'OGG', 'M4A', 'WAV', 'OPUS'].includes(up)) return 'file-audio';
  if (['JS', 'TS', 'PY', 'HTML', 'CSS', 'JSON', 'SQL'].includes(up)) return 'file-code';
  return 'file-text';
}

async function openFilePreviewModal(item) {
  const titleEl = $('#file-preview-title');
  const metaEl = $('#file-preview-meta');
  const dlEl = $('#file-preview-download');
  const bodyEl = $('#file-preview-body');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = item.kata_kunci || 'Pratinjau Dokumen';
  const sizeStr = formatFileSize(item.file_size);
  metaEl.textContent = `${item.file_ext || 'FILE'}${sizeStr ? ` • ${sizeStr}` : ''}${item.file_name ? ` • ${item.file_name}` : ''}`;
  dlEl.href = `/api/vault/${item.id}/download`;

  if (item.file_kind === 'PDF' && item.preview_url) {
    bodyEl.innerHTML = `<iframe class="file-preview-iframe" src="${encodeURI(item.preview_url)}" title="Pratinjau PDF"></iframe>`;
    openModal('modal-file-preview');
    return;
  }

  if (item.file_kind === 'TEXT' && item.preview_url) {
    bodyEl.innerHTML = `<pre class="file-preview-text">Memuat isi file...</pre>`;
    openModal('modal-file-preview');
    try {
      const res = await fetch(encodeURI(item.preview_url), { credentials: 'same-origin', cache: 'no-store' });
      const txt = await res.text();
      bodyEl.innerHTML = `<pre class="file-preview-text">${escapeHtml(txt)}</pre>`;
    } catch {
      bodyEl.innerHTML = `<pre class="file-preview-text">${escapeHtml(item.preview_snippet || 'Gagal memuat pratinjau file.')}</pre>`;
    }
    return;
  }

  window.open(`/api/vault/${item.id}/download`, '_blank');
}

function renderVault() {
  const wrap = $('#vault-grid');
  const empty = $('#vault-empty');
  if (!state.vaultList.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    renderIcons();
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = state.vaultList
    .map((v) => {
      const isFile = v.tipe === 'FILE';
      const kind = v.file_kind || (isFile ? 'DOC' : isSafeHttpUrl(v.konten) ? 'URL' : 'NOTE');
      const safeLink = !isFile && isSafeHttpUrl(v.konten);
      const sizeStr = formatFileSize(v.file_size);
      const previewUrl = v.preview_url ? encodeURI(v.preview_url) : '';
      const displayFileName = v.file_name || String(v.konten || '').split('/').pop();

      let stageHtml = '';
      if (isFile && kind === 'IMAGE' && previewUrl) {
        stageHtml = `
          <div class="vault-image-stage" data-zoom-vault="${previewUrl}">
            <img src="${previewUrl}" alt="${escapeHtml(v.kata_kunci)}" loading="lazy" />
            <div class="vault-stage-scrim"></div>
            <div class="vault-stage-top">
              <span class="vault-stage-badge">
                <i data-lucide="image" class="icon-13"></i>
                <span>${escapeHtml(v.file_ext || 'IMG')}</span>
              </span>
              ${sizeStr ? `<span class="vault-stage-badge mono">${escapeHtml(sizeStr)}</span>` : ''}
            </div>
            <span class="vault-zoom-hint">
              <i data-lucide="maximize-2" class="icon-13"></i>
              <span>Perbesar</span>
            </span>
          </div>`;
      } else if (isFile && kind === 'PDF' && previewUrl) {
        stageHtml = `
          <div class="vault-doc-stage" data-preview-vault="${v.id}">
            <iframe class="vault-pdf-frame" loading="lazy" src="${previewUrl}#toolbar=0&navpanes=0&scrollbar=0&page=1" tabindex="-1" title="${escapeHtml(v.kata_kunci)}"></iframe>
            <div class="vault-stage-scrim"></div>
            <div class="vault-wa-doc-bar">
              <span class="vault-wa-doc-icon"><i data-lucide="file-text" class="icon-16"></i></span>
              <div class="vault-wa-doc-info">
                <div class="vault-wa-doc-name">${escapeHtml(displayFileName)}</div>
                <div class="vault-wa-doc-meta">PDF${sizeStr ? ` • ${escapeHtml(sizeStr)}` : ''} • Klik untuk pratinjau</div>
              </div>
              <i data-lucide="maximize-2" class="icon-14 muted"></i>
            </div>
          </div>`;
      } else if (isFile && kind === 'TEXT') {
        stageHtml = `
          <div class="vault-doc-stage" data-preview-vault="${v.id}">
            <div class="vault-text-peek">${escapeHtml(v.preview_snippet || 'Dokumen teks kosong')}</div>
            <div class="vault-wa-doc-bar">
              <span class="vault-wa-doc-icon"><i data-lucide="${pickDocIcon(v.file_ext)}" class="icon-16"></i></span>
              <div class="vault-wa-doc-info">
                <div class="vault-wa-doc-name">${escapeHtml(displayFileName)}</div>
                <div class="vault-wa-doc-meta">${escapeHtml(v.file_ext || 'TXT')}${sizeStr ? ` • ${escapeHtml(sizeStr)}` : ''} • Klik untuk baca</div>
              </div>
              <i data-lucide="maximize-2" class="icon-14 muted"></i>
            </div>
          </div>`;
      } else if (isFile && kind === 'AUDIO' && previewUrl) {
        stageHtml = `
          <div class="vault-audio-stage">
            <div class="vault-domain-row">
              <span class="pill pill-cyan"><i data-lucide="file-audio" class="icon-13"></i><span>${escapeHtml(v.file_ext || 'AUDIO')}</span></span>
              ${sizeStr ? `<span class="text-xs muted mono">${escapeHtml(sizeStr)}</span>` : ''}
            </div>
            <audio controls preload="metadata" src="${previewUrl}"></audio>
          </div>`;
      } else if (isFile) {
        stageHtml = `
          <div class="vault-doc-stage" data-preview-vault="${v.id}">
            <div class="vault-sheet-mock" aria-hidden="true">
              <div class="vault-sheet-head">
                <span class="vault-sheet-ext">${escapeHtml(v.file_ext || 'FILE')}</span>
                <span class="vault-sheet-line w-55"></span>
              </div>
              <span class="vault-sheet-line w-90"></span>
              <span class="vault-sheet-line w-75"></span>
              <span class="vault-sheet-line w-90"></span>
            </div>
            <div class="vault-wa-doc-bar">
              <span class="vault-wa-doc-icon"><i data-lucide="${pickDocIcon(v.file_ext)}" class="icon-16"></i></span>
              <div class="vault-wa-doc-info">
                <div class="vault-wa-doc-name">${escapeHtml(displayFileName)}</div>
                <div class="vault-wa-doc-meta">${escapeHtml(v.file_ext || 'DOC')}${sizeStr ? ` • ${escapeHtml(sizeStr)}` : ''}</div>
              </div>
            </div>
          </div>`;
      } else {
        stageHtml = `
          <div class="vault-link-stage">
            <div class="vault-domain-row">
              <span class="pill pill-blue">
                <i data-lucide="${safeLink ? 'globe' : 'sticky-note'}" class="icon-13"></i>
                <span>${safeLink ? escapeHtml(v.domain || 'LINK') : 'CATATAN'}</span>
              </span>
            </div>
            <div class="vault-content-preview">${escapeHtml(v.konten)}</div>
          </div>`;
      }

      const primaryAction = isFile
        ? kind === 'IMAGE'
          ? `<button class="btn btn-primary btn-sm" type="button" data-zoom-vault="${previewUrl}"><i data-lucide="eye" class="icon-14"></i><span>Lihat</span></button>
             <a class="btn btn-secondary btn-sm" href="/api/vault/${v.id}/download" download><i data-lucide="download" class="icon-14"></i><span>Unduh</span></a>`
          : kind === 'PDF' || kind === 'TEXT'
          ? `<button class="btn btn-primary btn-sm" type="button" data-preview-vault="${v.id}"><i data-lucide="eye" class="icon-14"></i><span>Pratinjau</span></button>
             <a class="btn btn-secondary btn-sm" href="/api/vault/${v.id}/download" download><i data-lucide="download" class="icon-14"></i><span>Unduh</span></a>`
          : `<a class="btn btn-primary btn-sm" href="/api/vault/${v.id}/download" download><i data-lucide="download" class="icon-14"></i><span>Unduh File</span></a>`
        : `<button class="btn btn-primary btn-sm" type="button" data-copy-vault="${v.id}"><i data-lucide="copy" class="icon-14"></i><span>${safeLink ? 'Salin Link' : 'Salin Teks'}</span></button>${
            safeLink
              ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(v.konten)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link" class="icon-14"></i><span>Buka</span></a>`
              : ''
          }`;

      return `
      <article class="vault-card">
        ${stageHtml}
        <div class="vault-card-body">
          <div class="vault-title">${escapeHtml(v.kata_kunci)}</div>
          <div class="vault-card-footer">
            <div class="card-actions">${primaryAction}</div>
            <div class="memori-actions">
              <button class="icon-btn" type="button" title="Ubah Nama" aria-label="Ubah Nama" data-edit-vault="${v.id}">
                <i data-lucide="pencil" class="icon-14"></i>
              </button>
              <button class="icon-btn danger" type="button" title="Hapus" aria-label="Hapus" data-del-vault="${v.id}">
                <i data-lucide="trash-2" class="icon-14"></i>
              </button>
            </div>
          </div>
        </div>
      </article>`;
    })
    .join('');

  wrap.querySelectorAll('[data-zoom-vault]').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.zoomVault) openLightbox(el.dataset.zoomVault);
    });
  });

  wrap.querySelectorAll('[data-preview-vault]').forEach((el) => {
    el.addEventListener('click', () => {
      const item = state.vaultList.find((x) => x.id === Number(el.dataset.previewVault));
      if (item) openFilePreviewModal(item);
    });
  });

  wrap.querySelectorAll('[data-copy-vault]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = state.vaultList.find((x) => x.id === Number(btn.dataset.copyVault));
      if (!item) return;
      try {
        await navigator.clipboard.writeText(item.konten);
        toast('Konten berhasil disalin ke clipboard.', 'success');
      } catch {
        toast('Gagal menyalin otomatis. Salin manual dari kartu.', 'error');
      }
    });
  });

  wrap.querySelectorAll('[data-edit-vault]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.vaultList.find((x) => x.id === Number(btn.dataset.editVault));
      if (!item) return;
      $('#modal-vault-title').textContent = 'Ubah Nama Item Vault';
      $('#form-vault').reset();
      $('#vault-id').value = item.id;
      $('#vault-tipe').value = item.tipe;
      $('#vault-key').value = item.kata_kunci || '';
      $('#field-vault-tipe').classList.add('hidden');
      $('#field-vault-file').classList.add('hidden');
      if (item.tipe === 'LINK') {
        $('#vault-url').value = item.konten || '';
        $('#field-vault-link').classList.remove('hidden');
      } else {
        $('#field-vault-link').classList.add('hidden');
      }
      openModal('modal-vault');
    });
  });

  wrap.querySelectorAll('[data-del-vault]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus item vault ini?')) return;
      try {
        await api(`/api/vault/${btn.dataset.delVault}`, { method: 'DELETE' });
        toast('Item vault dihapus.', 'success');
        loadVault();
        loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

/* ==================== TAB 6: KEUANGAN ==================== */
const BULAN_SHORT_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function formatDateRangeShort(startIso, endIso) {
  const fmt = (iso) => {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return iso || '-';
    return `${d} ${BULAN_SHORT_ID[m - 1] || ''} ${y}`;
  };
  return `${fmt(startIso)} - ${fmt(endIso)}`;
}

function getMonthDateBounds(year, month1To12) {
  const lastDay = new Date(year, month1To12, 0).getDate();
  const mm = String(month1To12).padStart(2, '0');
  const dd = String(lastDay).padStart(2, '0');
  return {
    monthStr: `${year}-${mm}`,
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${dd}`,
  };
}

function computeFinancePeriodQuery() {
  const todayMonth = getCurrentMonthWibStr();
  const [curY, curM] = todayMonth.split('-').map(Number);

  if (state.financePeriod === 'last_month') {
    const d = new Date(curY, curM - 2, 1);
    const b = getMonthDateBounds(d.getFullYear(), d.getMonth() + 1);
    return {
      query: `month=${encodeURIComponent(b.monthStr)}`,
      rangeLabel: formatDateRangeShort(b.start, b.end),
      pickerMonth: b.monthStr,
    };
  }

  if (state.financePeriod === 'three_months') {
    const startD = new Date(curY, curM - 3, 1);
    const startBounds = getMonthDateBounds(startD.getFullYear(), startD.getMonth() + 1);
    const endBounds = getMonthDateBounds(curY, curM);
    return {
      query: `tanggal_mulai=${encodeURIComponent(startBounds.start)}&tanggal_akhir=${encodeURIComponent(endBounds.end)}`,
      rangeLabel: formatDateRangeShort(startBounds.start, endBounds.end),
      pickerMonth: endBounds.monthStr,
    };
  }

  if (state.financePeriod === 'custom') {
    const pickerVal = $('#expense-month-picker')?.value || todayMonth;
    const [y, m] = pickerVal.split('-').map(Number);
    const b = getMonthDateBounds(y || curY, m || curM);
    return {
      query: `month=${encodeURIComponent(b.monthStr)}`,
      rangeLabel: formatDateRangeShort(b.start, b.end),
      pickerMonth: b.monthStr,
    };
  }

  // Default: this_month
  const b = getMonthDateBounds(curY, curM);
  return {
    query: `month=${encodeURIComponent(b.monthStr)}`,
    rangeLabel: formatDateRangeShort(b.start, b.end),
    pickerMonth: b.monthStr,
  };
}

function pickFinanceCategoryIcon(cat, isIncome) {
  const map = {
    'Uang Saku': 'wallet',
    'Gaji & Freelance': 'briefcase',
    Beasiswa: 'graduation-cap',
    'Hadiah & Bonus': 'gift',
    'Makan & Minum': 'utensils',
    Transportasi: 'car',
    Akademik: 'book-open',
    Hiburan: 'sparkles',
    Lainnya: isIncome ? 'arrow-down-left' : 'receipt',
  };
  return map[cat] || (isIncome ? 'arrow-down-left' : 'arrow-up-right');
}

async function loadPengeluaran() {
  try {
    const periodInfo = computeFinancePeriodQuery();
    const picker = $('#expense-month-picker');
    if (picker && periodInfo.pickerMonth && state.financePeriod !== 'custom') {
      picker.value = periodInfo.pickerMonth;
    }
    state.financePeriodLabel = periodInfo.rangeLabel;
    state.financePeriodQuery = periodInfo.query;
    const exportBtn = $('#btn-export-csv');
    if (exportBtn) {
      exportBtn.href = `/api/pengeluaran/export?${periodInfo.query}`;
    }
    state.expenseData = await api(`/api/pengeluaran?${periodInfo.query}`);
    renderPengeluaran(state.expenseData);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setFinanceModalType(tipe = 'PENGELUARAN') {
  const isIncome = tipe === 'PEMASUKAN';
  const hidden = $('#expense-tipe');
  if (hidden) hidden.value = isIncome ? 'PEMASUKAN' : 'PENGELUARAN';

  $$('[data-set-fin-type]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.setFinType === (isIncome ? 'PEMASUKAN' : 'PENGELUARAN'));
  });

  const titleEl = $('#modal-expense-title');
  if (titleEl) titleEl.textContent = isIncome ? 'Catat Pemasukan' : 'Catat Pengeluaran';
  const itemLabel = $('#expense-item-label');
  if (itemLabel) itemLabel.textContent = isIncome ? 'Sumber Pemasukan' : 'Nama Item';
  const itemInput = $('#expense-item');
  if (itemInput) {
    itemInput.placeholder = isIncome
      ? 'Contoh: Uang saku / Gaji freelance / Beasiswa'
      : 'Contoh: Makan siang / Bensin';
  }
  const submitBtn = $('#expense-submit-btn');
  if (submitBtn) submitBtn.textContent = isIncome ? 'Simpan Pemasukan' : 'Simpan Pengeluaran';

  const select = $('#expense-kategori');
  if (select) {
    const cats = isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    select.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }
}

function renderPengeluaran(data) {
  const totalInc = Number(data.totalIncome) || 0;
  const totalExp = Number(data.totalExpense ?? data.total) || 0;
  const balance = Number(data.balance ?? totalInc - totalExp) || 0;

  if ($('#inc-month')) $('#inc-month').textContent = formatRupiah(totalInc);
  if ($('#inc-today')) $('#inc-today').textContent = `Hari ini: ${formatRupiah(data.todayIncome || 0)}`;
  if ($('#exp-month')) $('#exp-month').textContent = formatRupiah(totalExp);
  if ($('#exp-today')) $('#exp-today').textContent = `Hari ini: ${formatRupiah(data.todayTotal || 0)}`;
  if ($('#fin-balance')) $('#fin-balance').textContent = formatSignedRupiah(balance);
  if ($('#exp-count')) $('#exp-count').textContent = `${data.count} transaksi pada ${data.selectedMonth || '-'}`;
  if ($('#exp-week')) $('#exp-week').textContent = formatRupiah(data.weekTotal || 0);
  if ($('#inc-week')) $('#inc-week').textContent = `Pemasukan 7h: ${formatRupiah(data.weekIncome || 0)}`;

  renderExpenseChart(data);
  renderBudgetCard(data);

  const tbody = $('#expense-tbody');
  const empty = $('#expense-empty');
  const allItems = Array.isArray(data.items) ? data.items : [];
  const filteredItems =
    state.financeFilter === 'all'
      ? allItems
      : allItems.filter((item) => (item.tipe || 'PENGELUARAN') === state.financeFilter);

  if (!filteredItems.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    renderIcons();
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = filteredItems
    .map((e) => {
      const isIncome = (e.tipe || 'PENGELUARAN') === 'PEMASUKAN';
      return `
    <tr>
      <td class="mono text-xs">${escapeHtml(e.tanggal)}</td>
      <td>
        <div class="fin-item-cell">
          <span class="fin-dir-badge ${isIncome ? 'is-income' : 'is-expense'}" title="${isIncome ? 'Pemasukan' : 'Pengeluaran'}">
            <i data-lucide="${isIncome ? 'arrow-down-left' : 'arrow-up-right'}" class="icon-13"></i>
          </span>
          <strong>${escapeHtml(e.item)}</strong>
        </div>
      </td>
      <td><span class="pill ${isIncome ? 'pill-green' : 'pill-muted'}">${escapeHtml(e.kategori)}</span></td>
      <td class="text-right mono fw-600 ${isIncome ? 'amount-income' : 'amount-expense'}">${isIncome ? '+' : '-'}${formatRupiah(e.nominal)}</td>
      <td class="text-right">
        <button class="btn btn-danger-ghost btn-sm" type="button" data-del-exp="${e.id}">
          <i data-lucide="trash-2" class="icon-14"></i>
          <span>Hapus</span>
        </button>
      </td>
    </tr>`;
    })
    .join('');

  tbody.querySelectorAll('[data-del-exp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus transaksi keuangan ini?')) return;
      try {
        await api(`/api/pengeluaran/${btn.dataset.delExp}`, { method: 'DELETE' });
        toast('Transaksi dihapus.', 'success');
        loadPengeluaran();
        loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

function renderExpenseChart(data) {
  const totalInc = Number(data.totalIncome) || 0;
  const totalExp = Number(data.totalExpense ?? data.total) || 0;
  const balance = Number(data.balance ?? totalInc - totalExp) || 0;

  if ($('#report-balance')) $('#report-balance').textContent = formatSignedRupiah(balance);
  if ($('#report-income')) $('#report-income').textContent = formatRupiah(totalInc);
  if ($('#report-expense')) {
    $('#report-expense').textContent = totalExp > 0 ? `-${formatRupiah(totalExp)}` : formatRupiah(0);
  }

  // Ring Gauge: Pengeluaran ratio against Pemasukan (matches reference: e.g. 67% Pengeluaran)
  const rawPct = totalInc > 0 ? Math.round((totalExp / totalInc) * 100) : totalExp > 0 ? 100 : 0;
  const clampedVisualPct = Math.max(0, Math.min(100, rawPct));
  const circumference = 2 * Math.PI * 72; // r = 72 -> 452.39
  const offset = circumference * (1 - clampedVisualPct / 100);

  const ringEl = $('#report-ring-progress');
  if (ringEl) {
    ringEl.style.strokeDasharray = circumference.toFixed(2);
    ringEl.style.strokeDashoffset = offset.toFixed(2);
    ringEl.classList.toggle('is-over', rawPct >= 100);
    ringEl.classList.toggle('is-warn', rawPct >= 80 && rawPct < 100);
  }
  const pctEl = $('#report-ring-pct');
  if (pctEl) {
    pctEl.innerHTML = `${rawPct}<span class="pct-sign">%</span>`;
  }
  const labelEl = $('#report-ring-label');
  if (labelEl) {
    labelEl.textContent = 'Pengeluaran';
  }

  // Bottom category progress rows (Pemasukan / Pengeluaran underline tabs)
  const isIncomeMode = state.financeChartMode === 'PEMASUKAN';
  const sourceMap = isIncomeMode ? data.incomeByCategory || {} : data.byCategory || {};
  const modeTotal = isIncomeMode ? totalInc : totalExp;
  const rangeLabel = state.financePeriodLabel || data.selectedMonth || '-';

  const nonZeroEntries = Object.entries(sourceMap)
    .filter(([, val]) => Number(val) > 0)
    .sort((a, b) => b[1] - a[1]);

  const barsWrap = $('#expense-category-bars');
  if (!barsWrap) return;

  if (modeTotal <= 0 || !nonZeroEntries.length) {
    barsWrap.innerHTML = `
      <div class="report-cat-row">
        <span class="report-cat-icon">
          <i data-lucide="${isIncomeMode ? 'arrow-down-left' : 'arrow-up-right'}" class="icon-18"></i>
        </span>
        <div class="report-cat-main">
          <div class="report-cat-top">
            <span class="report-cat-name">${isIncomeMode ? 'Uang Masuk' : 'Uang Keluar'}</span>
            <span class="report-cat-amt mono">Rp 0</span>
          </div>
          <div class="report-cat-bar-track">
            <div class="report-cat-bar-fill" style="width:0%;"></div>
          </div>
          <div class="report-cat-meta">
            <span>${escapeHtml(rangeLabel)}</span>
            <span class="mono">0%</span>
          </div>
        </div>
      </div>`;
    renderIcons();
    return;
  }

  const summaryRow = `
    <div class="report-cat-row">
      <span class="report-cat-icon">
        <i data-lucide="${isIncomeMode ? 'arrow-down-left' : 'arrow-up-right'}" class="icon-18"></i>
      </span>
      <div class="report-cat-main">
        <div class="report-cat-top">
          <span class="report-cat-name">${isIncomeMode ? 'Total Uang Masuk' : 'Total Uang Keluar'}</span>
          <span class="report-cat-amt mono">${formatRupiah(modeTotal)}</span>
        </div>
        <div class="report-cat-bar-track">
          <div class="report-cat-bar-fill" style="width:100%;"></div>
        </div>
        <div class="report-cat-meta">
          <span>${escapeHtml(rangeLabel)}</span>
          <span class="mono">100%</span>
        </div>
      </div>
    </div>`;

  const catRows = nonZeroEntries
    .map(([cat, val]) => {
      const pct = modeTotal > 0 ? Math.round((val / modeTotal) * 100) : 0;
      const iconName = pickFinanceCategoryIcon(cat, isIncomeMode);
      return `
      <div class="report-cat-row">
        <span class="report-cat-icon">
          <i data-lucide="${iconName}" class="icon-18"></i>
        </span>
        <div class="report-cat-main">
          <div class="report-cat-top">
            <span class="report-cat-name">${escapeHtml(cat)}</span>
            <span class="report-cat-amt mono">${formatRupiah(val)}</span>
          </div>
          <div class="report-cat-bar-track">
            <div class="report-cat-bar-fill" style="width:${pct}%;"></div>
          </div>
          <div class="report-cat-meta">
            <span>${escapeHtml(rangeLabel)}</span>
            <span class="mono">${pct}%</span>
          </div>
        </div>
      </div>`;
    })
    .join('');

  barsWrap.innerHTML = summaryRow + catRows;
  renderIcons();
}

function renderBudgetCard(data) {
  const wrap = $('#budget-bars-wrap');
  const sub = $('#budget-status-sub');
  if (!wrap) return;

  const budget = data?.budget || { monthlyLimit: 0, byCategory: {} };
  const monthlyLimit = Number(budget.monthlyLimit) || 0;
  const spentTotal = Number(data?.monthTotal ?? data?.totalExpense ?? 0);
  const byCategory = budget.byCategory || {};
  const spentByCat = data?.byCategory || {};

  const rows = [];
  if (monthlyLimit > 0) {
    const pct = Math.round((spentTotal / monthlyLimit) * 100);
    const barW = Math.min(100, pct);
    const rem = monthlyLimit - spentTotal;
    const cls = pct >= 100 ? 'is-over' : pct >= 80 ? 'is-warn' : '';
    rows.push(`
      <div class="budget-row">
        <div class="budget-row-head">
          <strong>Total Bulanan</strong>
          <span class="mono">${formatRupiah(spentTotal)} / ${formatRupiah(monthlyLimit)} (${pct}%)</span>
        </div>
        <div class="budget-bar-track">
          <div class="budget-bar-fill ${cls}" style="width:${barW}%;"></div>
        </div>
        <div class="text-xs muted">
          ${rem >= 0 ? `Sisa budget: ${formatRupiah(rem)}` : `Melebihi budget sebesar ${formatRupiah(Math.abs(rem))}`}
        </div>
      </div>`);
  }

  for (const cat of EXPENSE_CATEGORIES) {
    const lim = Number(byCategory[cat]) || 0;
    if (lim <= 0) continue;
    const sp = Number(spentByCat[cat]) || 0;
    const pct = Math.round((sp / lim) * 100);
    const barW = Math.min(100, pct);
    const cls = pct >= 100 ? 'is-over' : pct >= 80 ? 'is-warn' : '';
    rows.push(`
      <div class="budget-row">
        <div class="budget-row-head">
          <span>${escapeHtml(cat)}</span>
          <span class="mono text-xs">${formatRupiah(sp)} / ${formatRupiah(lim)} (${pct}%)</span>
        </div>
        <div class="budget-bar-track">
          <div class="budget-bar-fill ${cls}" style="width:${barW}%;"></div>
        </div>
      </div>`);
  }

  if (!rows.length) {
    wrap.innerHTML =
      '<div class="text-sm muted">Belum ada batas budget yang diatur. Klik <strong>Atur Budget</strong> untuk mengaktifkan peringatan boros otomatis di 80% &amp; 100%.</div>';
    if (sub) sub.textContent = 'Notifikasi otomatis WA & Push saat tembus 80% dan 100%';
    return;
  }

  if (sub && monthlyLimit > 0) {
    const pct = Math.round((spentTotal / monthlyLimit) * 100);
    sub.textContent =
      pct >= 100
        ? `Peringatan: pengeluaran bulan ini sudah mencapai ${pct}% dari batas!`
        : pct >= 80
        ? `Hati-hati: pengeluaran sudah ${pct}% dari batas bulanan.`
        : `Aman: terpakai ${pct}% dari batas bulanan.`;
  }
  wrap.innerHTML = rows.join('');
}

function openBudgetModal() {
  const budget = state.expenseData?.budget || { monthlyLimit: 0, byCategory: {} };
  $('#budget-monthly-limit').value = budget.monthlyLimit || 0;
  $('#budget-cat-makan').value = budget.byCategory?.['Makan & Minum'] || 0;
  $('#budget-cat-transport').value = budget.byCategory?.Transportasi || 0;
  $('#budget-cat-akademik').value = budget.byCategory?.Akademik || 0;
  $('#budget-cat-hiburan').value = budget.byCategory?.Hiburan || 0;
  $('#budget-cat-lainnya').value = budget.byCategory?.Lainnya || 0;
  openModal('modal-budget');
}

/* ==================== HABIT TRACKER, FOCUS TIMER & QUICK REMINDERS ==================== */
async function loadHabits() {
  try {
    state.habitData = await api('/api/habits?days=56');
    renderHabits(state.habitData);
  } catch (err) {
    console.error(err);
  }
}

function renderHabits(data) {
  const sub = $('#habit-summary-sub');
  const gridEl = $('#habit-streak-grid');
  const listEl = $('#habit-list');
  if (!gridEl || !listEl) return;
  if (!hasSnapshotChanged('habits', data)) return;

  const summary = data?.summary || { totalHabits: 0, doneTodayCount: 0, bestStreak: 0 };
  if (sub) {
    sub.textContent = `${summary.doneTodayCount}/${summary.totalHabits} selesai hari ini • Streak terbaik ${summary.bestStreak} hari`;
  }

  const grid = Array.isArray(data?.grid) ? data.grid : [];
  gridEl.innerHTML = grid
    .map(
      (cell) =>
        `<span class="hm-cell lvl-${cell.level}" title="${escapeHtml(cell.tanggal)}: ${cell.count}/${cell.total} habit selesai"></span>`
    )
    .join('');

  const habits = Array.isArray(data?.habits) ? data.habits : [];
  if (!habits.length) {
    listEl.innerHTML =
      '<div class="text-sm muted">Belum ada habit harian. Klik <strong>+ Habit</strong> atau ketik <code>/h + Olahraga</code> di WhatsApp.</div>';
    renderIcons();
    return;
  }

  listEl.innerHTML = habits
    .map((h) => {
      const dots = (h.last7 || [])
        .map((d) => `<span class="habit-dot ${d.done ? 'on' : ''}" title="${escapeHtml(d.tanggal)}"></span>`)
        .join('');
      return `
      <div class="habit-row ${h.doneToday ? 'is-done' : ''}">
        <div class="habit-left">
          <button class="habit-check-btn ${h.doneToday ? 'checked' : ''}" type="button" data-toggle-habit="${h.id}" aria-label="Centang habit">
            <i data-lucide="check" class="icon-14"></i>
          </button>
          <div style="min-width:0;">
            <div class="fw-600 text-sm">${escapeHtml(h.nama)}</div>
            <div class="text-xs muted">${h.target_harian ? `${escapeHtml(h.target_harian)} • ` : ''}Streak ${h.streak} hari</div>
            <div class="habit-dots">${dots}</div>
          </div>
        </div>
        <button class="icon-btn danger" type="button" data-del-habit="${h.id}" title="Hapus Habit" aria-label="Hapus Habit">
          <i data-lucide="trash-2" class="icon-14"></i>
        </button>
      </div>`;
    })
    .join('');

  listEl.querySelectorAll('[data-toggle-habit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/habits/${btn.dataset.toggleHabit}/toggle`, {
          method: 'POST',
          body: JSON.stringify({ tanggal: getTodayWibStr() }),
        });
        loadHabits();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  listEl.querySelectorAll('[data-del-habit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Hapus habit ini beserta riwayat streaknya?')) return;
      try {
        await api(`/api/habits/${btn.dataset.delHabit}`, { method: 'DELETE' });
        toast('Habit dihapus.', 'success');
        loadHabits();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

function formatMmSs(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

async function loadFocus() {
  try {
    state.focusData = await api('/api/focus');
    renderFocus(state.focusData);
  } catch (err) {
    console.error(err);
  }
}

function renderFocus(data) {
  if (!hasSnapshotChanged('focus', { active: data?.active || null, stats: data?.stats || null })) return;
  if (state.focusTickTimer) {
    clearInterval(state.focusTickTimer);
    state.focusTickTimer = null;
  }

  const active = data?.active;
  const stats = data?.stats || { todaySessions: 0, todayMinutes: 0 };
  const clockEl = $('#focus-timer-display');
  const pillEl = $('#focus-status-pill');
  const topicEl = $('#focus-active-topic');
  const statsEl = $('#focus-today-stats');
  const startBtn = $('#btn-focus-start');
  const stopBtn = $('#btn-focus-stop');

  if (statsEl) {
    statsEl.textContent = `Hari ini: ${stats.todaySessions} sesi • ${stats.todayMinutes} menit fokus`;
  }

  if (!active || !active.active) {
    if (clockEl) clockEl.textContent = formatMmSs(state.focusPreset * 60);
    if (pillEl) {
      pillEl.className = 'pill pill-muted';
      pillEl.textContent = 'Siap';
    }
    if (topicEl) topicEl.textContent = 'Pilih durasi atau kirim /fokus 25 di WhatsApp';
    startBtn?.classList.remove('hidden');
    stopBtn?.classList.add('hidden');
    return;
  }

  if (pillEl) {
    pillEl.className = 'pill pill-green';
    pillEl.textContent = `Aktif • s/d ${active.endsAtDisplay || ''} WIB`;
  }
  if (topicEl) topicEl.textContent = `Sedang fokus: ${active.label}`;
  startBtn?.classList.add('hidden');
  stopBtn?.classList.remove('hidden');

  const endMs = new Date(active.endsAtIso).getTime();
  const updateTick = () => {
    const leftSec = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    if (clockEl) clockEl.textContent = formatMmSs(leftSec);
    if (leftSec <= 0 && state.focusTickTimer) {
      clearInterval(state.focusTickTimer);
      state.focusTickTimer = null;
      setTimeout(loadFocus, 1800);
    }
  };
  updateTick();
  state.focusTickTimer = setInterval(updateTick, 1000);
}

async function loadReminders() {
  try {
    state.reminderList = await api('/api/reminders?selesai=0');
    renderReminders(state.reminderList);
  } catch (err) {
    console.error(err);
  }
}

function renderReminders(list) {
  const wrap = $('#reminder-list');
  if (!wrap) return;
  if (!hasSnapshotChanged('reminders', list)) return;
  if (!list || !list.length) {
    wrap.innerHTML = '<div class="text-xs muted">Belum ada pengingat cepat aktif. Bisa juga lewat WA: <code>/r 30m angkat jemuran</code>.</div>';
    return;
  }
  wrap.innerHTML = list
    .map(
      (r) => `
      <div class="mini-item">
        <div>
          <div class="fw-600 text-sm">${escapeHtml(r.pesan)}</div>
          <div class="text-xs muted mono">${escapeHtml(r.trigger_at)} WIB</div>
        </div>
        <button class="icon-btn danger" type="button" data-del-rem="${r.id}" title="Hapus Pengingat" aria-label="Hapus Pengingat">
          <i data-lucide="x" class="icon-14"></i>
        </button>
      </div>`
    )
    .join('');

  wrap.querySelectorAll('[data-del-rem]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/reminders/${btn.dataset.delRem}`, { method: 'DELETE' });
        toast('Pengingat cepat dihapus.', 'success');
        loadReminders();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  renderIcons();
}

/* ==================== GLOBAL SPOTLIGHT SEARCH (CTRL+K) ==================== */
function openSpotlight() {
  openModal('modal-spotlight');
  const inp = $('#spotlight-input');
  if (inp) {
    inp.value = '';
    setTimeout(() => inp.focus(), 40);
  }
  const box = $('#spotlight-results');
  if (box) {
    box.innerHTML = '<div class="spotlight-empty muted text-sm">Ketik kata kunci untuk mencari di seluruh modul secara instan.</div>';
  }
}

async function runSpotlightSearch(q) {
  const box = $('#spotlight-results');
  if (!box) return;
  const clean = String(q || '').trim();
  if (!clean) {
    box.innerHTML = '<div class="spotlight-empty muted text-sm">Ketik kata kunci untuk mencari di seluruh modul secara instan.</div>';
    return;
  }

  try {
    const res = await api(`/api/search?q=${encodeURIComponent(clean)}`);
    if (!res.total) {
      box.innerHTML = `<div class="spotlight-empty muted text-sm">Tidak ditemukan hasil untuk "${escapeHtml(clean)}".</div>`;
      return;
    }

    const groups = [
      {
        title: 'Tugas & Deadline',
        tab: 'tugas',
        icon: 'check-square',
        items: (res.tugas || []).map((t) => ({ label: t.judul, meta: `${t.matkul ? `${t.matkul} • ` : ''}${t.deadline}` })),
      },
      {
        title: 'Jadwal & Presensi',
        tab: 'jadwal',
        icon: 'calendar-clock',
        items: (res.jadwal || []).map((j) => ({ label: j.nama, meta: `${j.hari || j.tanggal} • ${j.jam} WIB` })),
      },
      {
        title: 'Brankas Memori',
        tab: 'memori',
        icon: 'heart',
        items: (res.memori || []).map((m) => ({ label: m.isi.slice(0, 72), meta: `${m.hari}, ${m.tanggal}` })),
      },
      {
        title: 'Wishlist & Momen',
        tab: 'memori',
        icon: 'gift',
        items: (res.wishlist || []).map((w) => ({ label: w.judul, meta: `${w.tipe}${w.tanggal ? ` • ${w.tanggal}` : ''}` })),
      },
      {
        title: 'Quick Vault',
        tab: 'vault',
        icon: 'folder-lock',
        items: (res.vault || []).map((v) => ({ label: v.kata_kunci, meta: v.tipe })),
      },
      {
        title: 'Catatan Kuliah & Ide',
        tab: 'catatan',
        icon: 'book-open',
        items: (res.catatan || []).map((n) => ({ label: n.judul, meta: `${n.kategori} • ${n.sumber_tipe}` })),
      },
      {
        title: 'Keuangan',
        tab: 'keuangan',
        icon: 'wallet',
        items: (res.keuangan || []).map((k) => ({
          label: k.item,
          meta: `${k.tipe === 'PEMASUKAN' ? '+' : '-'}${formatRupiah(k.nominal)} • ${k.tanggal}`,
        })),
      },
      {
        title: 'Habit & Pengingat Cepat',
        tab: 'overview',
        icon: 'flame',
        items: [
          ...(res.habits || []).map((h) => ({ label: h.nama, meta: 'Habit Harian' })),
          ...(res.reminders || []).map((r) => ({ label: r.pesan, meta: `${r.trigger_at} WIB` })),
        ],
      },
    ].filter((g) => g.items.length > 0);

    box.innerHTML = groups
      .map(
        (g) => `
        <div>
          <div class="spotlight-group-title">${escapeHtml(g.title)}</div>
          ${g.items
            .map(
              (item) => `
            <button class="spotlight-item" type="button" data-spot-tab="${g.tab}">
              <span class="spotlight-item-left">
                <i data-lucide="${g.icon}" class="icon-15 muted"></i>
                <span class="spotlight-item-title">${escapeHtml(item.label)}</span>
              </span>
              <span class="text-xs muted mono">${escapeHtml(item.meta)}</span>
            </button>`
            )
            .join('')}
        </div>`
      )
      .join('');

    box.querySelectorAll('[data-spot-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeModal('modal-spotlight');
        switchTab(btn.dataset.spotTab);
      });
    });

    renderIcons();
  } catch (err) {
    box.innerHTML = `<div class="spotlight-empty muted text-sm">${escapeHtml(err.message)}</div>`;
  }
}

/* ==================== AI PARTNER IDEAS & MONTHLY RECAP ==================== */
async function openAiPartnerIdeas(customPrompt = '') {
  $('#ai-insight-title').textContent = 'Ide Kado & Date Personal AI';
  $('#ai-insight-sub').textContent = 'Disusun otomatis dari Brankas Memori & Wishlist pacarmu';
  $('#form-ai-ideas-prompt')?.classList.remove('hidden');
  $('#ai-insight-body').textContent = 'Sedang menganalisis Brankas Memori & Wishlist...';
  openModal('modal-ai-insight');

  try {
    const res = await api('/api/memori/ai-ideas', {
      method: 'POST',
      body: JSON.stringify({ prompt: customPrompt || 'Berikan rekomendasi ide kado dan ide date untuk pacar saya' }),
    });
    $('#ai-insight-body').textContent = res.content || 'Belum ada hasil.';
  } catch (err) {
    $('#ai-insight-body').textContent = `Gagal memuat rekomendasi AI: ${err.message}`;
  }
}

async function openAiPartnerRecap() {
  $('#ai-insight-title').textContent = 'Rekap Memori Pacar (30 Hari Terakhir)';
  $('#ai-insight-sub').textContent = 'Rangkuman momen terbaik bulan ini';
  $('#form-ai-ideas-prompt')?.classList.add('hidden');
  $('#ai-insight-body').textContent = 'Menyusun rangkuman kenangan 30 hari terakhir...';
  openModal('modal-ai-insight');

  try {
    const res = await api('/api/memori/monthly-recap', { method: 'POST' });
    $('#ai-insight-body').textContent = res.content || 'Belum ada catatan memori.';
  } catch (err) {
    $('#ai-insight-body').textContent = `Gagal menyusun rekap: ${err.message}`;
  }
}

/* ==================== SHARED FORMATTING HELPERS (4 FITUR BARU) ==================== */
function renderInlineFormatted(escapedStr) {
  return escapedStr.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderStructuredBulletsHtml(rawText, maxLines = 0) {
  const allLines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const lines = maxLines > 0 ? allLines.slice(0, maxLines) : allLines;
  if (!lines.length) return '<p class="note-para muted">Tidak ada ringkasan.</p>';

  const blocks = [];
  let currentList = [];
  const flushList = () => {
    if (currentList.length) {
      blocks.push(`<ul class="note-bullet-list">${currentList.map((li) => `<li>${li}</li>`).join('')}</ul>`);
      currentList = [];
    }
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bulletMatch) {
      currentList.push(renderInlineFormatted(escapeHtml(bulletMatch[1])));
    } else {
      flushList();
      blocks.push(`<p class="note-para">${renderInlineFormatted(escapeHtml(line))}</p>`);
    }
  }
  flushList();

  if (maxLines > 0 && allLines.length > maxLines) {
    blocks.push(`<p class="text-xs muted">+${allLines.length - maxLines} poin lainnya...</p>`);
  }
  return blocks.join('');
}

function formatUptime(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}h ${hours}j ${mins}m`;
  if (hours > 0) return `${hours}j ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}d`;
  return `${secs} dtk`;
}

/* ==================== FITUR 1: CATATAN KULIAH & IDE ==================== */
async function loadCatatan() {
  try {
    const params = new URLSearchParams();
    if (state.catatanCategory && state.catatanCategory !== 'all') {
      params.set('kategori', state.catatanCategory);
    }
    const q = $('#catatan-search-q')?.value.trim();
    if (q) params.set('q', q);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const data = await api(`/api/catatan${qs}`);
    state.catatanList = Array.isArray(data?.items) ? data.items : [];
    state.catatanCategories = Array.isArray(data?.categories) ? data.categories : [];
    renderCatatanCategories();
    renderCatatan();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderCatatanCategories() {
  const bar = $('#catatan-category-bar');
  const dl = $('#catatan-kategori-suggestions');
  if (bar) {
    const cats = state.catatanCategories || [];
    if (state.catatanCategory !== 'all' && !cats.some((c) => c.toLowerCase() === state.catatanCategory.toLowerCase())) {
      state.catatanCategory = 'all';
    }
    const pills = [
      `<button class="filter-pill ${state.catatanCategory === 'all' ? 'active' : ''}" data-catatan-cat="all" type="button">Semua</button>`,
      ...cats.map(
        (c) =>
          `<button class="filter-pill ${state.catatanCategory.toLowerCase() === c.toLowerCase() ? 'active' : ''}" data-catatan-cat="${escapeHtml(c)}" type="button">${escapeHtml(c)}</button>`
      ),
    ];
    bar.innerHTML = pills.join('');
    bar.querySelectorAll('[data-catatan-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.catatanCategory = btn.dataset.catatanCat || 'all';
        loadCatatan();
      });
    });
  }

  if (dl) {
    const defaults = ['Kriptografi', 'Sistem Terdistribusi', 'Pengolahan Citra Digital', 'Ide Proyek', 'Umum'];
    const merged = [...new Set([...(state.catatanCategories || []), ...defaults])];
    dl.innerHTML = merged.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  }
}

function pickNoteSourceIcon(src) {
  const s = String(src || 'TEXT').toUpperCase();
  if (s === 'VOICE') return 'mic';
  if (s === 'IMAGE') return 'image';
  return 'file-text';
}

function renderCatatan() {
  const wrap = $('#catatan-grid');
  const empty = $('#catatan-empty');
  if (!wrap || !empty) return;

  if (!state.catatanList.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    renderIcons();
    return;
  }

  empty.classList.add('hidden');
  wrap.innerHTML = state.catatanList
    .map((n) => {
      const dateShort = String(n.created_at || '').slice(0, 10) || '-';
      const srcIcon = pickNoteSourceIcon(n.sumber_tipe);
      return `
      <article class="note-card">
        <div class="note-card-head">
          <span class="pill pill-blue">${escapeHtml(n.kategori || 'Umum')}</span>
          <div class="memori-actions">
            <span class="pill pill-muted mono">
              <i data-lucide="${srcIcon}" class="icon-13"></i>
              <span>${escapeHtml(n.sumber_tipe || 'TEXT')}</span>
            </span>
          </div>
        </div>
        <div class="note-title">${escapeHtml(n.judul)}</div>
        <div class="note-bullets-preview">${renderStructuredBulletsHtml(n.ringkasan, 4)}</div>
        <div class="note-card-footer">
          <button class="btn btn-primary btn-sm" type="button" data-view-catatan="${n.id}">
            <i data-lucide="book-open" class="icon-14"></i>
            <span>Baca Detail</span>
          </button>
          <div class="memori-actions">
            <span class="text-xs muted mono">${escapeHtml(dateShort)}</span>
            <button class="icon-btn" type="button" title="Edit Catatan" aria-label="Edit Catatan" data-edit-catatan="${n.id}">
              <i data-lucide="pencil" class="icon-14"></i>
            </button>
            <button class="icon-btn danger" type="button" title="Hapus Catatan" aria-label="Hapus Catatan" data-del-catatan="${n.id}">
              <i data-lucide="trash-2" class="icon-14"></i>
            </button>
          </div>
        </div>
      </article>`;
    })
    .join('');

  wrap.querySelectorAll('[data-view-catatan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.catatanList.find((x) => x.id === Number(btn.dataset.viewCatatan));
      if (item) openCatatanDetail(item);
    });
  });

  wrap.querySelectorAll('[data-edit-catatan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.catatanList.find((x) => x.id === Number(btn.dataset.editCatatan));
      if (item) openCatatanEditModal(item);
    });
  });

  wrap.querySelectorAll('[data-del-catatan]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCatatanById(Number(btn.dataset.delCatatan)));
  });

  renderIcons();
}

function openCatatanDetail(item) {
  state.activeCatatanDetail = item;
  $('#catatan-detail-title').textContent = item.judul || 'Detail Catatan';
  const metaEl = $('#catatan-detail-meta');
  if (metaEl) {
    const srcIcon = pickNoteSourceIcon(item.sumber_tipe);
    metaEl.innerHTML = `
      <span class="pill pill-blue">${escapeHtml(item.kategori || 'Umum')}</span>
      <span class="pill pill-muted mono"><i data-lucide="${srcIcon}" class="icon-13"></i><span>${escapeHtml(item.sumber_tipe || 'TEXT')}</span></span>
      <span class="text-xs muted mono">${escapeHtml(String(item.created_at || '').slice(0, 16))}</span>
    `;
  }
  const bodyEl = $('#catatan-detail-body');
  if (bodyEl) {
    bodyEl.innerHTML = renderStructuredBulletsHtml(item.ringkasan, 0);
  }
  openModal('modal-catatan-detail');
}

function openCatatanEditModal(item) {
  $('#modal-catatan-title').textContent = 'Edit Catatan Kuliah / Ide';
  $('#form-catatan').reset();
  $('#catatan-id').value = item.id;
  $('#catatan-judul').value = item.judul || '';
  $('#catatan-kategori').value = item.kategori || 'Umum';
  $('#catatan-sumber').value = item.sumber_tipe || 'TEXT';
  $('#catatan-ringkasan').value = item.ringkasan || '';
  openModal('modal-catatan');
}

async function deleteCatatanById(id) {
  if (!id || !confirm('Hapus catatan ini?')) return;
  try {
    await api(`/api/catatan/${id}`, { method: 'DELETE' });
    toast('Catatan dihapus.', 'success');
    if (state.activeCatatanDetail?.id === id) {
      state.activeCatatanDetail = null;
      closeModal('modal-catatan-detail');
    }
    loadCatatan();
    loadStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ==================== FITUR 2: SYSTEM & AI TELEMETRY ==================== */
async function loadTelemetry() {
  try {
    const data = await api('/api/telemetry');
    state.telemetryData = data;
    renderTelemetry(data);
  } catch (err) {
    console.error(err);
  }
}

function renderTelemetry(data) {
  if (!data) return;
  const ai = data.ai || {};
  const srv = data.server || {};
  const gem = ai.gemini || { todayRequests: 0, dailyQuota: 1500, pct: 0, avgLatencyMs: 0 };
  const grq = ai.groq || { todayRequests: 0, dailyQuota: 1000, pct: 0, avgLatencyMs: 0 };

  if ($('#telemetry-model-sub')) {
    $('#telemetry-model-sub').textContent = `Primary: ${ai.primaryGeminiModel || 'gemini-3.8-flash'} • Aktif: ${ai.activeModel || '-'} • Groq Companion`;
  }
  if ($('#tel-gemini-model')) {
    $('#tel-gemini-model').textContent = `(${ai.primaryGeminiModel || 'gemini-3.8-flash'})`;
  }
  if ($('#tel-gemini-meta')) {
    $('#tel-gemini-meta').textContent = `${gem.todayRequests} / ${gem.dailyQuota} req (${gem.pct}%) • ${gem.avgLatencyMs} ms`;
  }
  if ($('#tel-gemini-bar')) {
    $('#tel-gemini-bar').style.width = `${Math.min(100, Math.max(gem.todayRequests > 0 ? 2 : 0, gem.pct))}%`;
    $('#tel-gemini-bar').className = `budget-bar-fill ${gem.pct >= 95 ? 'is-over' : gem.pct >= 80 ? 'is-warn' : 'bar-blue'}`;
  }

  if ($('#tel-groq-meta')) {
    $('#tel-groq-meta').textContent = `${grq.todayRequests} / ${grq.dailyQuota} req (${grq.pct}%) • ${grq.avgLatencyMs} ms`;
  }
  if ($('#tel-groq-bar')) {
    $('#tel-groq-bar').style.width = `${Math.min(100, Math.max(grq.todayRequests > 0 ? 2 : 0, grq.pct))}%`;
    $('#tel-groq-bar').className = `budget-bar-fill ${grq.pct >= 95 ? 'is-over' : grq.pct >= 80 ? 'is-warn' : 'bar-green'}`;
  }

  if ($('#tel-uptime')) $('#tel-uptime').textContent = formatUptime(srv.uptimeSeconds);
  if ($('#tel-ram')) $('#tel-ram').textContent = formatFileSize(srv.ramRssBytes) || '--';
  if ($('#tel-db-size')) $('#tel-db-size').textContent = formatFileSize(srv.dbSizeBytes) || '--';
  if ($('#tel-fallback')) {
    if (ai.lastFallback) {
      $('#tel-fallback').textContent = `${ai.lastFallback.provider} (${String(ai.lastFallback.created_at || '').slice(11, 16) || ai.lastFallback.tanggal})`;
    } else {
      $('#tel-fallback').textContent = 'Stabil (0 fallback)';
    }
  }
}

async function runAiEngineTest() {
  const btn = $('#btn-test-ai-engine');
  const box = $('#telemetry-test-result');
  if (btn) btn.disabled = true;
  if (box) {
    box.classList.remove('hidden');
    box.innerHTML = '<div class="text-sm muted">Menguji jalur koneksi Gemini (gemini-3.8-flash) dan Groq secara paralel...</div>';
  }
  try {
    const res = await api('/api/telemetry/test-ai', { method: 'POST' });
    if (res.telemetry) {
      state.telemetryData = res.telemetry;
      renderTelemetry(res.telemetry);
    }
    const t = res.test || {};
    const g = t.gemini || {};
    const q = t.groq || {};
    if (box) {
      box.innerHTML = `
        <div class="smart-planner-out-head" style="padding-bottom:8px;">
          <div class="card-title-group">
            <span class="pill ${t.fallbackReady ? 'pill-green' : 'pill-amber'}">${t.fallbackReady ? 'Dual-Engine Siap' : 'Parsial / Fallback'}</span>
            <span class="text-xs muted">${escapeHtml(t.summary || '')}</span>
          </div>
          <span class="text-xs muted mono">${escapeHtml(t.testedAt || '')}</span>
        </div>
        <div class="telemetry-test-grid">
          <div class="telemetry-test-row">
            <div class="telemetry-bar-head">
              <strong class="text-sm">Gemini</strong>
              <span class="pill ${g.ok ? 'pill-green' : 'pill-red'} mono">${escapeHtml(g.status || 'ERR')} • ${Number(g.latencyMs) || 0} ms</span>
            </div>
            <div class="text-xs muted mono">${escapeHtml(g.model || 'gemini-3.8-flash')}</div>
            ${g.error ? `<div class="text-xs muted">${escapeHtml(g.error)}</div>` : ''}
          </div>
          <div class="telemetry-test-row">
            <div class="telemetry-bar-head">
              <strong class="text-sm">Groq</strong>
              <span class="pill ${q.ok ? 'pill-green' : 'pill-red'} mono">${escapeHtml(q.status || 'ERR')} • ${Number(q.latencyMs) || 0} ms</span>
            </div>
            <div class="text-xs muted mono">${escapeHtml(q.model || '-')}</div>
            ${q.error ? `<div class="text-xs muted">${escapeHtml(q.error)}</div>` : ''}
          </div>
        </div>
      `;
    }
    toast('Pengujian AI Engine selesai.', t.fallbackReady ? 'success' : 'info');
  } catch (err) {
    if (box) {
      box.innerHTML = `<div class="text-sm muted">Pengujian gagal: ${escapeHtml(err.message)}</div>`;
    }
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ==================== FITUR 3: SMART DATE & GIFT ASSISTANT ==================== */
async function generateSmartPartnerRec(mode = 'date') {
  const budgetVal = $('#pacar-rec-budget')?.value.trim() || '';
  const box = $('#pacar-rec-result');
  const badge = $('#pacar-rec-badge');
  const meta = $('#pacar-rec-meta');
  const body = $('#pacar-rec-body');
  const btnDate = $('#btn-gen-date-ideas');
  const btnGift = $('#btn-gen-gift-ideas');

  if (btnDate) btnDate.disabled = true;
  if (btnGift) btnGift.disabled = true;

  const modeLabel = mode === 'gift' ? 'Rekomendasi Hadiah dari Wishlist' : 'Ide Kencan Weekend';
  if (box) box.classList.remove('hidden');
  if (badge) badge.textContent = modeLabel;
  if (meta) meta.textContent = 'Menganalisis 15 memori terbaru & wishlist aktif...';
  if (body) body.innerHTML = '<p class="note-para muted">Menyusun rekomendasi personal dari database...</p>';

  try {
    const res = await api('/api/pacar/rekomendasi', {
      method: 'POST',
      body: JSON.stringify({
        mode,
        budget: budgetVal ? Number(budgetVal) : null,
      }),
    });
    state.lastPacarRecText = res.content || '';
    const budgetLabel = res.budget ? ` • Budget ${formatRupiah(res.budget)}` : '';
    if (meta) {
      meta.textContent = `${res.memoriesUsed || 0} memori • ${res.wishlistsUsed || 0} wishlist aktif${budgetLabel}`;
    }
    if (body) {
      body.innerHTML = renderStructuredBulletsHtml(res.content || 'Belum ada hasil rekomendasi.', 0);
    }
    renderIcons();
  } catch (err) {
    if (meta) meta.textContent = 'Gagal memuat rekomendasi';
    if (body) body.innerHTML = `<p class="note-para muted">${escapeHtml(err.message)}</p>`;
    toast(err.message, 'error');
  } finally {
    if (btnDate) btnDate.disabled = false;
    if (btnGift) btnGift.disabled = false;
  }
}

/* ==================== FITUR 4: CALENDAR SYNC (.ICS) ==================== */
async function loadCalendarInfo() {
  try {
    const info = await api('/api/calendar/info');
    state.calendarInfo = info;
    renderCalendarInfo(info);
  } catch (err) {
    console.error(err);
  }
}

function renderCalendarInfo(info) {
  if (!info) return;
  const fullUrl = `${window.location.origin}${info.path || '/api/calendar.ics'}`;
  const input = $('#ics-feed-url-input');
  const dl = $('#btn-download-ics');
  const pill = $('#ics-sync-counts');

  if (input) input.value = fullUrl;
  if (dl) dl.href = info.path || '/api/calendar.ics';
  if (pill) pill.textContent = `${info.jadwalCount || 0} jadwal • ${info.tugasCount || 0} tugas`;
}

/* ==================== FORM & ACTION BINDINGS ==================== */
async function triggerWaReconnect() {
  try {
    await api('/api/whatsapp/reconnect', { method: 'POST' });
    toast('Menghubungkan ulang WhatsApp...', 'info');
    setTimeout(loadStatus, 1500);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function triggerWaLogout() {
  if (!confirm('Logout sesi WhatsApp saat ini dan buat QR Code baru?')) return;
  try {
    await api('/api/whatsapp/logout', { method: 'POST' });
    toast('Sesi WhatsApp dihapus, menunggu QR Code baru...', 'info');
    setTimeout(loadStatus, 2000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function bindFormsAndActions() {
  // Top bar & Overview actions
  $('#btn-enable-push')?.addEventListener('click', subscribeBrowserPush);
  $('#btn-header-ics')?.addEventListener('click', async () => {
    try {
      const info = state.calendarInfo || (await api('/api/calendar/info'));
      state.calendarInfo = info;
      renderCalendarInfo(info);
      const fullUrl = `${window.location.origin}${info.path || '/api/calendar.ics'}`;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(fullUrl);
        toast('Link Calendar Sync (.ics) disalin ke clipboard.', 'success');
      }
      switchTab('jadwal');
      setTimeout(() => {
        $('.calendar-sync-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#island-wa-trigger')?.addEventListener('click', () => {
    const st = state.statusData?.whatsapp?.status;
    if (st !== 'connected') {
      openQrModal();
    } else {
      switchTab('overview');
    }
  });
  $('#btn-open-qr-modal')?.addEventListener('click', openQrModal);
  $('#btn-wa-reconnect')?.addEventListener('click', triggerWaReconnect);
  $('#modal-btn-reconnect')?.addEventListener('click', triggerWaReconnect);
  $('#btn-wa-logout')?.addEventListener('click', triggerWaLogout);
  $('#modal-btn-logout')?.addEventListener('click', triggerWaLogout);

  $('#btn-test-notif')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/actions/test-notification', { method: 'POST' });
      const pushCount = res.result?.webPush?.sent || 0;
      const waOk = res.result?.whatsapp?.sent ? 'WA terkirim' : 'WA offline';
      toast(`Test notifikasi diproses (${waOk}, Push: ${pushCount} perangkat).`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-run-briefing')?.addEventListener('click', async () => {
    try {
      await api('/api/actions/morning-briefing', { method: 'POST' });
      toast('Morning Briefing telah dikirim.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-backup-wa')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/actions/backup-wa', { method: 'POST' });
      toast(`Backup ${res.result.fileName} berhasil dikirim ke WhatsApp.`, 'success');
    } catch (err) {
      toast(`Backup WhatsApp gagal: ${err.message}`, 'error');
    }
  });

  $('#btn-refresh-all')?.addEventListener('click', async () => {
    await refreshAll();
    toast('Seluruh data berhasil disinkronkan.', 'success');
  });

  // Jadwal filters & modal
  $$('[data-jadwal-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-jadwal-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.jadwalFilter = btn.dataset.jadwalFilter;
      loadJadwal();
    });
  });

  $('#jadwal-rutin')?.addEventListener('change', () => toggleJadwalFields(true));
  $('#jadwal-repeat-ok')?.addEventListener('change', syncJadwalRepeatField);
  $('#btn-open-jadwal-modal')?.addEventListener('click', () => {
    $('#modal-jadwal-title').textContent = 'Tambah Jadwal';
    $('#form-jadwal').reset();
    $('#jadwal-id').value = '';
    $('#jadwal-tanggal').value = getTodayWibStr();
    if ($('#jadwal-repeat-ok')) $('#jadwal-repeat-ok').checked = true;
    if ($('#jadwal-repeat-interval')) $('#jadwal-repeat-interval').value = 20;
    toggleJadwalFields(false);
    openModal('modal-jadwal');
  });

  $('#form-jadwal')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#jadwal-id').value;
    const isRutin = Number($('#jadwal-rutin').value);
    const body = {
      nama: $('#jadwal-nama').value.trim(),
      is_rutin: isRutin,
      hari: isRutin ? $('#jadwal-hari').value : null,
      tanggal: isRutin ? null : $('#jadwal-tanggal').value,
      jam: $('#jadwal-jam').value,
      repeat_until_ok: $('#jadwal-repeat-ok')?.checked ? 1 : 0,
      repeat_interval_min: Number($('#jadwal-repeat-interval')?.value) || 20,
    };
    try {
      if (id) {
        await api(`/api/jadwal/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Jadwal diperbarui.', 'success');
      } else {
        await api('/api/jadwal', { method: 'POST', body: JSON.stringify(body) });
        toast('Jadwal ditambahkan.', 'success');
      }
      closeModal('modal-jadwal');
      loadJadwal();
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Tugas filters & modal
  $$('[data-tugas-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-tugas-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tugasFilter = btn.dataset.tugasFilter;
      loadTugas();
    });
  });

  $('#btn-open-tugas-modal')?.addEventListener('click', () => {
    $('#modal-tugas-title').textContent = 'Tambah Tugas';
    $('#form-tugas').reset();
    $('#tugas-id').value = '';
    $('#tugas-deadline').value = `${getTodayWibStr()}T23:59`;
    openModal('modal-tugas');
  });

  $('#form-tugas')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#tugas-id').value;
    const body = {
      judul: $('#tugas-judul').value.trim(),
      matkul: $('#tugas-matkul').value.trim(),
      deadline: $('#tugas-deadline').value.replace('T', ' '),
    };
    try {
      if (id) {
        await api(`/api/tugas/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast('Tugas diperbarui.', 'success');
      } else {
        await api('/api/tugas', { method: 'POST', body: JSON.stringify(body) });
        toast('Tugas ditambahkan.', 'success');
      }
      closeModal('modal-tugas');
      loadTugas();
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Memori search & modal
  $('#btn-memori-search')?.addEventListener('click', loadMemori);
  $('#memori-search-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadMemori();
  });
  $('#btn-memori-reset')?.addEventListener('click', () => {
    $('#memori-search-q').value = '';
    $('#memori-search-date').value = '';
    loadMemori();
  });

  $('#btn-open-memori-modal')?.addEventListener('click', () => {
    $('#modal-memori-title').textContent = 'Catat Memori Baru';
    $('#form-memori').reset();
    $('#memori-id').value = '';
    $('#memori-tanggal').value = getTodayWibStr();
    openModal('modal-memori');
  });

  $('#form-memori')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#memori-id').value;
    const fd = new FormData();
    fd.append('tanggal', $('#memori-tanggal').value);
    fd.append('isi', $('#memori-isi').value.trim());
    fd.append('deskripsi', $('#memori-deskripsi').value.trim());
    const file = $('#memori-media').files[0];
    if (file) fd.append('media', file);

    try {
      if (id) {
        await api(`/api/memori/${id}`, { method: 'PUT', body: fd });
        toast('Memori dan deskripsi diperbarui.', 'success');
      } else {
        await api('/api/memori', { method: 'POST', body: fd });
        toast('Memori berhasil disimpan.', 'success');
      }
      closeModal('modal-memori');
      loadMemori();
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Wishlist / Momen modal
  $('#wishlist-tipe')?.addEventListener('change', toggleWishlistFields);

  $('#btn-open-wishlist-modal')?.addEventListener('click', () => {
    $('#modal-wishlist-title').textContent = 'Tambah Wishlist / Momen Spesial';
    $('#form-wishlist').reset();
    $('#wishlist-id').value = '';
    $('#wishlist-ulang').value = 'TAHUNAN';
    setDayCheckboxes('#wishlist-notif-days-group', '#wishlist-notif-custom', []);
    $('#wishlist-notif-jam').value = '';
    toggleWishlistFields();
    openModal('modal-wishlist');
  });

  $('#form-wishlist')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#wishlist-id').value;
    const tipe = $('#wishlist-tipe').value;
    const notifDays =
      tipe === 'MOMEN' ? readDayCheckboxes('#wishlist-notif-days-group', '#wishlist-notif-custom') : [];
    const body = {
      tipe,
      judul: $('#wishlist-judul').value.trim(),
      tanggal: tipe === 'MOMEN' ? $('#wishlist-tanggal').value || null : null,
      ulang: tipe === 'MOMEN' ? $('#wishlist-ulang').value || 'TAHUNAN' : 'TAHUNAN',
      catatan: $('#wishlist-catatan').value.trim(),
      notif_days: notifDays,
      notif_jam: tipe === 'MOMEN' ? $('#wishlist-notif-jam').value || '' : '',
    };
    try {
      if (id) {
        await api(`/api/wishlist/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Item berhasil diperbarui.', 'success');
      } else {
        await api('/api/wishlist', { method: 'POST', body: JSON.stringify(body) });
        toast(tipe === 'MOMEN' ? 'Momen spesial tersimpan.' : 'Wishlist ditambahkan.', 'success');
      }
      closeModal('modal-wishlist');
      loadWishlist();
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Notification timing settings modal
  $$('[data-open-notif-settings]').forEach((btn) => {
    btn.addEventListener('click', openNotifSettingsModal);
  });

  $('#form-notif-settings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const momentDays = readDayCheckboxes('#settings-moment-days-group', '#settings-moment-custom');
    if (!momentDays.length) {
      toast('Pilih minimal satu hari pengingat momen spesial.', 'error');
      return;
    }
    const payload = {
      momentDefaultDays: momentDays,
      momentDefaultTime: $('#settings-moment-time').value,
      morningBriefingEnabled: $('#settings-briefing-enabled').checked,
      morningBriefingTime: $('#settings-briefing-time').value,
      taskFirstReminderHours: Number($('#settings-task-first').value),
      taskSecondReminderHours: Number($('#settings-task-second').value),
      weeklyBackupEnabled: $('#settings-backup-enabled').checked,
      weeklyBackupDay: Number($('#settings-backup-day').value),
      weeklyBackupTime: $('#settings-backup-time').value,
    };
    try {
      await api('/api/settings/notifications', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      toast('Pengaturan waktu notifikasi tersimpan dan langsung aktif.', 'success');
      closeModal('modal-notif-settings');
      loadStatus();
      loadWishlist();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Vault filters & modal
  $$('[data-vault-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-vault-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.vaultFilter = btn.dataset.vaultFilter;
      loadVault();
    });
  });

  let vaultSearchTimeout;
  $('#vault-search-q')?.addEventListener('input', () => {
    clearTimeout(vaultSearchTimeout);
    vaultSearchTimeout = setTimeout(loadVault, 250);
  });

  $('#vault-tipe')?.addEventListener('change', () => {
    const isFile = $('#vault-tipe').value === 'FILE';
    $('#field-vault-link').classList.toggle('hidden', isFile);
    $('#field-vault-file').classList.toggle('hidden', !isFile);
  });

  $('#btn-open-vault-modal')?.addEventListener('click', () => {
    $('#modal-vault-title').textContent = 'Simpan ke Quick Vault';
    $('#form-vault').reset();
    $('#vault-id').value = '';
    $('#field-vault-tipe').classList.remove('hidden');
    $('#field-vault-link').classList.remove('hidden');
    $('#field-vault-file').classList.add('hidden');
    openModal('modal-vault');
  });

  $('#form-vault')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#vault-id').value;
    const tipe = $('#vault-tipe').value;
    const key = $('#vault-key').value.trim();
    try {
      if (id) {
        const body = { kata_kunci: key };
        if (tipe === 'LINK') {
          const url = $('#vault-url').value.trim();
          if (url) body.konten = url;
        }
        await api(`/api/vault/${id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        toast('Nama item vault berhasil diperbarui.', 'success');
      } else if (tipe === 'FILE') {
        const file = $('#vault-file').files[0];
        if (!file) {
          toast('Silakan pilih file terlebih dahulu.', 'error');
          return;
        }
        const fd = new FormData();
        fd.append('kata_kunci', key);
        fd.append('file', file);
        await api('/api/vault', { method: 'POST', body: fd });
        toast('Item tersimpan di Quick Vault.', 'success');
      } else {
        const url = $('#vault-url').value.trim();
        if (!url) {
          toast('Masukkan URL atau teks link.', 'error');
          return;
        }
        await api('/api/vault', {
          method: 'POST',
          body: JSON.stringify({ kata_kunci: key, konten: url, tipe: 'LINK' }),
        });
        toast('Item tersimpan di Quick Vault.', 'success');
      }
      closeModal('modal-vault');
      loadVault();
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Finance modal, period tabs, filters & month picker
  $('#expense-month-picker')?.addEventListener('change', () => {
    state.financePeriod = 'custom';
    $$('[data-report-period]').forEach((b) => b.classList.remove('active'));
    loadPengeluaran();
  });

  $$('[data-report-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-report-period]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.financePeriod = btn.dataset.reportPeriod || 'this_month';
      loadPengeluaran();
    });
  });

  $$('[data-fin-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-fin-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.financeFilter = btn.dataset.finFilter || 'all';
      if (state.expenseData) renderPengeluaran(state.expenseData);
    });
  });

  $$('[data-chart-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-chart-mode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.financeChartMode = btn.dataset.chartMode || 'PENGELUARAN';
      if (state.expenseData) renderExpenseChart(state.expenseData);
    });
  });

  $$('[data-set-fin-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setFinanceModalType(btn.dataset.setFinType || 'PENGELUARAN');
    });
  });

  $('#btn-open-expense-modal')?.addEventListener('click', () => {
    $('#form-expense').reset();
    $('#expense-tanggal').value = getTodayWibStr();
    setFinanceModalType('PENGELUARAN');
    openModal('modal-expense');
  });

  $('#btn-open-income-modal')?.addEventListener('click', () => {
    $('#form-expense').reset();
    $('#expense-tanggal').value = getTodayWibStr();
    setFinanceModalType('PEMASUKAN');
    openModal('modal-expense');
  });

  $('#form-expense')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tipe = $('#expense-tipe')?.value || 'PENGELUARAN';
    const body = {
      tipe,
      item: $('#expense-item').value.trim(),
      nominal: Number($('#expense-nominal').value),
      tanggal: $('#expense-tanggal').value,
      kategori: $('#expense-kategori').value,
    };
    try {
      await api('/api/pengeluaran', { method: 'POST', body: JSON.stringify(body) });
      toast(tipe === 'PEMASUKAN' ? 'Pemasukan dicatat.' : 'Pengeluaran dicatat.', 'success');
      closeModal('modal-expense');
      loadPengeluaran();
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Security Audit Logs modal
  $('#btn-open-audit-logs')?.addEventListener('click', () => {
    openModal('modal-audit-logs');
    loadAuditLogs();
  });

  // Global Spotlight Search (Ctrl+K / Cmd+K + Header button)
  $('#btn-open-spotlight')?.addEventListener('click', openSpotlight);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.authenticated || !state.pinRequired) openSpotlight();
    }
  });
  $('#spotlight-input')?.addEventListener('input', (e) => {
    if (state.spotlightTimer) clearTimeout(state.spotlightTimer);
    const val = e.target.value;
    state.spotlightTimer = setTimeout(() => runSpotlightSearch(val), 160);
  });

  // Budget Bulanan modal
  $('#btn-open-budget-modal')?.addEventListener('click', openBudgetModal);
  $('#btn-edit-budget-inline')?.addEventListener('click', openBudgetModal);
  $('#form-budget')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      monthlyLimit: Number($('#budget-monthly-limit').value) || 0,
      byCategory: {
        'Makan & Minum': Number($('#budget-cat-makan').value) || 0,
        Transportasi: Number($('#budget-cat-transport').value) || 0,
        Akademik: Number($('#budget-cat-akademik').value) || 0,
        Hiburan: Number($('#budget-cat-hiburan').value) || 0,
        Lainnya: Number($('#budget-cat-lainnya').value) || 0,
      },
    };
    try {
      await api('/api/budgets', { method: 'PUT', body: JSON.stringify(payload) });
      toast('Batas budget bulanan disimpan.', 'success');
      closeModal('modal-budget');
      loadPengeluaran();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Habit modal
  $('#btn-open-habit-modal')?.addEventListener('click', () => {
    $('#form-habit').reset();
    openModal('modal-habit');
  });
  $('#form-habit')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/habits', {
        method: 'POST',
        body: JSON.stringify({
          nama: $('#habit-nama').value.trim(),
          target_harian: $('#habit-target').value.trim(),
        }),
      });
      toast('Habit baru ditambahkan.', 'success');
      closeModal('modal-habit');
      loadHabits();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Focus Timer controls
  $$('[data-focus-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-focus-preset]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.focusPreset = Number(btn.dataset.focusPreset) || 25;
      if (!state.focusData?.active) {
        const clockEl = $('#focus-timer-display');
        if (clockEl) clockEl.textContent = formatMmSs(state.focusPreset * 60);
      }
    });
  });

  $('#btn-focus-start')?.addEventListener('click', async () => {
    const label = $('#focus-label-input')?.value.trim() || (state.focusPreset <= 10 ? 'Istirahat Singkat' : 'Sesi Fokus');
    try {
      const res = await api('/api/focus/start', {
        method: 'POST',
        body: JSON.stringify({ label, durationMinutes: state.focusPreset }),
      });
      state.focusData = res;
      renderFocus(res);
      toast(`Mode fokus ${state.focusPreset} menit dimulai.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-focus-stop')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/focus/stop', { method: 'POST' });
      state.focusData = res;
      renderFocus(res);
      toast('Sesi fokus dihentikan.', 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Quick Reminder inline form
  $('#form-quick-reminder')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const menit = Number($('#quick-rem-mins').value) || 30;
    const pesan = $('#quick-rem-msg').value.trim();
    if (!pesan) return;
    try {
      await api('/api/reminders', {
        method: 'POST',
        body: JSON.stringify({ menit, pesan }),
      });
      $('#quick-rem-msg').value = '';
      toast(`Pengingat dipasang untuk ${menit} menit lagi.`, 'success');
      loadReminders();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // AI Partner Ideas & Monthly Recap
  $('#btn-ai-partner-ideas')?.addEventListener('click', () => {
    if ($('#ai-ideas-input')) $('#ai-ideas-input').value = '';
    openAiPartnerIdeas('');
  });
  $('#form-ai-ideas-prompt')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#ai-ideas-input')?.value.trim() || '';
    openAiPartnerIdeas(q);
  });
  $('#btn-ai-partner-recap')?.addEventListener('click', openAiPartnerRecap);
  $('#btn-copy-ai-insight')?.addEventListener('click', async () => {
    const txt = $('#ai-insight-body')?.textContent || '';
    try {
      await navigator.clipboard.writeText(txt);
      toast('Hasil AI berhasil disalin.', 'success');
    } catch {
      toast('Gagal menyalin otomatis.', 'error');
    }
  });

  $('#btn-refresh-audit')?.addEventListener('click', loadAuditLogs);

  $('#btn-clear-audit')?.addEventListener('click', async () => {
    if (!confirm('Hapus seluruh riwayat log keamanan & akses?')) return;
    try {
      await api('/api/audit-logs', { method: 'DELETE' });
      toast('Riwayat log keamanan dibersihkan.', 'success');
      loadAuditLogs();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $$('[data-audit-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('[data-audit-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.auditFilter = btn.dataset.auditFilter || 'all';
      loadAuditLogs();
    });
  });

  // FITUR 1: Catatan Kuliah & Ide
  let catatanSearchTimer;
  $('#catatan-search-q')?.addEventListener('input', () => {
    clearTimeout(catatanSearchTimer);
    catatanSearchTimer = setTimeout(loadCatatan, 220);
  });

  $('#btn-open-catatan-modal')?.addEventListener('click', () => {
    $('#modal-catatan-title').textContent = 'Tambah Catatan Kuliah / Ide';
    $('#form-catatan').reset();
    $('#catatan-id').value = '';
    $('#catatan-sumber').value = 'TEXT';
    openModal('modal-catatan');
  });

  $('#form-catatan')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#catatan-id').value;
    const body = {
      judul: $('#catatan-judul').value.trim(),
      kategori: $('#catatan-kategori').value.trim() || 'Umum',
      sumber_tipe: $('#catatan-sumber').value || 'TEXT',
      ringkasan: $('#catatan-ringkasan').value.trim(),
    };
    try {
      if (id) {
        await api(`/api/catatan/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Catatan berhasil diperbarui.', 'success');
      } else {
        await api('/api/catatan', { method: 'POST', body: JSON.stringify(body) });
        toast('Catatan baru disimpan.', 'success');
      }
      closeModal('modal-catatan');
      loadCatatan();
      loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-copy-catatan-detail')?.addEventListener('click', async () => {
    const note = state.activeCatatanDetail;
    if (!note) return;
    try {
      await navigator.clipboard.writeText(`${note.judul} [${note.kategori}]\n\n${note.ringkasan}`);
      toast('Ringkasan catatan disalin ke clipboard.', 'success');
    } catch {
      toast('Gagal menyalin otomatis.', 'error');
    }
  });

  $('#btn-edit-catatan-detail')?.addEventListener('click', () => {
    const note = state.activeCatatanDetail;
    if (!note) return;
    closeModal('modal-catatan-detail');
    openCatatanEditModal(note);
  });

  $('#btn-del-catatan-detail')?.addEventListener('click', () => {
    if (state.activeCatatanDetail) deleteCatatanById(state.activeCatatanDetail.id);
  });

  // FITUR 2: System & AI Telemetry
  $('#btn-refresh-telemetry')?.addEventListener('click', async () => {
    await loadTelemetry();
    toast('Telemetry server & AI diperbarui.', 'info');
  });
  $('#btn-test-ai-engine')?.addEventListener('click', runAiEngineTest);

  // FITUR 3: Smart Date & Gift Assistant
  $('#btn-gen-date-ideas')?.addEventListener('click', () => generateSmartPartnerRec('date'));
  $('#btn-gen-gift-ideas')?.addEventListener('click', () => generateSmartPartnerRec('gift'));
  $('#btn-copy-pacar-rec')?.addEventListener('click', async () => {
    if (!state.lastPacarRecText) return;
    try {
      await navigator.clipboard.writeText(state.lastPacarRecText);
      toast('Rekomendasi AI berhasil disalin.', 'success');
    } catch {
      toast('Gagal menyalin otomatis.', 'error');
    }
  });
  $('#btn-clear-pacar-rec')?.addEventListener('click', () => {
    $('#pacar-rec-result')?.classList.add('hidden');
  });

  // FITUR 4: Calendar Sync (.ics)
  $('#btn-copy-ics-url')?.addEventListener('click', async () => {
    const url = $('#ics-feed-url-input')?.value || '';
    if (!url || !url.startsWith('http')) {
      toast('Link kalender belum siap.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link Kalender (.ics) berhasil disalin.', 'success');
    } catch {
      $('#ics-feed-url-input')?.select();
      toast('Salin manual link yang sudah ditandai.', 'info');
    }
  });
}

/* ==================== SECURITY & ACCESS AUDIT LOGS ==================== */
async function loadAuditLogs() {
  try {
    const params = new URLSearchParams({ limit: '100' });
    if (state.auditFilter && state.auditFilter !== 'all') {
      params.set('event', state.auditFilter);
    }
    const data = await api(`/api/audit-logs?${params.toString()}`);
    renderAuditLogs(data);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderAuditLogs(data) {
  const stats = data?.stats || {};
  const logs = Array.isArray(data?.logs) ? data.logs : [];

  if ($('#audit-stat-total')) $('#audit-stat-total').textContent = stats.total || 0;
  if ($('#audit-stat-success')) $('#audit-stat-success').textContent = stats.successCount || 0;
  if ($('#audit-stat-failed')) $('#audit-stat-failed').textContent = stats.failedCount || 0;
  if ($('#audit-stat-ips')) $('#audit-stat-ips').textContent = stats.uniqueIps || 0;

  const listEl = $('#audit-log-list');
  const emptyEl = $('#audit-log-empty');
  if (!listEl || !emptyEl) return;

  if (!logs.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    renderIcons();
    return;
  }

  emptyEl.classList.add('hidden');
  const eventMeta = {
    LOGIN_BERHASIL: { label: 'Login Berhasil', pill: 'pill-green', icon: 'shield-check', alert: false },
    PIN_SALAH: { label: 'PIN Salah', pill: 'pill-red', icon: 'shield-alert', alert: true },
    AKSES_DITOLAK: { label: 'Akses Ditolak', pill: 'pill-amber', icon: 'shield-off', alert: true },
    LOGOUT: { label: 'Logout', pill: 'pill-muted', icon: 'log-out', alert: false },
  };

  listEl.innerHTML = logs
    .map((l) => {
      const meta = eventMeta[l.event] || { label: l.event, pill: 'pill-muted', icon: 'activity', alert: false };
      const devIcon =
        l.device_type === 'mobile'
          ? 'smartphone'
          : l.device_type === 'tablet'
          ? 'tablet'
          : l.device_type === 'bot'
          ? 'terminal'
          : 'monitor';
      return `
      <div class="audit-row ${meta.alert ? 'is-alert' : ''}">
        <div class="audit-row-head">
          <span class="pill ${meta.pill}">
            <i data-lucide="${meta.icon}" class="icon-13"></i>
            <span>${escapeHtml(meta.label)}</span>
          </span>
          <span class="mono text-xs muted">${escapeHtml(l.waktu || '-')}</span>
        </div>
        <div class="audit-meta-grid">
          <div class="audit-meta-line">
            <i data-lucide="globe" class="icon-14"></i>
            <span class="mono fw-600">${escapeHtml(l.ip || '-')}</span>
            <span class="muted">• ${escapeHtml(l.path || '/')}</span>
          </div>
          <div class="audit-meta-line">
            <i data-lucide="map-pin" class="icon-14"></i>
            <span>${escapeHtml(l.lokasi || 'Tidak diketahui')}</span>
          </div>
          <div class="audit-meta-line">
            <i data-lucide="${devIcon}" class="icon-14"></i>
            <span>${escapeHtml(l.device || 'Perangkat tidak dikenal')}</span>
          </div>
        </div>
      </div>`;
    })
    .join('');

  renderIcons();
}

/* ==================== REAL-TIME SSE LIVE SYNC ==================== */
function disconnectLiveEvents() {
  state.sseConnected = false;
  if (state.eventSource) {
    try {
      state.eventSource.close();
    } catch {
      // ignore
    }
    state.eventSource = null;
  }
}

function connectLiveEvents() {
  if (typeof window.EventSource === 'undefined') return;
  disconnectLiveEvents();

  const es = new EventSource('/api/events');
  state.eventSource = es;

  es.addEventListener('open', () => {
    state.sseConnected = true;
  });
  es.addEventListener('connected', () => {
    state.sseConnected = true;
  });
  es.addEventListener('error', () => {
    state.sseConnected = false;
  });

  es.addEventListener('data-updated', (ev) => {
    try {
      const payload = JSON.parse(ev.data || '{}');
      const mod = payload.module;
      loadStatus();
      if (mod === 'jadwal') {
        loadJadwal();
        loadCalendarInfo();
      } else if (mod === 'tugas') {
        loadTugas();
        loadCalendarInfo();
      } else if (mod === 'catatan') loadCatatan();
      else if (mod === 'telemetry') loadTelemetry();
      else if (mod === 'memori') loadMemori();
      else if (mod === 'wishlist') loadWishlist();
      else if (mod === 'vault') loadVault();
      else if (mod === 'pengeluaran') loadPengeluaran();
      else if (mod === 'settings') loadWishlist();
      else if (mod === 'habits') loadHabits();
      else if (mod === 'focus') loadFocus();
      else if (mod === 'reminder') loadReminders();
      else if (mod === 'audit') {
        const modal = $('#modal-audit-logs');
        if (modal && !modal.classList.contains('hidden')) loadAuditLogs();
      } else refreshAll();

      if (payload.source === 'whatsapp') {
        const labels = {
          jadwal: 'Jadwal baru masuk dari WhatsApp.',
          tugas: 'Tugas diperbarui dari WhatsApp.',
          catatan: 'Catatan kuliah/ide baru masuk dari WhatsApp.',
          memori: 'Memori baru masuk dari WhatsApp.',
          wishlist: 'Wishlist atau momen baru dari WhatsApp.',
          vault: 'Item Vault baru masuk dari WhatsApp.',
          pengeluaran: 'Transaksi keuangan baru masuk dari WhatsApp.',
          habits: 'Habit harian diperbarui dari WhatsApp.',
          focus: 'Status Focus Timer diperbarui dari WhatsApp.',
          reminder: 'Pengingat cepat baru masuk dari WhatsApp.',
        };
        toast(labels[mod] || 'Data baru masuk dari WhatsApp.', 'success');
      }
    } catch {
      refreshAll();
    }
  });
}

async function refreshActiveTab() {
  const jobs = [loadStatus()];
  if (state.activeTab === 'overview') {
    jobs.push(loadTelemetry(), loadHabits(), loadReminders(), loadFocus());
  } else if (state.activeTab === 'jadwal') {
    jobs.push(loadJadwal(), loadCalendarInfo());
  } else if (state.activeTab === 'tugas') {
    jobs.push(loadTugas());
  } else if (state.activeTab === 'catatan') {
    jobs.push(loadCatatan());
  } else if (state.activeTab === 'memori') {
    jobs.push(loadMemori(), loadWishlist());
  } else if (state.activeTab === 'vault') {
    jobs.push(loadVault());
  } else if (state.activeTab === 'keuangan') {
    jobs.push(loadPengeluaran());
  }
  await Promise.all(jobs);
}

/* ==================== BOOTSTRAP ==================== */
async function refreshAll() {
  state.renderCache = {};
  await Promise.all([
    loadStatus(),
    loadTelemetry(),
    loadHabits(),
    loadReminders(),
    loadFocus(),
    loadJadwal(),
    loadCalendarInfo(),
    loadTugas(),
    loadCatatan(),
    loadMemori(),
    loadWishlist(),
    loadVault(),
    loadPengeluaran(),
  ]);
}

async function bootDashboard() {
  const initialHash = window.location.hash.replace('#', '');
  if (initialHash && TAB_ORDER.includes(initialHash)) {
    switchTab(initialHash);
  } else {
    // Lazy-load ONLY the active tab on initial boot (avoids 13-request burst on startup!)
    await refreshActiveTab();
  }
  await initServiceWorker();
  connectLiveEvents();

  // Refresh immediately when returning to the tab from background (bind once)
  if (!state.visibilityBound) {
    state.visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (state.authenticated || !state.pinRequired)) {
        loadStatus();
        if (state.activeTab === 'overview') loadTelemetry();
      }
    });
  }

  // Gentle 30s heartbeat (SSE already pushes instant real-time updates on every data change)
  if (state.statusPollTimer) clearInterval(state.statusPollTimer);
  state.statusPollTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.sseConnected) {
      loadStatus();
      if (state.activeTab === 'overview') loadTelemetry();
    } else {
      refreshActiveTab();
    }
  }, 30000);
}

document.addEventListener('DOMContentLoaded', () => {
  initThemeToggle();
  renderIcons();
  startClock();
  bindNavigation();
  bindModals();
  bindPinForm();
  bindFormsAndActions();
  checkAuthAndBoot();
});
