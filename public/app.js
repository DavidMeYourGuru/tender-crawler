/* global fetch */
import { escapeHtml, safeHttpUrl } from './ui-security.js';
'use strict';

const TOKEN_KEY = 'tender_crawler_token';
const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  view: 'tenders',
  inboxTab: 'unseen',
  activeProfileId: localStorage.getItem('tender_active_profile') || '',
  profiles: [],
  page: 1,
  filters: {
    q: '',
    sources: '',
    regions: '',
    status: '',
    cpv: '',
    sort: 'newest',
  },
  fpage: 1,
  ffilters: {
    q: '',
    geber: '',
    status: '',
    review: '',
    projectType: '',
    sort: 'deadline',
  },
  chatMessages: [],
  chatSending: false,
};

const $ = (id) => document.getElementById(id);
function showActionError(message) {
  const target = $('active-profile-description');
  if (target) { target.textContent = message; target.classList.add('error'); setTimeout(() => { target.classList.remove('error'); updateProfileHeader(); }, 4000); }
}

/* ---------- View-Umschaltung ---------- */

const VIEWS = ['tenders', 'profiles', 'admin', 'funding', 'funding-chat'];

function viewFromHash() {
  const h = (location.hash || '').replace(/^#/, '');
  return VIEWS.includes(h) ? h : 'tenders';
}

function switchView(view) {
  const target = VIEWS.includes(view) ? view : 'tenders';
  if (target === 'tenders') state.inboxTab = 'unseen';
  state.view = target;
  const isTenders = target === 'tenders';
  const isFunding = target === 'funding';
  const isChat = target === 'funding-chat';
  $('app').classList.toggle('hidden', !isTenders);
  $('profiles-app').classList.toggle('hidden', target !== 'profiles');
  $('admin-app').classList.toggle('hidden', target !== 'admin');
  $('funding-app').classList.toggle('hidden', !isFunding);
  $('funding-chat-app').classList.toggle('hidden', !isChat);
  $('tab-tenders').classList.toggle('active', target === 'tenders');
  $('tab-profiles').classList.toggle('active', target === 'profiles');
  $('tab-admin').classList.toggle('active', target === 'admin');
  document.querySelectorAll('[data-inbox-tab]').forEach((tab) => tab.classList.toggle('active', tab.dataset.inboxTab === state.inboxTab));
  $('tab-funding').classList.toggle('active', isFunding);
  $('tab-funding-chat').classList.toggle('active', isChat);
  // Tab im URL-Hash festhalten, damit er beim Reload erhalten bleibt.
  // replaceState löst kein hashchange aus → keine Endlosschleife.
  history.replaceState(null, '', `#${target}`);
  if (isTenders) loadTenders();
  if (isTenders) loadSearchProfiles();
  if (target === 'profiles') loadSearchProfiles();
  if (target === 'admin') { loadCrawls(); loadAdminSources(); }
  if (isFunding) loadFundingAll();
  if (isChat) initFundingChat();
}

// Beim Vor-/Zurück-Navigieren und manueller #-Änderung den Tab wechseln
window.addEventListener('hashchange', () => {
  const target = viewFromHash();
  if (target !== state.view) switchView(target);
});

$('tab-tenders').addEventListener('click', () => switchView('tenders'));
$('tab-profiles').addEventListener('click', () => switchView('profiles'));
$('tab-admin').addEventListener('click', () => switchView('admin'));
$('tab-funding').addEventListener('click', () => switchView('funding'));
$('tab-funding-chat').addEventListener('click', () => switchView('funding-chat'));

/* ---------- API-Helper ---------- */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body && typeof options.body === 'object' && !(options.body instanceof FormData)
      ? JSON.stringify(options.body)
      : options.body,
  });

  if (response.status === 401) {
    setToken('');
    showLogin();
    throw new Error('Nicht autorisiert');
  }
  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((data && data.error) || `HTTP ${response.status}`);
  }
  return data;
}

/* ---------- Token / Login ---------- */

function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function showLogin(message = '') {
  $('login-overlay').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('login-error').classList.toggle('hidden', !message);
  if (message) $('login-error').textContent = message;
  $('detail-overlay').classList.add('hidden');
}

function showApp() {
  $('login-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  // Beim Reload den zuletzt aktiven Tab aus dem URL-Hash wiederherstellen
  switchView(viewFromHash());
  refreshAll();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('token-input').value.trim();
  setToken(token);
  try {
    await api('/api/status');
    showApp();
  } catch (error) {
    setToken('');
    showLogin('Token ungültig – bitte erneut versuchen.');
  }
});

$('btn-logout').addEventListener('click', () => {
  setToken('');
  showLogin();
});

$('active-profile').addEventListener('change', () => {
  state.activeProfileId = $('active-profile').value;
  if (state.activeProfileId) localStorage.setItem('tender_active_profile', state.activeProfileId); else localStorage.removeItem('tender_active_profile');
  state.inboxTab = 'unseen'; document.querySelectorAll('[data-inbox-tab]').forEach((tab) => tab.classList.toggle('active', tab.dataset.inboxTab === state.inboxTab));
  updateProfileHeader(); loadTenders(); loadSearchProfiles();
});
document.querySelectorAll('[data-inbox-tab]').forEach((tab) => tab.addEventListener('click', () => {
  state.inboxTab = tab.dataset.inboxTab; document.querySelectorAll('[data-inbox-tab]').forEach((item) => item.classList.toggle('active', item === tab)); loadTenders();
}));
$('btn-new-profile').addEventListener('click', () => showProfileForm());
$('btn-cancel-profile').addEventListener('click', () => $('profile-form').classList.add('hidden'));
$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const id = $('profile-id').value;
  const cpvCodes = $('profile-cpvs').value.split(',').map((v) => v.trim()).filter(Boolean);
  const invalidCpvs = cpvCodes.filter((value) => !/^\d{8}(?:-\d)?$/.test(value));
  if (invalidCpvs.length) { $('profile-form-error').textContent = `Ungültige CPV-Codes: ${invalidCpvs.join(', ')}. Erwartet werden 8 Ziffern, optional mit Prüfziffer.`; $('profile-form-error').classList.remove('hidden'); return; }
  const body = { name: $('profile-name').value.trim(), keywords: $('profile-keywords').value.trim(), cpvCodes, regions: $('profile-regions').value.split(',').map((v) => v.trim()).filter(Boolean), sources: $('profile-sources').value.split(',').map((v) => v.trim()).filter(Boolean), statusFilter: $('profile-status').value, minLeadDays: $('profile-lead-days').value ? Number($('profile-lead-days').value) : null };
  try { const result = await api(id ? `/api/searches/${id}` : '/api/searches', { method: id ? 'PUT' : 'POST', body }); if (!id && !state.activeProfileId) { state.activeProfileId = String(result.id); localStorage.setItem('tender_active_profile', state.activeProfileId); } $('profile-form-error').textContent = ''; $('profile-form-error').classList.add('hidden'); $('profile-form').classList.add('hidden'); await loadSearchProfiles(); if (state.view === 'profiles') renderProfiles(); } catch (error) { $('profile-form-error').textContent = error.message; $('profile-form-error').classList.remove('hidden'); }
});

/* ---------- Formatierung ---------- */

const fmtDate = (value) => {
  if (!value) return '–';
  const [date] = String(value).split('T');
  return date;
};

const fmtCents = (cents, currency = 'EUR') => {
  if (cents == null) return '–';
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
};

const statusLabel = {
  open: 'Offen',
  closing_soon: 'Frist bald',
  closed: 'Geschlossen',
};

const fundingStatusLabel = {
  open: 'Offen',
  ongoing: 'Laufend',
  closed: 'Geschlossen',
  unknown: 'Unbekannt',
};

const fundingReviewLabel = {
  unreviewed: 'Ungeprüft',
  needs_review: 'Prüfbedürftig',
  verified: 'Verifiziert',
};

const fundingReviewClass = {
  unreviewed: 'chip-status-closed',
  needs_review: 'chip-status-closing_soon',
  verified: 'chip-status-open',
};

const fmtMonths = (min, max) => {
  if (min == null && max == null) return null;
  if (min != null && max != null && min !== max) return `${min}–${max} Monate`;
  const v = min ?? max;
  return `${v} Monat${v === 1 ? '' : 'e'}`;
};

const daysUntil = (isoDate) => {
  if (!isoDate) return null;
  let d = isoDate;
  if (d.includes('T')) d = d.split('T')[0];
  return Math.ceil((new Date(`${d}T23:59:59`).getTime() - Date.now()) / 86400000);
};

function linkKindLabel(kind) {
  return {
    guideline: 'Richtlinie',
    application: 'Antrag',
    document: 'Dokument',
    primary: 'Quelle',
  }[kind] || kind;
}

/**
 * HTML-escaped Text mit klickbaren HTTP(S)-Links.
 */
