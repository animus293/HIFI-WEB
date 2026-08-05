(function() {
  'use strict';

  const FEEDBACK_HUB_ID = 'feedback-global-hub';
  let currentUser = null;
  let socket = null;
  let adminOpen = false;
  let reportTargetMsg = null;
  let activeTab = 'users';

  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
  const api = (p) => API_BASE + p;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // escapeHtml (textContent→innerHTML) does NOT escape quotes, so it is unsafe
  // inside attributes. This escaper handles every character a data-* attribute
  // can break on (stored-XSS hardening: usernames/displayNames are attacker
  // controlled and end up in data-search/data-name below).
  function attrEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Two-step inline confirm (no window.confirm — unreliable in Capacitor's
  // native WebView). First click arms the button for 3s, second click fires.
  function armConfirm(btn, label, onConfirm) {
    if (btn.dataset.armed === '1') { onConfirm(); return; }
    btn.dataset.armed = '1';
    const original = btn.textContent;
    btn.textContent = label;
    btn.classList.add('confirming');
    setTimeout(() => {
      btn.dataset.armed = '0';
      btn.textContent = original;
      btn.classList.remove('confirming');
    }, 3000);
  }

  function avatarHtml(url, name) {
    if (typeof window.avatarHtml === 'function') return window.avatarHtml(url, name);
    const initial = (name || '?').charAt(0).toUpperCase();
    if (url) return '<img src="' + attrEscape(url) + '" alt="">';
    return '<span class="avatar-fallback">' + escapeHtml(initial) + '</span>';
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function showToast(msg, type) {
    if (typeof window.showToast === 'function') { window.showToast(msg, type); return; }
    const container = $('#toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => { t.classList.add('toast-hide'); setTimeout(() => t.remove(), 300); }, 3000);
  }

  function userName(u) {
    if (!u) return 'Unknown';
    return u.displayName || u.username || 'Unknown';
  }

  function init() {
    const check = setInterval(() => {
      if (window.currentUser && window.socket) {
        clearInterval(check);
        currentUser = window.currentUser;
        socket = window.socket;
        setup();
      }
    }, 200);
  }

  async function setup() {
    refreshAdminUI();
    wireNavButtons();
    wireReportModal();
    wireAdminPanel();
    wireSocketEvents();
    // Re-check role after profile sync lands (a promoted user gets the button live).
    const roleCheck = setInterval(() => {
      if (window.currentUser && window.currentUser !== currentUser) {
        currentUser = window.currentUser;
        refreshAdminUI();
      }
    }, 1500);
  }

  function isAdmin() {
    return !!(currentUser && currentUser.role === 'admin');
  }

  function refreshAdminUI() {
    const show = isAdmin();
    const btn = $('#adminBtn');
    const dd = $('#dropdownAdmin');
    if (btn) btn.style.display = show ? '' : 'none';
    if (dd) dd.style.display = show ? '' : 'none';
    return show;
  }

  function wireNavButtons() {
    $('#adminBtn')?.addEventListener('click', toggleAdminPanel);
    $('#dropdownAdmin')?.addEventListener('click', () => {
      const dd = $('#navDropdown');
      if (dd) dd.classList.remove('open');
      toggleAdminPanel();
    });
  }

  // ============ REPORT MESSAGE MODAL ============

  function wireReportModal() {
    $('#submitReportBtn')?.addEventListener('click', submitReport);
    $('#cancelReportBtn')?.addEventListener('click', () => closeModal('reportModal'));
    $('#closeReportModal')?.addEventListener('click', () => closeModal('reportModal'));
  }

  // Exposed to app.js renderMessage's more-menu "Report" action.
  window.openReportModal = function(msg) {
    if (!msg) return;
    reportTargetMsg = msg;
    const preview = $('#reportPreview');
    if (preview) {
      const txt = msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'location' ? '📍 Location' : msg.type === 'voice' ? '🎤 Voice' : 'Message');
      preview.textContent = (txt && txt.length > 120) ? txt.slice(0, 120) + '…' : (txt || 'Message');
    }
    const reason = $('#reportReason');
    if (reason) reason.value = 'spam';
    const err = $('#reportError');
    if (err) err.textContent = '';
    openModal('reportModal');
  };

  async function submitReport() {
    if (!reportTargetMsg) return;
    const reason = $('#reportReason')?.value || 'other';
    const err = $('#reportError');
    const btn = $('#submitReportBtn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(api('/api/messages/' + reportTargetMsg.id + '/report'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
      });
      const data = await res.json();
      if (data.success) {
        closeModal('reportModal');
        showToast(data.alreadyReported ? 'You already reported this message' : 'Report submitted — thanks for keeping HiFi safe');
        reportTargetMsg = null;
      } else {
        if (err) err.textContent = data.error || 'Failed to submit report';
      }
    } catch (e) {
      if (err) err.textContent = 'Connection error';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function openModal(id) {
    const el = $('#' + id);
    if (el) { el.classList.add('show'); el.setAttribute('aria-hidden', 'false'); }
  }
  function closeModal(id) {
    const el = $('#' + id);
    if (el) { el.classList.remove('show'); el.setAttribute('aria-hidden', 'true'); }
  }

  // The report modal only toggles a CSS class (never a Nav entry), so register
  // it with the overlay closer registry — the Android back button closes it.
  if (window.registerOverlayCloser) {
    window.registerOverlayCloser({
      id: 'reportModal',
      isOpen: function() {
        const el = document.getElementById('reportModal');
        return !!(el && el.classList.contains('show'));
      },
      close: function() { closeModal('reportModal'); }
    });
  }

  // ============ ADMIN PANEL ============

  function toggleAdminPanel() {
    if (adminOpen) closeAdminPanel();
    else openAdminPanel();
  }

  async function openAdminPanel() {
    if (adminOpen || !refreshAdminUI()) return;
    adminOpen = true;
    const overlay = $('#adminOverlay');
    if (overlay) {
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
    }
    renderAdminTab(activeTab);
    if (window.Nav) window.Nav.push('admin', closeAdminPanelInternal);
  }

  function closeAdminPanelInternal() {
    if (!adminOpen) return;
    adminOpen = false;
    const overlay = $('#adminOverlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
  }

  function closeAdminPanel() {
    if (window.Nav) window.Nav.back();
    else closeAdminPanelInternal();
  }

  function wireAdminPanel() {
    $('#closeAdminPanel')?.addEventListener('click', closeAdminPanel);
    $$('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.admin-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        renderAdminTab(activeTab);
      });
    });
  }

  function renderAdminTab(tab) {
    const body = $('#adminBody');
    if (!body) return;
    if (tab === 'users') renderUsersTab(body);
    else if (tab === 'reports') renderReportsTab(body);
    else if (tab === 'appeals') renderAppealsTab(body);
    else if (tab === 'feedback') renderFeedbackTab(body);
    else if (tab === 'bots') renderBotsTab(body);
  }

  // ---- Bot Check tab: inspect every photo/video/voice/file a user actually
  // sent through the app (stored on the server) + behavioral signals, so an
  // admin can judge real vs automated. No device/file access involved — only
  // data the app already holds. ----
  function botRiskHtml(score) {
    const s = Number(score) || 0;
    const label = s >= 50 ? 'high' : s >= 25 ? 'medium' : 'low';
    return '<span class="bot-risk ' + label + '">' + s + '</span>';
  }

  async function renderBotsTab(body) {
    body.innerHTML = '<div class="admin-loading">Loading users…</div>';
    try {
      const res = await fetch(api('/api/admin/users'));
      const data = await res.json();
      if (!data.users) {
        body.innerHTML = '<div class="admin-empty">' + escapeHtml(data.error || 'Failed to load users') + '</div>';
        return;
      }
      const users = data.users.slice().sort((a, b) => (b.botScore || 0) - (a.botScore || 0));
      const rows = users.map(u =>
        '<div class="admin-user-row bot-row" data-id="' + attrEscape(u.id) + '" data-search="' + attrEscape((u.displayName || '') + ' ' + (u.username || '')) + '">' +
          '<div class="admin-user-avatar">' + avatarHtml(u.avatar, u.displayName || u.username) + '</div>' +
          '<div class="admin-user-info">' +
            '<div class="admin-user-name">' + escapeHtml(userName(u)) +
              (u.role === 'admin' ? ' <span class="admin-badge">ADMIN</span>' : '') +
              (u.banned ? ' <span class="admin-badge banned">BANNED</span>' : '') +
            '</div>' +
            '<div class="admin-user-sub">@' + escapeHtml(u.username || '') +
              ' · ' + (u.messageCount || 0) + ' msgs' +
              ' · ' + (u.mediaCount || 0) + ' media' +
              ' · ' + (u.online ? 'online' : 'offline') +
            '</div>' +
          '</div>' +
          '<div class="bot-score-col">' + botRiskHtml(u.botScore) + '</div>' +
          '<button class="admin-action bot-inspect" data-id="' + attrEscape(u.id) + '">Inspect</button>' +
        '</div>'
      ).join('');
      body.innerHTML =
        '<div class="bot-intro">🛡️ Bot Check — reviews media each user has <b>actually sent</b> (already on the server) plus signals like message speed and account age. Higher score = looks automated. Click <b>Inspect</b> to see their media and decide.</div>' +
        '<div class="admin-user-list">' + rows + '</div>';
      $$('.bot-inspect', body).forEach(btn => {
        btn.addEventListener('click', () => renderBotDetail(body, btn.dataset.id));
      });
    } catch (e) {
      body.innerHTML = '<div class="admin-empty">Failed to load users</div>';
    }
  }

  async function renderBotDetail(body, userId) {
    body.innerHTML = '<div class="admin-loading">Loading user media…</div>';
    try {
      const res = await fetch(api('/api/admin/users/' + userId + '/media'));
      const data = await res.json();
      if (!data.user) {
        body.innerHTML = '<div class="admin-empty">' + escapeHtml(data.error || 'Failed to load user') + '</div>';
        return;
      }
      const u = data.user;
      const s = data.signals || {};
      const media = data.media || [];
      const mediaGrid = media.length
        ? '<div class="bot-media-grid">' + media.map(m => botMediaTileHtml(m)).join('') + '</div>'
        : '<div class="admin-empty">No media sent through the app.</div>';
      body.innerHTML =
        '<button class="admin-action bot-back">← Back to Bot Check</button>' +
        '<div class="bot-detail-header">' +
          '<div class="admin-user-avatar large">' + avatarHtml(u.avatar, u.displayName || u.username) + '</div>' +
          '<div>' +
            '<div class="admin-user-name">' + escapeHtml(userName(u)) +
              (u.role === 'admin' ? ' <span class="admin-badge">ADMIN</span>' : '') +
              (u.banned ? ' <span class="admin-badge banned">BANNED</span>' : '') +
            '</div>' +
            '<div class="admin-user-sub">@' + escapeHtml(u.username || '') + ' · joined ' + timeAgo(u.createdAt) + '</div>' +
          '</div>' +
          '<div class="bot-score-big">Bot score ' + botRiskHtml(data.botScore) + ' <span class="bot-risk-text ' + (data.risk || 'low') + '">' + escapeHtml(data.risk || 'low') + ' risk</span></div>' +
        '</div>' +
        '<div class="bot-signals">' +
          botSignalHtml('Account age', (s.accountAgeDays || 0) + ' days') +
          botSignalHtml('Messages sent', s.totalMessages || 0) +
          botSignalHtml('Media sent', s.mediaCount || 0) +
          botSignalHtml('Msgs / day', s.msgsPerDay || 0) +
          botSignalHtml('DM partners', s.uniquePartners || 0) +
          botSignalHtml('Groups', s.uniqueGroups || 0) +
          botSignalHtml('First msg', s.firstMessageAt ? timeAgo(s.firstMessageAt) : '—') +
          botSignalHtml('Last msg', s.lastMessageAt ? timeAgo(s.lastMessageAt) : '—') +
        '</div>' +
        '<div class="bot-media-title">📷 Media this user sent (' + media.length + ')</div>' +
        mediaGrid;
      $$('.bot-back', body).forEach(b => b.addEventListener('click', () => renderBotsTab(body)));
      // Tap a media tile → in-app lightbox (window.open is blocked inside the
      // Capacitor WebView, so the preview must be an overlay, not a new tab).
      $$('.bot-media-tile', body).forEach(t => {
        t.addEventListener('click', () => {
          const url = t.dataset.url;
          const type = t.dataset.mtype;
          if (url) showBotLightbox(url, type);
        });
      });
    } catch (e) {
      body.innerHTML = '<div class="admin-empty">Failed to load user media</div>';
    }
  }

  // Full-screen lightbox for Bot Check media — works on web AND in the native
  // Android WebView (window.open would be silently blocked there).
  function showBotLightbox(url, type) {
    let overlay = $('#botLightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'bot-lightbox';
      overlay.id = 'botLightbox';
      document.body.appendChild(overlay);
    }
    const isImage = !type || type === 'image' || /^data:image\//.test(url) || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url);
    const isVideo = type === 'video' || /\.(mp4|webm)(\?|$)/i.test(url);
    const inner = isVideo
      ? '<video src="' + attrEscape(url) + '" controls autoplay playsinline></video>'
      : isImage
        ? '<img src="' + attrEscape(url) + '" alt="Media preview">'
        : '<div class="bot-lightbox-file">' + (type === 'voice' ? '🎤 Voice message' : type === 'file' || type === 'document' ? '📄 File' : '📄 Attachment') + '<br><a href="' + attrEscape(url) + '" target="_blank" rel="noopener">Open</a></div>';
    overlay.innerHTML = '<div class="bot-lightbox-bg"></div><div class="bot-lightbox-content">' + inner + '<button class="bot-lightbox-close" title="Close">✕</button></div>';
    overlay.classList.add('show');
    document.body.classList.add('no-scroll');
    const close = () => {
      overlay.classList.remove('show');
      document.body.classList.remove('no-scroll');
      if (isVideo) {
        const v = overlay.querySelector('video');
        if (v) v.pause();
      }
    };
    overlay.querySelector('.bot-lightbox-bg').addEventListener('click', close);
    overlay.querySelector('.bot-lightbox-close').addEventListener('click', close);
  }

  function botSignalHtml(label, value) {
    return '<div class="bot-signal"><span class="bot-signal-label">' + escapeHtml(label) + '</span><span class="bot-signal-value">' + escapeHtml(String(value)) + '</span></div>';
  }

  // mediaUrl is client-influenced (a socket can store an arbitrary string), so
  // it goes through the same window.safeUrl sanitizer the chat renderers use.
  // allowDataImage=true is REQUIRED: the web photo flow compresses images into
  // data:image/... URLs and stores them as mediaUrl — without this flag every
  // web-sent photo would be rejected and show an empty placeholder tile.
  // API_BASE is only prefixed onto relative /uploads paths (never onto a
  // client-supplied absolute URL, which would get mangled into a broken link).
  function botMediaFullUrl(mediaUrl) {
    if (!mediaUrl) return '';
    let full = mediaUrl.charAt(0) === '/' ? API_BASE + mediaUrl : mediaUrl;
    if (typeof window.safeUrl === 'function') full = window.safeUrl(full, true) || '';
    return full;
  }

  function botMediaTileHtml(m) {
    const full = botMediaFullUrl(m.mediaUrl);
    const when = timeAgo(m.timestamp);
    const label = m.type === 'image' ? '📷' : m.type === 'video' ? '🎬' : m.type === 'voice' ? '🎤' : '📄';
    const isImage = full && (m.type === 'image' || /^data:image\//.test(full));
    const thumb = isImage ? '<img src="' + attrEscape(full) + '" alt="" loading="lazy">' : '<div class="bot-media-placeholder">' + label + '</div>';
    return '<div class="bot-media-tile" data-url="' + attrEscape(full) + '" data-mtype="' + attrEscape(m.type || '') + '" title="' + attrEscape(when) + '">' + thumb + '<div class="bot-media-time">' + escapeHtml(when) + '</div></div>';
  }

  // ---- Appeals tab (banned users asking for reinstatement) ----
  async function renderAppealsTab(body) {
    body.innerHTML = '<div class="admin-loading">Loading appeals…</div>';
    try {
      const res = await fetch(api('/api/admin/appeals'));
      // Old backends don't have this route yet — surface that clearly instead
      // of a generic "failed to load".
      if (res.status === 401 || res.status === 404) {
        body.innerHTML = '<div class="admin-empty">⚙️ The server hasn\'t been updated yet — redeploy the backend to enable appeals.</div>';
        return;
      }
      const data = await res.json();
      const appeals = data.appeals || [];
      if (!appeals.length) {
        body.innerHTML = '<div class="admin-empty">🛡️ No open appeals — all clear.</div>';
        return;
      }
      body.innerHTML = '<div class="admin-report-list">' + appeals.map(appealCardHtml).join('') + '</div>';
      $$('.admin-action', body).forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const action = btn.dataset.action;
          armConfirm(btn, action === 'approve' ? 'Unban this user?' : 'Reject this appeal?', () => resolveAppeal(btn, id, action));
        });
      });
    } catch (e) {
      body.innerHTML = '<div class="admin-empty">Failed to load appeals</div>';
    }
  }

  function appealCardHtml(a) {
    return '<div class="admin-report-card">' +
      '<div class="admin-report-top">' +
        '<span class="admin-report-reason">APPEAL</span>' +
        '<span class="admin-report-time">' + timeAgo(a.createdAt) + '</span>' +
      '</div>' +
      '<div class="admin-user-name">' + escapeHtml(a.displayName) + ' <span style="color:var(--text-muted);font-weight:500;">@' + escapeHtml(a.username) + '</span></div>' +
      '<div class="admin-report-msg">' + escapeHtml((a.reason && a.reason.length > 220) ? a.reason.slice(0, 220) + '…' : a.reason) + '</div>' +
      '<div class="admin-report-meta">' +
        '<span>📩 banned ' + timeAgo(a.bannedAt || a.createdAt) + '</span>' +
        '<span>💬 ' + (a.messageCount || 0) + ' msgs' + (a.priorReports ? ' · ' + a.priorReports + ' reports' : '') + '</span>' +
      '</div>' +
      '<div class="admin-report-actions">' +
        '<button class="admin-action approve" data-id="' + attrEscape(a.id) + '" data-action="approve">Approve & Unban</button>' +
        '<button class="admin-action delete" data-id="' + attrEscape(a.id) + '" data-action="reject">Reject</button>' +
      '</div>' +
    '</div>';
  }

  async function resolveAppeal(btn, id, action) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch(api('/api/admin/appeals/' + id + '/' + action), { method: 'POST' });
      const data = await res.json();
      showToast(data.success ? (action === 'approve' ? 'Appeal approved — user unbanned' : 'Appeal rejected') : (data.error || 'Action failed'), data.success ? 'info' : 'error');
    } catch (e) {
      showToast('Action failed', 'error');
    }
    renderAdminTab('appeals');
  }

  // ---- Users tab ----
  async function renderUsersTab(body) {
    body.innerHTML = '<div class="admin-loading">Loading users…</div>';
    try {
      const res = await fetch(api('/api/admin/users'));
      const data = await res.json();
      if (!data.users) {
        body.innerHTML = '<div class="admin-empty">' + escapeHtml(data.error || 'Failed to load users') + '</div>';
        return;
      }
      const list = data.users.map(u => userRowHtml(u)).join('');
      body.innerHTML =
        '<div class="admin-toolbar"><input type="text" class="admin-search" id="adminUserSearch" placeholder="Search users…"></div>' +
        '<div class="admin-user-list">' + list + '</div>';
      wireUserActions(body);
      const search = $('#adminUserSearch');
      if (search) {
        search.addEventListener('input', () => {
          const q = search.value.toLowerCase();
          $$('.admin-user-row', body).forEach(row => {
            const hay = (row.dataset.search || '').toLowerCase();
            row.style.display = hay.includes(q) ? '' : 'none';
          });
        });
      }
    } catch (e) {
      body.innerHTML = '<div class="admin-empty">Failed to load users</div>';
    }
  }

  function userRowHtml(u) {
    const isSelf = String(u.id) === String(currentUser.id);
    const banned = !!u.banned;
    return '<div class="admin-user-row' + (banned ? ' banned' : '') + '" data-search="' + attrEscape((u.displayName || '') + ' ' + (u.username || '')) + '">' +
      '<div class="admin-user-avatar">' + avatarHtml(u.avatar, u.displayName || u.username) + '</div>' +
      '<div class="admin-user-info">' +
        '<div class="admin-user-name">' + escapeHtml(userName(u)) +
          (u.role === 'admin' ? ' <span class="admin-badge">ADMIN</span>' : '') +
          (isSelf ? ' <span class="admin-badge self">YOU</span>' : '') +
          (banned ? ' <span class="admin-badge banned">BANNED</span>' : '') +
        '</div>' +
        '<div class="admin-user-sub">@' + escapeHtml(u.username || '') +
          ' · ' + (u.messageCount || 0) + ' msgs' +
          (u.reportCount ? ' · ' + u.reportCount + ' reports' : '') +
          ' · ' + (u.online ? 'online' : 'offline') +
        '</div>' +
      '</div>' +
      (isSelf ? '' : '<button class="admin-ban-btn' + (banned ? ' unban' : '') + '" data-id="' + attrEscape(u.id) + '" data-banned="' + banned + '" data-name="' + attrEscape(userName(u)) + '">' + (banned ? 'Unban' : 'Ban') + '</button>') +
    '</div>';
  }

  function wireUserActions(body) {
    $$('.admin-ban-btn', body).forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.dataset.id;
        const name = btn.dataset.name;
        const currentlyBanned = btn.dataset.banned === 'true';
        if (!currentlyBanned) {
          armConfirm(btn, 'Ban ' + name + '?', () => doBan(btn, userId, name, currentlyBanned));
          return;
        }
        await doBan(btn, userId, name, currentlyBanned);
      });
    });
  }

  async function doBan(btn, userId, name, currentlyBanned) {
    const action = currentlyBanned ? 'unban' : 'ban';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch(api('/api/admin/users/' + userId + '/' + action), { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(currentlyBanned ? name + ' unbanned' : name + ' banned', currentlyBanned ? 'info' : 'error');
      } else {
        showToast(data.error || 'Action failed', 'error');
      }
    } catch (e) {
      showToast('Action failed', 'error');
    }
    renderAdminTab('users');
  }

  // ---- Reports tab (light inbox-style, matching Feedback Hub) ----
  // Friendly reason info: icon + human label + css class per report reason.
  function reportReasonInfo(reason) {
    const r = String(reason || 'other').toLowerCase();
    if (r === 'spam') return { icon: '📣', label: 'Spam', cls: 'spam' };
    if (r === 'abuse' || r === 'harassment') return { icon: '😠', label: 'Abuse', cls: 'abuse' };
    if (r === 'inappropriate' || r === 'nsfw') return { icon: '⚠️', label: 'Inappropriate', cls: 'inappropriate' };
    return { icon: '🚩', label: 'Other', cls: 'other' };
  }

  async function renderReportsTab(body) {
    body.innerHTML = '<div class="admin-loading">Loading reports…</div>';
    try {
      const res = await fetch(api('/api/admin/reports'));
      const data = await res.json();
      const reports = data.reports || [];
      body.innerHTML =
        '<div class="fb-intro">🚩 <b>Reports</b> — messages users flagged for review. <b>Dismiss</b> if it\'s fine, <b>Delete msg</b> to remove it, or <b>Delete + Ban</b> to remove it and block the author.</div>' +
        '<div class="fb-stats"><span class="fb-stat-pill">' + reports.length + ' open ' + (reports.length === 1 ? 'report' : 'reports') + '</span></div>' +
        (reports.length
          ? '<div class="fb-list">' + reports.map(reportRowHtml).join('') + '</div>'
          : '<div class="admin-empty">🎉 No open reports — all clear.</div>');
      wireReportActions(body);
    } catch (e) {
      body.innerHTML = '<div class="admin-empty">Failed to load reports</div>';
    }
  }

  function reportRowHtml(r) {
    const msg = r.message;
    const k = reportReasonInfo(r.reason);
    const author = r.author;
    const text = msg ? (msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'location' ? '📍 Location' : msg.type === 'voice' ? '🎤 Voice' : 'Message')) : '(message deleted)';
    return '<div class="fb-row fb-report-row">' +
      '<div class="fb-row-icon avatar">' + avatarHtml(author && author.avatar, userName(author)) + '</div>' +
      '<div class="fb-row-main">' +
        '<div class="fb-row-top">' +
          '<span class="fb-row-name">' + escapeHtml(userName(author)) + '</span>' +
          (author && author.banned ? '<span class="fb-row-status banned">BANNED</span>' : '') +
          '<span class="fb-reason-chip ' + k.cls + '">' + k.icon + ' ' + escapeHtml(k.label) + '</span>' +
          '<span class="fb-row-time">' + timeAgo(r.createdAt) + '</span>' +
        '</div>' +
        '<div class="fb-row-text">' + escapeHtml((text && text.length > 200) ? text.slice(0, 200) + '…' : text) + '</div>' +
        '<div class="fb-row-meta"><span>🚩 reported by ' + escapeHtml(userName(r.reporter)) + '</span></div>' +
        '<div class="fb-report-actions">' +
          '<button class="fb-act dismiss" data-id="' + attrEscape(r.id) + '" data-action="dismiss">Dismiss</button>' +
          '<button class="fb-act delete" data-id="' + attrEscape(r.id) + '" data-action="delete">Delete msg</button>' +
          (author && author.id !== currentUser.id ? '<button class="fb-act ban" data-id="' + attrEscape(r.id) + '" data-action="delete-ban">Delete + Ban</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function wireReportActions(body) {
    $$('.fb-act', body).forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        const label = action === 'dismiss' ? 'Dismiss this report?' : action === 'delete' ? 'Delete this message?' : 'Delete msg + ban author?';
        armConfirm(btn, label, () => resolveReport(btn, id, action));
      });
    });
  }

  async function resolveReport(btn, id, action) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch(api('/api/admin/reports/' + id + '/resolve'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      showToast(data.success ? (action === 'dismiss' ? 'Report dismissed' : action === 'delete' ? 'Message deleted' : 'Message deleted & author banned') : (data.error || 'Action failed'), data.success ? 'info' : 'error');
    } catch (e) {
      showToast('Action failed', 'error');
    }
    renderAdminTab('reports');
  }

  // ---- Feedback Hub tab (moderation of abusive posts) ----
  // Shared fetch + normalization for the Feedback Hub tab. Returns
  // { roots, repliesByParent, usersMap } with deleted/orphaned items already
  // filtered out (a reply whose thread root is deleted is hidden too).
  async function loadFeedbackHubData() {
    const res = await fetch(api('/api/feedback/messages?hubId=' + FEEDBACK_HUB_ID));
    const data = await res.json();
    const allMsgs = data.messages || [];
    const deletedIds = new Set(allMsgs.filter(m => m.deleted).map(m => m.id));
    const visible = allMsgs.filter(m => !m.deleted && !(m.parentId && deletedIds.has(m.parentId)));
    const roots = visible.filter(m => !m.parentId).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const repliesByParent = {};
    visible.filter(m => m.parentId).forEach(m => {
      if (!repliesByParent[m.parentId]) repliesByParent[m.parentId] = [];
      repliesByParent[m.parentId].push(m);
    });
    Object.values(repliesByParent).forEach(arr => arr.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)));
    const usersMap = {};
    (data.users || []).forEach(u => usersMap[u.id] = u);
    return { roots, repliesByParent, usersMap };
  }

  function deleteFeedbackMsg(btn, id, onDone) {
    armConfirm(btn, 'Delete post?', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await fetch(api('/api/admin/feedback/' + id + '/delete'), { method: 'POST' });
        const data = await res.json();
        showToast(data.success ? 'Feedback post removed' : (data.error || 'Failed to delete'), data.success ? 'info' : 'error');
      } catch (e) {
        showToast('Failed to delete', 'error');
      }
      if (typeof onDone === 'function') onDone();
      else renderAdminTab('feedback');
    });
  }

  // ---- Feedback Hub admin tab (moderation of discussion threads) ----
  // Friendly kind info: icon + human label + css class for each thread type.
  function fbKindInfo(m) {
    if (m._bug) return { icon: '🐛', label: 'Bug report', cls: 'bug' };
    if (m._feature) return { icon: '💡', label: 'Feature request', cls: 'feature' };
    if (m._poll) return { icon: '📊', label: 'Poll', cls: 'poll' };
    return { icon: '💬', label: 'Discussion', cls: 'post' };
  }

  function fbStatusOf(m) {
    if (m._bug && m._bug.status) return m._bug.status;
    if (m._feature && m._feature.status) return m._feature.status;
    return '';
  }

  function fbVotesOf(m) {
    if (m._feature && Array.isArray(m._feature.votes)) return m._feature.votes.length;
    if (m._poll && m._poll.votes) return Object.keys(m._poll.votes).length;
    return 0;
  }

  // Thread list view: a light, compact list of discussion threads (root posts)
  // newest first, with a search box. Click a row to open the thread.
  async function renderFeedbackTab(body) {
    body.innerHTML = '<div class="admin-loading">Loading feedback hub…</div>';
    try {
      const { roots, repliesByParent, usersMap } = await loadFeedbackHubData();
      const totalReplies = Object.values(repliesByParent).reduce((n, a) => n + a.length, 0);
      const rows = roots.map(m =>
        feedbackThreadRowHtml(m, usersMap, (repliesByParent[m.id] || []).length)
      ).join('');
      body.innerHTML =
        '<div class="fb-intro">💬 <b>Feedback Hub</b> — discussion threads from users. Open one to see its replies. <b>Delete</b> removes the thread and all replies.</div>' +
        '<div class="fb-stats">' +
          '<span class="fb-stat-pill">' + roots.length + ' ' + (roots.length === 1 ? 'thread' : 'threads') + '</span>' +
          '<span class="fb-stat-pill">' + totalReplies + ' ' + (totalReplies === 1 ? 'reply' : 'replies') + '</span>' +
        '</div>' +
        (roots.length ? '<div class="admin-toolbar"><input type="text" class="admin-search" id="fbAdminSearch" placeholder="Search threads…"></div>' : '') +
        (roots.length ? '<div class="fb-list">' + rows + '</div>' : '<div class="admin-empty">No discussion threads yet — when users post in the Feedback Hub, threads appear here.</div>');
      $$('.fb-row', body).forEach(card => {
        card.addEventListener('click', (e) => {
          // Clicking a button inside the row must not also open it.
          if (e.target.closest('.fb-open') || e.target.closest('.fb-del')) return;
          renderFeedbackThreadDetail(body, card.dataset.id, usersMap, repliesByParent, roots);
        });
      });
      // Dedicated open handler (stopPropagation so the row click doesn't
      // double-fire) — the open button must NOT go through deleteFeedbackMsg.
      $$('.fb-open', body).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          renderFeedbackThreadDetail(body, btn.dataset.id, usersMap, repliesByParent, roots);
        });
      });
      // Only the delete buttons delete.
      $$('.fb-del', body).forEach(btn => {
        btn.addEventListener('click', () => deleteFeedbackMsg(btn, btn.dataset.id));
      });
      // Live filter by text or author, same pattern as the Users tab.
      const search = $('#fbAdminSearch');
      if (search) {
        search.addEventListener('input', () => {
          const q = search.value.toLowerCase();
          $$('.fb-row', body).forEach(card => {
            card.style.display = (card.dataset.search || '').toLowerCase().includes(q) ? '' : 'none';
          });
        });
      }
    } catch (e) {
      body.innerHTML = '<div class="admin-empty">Failed to load feedback hub</div>';
    }
  }

  function feedbackThreadRowHtml(m, usersMap, replyCount, inDetail) {
    const author = usersMap[m.from];
    const k = fbKindInfo(m);
    const status = fbStatusOf(m);
    const votes = fbVotesOf(m);
    const text = m.text || (m.type === 'image' ? '📷 Photo' : m.type === 'location' ? '📍 Location' : 'Message');
    const searchText = ((m.text || '') + ' ' + userName(author) + ' ' + (author && author.username || '')).toLowerCase();
    return '<div class="fb-row' + (inDetail ? ' fb-row-detail' : '') + '" data-id="' + attrEscape(m.id) + '" data-search="' + attrEscape(searchText) + '">' +
      '<div class="fb-row-icon ' + k.cls + '" title="' + escapeHtml(k.label) + '">' + k.icon + '</div>' +
      '<div class="fb-row-main">' +
        '<div class="fb-row-top">' +
          '<span class="fb-row-name">' + escapeHtml(userName(author)) + '</span>' +
          '<span class="fb-row-time">' + timeAgo(m.timestamp) + '</span>' +
          (status ? '<span class="fb-row-status">' + escapeHtml(status) + '</span>' : '') +
          (inDetail ? '<span class="fb-row-tag">THREAD</span>' : '') +
        '</div>' +
        '<div class="fb-row-text">' + escapeHtml((text && text.length > 200) ? text.slice(0, 200) + '…' : text) + '</div>' +
        '<div class="fb-row-meta">' +
          '<span>💬 ' + replyCount + (replyCount === 1 ? ' reply' : ' replies') + '</span>' +
          (votes ? '<span>👍 ' + votes + (votes === 1 ? ' vote' : ' votes') + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="fb-row-actions">' +
        (inDetail ? '' : '<button class="fb-open" data-id="' + attrEscape(m.id) + '" title="Open thread">→</button>') +
        '<button class="fb-del" data-id="' + attrEscape(m.id) + '" title="Delete thread">🗑</button>' +
      '</div>' +
    '</div>';
  }

  // Thread detail view: the root post on top, then its replies, each with a
  // delete button, plus a back button to the thread list. Uses the data passed
  // from the list view (no re-fetch), and stays in the thread after a reply is
  // deleted instead of bouncing back to the list.
  function renderFeedbackThreadDetail(body, threadId, usersMap, repliesByParent, roots) {
    const found = (roots || []).find(m => m.id === threadId);
    if (!found) { renderFeedbackTab(body); return; }
    const replies = (repliesByParent[threadId] || []).slice();
    const render = () => {
      body.innerHTML =
        '<button class="admin-action bot-back" id="fbThreadBack">← Back to threads</button>' +
        '<div class="fb-hint">' + replies.length + ' ' + (replies.length === 1 ? 'reply' : 'replies') + ' — delete removes abusive content.</div>' +
        '<div class="fb-list">' +
          feedbackThreadRowHtml(found, usersMap, replies.length, true) +
          replies.map(r => feedbackReplyRowHtml(r, usersMap)).join('') +
        '</div>';
      $('#fbThreadBack').addEventListener('click', () => renderFeedbackTab(body));
      // Only the delete buttons delete; deleting a REPLY stays in the thread
      // (splice locally + re-render), but deleting the ROOT thread itself must
      // bounce back to the list — the root isn't in `replies`, so without this
      // its card would stay visible after the server already removed it.
      $$('.fb-del', body).forEach(btn => {
        btn.addEventListener('click', () => deleteFeedbackMsg(btn, btn.dataset.id, () => {
          if (btn.dataset.id === threadId) { renderFeedbackTab(body); return; }
          const i = replies.findIndex(r => r.id === btn.dataset.id);
          if (i > -1) replies.splice(i, 1);
          render();
        }));
      });
    };
    render();
  }

  function feedbackReplyRowHtml(m, usersMap) {
    const author = usersMap[m.from];
    const text = m.text || (m.type === 'image' ? '📷 Photo' : m.type === 'location' ? '📍 Location' : 'Message');
    return '<div class="fb-reply">' +
      '<div class="fb-reply-head">' +
        '<div class="admin-user-avatar small">' + avatarHtml(author && author.avatar, userName(author)) + '</div>' +
        '<span class="fb-reply-name">' + escapeHtml(userName(author)) + '</span>' +
        '<span class="fb-reply-time">' + timeAgo(m.timestamp) + '</span>' +
        '<button class="fb-del" data-id="' + attrEscape(m.id) + '" title="Delete reply">🗑</button>' +
      '</div>' +
      '<div class="fb-reply-text">' + escapeHtml((text && text.length > 200) ? text.slice(0, 200) + '…' : text) + '</div>' +
    '</div>';
  }


  // ============ SOCKET: live ban notification ============
  function wireSocketEvents() {
    if (!socket) return;
    // Server kicks banned users and tells them why before disconnecting.
    socket.on('account_banned', (data) => {
      showToast((data && data.message) || 'Your account has been banned.', 'error');
      setTimeout(() => {
        if (typeof window.doLogout === 'function') window.doLogout('Your account has been banned.');
      }, 1200);
    });
  }

  window.toggleAdminPanel = toggleAdminPanel;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
