/* ==================== STATE & HELPERS ==================== */
const state = {
  activeTab: 'overview',
  jadwalFilter: 'all',
  tugasFilter: '0',
  vaultFilter: 'all',
  financeFilter: 'all',
  financeChartMode: 'PENGELUARAN',
  jadwalList: [],
  tugasList: [],
  memoriList: [],
  wishlistList: [],
  vaultList: [],
  expenseData: null,
  statusData: null,
  notifSettings: null,
  expenseChart: null,
  statusPollTimer: null,
  eventSource: null,
  authenticated: false,
  pinRequired: false,
  pushSubscribed: false,
};

const CATEGORY_COLORS = {
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

const EXPENSE_CATEGORIES = ['Makan & Minum', 'Transportasi', 'Akademik', 'Hiburan', 'Lainnya'];
const INCOME_CATEGORIES = ['Uang Saku', 'Gaji & Freelance', 'Beasiswa', 'Hadiah & Bonus', 'Lainnya'];

const HARI_BACKUP_LABELS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function renderIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }
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
const TAB_ORDER = ['overview', 'jadwal', 'tugas', 'memori', 'vault', 'keuangan'];

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

  if (target === 'overview') loadStatus();
  if (target === 'jadwal') loadJadwal();
  if (target === 'tugas') loadTugas();
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
  requestAnimationFrame(() => updateNavSliders(false));

  // KPI cards
  $('#kpi-jadwal').textContent = overview.todaySchedules.length;
  $('#kpi-jadwal-sub').textContent = `${stats.jadwal_aktif} jadwal aktif total`;
  $('#kpi-tugas').textContent = stats.tugas_aktif;
  $('#kpi-tugas-sub').textContent = `${stats.tugas} total tugas tercatat`;
  $('#kpi-expense').textContent = formatSignedRupiah(overview.monthBalance ?? -overview.monthExpenseTotal);
  $('#kpi-expense-today').textContent = `Masuk: ${formatRupiah(overview.monthIncomeTotal || 0)} • Keluar: ${formatRupiah(overview.monthExpenseTotal || 0)}`;
  $('#kpi-total-records').textContent = stats.total_records;
  $('#kpi-vault-sub').textContent = `${stats.memori_pacar} memori • ${stats.momen_wishlist} wishlist • ${stats.vault} vault`;

  // Dynamic Island & Overview WA Status
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
    islandLabel.textContent = 'WA Connected';
    pill.className = 'pill pill-green';
    pill.textContent = 'Connected';
    connBox.classList.remove('hidden');
    $('#wa-connected-meta').textContent = `Bot: ${whatsapp.connectedPhone || '-'} • Aktif sejak ${whatsapp.lastConnectedAt || '-'}`;
  } else if (whatsapp.status === 'qr' && whatsapp.qrCodeDataUrl) {
    islandDot.className = 'status-dot dot-amber';
    islandLabel.textContent = 'Bot Offline';
    islandQrCue.classList.remove('hidden');
    pill.className = 'pill pill-amber';
    pill.textContent = 'Menunggu Scan QR';
    qrBox.classList.remove('hidden');
    $('#wa-qr-img').src = whatsapp.qrCodeDataUrl;
  } else if (whatsapp.status === 'connecting') {
    islandDot.className = 'status-dot dot-amber';
    islandLabel.textContent = 'Connecting';
    pill.className = 'pill pill-blue';
    pill.textContent = 'Menghubungkan';
    discBox.classList.remove('hidden');
    $('#wa-error-text').textContent = 'Menghubungkan ke server WhatsApp (Baileys)...';
  } else {
    islandDot.className = 'status-dot dot-red';
    islandLabel.textContent = 'Disconnected';
    islandQrCue.classList.remove('hidden');
    pill.className = 'pill pill-red';
    pill.textContent = 'Disconnected';
    discBox.classList.remove('hidden');
    $('#wa-error-text').textContent = whatsapp.lastError || 'Belum terhubung ke WhatsApp.';
  }

  updateQrModalContent(whatsapp);

  // Readiness chips
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

  // Today's schedules
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

  // Urgent tasks & moments
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
      <td><strong>${escapeHtml(j.nama)}</strong></td>
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
      toggleJadwalFields();
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