function linkify(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  const urlPattern = /(https?:\/\/[^\s<>"']+)/g;
  return escaped.replace(urlPattern, (url) => {
    const safe = escapeHtml(url);
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
  });
}

/* ---------- Status-Badge ---------- */

let activeJobIds = [];
let cancelPollTimer = null;
let directCrawlRunning = false;
let crawlBusy = false;

function jobModeLabel(job) {
  // Automatik-Modus: Backfill läuft, bis der Checkpoint vollständig ist
  const checkpointMode = job.source_id === 'evergabe' && !job.backfill_complete ? 'Initialimport' : 'Aktualisierung';
  return checkpointMode;
}

function updateStatusBadge(crawl, analysis, jobs) {
  const adminBadge = $('admin-status-badge');
  const badge = adminBadge || $('status-badge');
  const statusTitle = $('crawl-status-title');
  const jobStatusEl = $('job-status');
  const startBtn = $('btn-crawl');
  const cancelBtn = $('btn-cancel-job');
  const activeJobs = jobs?.active || [];
  const activeJob = activeJobs.find((job) => job.status === 'running') || activeJobs[0] || null;
  const isBusy = Boolean(crawl?.running || activeJob || analysis?.running);
  directCrawlRunning = Boolean(crawl?.running);
  crawlBusy = Boolean(directCrawlRunning || activeJob);
  activeJobIds = activeJobs.map((job) => job.id);

  if (crawl?.running) {
    badge.textContent = 'Crawl läuft';
    badge.className = 'badge badge-running';
    statusTitle.textContent = 'Ausschreibungsquellen werden aktualisiert';
    jobStatusEl.textContent = crawl.message || 'Der automatische Abruf läuft im Hintergrund.';
  } else if (activeJob) {
    badge.textContent = activeJob.status === 'running' ? 'Browser-Crawl läuft' : 'Browser-Crawl wartet';
    badge.className = 'badge badge-running';
    statusTitle.textContent = activeJob.status === 'running' ? 'Eine Plattform wird durchsucht' : 'Browser-Crawl wartet auf Verarbeitung';
  } else if (analysis?.running) {
    badge.textContent = 'LLM-Analyse läuft';
    badge.className = 'badge badge-running';
    statusTitle.textContent = 'Analyse läuft';
    jobStatusEl.textContent = 'Während der Analyse kann kein neuer Crawl gestartet werden.';
  } else {
    badge.textContent = 'Bereit';
    badge.className = 'badge badge-idle';
    statusTitle.textContent = 'Kein Crawl aktiv';
    jobStatusEl.textContent = 'Die Quellen können manuell aktualisiert werden.';
  }

  startBtn.classList.toggle('hidden', isBusy);
  startBtn.disabled = isBusy;

  // Job-Fortschritt (einziger sichtbarer Browser-Job pro Quelle)
  if (activeJob) {
    const progress = activeJob.pages_done
      ? ` · Seite ${activeJob.pages_done} (${activeJob.items_discovered} Treffer, ${activeJob.items_new} neu)`
      : '';
    jobStatusEl.textContent = `${jobModeLabel(activeJob)}: ${activeJob.source_name || activeJob.source_id}${progress}`;
  } else {
    activeJobIds = [];
  }
  const allBrowserJobsCancelling = activeJobs.length > 0 && activeJobs.every((job) => job.cancel_requested);
  const cancellationRequested = (!directCrawlRunning || crawl?.cancelRequested)
    && (!activeJobs.length || allBrowserJobsCancelling);
  cancelBtn.classList.toggle('hidden', !crawlBusy);
  cancelBtn.disabled = Boolean(cancellationRequested);
  cancelBtn.textContent = cancellationRequested ? 'Abbruch angefordert' : 'Crawl abbrechen';
}

async function loadStatus() {
  try {
    const data = await api('/api/status');
    updateStatusBadge(data.crawl, data.analysis, data.jobs);
  } catch (error) {
    console.error('Status konnte nicht geladen werden:', error.message);
  }
}

/* ---------- Daten laden ---------- */

async function refreshAll() {
  await Promise.all([loadStatus(), loadCrawls(), loadSources(), loadTenders(), loadSearchProfiles(), loadFundingStats(), loadFundingCrawls(), loadFundingPrograms()]);
}

async function loadSources() {
  try {
    const sources = await api('/api/sources');
    const select = $('filter-source');
    const current = state.filters.sources;
    select.innerHTML = '<option value="">Alle Quellen</option>';
    for (const source of sources) {
      // Deaktivierte Quellen (z. B. bund.de → eVergabe) nicht anbieten
      if (!source.enabled) continue;
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.name;
      if (source.id === current) option.selected = true;
      select.appendChild(option);
    }
    renderAdminSources(sources);
  } catch (error) {
    console.error('Quellen konnten nicht geladen werden:', error.message);
  }
}

async function loadCrawls() {
  try {
    const data = await api('/api/crawls?limit=10');
    const container = $('crawl-log');
    container.innerHTML = '';
    if (!data.crawls.length) {
      container.innerHTML = '<div class="crawl-entry"><span class="crawl-source">Noch keine Crawls</span></div>';
      return;
    }
    for (const crawl of data.crawls) {
      const entry = document.createElement('div');
      entry.className = 'crawl-entry';
      const duration = crawl.duration_ms != null
        ? ` · ${crawl.duration_ms >= 60000 ? `${Math.round(crawl.duration_ms / 60000)} min` : `${Math.round(crawl.duration_ms / 1000)} s`}`
        : '';
      entry.innerHTML = `
        <span class="crawl-source">${escapeHtml(crawl.source_name || 'alle')}</span>
        <span class="crawl-time">${fmtDate(crawl.started_at)}${duration}</span>
        <span class="crawl-nums">
          ${crawl.items_discovered} gefunden · ${crawl.items_new} neu · ${crawl.items_changed} geändert
          ${crawl.errors ? ` · <span style="color:var(--danger)">${crawl.errors} Fehler</span>` : ''}
        </span>
        <span class="chip chip-status-${escapeHtml(crawl.status || 'idle')}">${escapeHtml(crawl.status || '')}</span>
      `;
      container.appendChild(entry);
    }
  } catch (error) {
    console.error('Crawls konnten nicht geladen werden:', error.message);
  }
}

function renderAdminSources(sources) {
  const target = $('admin-source-list');
  if (!target) return;
  const visibleSources = sources.filter((source) => source.id !== 'bund');
  if (!visibleSources.length) { target.innerHTML = '<p class="muted">Keine Ausschreibungsquellen vorhanden.</p>'; return; }
  target.innerHTML = visibleSources.map((source) => `<div class="source-row"><div class="source-main"><strong>${escapeHtml(source.name || source.id)}</strong><span class="muted">${escapeHtml(source.region || '–')}</span></div><div class="source-meta"><span class="chip">${source.enabled ? 'Aktiv' : 'Deaktiviert'}</span><span class="muted">${source.last_crawl_at ? `Letzter Crawl: ${fmtDate(source.last_crawl_at)}` : 'Noch kein Crawl'}</span></div></div>`).join('');
}

async function loadAdminSources() {
  try { const sources = await api('/api/sources'); renderAdminSources(sources); } catch (error) { const target = $('admin-source-list'); if (target) target.innerHTML = `<p class="error">Quellen konnten nicht geladen werden: ${escapeHtml(error.message)}</p>`; }
}

function profileArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try { return JSON.parse(value) || []; } catch { return String(value).split(',').map((v) => v.trim()).filter(Boolean); }
}

async function loadSearchProfiles() {
  try {
    const data = await api('/api/searches');
    state.profiles = data.searches || [];
    if (state.activeProfileId && !state.profiles.some((profile) => String(profile.id) === String(state.activeProfileId))) {
      state.activeProfileId = '';
      localStorage.removeItem('tender_active_profile');
      state.inboxTab = 'unseen';
      ['count-all', 'count-watch', 'count-unseen', 'stat-total-open', 'stat-new-today', 'stat-new-7d'].forEach((id) => { if ($(id)) $(id).textContent = '0'; });
      renderTenders({ total: 0, tenders: [], page: 1, totalPages: 0 });
    }
    const picker = $('active-profile');
    if (picker) {
      picker.innerHTML = '<option value="">Kein Profil ausgewählt</option>';
      state.profiles.forEach((profile) => {
        const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name;
        if (String(profile.id) === String(state.activeProfileId)) option.selected = true;
        picker.appendChild(option);
      });
    }
    renderProfiles();
    updateProfileHeader();
    if (!state.activeProfileId) ['count-all', 'count-watch', 'count-unseen', 'stat-total-open', 'stat-new-today', 'stat-new-7d'].forEach((id) => { if ($(id)) $(id).textContent = '0'; });
    if (state.activeProfileId) {
      const counts = await api(`/api/searches/${state.activeProfileId}/counts`).catch(() => null);
      if (counts) {
        $('count-all').textContent = counts.total; $('count-watch').textContent = counts.watch; $('count-unseen').textContent = counts.unseen;
        $('stat-total-open').textContent = counts.unseen; $('stat-new-today').textContent = counts.total; $('stat-new-7d').textContent = counts.watch;
      }
    }
  } catch (error) { console.error('Suchprofile konnten nicht geladen werden:', error.message); }
}

function updateProfileHeader() {
  const profile = state.profiles.find((item) => String(item.id) === String(state.activeProfileId));
  $('active-profile-title').textContent = profile ? profile.name : 'Dein Posteingang';
  $('active-profile-description').textContent = profile ? `${profile.keywords || 'CPV-basierte Suche'} · passende Verfahren aus deinem Suchprofil` : 'Wähle ein Suchprofil, um passende Verfahren zu sehen.';
}

function renderProfiles() {
  const list = $('profile-list'); if (!list) return;
  list.innerHTML = '';
  if (!state.profiles.length) { list.innerHTML = '<div class="empty-state"><h3>Noch kein Suchprofil</h3><p>Erstelle ein Profil mit deinen CPV-Codes und Fachbegriffen.</p><button class="btn btn-primary" id="empty-new-profile">Profil anlegen</button></div>'; $('empty-new-profile')?.addEventListener('click', () => showProfileForm()); return; }
  state.profiles.forEach((profile) => {
    const card = document.createElement('article'); card.className = 'card profile-card';
    const cpvs = profileArray(profile.cpv_codes); const regions = profileArray(profile.regions);
    card.innerHTML = `<div class="profile-card-head"><h3>${escapeHtml(profile.name)}</h3><span class="chip">${profile.status_filter === 'open' ? 'Offen' : 'Aktiv'}</span></div><p class="muted">${escapeHtml(profile.keywords || 'Keine Suchbegriffe')}</p><div class="chip-group">${cpvs.map((cpv) => `<span class="chip">CPV ${escapeHtml(cpv)}</span>`).join('') || '<span class="muted">Keine CPVs</span>'}</div><small>${regions.length ? `Regionen: ${escapeHtml(regions.join(', '))}` : 'Alle Regionen'}${profile.min_lead_days != null ? ` · mindestens ${profile.min_lead_days} Tage Vorlauf` : ''}</small><div class="profile-actions"><button class="btn btn-primary" data-use="${profile.id}">Verwenden</button><button class="btn" data-edit="${profile.id}">Bearbeiten</button><button class="btn btn-ghost" data-delete="${profile.id}">Löschen</button></div>`;
    card.querySelector('[data-use]').addEventListener('click', () => { state.activeProfileId = String(profile.id); localStorage.setItem('tender_active_profile', state.activeProfileId); switchView('tenders'); });
    card.querySelector('[data-edit]').addEventListener('click', () => showProfileForm(profile));
    card.querySelector('[data-delete]').addEventListener('click', async () => { if (confirm(`Profil „${profile.name}“ löschen?`)) { try { await api(`/api/searches/${profile.id}`, { method: 'DELETE' }); if (String(profile.id) === state.activeProfileId) { state.activeProfileId = ''; localStorage.removeItem('tender_active_profile'); } await loadSearchProfiles(); } catch (error) { showActionError(error.message); } } });
    list.appendChild(card);
  });
}

function showProfileForm(profile = null) {
  $('profile-form').classList.remove('hidden'); $('profile-form-title').textContent = profile ? 'Suchprofil bearbeiten' : 'Neues Suchprofil';
  $('profile-form-error').textContent = ''; $('profile-form-error').classList.add('hidden');
  $('profile-id').value = profile?.id || ''; $('profile-name').value = profile?.name || ''; $('profile-keywords').value = profile?.keywords || '';
  $('profile-cpvs').value = profileArray(profile?.cpv_codes).join(', '); $('profile-regions').value = profileArray(profile?.regions).join(', '); $('profile-sources').value = profileArray(profile?.sources).join(', '); $('profile-status').value = profile?.status_filter || 'open'; $('profile-lead-days').value = profile?.min_lead_days ?? '';
  $('profile-name').focus();
}

async function loadTenders() {
  try {
    if (!state.activeProfileId) { renderTenders({ total: 0, tenders: [], page: 1, totalPages: 0 }); return; }
    const params = new URLSearchParams({
      page: state.page,
      limit: 25,
      sort: state.filters.sort,
    });
    params.set('profile_id', state.activeProfileId);
    if (state.inboxTab === 'watch') params.set('user_state', 'watch');
    if (state.inboxTab === 'unseen') params.set('user_state', 'unseen');
    if (state.filters.q) params.set('q', state.filters.q);
    if (state.filters.sources) params.set('sources', state.filters.sources);
    if (state.filters.regions) params.set('regions', state.filters.regions);
    if (state.filters.status) params.set('status', state.filters.status);
    if (state.filters.cpv) params.set('cpv', state.filters.cpv);

    const data = await api(`/api/tenders?${params.toString()}`);
    renderTenders(data);
  } catch (error) {
    console.error('Tender konnten nicht geladen werden:', error.message);
  }
}

/* ---------- Tender rendern ---------- */

function renderTenders(data) {
  const list = $('tender-list');
  list.innerHTML = '';
  $('tender-count').textContent = `(${data.total})`;

  if (!data.tenders.length) {
    list.innerHTML = state.activeProfileId
      ? '<div class="empty-state"><h3>Keine Treffer in dieser Ansicht</h3><p>Neue passende Ausschreibungen erscheinen nach dem nächsten Crawl.</p></div>'
      : '<div class="empty-state"><h3>Starte mit einem Suchprofil</h3><p>Definiere CPV-Codes und Fachbegriffe, damit hier relevante Verfahren erscheinen.</p><button class="btn btn-primary" id="empty-profile-cta">Suchprofil anlegen</button></div>';
    $('empty-profile-cta')?.addEventListener('click', () => switchView('profiles'));
    $('pagination').innerHTML = '';
    return;
  }

  for (const tender of data.tenders) {
    const item = document.createElement('div');
    item.className = 'tender-item';
    const deadlineDays = daysUntil(tender.submission_deadline);
    const cpvChips = (tender.cpv_codes || []).slice(0, 4).map((code) => `<span class="chip">CPV ${escapeHtml(code)}</span>`).join('');
    const activeProfile = state.profiles.find((profile) => String(profile.id) === String(state.activeProfileId));
    const tenderText = `${tender.title || ''} ${tender.description || ''}`.toLowerCase();
    const matchedCpvs = activeProfile ? profileArray(activeProfile.cpv_codes).filter((code) => (tender.cpv_codes || []).some((candidate) => String(candidate).startsWith(String(code)))) : [];
    const matchedKeywords = activeProfile ? String(activeProfile.keywords || '').split(/[,\n]+/).map((value) => value.trim()).filter((value) => value && tenderText.includes(value.toLowerCase())) : [];
    const matchReasons = [...matchedCpvs.map((code) => `CPV ${code}`), ...matchedKeywords].slice(0, 4);
    item.innerHTML = `
      <div class="tender-card-top"><div class="tender-title">${escapeHtml(tender.title)}</div><span class="deadline ${deadlineDays != null && deadlineDays < 14 ? 'deadline-soon' : ''}">${deadlineDays != null ? `in ${Math.max(0, deadlineDays)} Tagen` : 'Keine Frist'}</span></div>
      <div class="tender-meta">
        <span>${escapeHtml(tender.contracting_authority || tender.source_name || tender.source_id || 'Auftraggeber unbekannt')}</span>
        <span>${escapeHtml(tender.place_of_performance || 'Ort nicht angegeben')}</span>
        ${tender.submission_deadline ? `<span>Frist: ${fmtDate(tender.submission_deadline)}</span>` : ''}
      </div>
      <div class="chip-group">${cpvChips || '<span class="muted">Keine CPV-Angabe</span>'}</div>
      <div class="match-reason"><strong>Passt wegen:</strong> ${escapeHtml(matchReasons.join(', ') || 'passendem Suchprofil')}</div>
      <div class="tender-actions"><button class="btn btn-small" data-state="${tender.user_state === 'watch' ? 'seen' : 'watch'}">${tender.user_state === 'watch' ? '★ Beobachtet · entfernen' : '☆ Beobachten'}</button><button class="btn btn-small btn-ghost" data-state="dismiss">Unpassend</button><button class="btn btn-small btn-ghost" data-details>Details</button></div>
    `;
    item.querySelector('[data-details]').addEventListener('click', (event) => { event.stopPropagation(); openDetail(tender.id); });
    item.querySelectorAll('[data-state]').forEach((button) => button.addEventListener('click', async (event) => { event.stopPropagation(); try { await api(`/api/tenders/${tender.id}/state`, { method: 'POST', body: { state: button.dataset.state } }); await loadTenders(); await loadSearchProfiles(); } catch (error) { showActionError(error.message); } }));
    item.addEventListener('click', () => openDetail(tender.id));
    list.appendChild(item);
  }

  renderPagination(data);
}

function renderPagination(data) {
  const pagination = $('pagination');
  pagination.innerHTML = '';

  if (data.totalPages <= 1) return;

  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn';
  prevBtn.textContent = '‹';
  prevBtn.disabled = data.page <= 1;
  prevBtn.addEventListener('click', () => {
    state.page = Math.max(1, data.page - 1);
    loadTenders();
  });
  pagination.appendChild(prevBtn);

  const start = Math.max(1, data.page - 2);
  const end = Math.min(data.totalPages, data.page + 2);
  for (let i = start; i <= end; i += 1) {
    const btn = document.createElement('button');
    btn.className = `btn${i === data.page ? ' active' : ''}`;
    btn.textContent = i;
    btn.addEventListener('click', () => {
      state.page = i;
      loadTenders();
    });
    pagination.appendChild(btn);
  }

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn';
  nextBtn.textContent = '›';
  nextBtn.disabled = data.page >= data.totalPages;
  nextBtn.addEventListener('click', () => {
    state.page = Math.min(data.totalPages, data.page + 1);
    loadTenders();
  });
  pagination.appendChild(nextBtn);
}

/* ---------- Förderprogramme ---------- */

async function loadFundingAll() {
  await Promise.all([loadFundingStats(), loadFundingCrawls(), loadFundingPrograms(), loadSourcesManaged()]);
}

async function loadFundingStats() {
  try {
    const stats = await api('/api/funding/stats');
    $('f-stat-open').textContent = stats.open;
    $('f-stat-total').textContent = stats.total;
    $('f-stat-review').textContent = stats.needsReview;
    $('f-stat-verified').textContent = stats.verified;
    $('f-stat-closing').textContent = stats.closingSoon;
  } catch (error) {
    console.error('Förder-Statistiken konnten nicht geladen werden:', error.message);
  }
}

async function loadFundingCrawls() {
  try {
    const data = await api('/api/funding/crawls?limit=6');
    const container = $('funding-crawl-log');
    container.innerHTML = '';
    if (!data.crawls.length) {
      container.innerHTML = '<div class="crawl-entry"><span class="crawl-source">Noch keine Förder-Crawls</span></div>';
      return;
    }
    for (const crawl of data.crawls) {
      const entry = document.createElement('div');
      entry.className = 'crawl-entry';
      entry.innerHTML = `
        <span class="crawl-source">Förder-Crawl</span>
        <span class="crawl-time">${fmtDate(crawl.started_at)}</span>
        <span class="crawl-nums">
          ${crawl.items_discovered} gefunden · ${crawl.items_new} neu · ${crawl.items_changed} geändert
          · ${crawl.documents_loaded} Dokumente
          ${crawl.needs_review ? ` · ${crawl.needs_review} prüfbedürftig` : ''}
          ${crawl.errors ? ` · <span style="color:var(--danger)">${crawl.errors} Fehler</span>` : ''}
        </span>
        <span class="chip chip-status-${escapeHtml(crawl.status === 'completed' ? 'open' : 'closing_soon')}">${escapeHtml(crawl.status)}</span>
      `;
      container.appendChild(entry);
    }
  } catch (error) {
    console.error('Förder-Crawls konnten nicht geladen werden:', error.message);
  }
}

async function loadFundingPrograms() {
  try {
    const params = new URLSearchParams({ page: state.fpage, limit: 25, sort: state.ffilters.sort });
    if (state.ffilters.q) params.set('q', state.ffilters.q);
    if (state.ffilters.geber) params.set('geber', state.ffilters.geber);
    if (state.ffilters.status) params.set('status', state.ffilters.status);
    if (state.ffilters.review) params.set('review_status', state.ffilters.review);
    if (state.ffilters.projectType) params.set('project_type', state.ffilters.projectType);
    const data = await api(`/api/funding-programs?${params.toString()}`);
    renderFundingPrograms(data);
  } catch (error) {
    console.error('Förderprogramme konnten nicht geladen werden:', error.message);
  }
}

function renderFundingPrograms(data) {
  const list = $('funding-program-list');
  list.innerHTML = '';
  $('funding-count').textContent = `(${data.total})`;

  if (!data.programs.length) {
    list.innerHTML = '<div class="tender-item"><div class="tender-title">Keine Förder-Calls gefunden.</div></div>';
    $('funding-pagination').innerHTML = '';
    return;
  }

  for (const p of data.programs) {
    const item = document.createElement('div');
    item.className = 'tender-item';
    const geber = p.funding_geber_short || p.funding_geber || '';
    const nextDeadline = p.next_deadline;
    const types = p.project_type_summary || '';
    const maxAmt = p.max_amount_cents;
    const isNew = p.first_seen_at && (Date.now() - new Date(p.first_seen_at).getTime()) < 7*86400000;

    item.innerHTML = `
      <div class="tender-title">${isNew ? '<span class="chip chip-status-open" title="Neu in den letzten 7 Tagen">Neu</span> ' : ''}${escapeHtml(p.title)}</div>
      <div class="tender-meta">
        <span class="chip chip-status-${escapeHtml(p.status)}">${escapeHtml(fundingStatusLabel[p.status] || p.status)}</span>
        ${geber ? `<span class="chip">${escapeHtml(geber)}</span>` : ''}
        ${nextDeadline ? `<span class="chip ${daysUntil(nextDeadline) <= 14 ? 'chip-status-closing_soon' : ''}" title="${escapeHtml(p.next_deadline_label || 'Frist')}">${p.next_deadline_label && p.next_deadline_label !== 'Antragsfrist' ? `${escapeHtml(p.next_deadline_label)}: ` : 'Frist: '}${fmtDate(nextDeadline)}${daysUntil(nextDeadline) <= 14 ? ` (${daysUntil(nextDeadline)} Tage)` : ''}</span>` : ''}
        ${maxAmt != null ? `<span class="chip">${fmtCents(maxAmt)}</span>` : ''}
      </div>
      ${types ? `<div class="tender-summary"><strong>${escapeHtml(types)}</strong></div>` : ''}
      ${p.funding_gegenstand ? `<div class="tender-summary">${escapeHtml(p.funding_gegenstand.slice(0, 200))}</div>` : ''}
    `;
    item.addEventListener('click', () => openFundingDetail(p.id));
    list.appendChild(item);
  }

  renderFundingPagination(data);
}

function renderFundingPagination(data) {
  const pagination = $('funding-pagination');
  pagination.innerHTML = '';
  if (data.totalPages <= 1) return;

  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = '‹';
  prev.disabled = data.page <= 1;
  prev.addEventListener('click', () => { state.fpage = Math.max(1, data.page - 1); loadFundingPrograms(); });
  pagination.appendChild(prev);

  const start = Math.max(1, data.page - 2);
  const end = Math.min(data.totalPages, data.page + 2);
  for (let i = start; i <= end; i += 1) {
    const btn = document.createElement('button');
    btn.className = `btn${i === data.page ? ' active' : ''}`;
    btn.textContent = i;
    btn.addEventListener('click', () => { state.fpage = i; loadFundingPrograms(); });
    pagination.appendChild(btn);
  }

  const next = document.createElement('button');
  next.className = 'btn';
  next.textContent = '›';
  next.disabled = data.page >= data.totalPages;
  next.addEventListener('click', () => { state.fpage = Math.min(data.totalPages, data.page + 1); loadFundingPrograms(); });
  pagination.appendChild(next);
}

function applyFundingFilters() {
  state.ffilters.q = $('f-filter-q').value.trim();
  state.ffilters.geber = $('f-filter-geber').value.trim();
  state.ffilters.status = $('f-filter-status').value;
  state.ffilters.review = $('f-filter-review').value;
  state.ffilters.projectType = $('f-filter-project-type').value.trim();
  state.ffilters.sort = $('f-filter-sort').value;
  state.fpage = 1;
  loadFundingPrograms();
}

/* ---------- Förder-Detail mit Prüfmodus ---------- */

function editableField(label, entity, field, value, overrides, display) {
  const ov = (overrides || []).find((o) => o.entity === entity && o.field === field);
  const isManual = Boolean(ov);
  const hasValue = ov ? ov.value != null : value != null;
  const notStated = !hasValue;
  const text = ov && ov.value != null ? String(ov.value) : (display != null ? display : (value != null ? String(value) : ''));
  const inputValue = ov && ov.value != null ? String(ov.value) : (value != null ? String(value) : '');
  return `
    <div class="field-row" data-entity="${escapeHtml(entity)}" data-field="${escapeHtml(field)}">
      <div class="field-line">
        <span class="field-label">${escapeHtml(label)}${notStated ? ' <span class="not-stated">nicht genannt</span>' : ''}${isManual ? ' <span class="chip chip-status-open">manuell</span>' : ''}</span>
        <button type="button" class="btn btn-ghost field-edit">${hasValue ? 'Bearbeiten' : 'Ergänzen'}</button>
      </div>
      <div class="field-text">${text ? escapeHtml(text) : '<span class="muted">–</span>'}</div>
      <div class="field-editbox hidden">
        <input class="field-input" value="${escapeHtml(inputValue)}" placeholder="Wert angeben" />
        <button type="button" class="btn btn-primary field-save">Speichern</button>
        <button type="button" class="btn btn-ghost field-cancel">Abbrechen</button>
        ${isManual ? '<button type="button" class="btn btn-ghost field-reset">Auf Quelle</button>' : ''}
      </div>
      <div class="field-msg"></div>
    </div>
  `;
}

const PT_EDIT_FIELDS = [
  ['amount_min_cents', 'Betrag min. (€)'],
  ['amount_max_cents', 'Betrag max. (€)'],
  ['duration_min_months', 'Laufzeit min. (Monate)'],
  ['duration_max_months', 'Laufzeit max. (Monate)'],
  ['funding_quote_min', 'Förderquote min. (%)'],
  ['funding_quote_max', 'Förderquote max. (%)'],
];

function effOverride(overrides, entity, field, fallback) {
  const ov = (overrides || []).find((o) => o.entity === entity && o.field === field);
  if (ov && ov.value != null) return ov.value;
  return fallback;
}

function projectTypeSection(pt, idx, overrides) {
  const effective = (field) => effOverride(overrides, 'project_type', `${pt.name}:${field}`, pt[field]);
  const durMin = effective('duration_min_months');
  const durMax = effective('duration_max_months');
  const amtMin = effective('amount_min_cents');
  const amtMax = effective('amount_max_cents');
  const quoteMin = effective('funding_quote_min');
  const quoteMax = effective('funding_quote_max');

  const sum =
    (durMin != null || durMax != null ? kv('Laufzeit', fmtMonths(durMin, durMax)) : '')
    + (amtMin != null ? kv('Fördersumme', fmtCents(amtMin) + (amtMax && amtMax !== amtMin ? ` – ${fmtCents(amtMax)}` : '')) : '')
    + (quoteMin != null ? kv('Förderquote', `${quoteMin}${quoteMax && quoteMax !== quoteMin ? `–${quoteMax}` : ''} %`) : '')
    + (effective('max_amount_cents') != null ? kv('Höchstbetrag', fmtCents(effective('max_amount_cents'))) : '')
    + (pt.conditions ? kv('Bedingungen', pt.conditions) : '');
  const editFields = PT_EDIT_FIELDS
    .map(([field, label]) => {
      const value = effective(field);
      return `<div class="kv-edit-field"><label>${escapeHtml(label)}</label><input class="pt-input" data-field="${escapeHtml(field)}" value="${escapeHtml(value != null ? value : '')}" /></div>`;
    })
    .join('');
  return `
    <div class="detail-section pt-block" data-pt="${escapeHtml(pt.name)}">
      <div class="field-line">
        <h3>${escapeHtml(pt.name)}</h3>
        <button type="button" class="btn btn-ghost field-edit" data-pt-form="pt-form-${idx}">Bearbeiten</button>
      </div>
      <div class="kv">${sum || '<span class="muted">Keine Angaben</span>'}</div>
      <div class="field-editbox hidden" id="pt-form-${idx}">
        <div class="kv-edit">${editFields}</div>
        <div class="field-actions">
          <button type="button" class="btn btn-primary pt-save">Speichern</button>
          <button type="button" class="btn btn-ghost field-cancel">Abbrechen</button>
        </div>
      </div>
    </div>
  `;
}

function kv(label, value) {
  return `<div class="kv-row"><span class="kv-label">${escapeHtml(label)}</span><span class="kv-value">${escapeHtml(value)}</span></div>`;
}

async function openFundingDetail(id) {
  try {
    const program = await api(`/api/funding-programs/${id}`);
    const content = $('funding-detail-content');
    content.dataset.programId = id;
    const overrides = program.overrides || [];
    const titleOverride = overrides.find((o) => o.entity === 'program' && o.field === 'title');
    const displayTitle = titleOverride && titleOverride.value ? titleOverride.value : program.title;
    const geber = program.funding_geber_short ? `${program.funding_geber} (${program.funding_geber_short})` : program.funding_geber;

    const projectTypeHtml = (program.project_types || []).map((pt, idx) => projectTypeSection(pt, idx, overrides)).join('');
    const eligibilityHtml = (program.eligibility || []).map((e) => `
      <li>${escapeHtml(e.text)}</li>
    `).join('');

    content.innerHTML = `
      <div class="detail-head">
        <h2>${escapeHtml(displayTitle)}</h2>
        <div class="detail-chips">
          <span class="chip chip-status-${escapeHtml(program.status)}">${escapeHtml(fundingStatusLabel[program.status] || program.status)}</span>
          <span class="chip ${fundingReviewClass[program.review_status] || ''}">${escapeHtml(fundingReviewLabel[program.review_status] || program.review_status)}</span>
          ${geber ? `<span class="chip">${escapeHtml(geber)}</span>` : ''}
        </div>
      </div>
      ${program.current_call ? `<p class="detail-call">${escapeHtml(program.current_call)}</p>` : ''}
      <div class="detail-section">
        ${(() => {
          const deadlineLabelIsPub = (l) => /bekanntmachung|veröffentlichung|veroeffentlichung|bekanntmachungstag|veröffentlicht|veroeffentlicht/i.test(l || '');
          const realDeadlines = (program.deadlines || []).filter((d) => !deadlineLabelIsPub(d.label));
          return realDeadlines.length
            ? realDeadlines.map((d) => {
                const date = d.is_ongoing ? 'laufend' : fmtDate(d.deadline_at);
                const time = d.deadline_at && d.deadline_at.includes('T') ? escapeHtml(` um ${String(d.deadline_at).split('T')[1].slice(0, 5)} Uhr`) : '';
                const prefix = d.label && d.label !== 'Antragsfrist' ? `${escapeHtml(d.label)} | ` : 'Frist: ';
                return `<p><strong>${prefix}</strong>${date}${time}</p>`;
              }).join('')
            : '<p><strong>Frist:</strong> keine Angabe</p>';
        })()}
        ${program.primary_url ? `<p><a href="${escapeHtml(program.primary_url)}" target="_blank" rel="noopener noreferrer">Zur offiziellen Quelle ↗</a></p>` : ''}
      </div>
      <div class="detail-section">
        <h3>Kernangaben</h3>
        ${editableField('Titel', 'program', 'title', program.title, overrides)}
        ${editableField('Fördergeber', 'program', 'funding_geber', program.funding_geber, overrides)}
        ${program.funding_gegenstand ? editableField('Fördergegenstand', 'program', 'funding_gegenstand', program.funding_gegenstand, overrides) : ''}
      </div>
      ${projectTypeHtml}
      ${eligibilityHtml ? `
      <div class="detail-section">
        <h3>Antragsberechtigte / Voraussetzungen</h3>
        <ul class="plain-list">${eligibilityHtml}</ul>
      </div>` : ''}
      ${(() => {
        const usefulKinds = ['guideline', 'application', 'document', 'primary'];
        const usefulLinks = (program.links || []).filter((l) => usefulKinds.includes(l.kind)).slice(0, 12);
        if (!usefulLinks.length) return '';
        return `
        <div class="detail-section">
          <h3>Offizielle Links</h3>
          <ul class="plain-list">${usefulLinks.map((l) => `<li><span class="chip">${escapeHtml(linkKindLabel(l.kind))}</span> <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.title || l.url)}</a></li>`).join('')}</ul>
        </div>`;
      })()}
      ${program.source_text ? `
      <div class="detail-section">
        <h3>Vollständiger Call</h3>
        <div class="call-fulltext">${escapeHtml(program.source_text)}</div>
      </div>` : ''}
      <div class="detail-section detail-actions">
        <button id="btn-funding-confirm" class="btn btn-primary">Als geprüft bestätigen</button>
        <span id="funding-detail-msg" class="action-msg"></span>
      </div>
    `;

    $('btn-funding-confirm').addEventListener('click', async () => {
      try {
        await api(`/api/funding-programs/${id}/confirm`, { method: 'POST' });
        $('funding-detail-msg').textContent = 'Datensatz bestätigt.';
        $('funding-detail-msg').style.color = 'var(--success)';
        loadFundingStats();
        loadFundingPrograms();
      } catch (error) {
        $('funding-detail-msg').textContent = `Fehler: ${error.message}`;
        $('funding-detail-msg').style.color = 'var(--danger)';
      }
    });

    $('funding-detail-overlay').classList.remove('hidden');
  } catch (error) {
    console.error('Förderprogramm-Detail konnte nicht geladen werden:', error.message);
  }
}

// Delegierte Bearbeitungs-Handler für das Förder-Detail
$('funding-detail-content').addEventListener('click', async (event) => {  const content = $('funding-detail-content');
  const programId = content.dataset.programId;
  const btn = event.target.closest('button');
  if (!btn) return;

  if (btn.classList.contains('field-edit')) {
    const formId = btn.dataset.ptForm;
    if (formId) {
      $(formId).classList.remove('hidden');
      btn.classList.add('hidden');
    } else {
      const row = btn.closest('.field-row');
      row.querySelector('.field-editbox').classList.remove('hidden');
      row.querySelector('.field-line').classList.add('hidden');
    }
    return;
  }

  if (btn.classList.contains('field-cancel')) {
    const editbox = btn.closest('.field-editbox');
    if (editbox) {
      editbox.classList.add('hidden');
      const block = editbox.closest('.pt-block');
      if (block) {
        block.querySelector('.field-edit').classList.remove('hidden');
      } else {
        const row = editbox.closest('.field-row');
        row.querySelector('.field-line').classList.remove('hidden');
      }
    }
    return;
  }

  if (btn.classList.contains('field-save')) {
    const row = btn.closest('.field-row');
    const entity = row.dataset.entity;
    const field = row.dataset.field;
    const value = row.querySelector('.field-input').value.trim();
    try {
      await api(`/api/funding-programs/${programId}/override`, { method: 'POST', body: { entity, field, value } });
    } catch (error) {
      const msg = row.querySelector('.field-msg');
      msg.textContent = `Fehler: ${error.message}`;
      msg.classList.add('msg-error');
      return;
    }
    openFundingDetail(programId);
    return;
  }

  if (btn.classList.contains('field-reset')) {
    const row = btn.closest('.field-row');
    await api(`/api/funding-programs/${programId}/override`, { method: 'POST', body: { entity: row.dataset.entity, field: row.dataset.field, value: null } });
    openFundingDetail(programId);
    return;
  }

  if (btn.classList.contains('pt-save')) {
    const block = btn.closest('.pt-block');
    const ptName = block.dataset.pt;
    const promises = Array.from(block.querySelectorAll('.pt-input')).map((input) =>
      api(`/api/funding-programs/${programId}/override`, {
        method: 'POST',
        body: { entity: 'project_type', field: `${ptName}:${input.dataset.field}`, value: input.value.trim() || null },
      })
    );
    await Promise.all(promises);
    openFundingDetail(programId);
  }
});

$('btn-close-funding-detail').addEventListener('click', () => {
  $('funding-detail-overlay').classList.add('hidden');
});

$('funding-detail-overlay').addEventListener('click', (event) => {
  if (event.target === $('funding-detail-overlay')) {
    $('funding-detail-overlay').classList.add('hidden');
  }
});

$('btn-funding-crawl').addEventListener('click', async () => {
  const btn = $('btn-funding-crawl');
  btn.disabled = true;
  $('funding-action-msg').textContent = 'Förder-Crawl wird gestartet …';
  try {
    await api('/api/funding/crawl', { method: 'POST', body: { sources: null } });
    $('funding-action-msg').textContent = 'Förder-Crawl läuft im Hintergrund.';
  } catch (error) {
    $('funding-action-msg').textContent = `Fehler: ${error.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      $('funding-action-msg').textContent = '';
      loadFundingCrawls();
      loadFundingStats();
      loadFundingPrograms();
    }, 1000);
  }
});

let fundingDebounce = null;
function scheduleFundingSearch() {
  clearTimeout(fundingDebounce);
  fundingDebounce = setTimeout(applyFundingFilters, 250);
}

/* ---------- Quellenverwaltung ---------- */

const sourceStateLabel = {
  unprobed: 'Ungeprüft',
  active: 'Aktiv',
  blocked: 'Blockiert',
  needs_config: 'Konfig nötig',
  disabled: 'Deaktiviert',
  error: 'Fehler',
};

async function loadSourcesManaged() {
  try {
    const data = await api('/api/crawl-sources');
    const container = $('source-list');
    // Im Förderbereich nur die feste Förderquelle anzeigen
    const kinds = data.sources.filter((s) => s.declared_kind === 'funding');
    container.innerHTML = kinds.map((s) => `
      <div class="source-row" data-id="${s.id}">
        <div class="source-main">
          <div class="source-name">${escapeHtml(s.name)} <span class="chip">${escapeHtml(s.declared_kind)}</span> <span class="chip">${escapeHtml(s.access)}</span></div>
          <div class="source-url">${escapeHtml(s.url)}</div>
        </div>
        <div class="source-meta">
          <span class="chip chip-status-${escapeHtml(sourceStateClass(s.state))}">${escapeHtml(sourceStateLabel[s.state] || s.state)}</span>
          ${s.last_item_count != null ? `<span>${s.last_item_count} Treffer</span>` : ''}
          ${s.last_error_type ? `<span class="source-error">${escapeHtml(s.last_error_type)}</span>` : ''}
          <button class="btn btn-ghost source-probe" data-id="${s.id}">Prüfen</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    $('source-list').innerHTML = `<div class="source-row">Quellen konnten nicht geladen werden: ${escapeHtml(error.message)}</div>`;
  }
}

function sourceStateClass(state) {
  if (state === 'active') return 'open';
  if (state === 'blocked' || state === 'error') return 'closed';
  if (state === 'needs_config') return 'closing_soon';
  return 'closed';
}

$('source-list').addEventListener('click', async (event) => {
  const btn = event.target.closest('.source-probe');
  if (!btn) return;
  const id = btn.dataset.id;
  btn.disabled = true;
  btn.textContent = 'prüft …';
  try {
    const res = await api(`/api/crawl-sources/${id}/probe`, { method: 'POST' });
    btn.textContent = res.result.state === 'active' ? 'Aktiv' : `Prüfen (${res.result.state})`;
    loadSourcesManaged();
  } catch (error) {
    btn.textContent = 'Fehler';
    $('source-msg').textContent = error.message;
  }
});

$('btn-source-refresh').addEventListener('click', () => loadSourcesManaged());

['f-filter-status', 'f-filter-review', 'f-filter-sort'].forEach((id) => {
  $(id).addEventListener('change', applyFundingFilters);
});
$('f-filter-q').addEventListener('input', scheduleFundingSearch);
$('f-filter-geber').addEventListener('input', scheduleFundingSearch);
$('f-filter-project-type').addEventListener('input', scheduleFundingSearch);
$('btn-funding-apply').addEventListener('click', applyFundingFilters);

/* ---------- Detail-Overlay ---------- */

async function openDetail(id) {
  try {
    const tender = await api(`/api/tenders/${id}`);
    // Das Öffnen zählt als gelesen; Beobachtet/Unpassend bleiben erhalten.
    if (tender.user_state === 'unseen') {
      try { await api(`/api/tenders/${id}/state`, { method: 'POST', body: { state: 'seen' } }); tender.user_state = 'seen'; await loadSearchProfiles(); await loadTenders(); } catch (error) { showActionError(error.message); }
    }
    const content = $('detail-content');

    const reqs = Array.isArray(tender.llm_requirements)
      ? `<ul>${tender.llm_requirements.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
      : '<p>–</p>';

    const cpvLabels = tender.cpv_labels?.length
      ? tender.cpv_labels.map((label) => `<span class="chip">${escapeHtml(label)}</span>`).join(' ')
      : tender.cpv_codes?.length
        ? tender.cpv_codes.map((code) => `<span class="chip">CPV ${escapeHtml(code)}</span>`).join(' ')
        : '<p>–</p>';

    const facts = Array.isArray(tender.facts) ? tender.facts : [];
    const lots = Array.isArray(tender.lots) ? tender.lots : [];
    const criteria = Array.isArray(tender.criteria) ? tender.criteria : [];
    const messages = Array.isArray(tender.messages) ? tender.messages : [];
    const textSections = Array.isArray(tender.text_sections) ? tender.text_sections : [];
    const documents = Array.isArray(tender.documents) ? tender.documents : [];
    const factGroups = new Map();
    for (const fact of facts) {
      const section = fact.section_key || 'Weitere Angaben';
      if (!factGroups.has(section)) factGroups.set(section, []);
      factGroups.get(section).push(fact);
    }
    const factsHtml = [...factGroups.entries()].map(([section, values]) => `
      <div class="detail-subsection"><h4>${escapeHtml(section)}</h4>
      <dl>${values.map((fact) => `<div><dt>${escapeHtml(fact.label || 'Angabe')}</dt><dd>${escapeHtml(fact.value_text || '–')}</dd></div>`).join('')}</dl></div>
    `).join('');
    const documentsHtml = documents.length ? `
      <table class="detail-table"><thead><tr><th>Datei</th><th>Kategorie</th><th>Status</th><th>Quelle</th></tr></thead><tbody>
      ${documents.map((doc) => {
        const locator = doc.locator_json || doc.locator || {};
        const pageUrl = safeHttpUrl(locator.pageUrl || locator.page_url || doc.source_url);
        return `<tr><td>${escapeHtml(doc.filename || 'Dokument')}</td><td>${escapeHtml(doc.category || '–')}</td><td>${escapeHtml(doc.download_status || 'not_requested')}</td><td>${pageUrl ? `<a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">Portalseite ↗</a>` : '–'}</td></tr>`;
      }).join('')}</tbody></table>` : '<p>Keine Dokumente inventarisiert.</p>';
    const lotsHtml = lots.length ? `<table class="detail-table"><thead><tr><th>Los</th><th>Titel</th><th>Ort</th><th>Laufzeit</th><th>Wert</th></tr></thead><tbody>${lots.map((lot) => `<tr><td>${escapeHtml(lot.lot_number || lot.lot_key || '–')}</td><td>${escapeHtml(lot.title || lot.description || '–')}</td><td>${escapeHtml(lot.place_of_performance || '–')}</td><td>${escapeHtml(lot.contract_duration || '–')}</td><td>${escapeHtml(fmtCents(lot.estimated_value_cents, lot.estimated_value_currency))}</td></tr>`).join('')}</tbody></table>` : '<p>Keine Lose inventarisiert.</p>';
    const criteriaHtml = criteria.length ? `<table class="detail-table"><thead><tr><th>Art</th><th>Kriterium</th><th>Gewichtung</th><th>Erforderlich</th></tr></thead><tbody>${criteria.map((criterion) => `<tr><td>${escapeHtml(criterion.kind || '–')}</td><td>${escapeHtml(criterion.title || criterion.description || '–')}<br><small>${escapeHtml(criterion.description || '')}</small></td><td>${criterion.weight == null ? '–' : `${escapeHtml(criterion.weight)} %`}</td><td>${criterion.required == null ? '–' : (criterion.required ? 'Ja' : 'Nein')}</td></tr>`).join('')}</tbody></table>` : '<p>Keine Kriterien inventarisiert.</p>';
    const messagesHtml = messages.length ? `<div>${messages.map((message) => `<article class="detail-message"><h4>${escapeHtml(message.subject || 'Nachricht')}</h4><small>${escapeHtml(fmtDate(message.published_at))}</small><p>${linkify(message.body || '')}</p></article>`).join('')}</div>` : '<p>Keine Nachrichten inventarisiert.</p>';
    const textSectionsHtml = textSections.map((section) => `
      <details class="detail-text-section"><summary>${escapeHtml(section.title || section.section_key || 'Abschnitt')} · ${escapeHtml(section.status || 'complete')}</summary><pre>${escapeHtml(section.text || '')}</pre></details>
    `).join('');
    const completenessSections = tender.completeness_status?.sections || {};
    const completenessHtml = Object.keys(completenessSections).length
      ? `<dl>${Object.entries(completenessSections).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`
      : '<p>Keine Abschnittsstatus verfügbar.</p>';

    const changes = (tender.changes || []).slice(0, 10)
      .map((c) => `<li><strong>${escapeHtml(c.field)}</strong>: ${escapeHtml(c.old_value ?? '–')} → ${escapeHtml(c.new_value ?? '–')}</li>`)
      .join('');

    content.innerHTML = `
      <div class="detail-title-row"><h2>${escapeHtml(tender.title)}</h2><div class="tender-actions"><button class="btn btn-small" id="detail-watch">${tender.user_state === 'watch' ? '★ Beobachtet' : '☆ Beobachten'}</button><button class="btn btn-small btn-ghost" id="detail-dismiss">Unpassend</button></div></div>
      <div class="detail-section">
        <h3>Entscheidungsgrundlage</h3>
        <p><strong>Abgabefrist:</strong> ${fmtDate(tender.submission_deadline)}${daysUntil(tender.submission_deadline) != null ? ` (in ${Math.max(0, daysUntil(tender.submission_deadline))} Tagen)` : ''}</p>
        <p><strong>Frist für Fragen:</strong> ${fmtDate(tender.question_deadline)}</p>
        <p><strong>Wert:</strong> ${escapeHtml(fmtCents(tender.estimated_value_cents, tender.estimated_value_currency))}</p>
        <p><strong>Auftraggeber:</strong> ${escapeHtml(tender.contracting_authority || '–')}</p>
        <p><strong>Leistungsort:</strong> ${escapeHtml(tender.place_of_performance || '–')}</p>
        ${safeHttpUrl(tender.url) ? `<p><a href="${escapeHtml(safeHttpUrl(tender.url))}" target="_blank" rel="noopener noreferrer">Zur Ausschreibung ↗</a></p>` : ''}
      </div>
      ${tender.description ? `
      <div class="detail-section">
        <h3>Leistungsgegenstand</h3>
        <p>${linkify(tender.description)}</p>
      </div>` : ''}
      ${tender.cpv_labels?.length || tender.cpv_codes?.length ? `
      <div class="detail-section">
        <h3>CPV-Codes</h3>
        <p class="chip-group">${cpvLabels}</p>
      </div>` : ''}
      <div class="detail-section">
        <h3>Lose</h3>
        ${lotsHtml}
      </div>
      <div class="detail-section">
        <h3>Kriterien</h3>
        ${criteriaHtml}
      </div>
      <details class="technical-details"><summary>Technische Details</summary>
      <div class="detail-section">
        <h3>Vollständigkeit</h3>
        <p><strong>Gesamt:</strong> ${escapeHtml(tender.completeness_status?.overall || tender.detail_status || '–')}</p>
        ${completenessHtml}
      </div>
      <div class="detail-section">
        <h3>Zusatzangaben</h3>
        ${factsHtml || '<p>–</p>'}
      </div>
      <div class="detail-section">
        <h3>Dokumentinventar</h3>
        ${documentsHtml}
      </div>
      <div class="detail-section">
        <h3>Nachrichten</h3>
        ${messagesHtml}
      </div>
      ${textSectionsHtml ? `
      <div class="detail-section">
        <h3>Gespeicherte Seiteninhalte</h3>
        ${textSectionsHtml}
      </div>` : ''}
      ${tender.llm_summary ? `
      <div class="detail-section">
        <h3>LLM-Analyse</h3>
        <p>${escapeHtml(tender.llm_summary)}</p>
        ${tender.llm_relevance_score != null ? `<p><strong>Relevanz:</strong> ${Math.round(tender.llm_relevance_score * 100)}%</p>` : ''}
        ${tender.llm_relevance_reason ? `<p>${escapeHtml(tender.llm_relevance_reason)}</p>` : ''}
      </div>` : ''}
      ${tender.llm_requirements?.length ? `
      <div class="detail-section">
        <h3>Anforderungen (LLM)</h3>
        ${reqs}
      </div>` : ''}
      ${changes ? `
      <div class="detail-section">
        <h3>Letzte Änderungen</h3>
        <ul>${changes}</ul>
      </div>` : ''}
      </details>
    `;
    $('detail-watch').addEventListener('click', async () => { try { const nextState = tender.user_state === 'watch' ? 'seen' : 'watch'; await api(`/api/tenders/${tender.id}/state`, { method: 'POST', body: { state: nextState } }); tender.user_state = nextState; $('detail-watch').textContent = nextState === 'watch' ? '★ Beobachtet' : '☆ Beobachten'; await loadTenders(); await loadSearchProfiles(); } catch (error) { showActionError(error.message); } });
    $('detail-dismiss').addEventListener('click', async () => { try { await api(`/api/tenders/${tender.id}/state`, { method: 'POST', body: { state: 'dismiss' } }); $('detail-overlay').classList.add('hidden'); await loadTenders(); await loadSearchProfiles(); } catch (error) { showActionError(error.message); } });
    $('detail-overlay').classList.remove('hidden');
  } catch (error) {
    console.error('Detail konnte nicht geladen werden:', error.message);
  }
}

$('btn-close-detail').addEventListener('click', () => {
  $('detail-overlay').classList.add('hidden');
});

$('detail-overlay').addEventListener('click', (event) => {
  if (event.target === $('detail-overlay')) {
    $('detail-overlay').classList.add('hidden');
  }
});

/* ---------- Aktionen ---------- */

$('btn-crawl').addEventListener('click', async () => {
  const btn = $('btn-crawl');
  btn.disabled = true;
  $('action-msg').textContent = 'Crawl wird gestartet …';
  try {
    await api('/api/crawl', { method: 'POST', body: { sources: null, enrich: true } });
    $('action-msg').textContent = 'Crawl läuft im Hintergrund.';
  } catch (error) {
    $('action-msg').textContent = `Fehler: ${error.message}`;
  } finally {
    setTimeout(() => {
      $('action-msg').textContent = '';
      loadStatus();
      loadCrawls();
    }, 1000);
  }
});

// Ausschreibungen werden nie per LLM analysiert – der Button wurde entfernt.
// Nur Förder-Calls nutzen das LLM (im Förder-Crawl, nur für neue Calls).

/* ---------- Live-Filter ---------- */

// Zentrale Filter-Anwendung: liest alle Filterfelder, springt auf Seite 1
function applyFilters() {
  state.filters.q = $('filter-q').value.trim();
  state.filters.sources = $('filter-source').value;
  state.filters.regions = $('filter-region').value;
  state.filters.status = $('filter-status').value;
  state.filters.cpv = $('filter-cpv').value.trim();
  state.filters.sort = $('filter-sort').value;
  state.page = 1;
  loadTenders();
}

let debounceTimer = null;
// Textfelder (Suche, CPV) mit kurzem Debounce – Filter live aktualisieren
function scheduleLiveSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, 250);
}

// Selekt-Dropdowns reagieren sofort auf Änderungen
['filter-source', 'filter-region', 'filter-status', 'filter-sort'].forEach((id) => {
  $(id).addEventListener('change', applyFilters);
});

// Textfelder live mit Debounce
$('filter-q').addEventListener('input', scheduleLiveSearch);
$('filter-cpv').addEventListener('input', scheduleLiveSearch);

$('btn-apply-filters').addEventListener('click', applyFilters);

$('btn-refresh').addEventListener('click', async () => {
  const btn = $('btn-refresh');
  btn.disabled = true;
  btn.textContent = '⟳ Wird geprüft …';
  try {
    await Promise.all([loadStatus(), loadCrawls(), loadAdminSources()]);
    $('action-msg').textContent = `Status geprüft um ${new Date().toLocaleTimeString('de-DE')}.`;
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Status prüfen';
  }
});

$('btn-cancel-job').addEventListener('click', async () => {
  if (!crawlBusy) return;
  const btn = $('btn-cancel-job');
  btn.disabled = true;
  btn.textContent = 'Abbruch wird angefordert …';
  try {
    const jobIds = [...activeJobIds];
    const requests = jobIds.map((jobId) => api(`/api/jobs/${jobId}/cancel`, { method: 'POST' }));
    if (directCrawlRunning) requests.push(api('/api/crawl/cancel', { method: 'POST' }));
    await Promise.all(requests);
    await Promise.all([loadStatus(), loadCrawls(), loadAdminSources()]);
    $('action-msg').textContent = crawlBusy
      ? 'Abbruch angefordert. Laufende Abrufe werden noch beendet.'
      : 'Crawl abgebrochen. Du kannst ihn jetzt neu starten.';
    clearTimeout(cancelPollTimer);
    const pollCancellation = async (attempt = 0) => {
      await Promise.all([loadStatus(), loadCrawls(), loadAdminSources()]);
      if (!crawlBusy) {
        $('action-msg').textContent = 'Crawl abgebrochen. Du kannst ihn jetzt neu starten.';
        return;
      }
      if (!activeJobIds.length && directCrawlRunning) {
        $('action-msg').textContent = 'Browser-Jobs sind beendet. Der aktuelle Quellenabruf läuft noch aus.';
      }
      if (attempt >= 149) {
        $('action-msg').textContent = 'Der Abbruch dauert länger als erwartet. Bitte den Status erneut prüfen.';
        return;
      }
      cancelPollTimer = setTimeout(() => pollCancellation(attempt + 1), 2000);
    };
    if (crawlBusy) cancelPollTimer = setTimeout(() => pollCancellation(), 1000);
  } catch (error) {
    $('action-msg').textContent = `Abbruch fehlgeschlagen: ${error.message}`;
    btn.disabled = false;
    btn.textContent = 'Crawl abbrechen';
  }
});

/* ---------- Förder-Chat ---------- */

const CHAT_PROFILE_KEY = 'funding_chat_profile';
const CHAT_EXAMPLES = [
  'Welche offenen Calls passen zu einem Verbundprojekt im Bereich Wasserstoff-Elektrolyse?',
  'Wo gibt es Förderung für Grundlagenforschung mit Fokus auf KI in der Energiebranche?',
  'Welche Calls richten sich an Hochschulen und haben eine Antragsfrist in den nächsten Monaten?',
  'Welche Fördermittel eignen sich für Machbarkeitsstudien und kleine Einzelvorhaben?',
];

function initFundingChat() {
  const profileEl = $('chat-profile');
  if (!profileEl.dataset.loaded) {
    profileEl.value = localStorage.getItem(CHAT_PROFILE_KEY) || '';
    profileEl.dataset.loaded = '1';
  }
  renderFundingChat();
}

$('btn-chat-profile-save').addEventListener('click', () => {
  const value = $('chat-profile').value.trim();
  if (value) localStorage.setItem(CHAT_PROFILE_KEY, value);
  else localStorage.removeItem(CHAT_PROFILE_KEY);
  $('chat-profile-msg').textContent = value ? 'Profil gespeichert.' : 'Profil entfernt.';
  setTimeout(() => { $('chat-profile-msg').textContent = ''; }, 2000);
});

$('btn-chat-new').addEventListener('click', () => {
  state.chatMessages = [];
  renderFundingChat();
});

$('chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.chatSending) return;
  const input = $('chat-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  await sendChatQuestion(question);
});

$('chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
});

function renderFundingChat() {
  const container = $('chat-messages');
  const messages = state.chatMessages;
  if (!messages.length) {
    container.innerHTML = `
      <div class="chat-empty">
        <p>Frage den Berater nach passenden Förder-Calls. Der Chat antwortet nur auf Basis der gespeicherten Bekanntmachungen und nennt seine Quellen.</p>
        <div class="chat-examples">${CHAT_EXAMPLES.map((e) => `<button class="btn chat-example" data-question="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}</div>
      </div>`;
    container.querySelectorAll('.chat-example').forEach((btn) => {
      btn.addEventListener('click', () => sendChatQuestion(btn.dataset.question));
    });
    return;
  }
  container.innerHTML = messages.map((m, i) => {
    if (m.role === 'user') {
      return `<div class="chat-msg chat-user"><div class="chat-bubble">${escapeHtml(m.content)}</div></div>`;
    }
    return `
      <div class="chat-msg chat-assistant">
        <div class="chat-bubble">${renderChatAnswer(m.content)}</div>
        ${renderChatSources(m.sources)}
      </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

function renderChatAnswer(text) {
  if (!text) return '';
  // linkify escaped + verlinkt genau einmal. Leerzeilen → Absätze (<p>),
  // **Fett** → <strong>, einfache Zeilenumbrüche → <br>.
  const linked = linkify(text);
  return linked
    .split(/\n{2,}/)
    .map((block) => {
      const body = block
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
      return body ? `<p>${body}</p>` : '';
    })
    .join('');
}

function renderChatSources(sources) {
  if (!sources || !sources.length) return '';
  const cards = sources.map((s) => `
    <div class="chat-source card" data-pid="${Number(s.program_id)}">
      <div class="chat-source-head">
        <span class="chip chip-status-${escapeHtml(s.status || 'unknown')}">${escapeHtml(fundingStatusLabel[s.status] || s.status || '')}</span>
        ${s.fit ? `<span class="chip chip-fit-${escapeHtml(s.fit)}">${escapeHtml(s.fit === 'high' ? 'Sehr passend' : s.fit === 'medium' ? 'Gut passend' : 'Bedingt passend')}</span>` : ''}
        ${s.next_deadline ? `<span class="chip">Frist: ${fmtDate(s.next_deadline)}</span>` : ''}
      </div>
      <div class="chat-source-title">${escapeHtml(s.title || 'Förder-Call')}</div>
      ${s.funding_geber ? `<div class="chat-source-meta">${escapeHtml(s.funding_geber)}</div>` : ''}
      ${(s.quotes && s.quotes.length) ? `<ul class="chat-quotes">${s.quotes.slice(0, 2).map((q) => `<li>„${escapeHtml(q.quote)}"</li>`).join('')}</ul>` : ''}
      <div class="chat-source-actions">
        <a class="btn" href="${escapeHtml(s.url || '#')}" target="_blank" rel="noopener noreferrer">Quelle öffnen ↗</a>
        <button class="btn btn-ghost chat-open-detail">Details</button>
      </div>
    </div>`).join('');
  return `<div class="chat-sources"><h3>Quellen</h3>${cards}</div>`;
}

function setChatStatus(text) {
  $('chat-status').textContent = text || '';
}

function chatMessageNode(message) {
  if (message.role === 'user') {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-user';
    el.innerHTML = `<div class="chat-bubble">${escapeHtml(message.content)}</div>`;
    return el;
  }
  const el = document.createElement('div');
  el.className = 'chat-msg chat-assistant';
  el.innerHTML = `<div class="chat-bubble">${renderChatAnswer(message.content)}</div>${renderChatSources(message.sources)}`;
  return el;
}

function appendChatMessage(message) {
  const container = $('chat-messages');
  if (container.querySelector('.chat-empty')) container.innerHTML = '';
  const node = chatMessageNode(message);
  container.appendChild(node);
  // Zum Anfang der neuen Nachricht springen (nicht zum Listenende).
  container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

async function sendChatQuestion(question) {
  if (state.chatSending) return;
  state.chatSending = true;
  $('btn-chat-send').disabled = true;
  state.chatMessages.push({ role: 'user', content: question });
  appendChatMessage(state.chatMessages[state.chatMessages.length - 1]);

  // Mehrere Lade-Status nacheinander anzeigen, bis die Antwort da ist.
  const statusStages = [
    'Optimiere Suchbegriffe …',
    'Suche Förder-Calls …',
    'Bewerte Relevanz …',
    'Lade Quellen …',
    'Erstelle Beratung …',
  ];
  let stage = 0;
  setChatStatus(statusStages[0]);
  const statusTimer = setInterval(() => {
    stage = (stage + 1) % statusStages.length;
    setChatStatus(statusStages[stage]);
  }, 2000);

  const profile = $('chat-profile').value.trim();
  const history = state.chatMessages.slice(-13, -1).map((m) => ({ role: m.role, content: m.content }));
  const token = state.token;

  try {
    const res = await fetch('/api/funding-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question, profile, history }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const assistantMsg = {
      role: 'assistant',
      content: data.answer || '',
      sources: data.sources || [],
    };
    state.chatMessages.push(assistantMsg);
    appendChatMessage(assistantMsg);
  } catch (error) {
    state.chatMessages.push({
      role: 'assistant',
      content: `Entschuldigung, die Beratung ist gerade nicht verfügbar: ${error.message}`,
      sources: [],
    });
    appendChatMessage(state.chatMessages[state.chatMessages.length - 1]);
  } finally {
    clearInterval(statusTimer);
    state.chatSending = false;
    $('btn-chat-send').disabled = false;
    setChatStatus('');
  }
}

$('chat-messages').addEventListener('click', (event) => {
  const detailBtn = event.target.closest('.chat-open-detail');
  const sourceCard = event.target.closest('.chat-source');
  if (detailBtn && sourceCard) {
    openFundingDetail(Number(sourceCard.dataset.pid));
  }
});

/* ---------- Initialisierung ---------- */

// Immer prüfen: Ist Auth aktiv, verlangt /api/status ohne Token eine Anmeldung.
// Ist Auth deaktiviert, liefert /api/status 200 und die App wird direkt geladen.
api('/api/status')
  .then(() => showApp())
  .catch(() => showLogin('Token ungültig oder fehlt – bitte anmelden.'));

// Automatische Aktualisierung alle 30 Sekunden, wenn angemeldet
setInterval(() => {
  if (!state.token || $('app').classList.contains('hidden')) return;
  loadStatus();
}, 30000);