function toggleJadwalFields() {
  const isRutin = $('#jadwal-rutin').value === '1';
  $('#field-jadwal-hari').classList.toggle('hidden', !isRutin);
  $('#field-jadwal-tanggal').classList.toggle('hidden', isRutin);
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
            <iframe class="vault-pdf-frame" src="${previewUrl}#toolbar=0&navpanes=0&scrollbar=0&page=1" tabindex="-1" title="${escapeHtml(v.kata_kunci)}"></iframe>
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
async function loadPengeluaran() {
  try {
    const picker = $('#expense-month-picker');
    if (picker && !picker.value) picker.value = getCurrentMonthWibStr();
    const month = picker?.value || getCurrentMonthWibStr();
    state.expenseData = await api(`/api/pengeluaran?month=${encodeURIComponent(month)}`);
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
  const isIncomeMode = state.financeChartMode === 'PEMASUKAN';
  const sourceMap = isIncomeMode ? data.incomeByCategory || {} : data.byCategory || {};
  const entries = Object.entries(sourceMap);
  const total = isIncomeMode ? Number(data.totalIncome) || 0 : Number(data.totalExpense ?? data.total) || 0;

  const barsWrap = $('#expense-category-bars');
  barsWrap.innerHTML = entries
    .map(([cat, val]) => {
      const pct = total > 0 ? Math.round((val / total) * 100) : 0;
      const color = CATEGORY_COLORS[cat] || '#d4d4d8';
      return `
      <div class="cat-bar-row">
        <div class="cat-bar-head">
          <span>${escapeHtml(cat)}</span>
          <span class="mono">${formatRupiah(val)} (${pct}%)</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${pct}%;background:${color};"></div>
        </div>
      </div>`;
    })
    .join('');

  const canvas = $('#expense-chart');
  if (!canvas || typeof window.Chart === 'undefined') return;

  if (state.expenseChart) {
    state.expenseChart.destroy();
    state.expenseChart = null;
  }

  const nonZero = entries.filter(([, v]) => v > 0);
  const labels = nonZero.length ? nonZero.map(([k]) => k) : ['Belum ada data'];
  const values = nonZero.length ? nonZero.map(([, v]) => v) : [1];
  const colors = nonZero.length
    ? nonZero.map(([k]) => CATEGORY_COLORS[k] || '#d4d4d8')
    : ['rgba(255, 255, 255, 0.16)'];

  state.expenseChart = new window.Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderColor: 'rgba(255, 255, 255, 0.12)',
          borderWidth: 1,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: 'rgba(255, 255, 255, 0.85)', boxWidth: 11, padding: 14 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              nonZero.length ? ` ${ctx.label}: ${formatRupiah(ctx.parsed)}` : ' Belum ada transaksi',
          },
        },
      },
    },
  });
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
  // Dynamic Island & Overview actions
  $('#btn-enable-push')?.addEventListener('click', subscribeBrowserPush);
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

  $('#jadwal-rutin')?.addEventListener('change', toggleJadwalFields);
  $('#btn-open-jadwal-modal')?.addEventListener('click', () => {
    $('#modal-jadwal-title').textContent = 'Tambah Jadwal';
    $('#form-jadwal').reset();
    $('#jadwal-id').value = '';
    $('#jadwal-tanggal').value = getTodayWibStr();
    toggleJadwalFields();
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

  // Finance modal, filters & month picker
  $('#expense-month-picker')?.addEventListener('change', loadPengeluaran);

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
}

/* ==================== REAL-TIME SSE LIVE SYNC ==================== */
function disconnectLiveEvents() {
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

  es.addEventListener('data-updated', (ev) => {
    try {
      const payload = JSON.parse(ev.data || '{}');
      const mod = payload.module;
      loadStatus();
      if (mod === 'jadwal') loadJadwal();
      else if (mod === 'tugas') loadTugas();
      else if (mod === 'memori') loadMemori();
      else if (mod === 'wishlist') loadWishlist();
      else if (mod === 'vault') loadVault();
      else if (mod === 'pengeluaran') loadPengeluaran();
      else if (mod === 'settings') loadWishlist();
      else refreshAll();

      if (payload.source === 'whatsapp') {
        const labels = {
          jadwal: 'Jadwal baru masuk dari WhatsApp.',
          tugas: 'Tugas diperbarui dari WhatsApp.',
          memori: 'Memori baru masuk dari WhatsApp.',
          wishlist: 'Wishlist atau momen baru dari WhatsApp.',
          vault: 'Item Vault baru masuk dari WhatsApp.',
          pengeluaran: 'Pengeluaran baru masuk dari WhatsApp.',
        };
        toast(labels[mod] || 'Data baru masuk dari WhatsApp.', 'success');
      }
    } catch {
      refreshAll();
    }
  });
}

function refreshActiveTab() {
  loadStatus();
  if (state.activeTab === 'jadwal') loadJadwal();
  else if (state.activeTab === 'tugas') loadTugas();
  else if (state.activeTab === 'memori') {
    loadMemori();
    loadWishlist();
  } else if (state.activeTab === 'vault') loadVault();
  else if (state.activeTab === 'keuangan') loadPengeluaran();
}

/* ==================== BOOTSTRAP ==================== */
async function refreshAll() {
  await Promise.all([
    loadStatus(),
    loadJadwal(),
    loadTugas(),
    loadMemori(),
    loadWishlist(),
    loadVault(),
    loadPengeluaran(),
  ]);
}

async function bootDashboard() {
  const initialHash = window.location.hash.replace('#', '');
  if (initialHash) {
    switchTab(initialHash);
  }
  await refreshAll();
  await initServiceWorker();
  connectLiveEvents();

  if (state.statusPollTimer) clearInterval(state.statusPollTimer);
  state.statusPollTimer = setInterval(() => {
    if (document.hidden) return;
    refreshActiveTab();
  }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  renderIcons();
  startClock();
  bindNavigation();
  bindModals();
  bindPinForm();
  bindFormsAndActions();
  checkAuthAndBoot();
});
