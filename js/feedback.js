(function() {
  'use strict';

  const FEEDBACK_HUB_ID = 'feedback-global-hub';
  let currentUser = null;
  let socket = null;
  let feedbackHub = null;
  let usersMap = {};
  let dashboardOpen = false;
  let dashboardEl = null;
  let currentFilter = 'all';
  let allMessages = [];
  let threadParentId = null;
  let mentionPopup = { open: false, items: [], active: 0, queryStart: 0 };
  let pendingBugResolve = null;
  let pendingFeatureResolve = null;
  let pendingPollResolve = null;
  let dashboardForcedChatOpen = false;
  let feedbackNotifs = []; // unread 'for me' thread replies → Notifications drawer

  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
  const api = (p) => API_BASE + p;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    const days = Math.floor(hrs / 24);
    return days + 'd';
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function getUserName(userId) {
    const u = usersMap[userId];
    return u ? u.displayName || u.username : userId.slice(0, 8);
  }

  // Gold crown next to hub authors who are global admins (usersMap now carries
  // the safe isAdmin flag from the backend). Self-contained SVG so we don't
  // depend on app.js's icon() helper load order. Kept in sync with app.js's
  // ADMIN_BADGE_TITLE — same copy on purpose.
  var HUB_ADMIN_TITLE = 'Verified admin — assigned by the server';
  function hubAdminBadge(userId) {
    const u = usersMap[userId];
    return (u && u.isAdmin)
      ? '<span class="admin-badge" title="' + HUB_ADMIN_TITLE + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 19l3-14 4 7 4-7 3 14"/><path d="M2 19h20"/></svg></span>'
      : '';
  }

  function getAvatarChar(userId) {
    return getUserName(userId).charAt(0).toUpperCase();
  }

  function showToast(msg, type) {
    const container = $('#toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => { t.classList.add('toast-hide'); setTimeout(() => t.remove(), 300); }, 3000);
  }

  function escapeHtml(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Attribute-context escaping: escapeHtml() above does NOT escape quotes, so
  // any user-controlled value placed inside an attribute (data-*, title) must
  // go through this — otherwise a poll quadrant like x" onmouseover=... breaks
  // out of the attribute (stored XSS for every viewer).
  function attrEsc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Poll for the app's authenticated session (window.currentUser +
  // window.socket are set by app.js after login/boot). Account switches call
  // resetFeedbackHub -> startPolling again so the hub rebinds to the NEW user
  // and NEW socket instead of the account that was active at page load.
  let pollTimer = null;
  let listenersBound = false;
  let boundSocket = null;

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (window.currentUser && window.socket) {
        clearInterval(pollTimer);
        pollTimer = null;
        currentUser = window.currentUser;
        socket = window.socket;
        setup();
      }
    }, 200);
  }

  function init() {
    startPolling();
  }

  // Resolve the discussion thread to open from a deep link. The backend poll
  // provides the thread ROOT id (parentId) once redeployed, but older backends
  // only give us the reply's own message id — so fall back to looking the
  // reply up in allMessages and using its parentId (or its own id when it IS a
  // root post). This keeps deep links working even before the redeploy.
  function resolveThreadTarget(threadId, replyId) {
    if (threadId) return threadId;
    if (!replyId) return null;
    var reply = allMessages.find(function(m) { return String(m.id) === String(replyId); });
    if (!reply) return null;
    return reply.parentId || reply.id;
  }

  function openDeepLink(threadId, replyId) {
    var target = resolveThreadTarget(threadId, replyId);
    if (target && typeof window.openFeedbackThread === 'function') {
      // Read mode + one-frame defer: no keyboard pop and no double animation.
      window.openFeedbackThread(target, { focus: false, defer: true });
    }
  }

  // Android deep link: a "HiFi Feedback" notification tap stores the thread
  // root id (hifi_pending_thread) and/or reply id (hifi_pending_reply). After
  // the hub is ready, open that discussion thread. One-shot — the take*
  // getters clear their prefs. Called on boot AND on app resume
  // (visibilitychange) so a tap while the app is warm in the background still
  // jumps into the thread instead of only working on a cold start.
  function consumePendingThreadDeepLink() {
    if (!window.currentUser || !window.socket) return;
    if (typeof AndroidNativeConfig === 'undefined' || !AndroidNativeConfig
        || typeof AndroidNativeConfig.takePendingThreadId !== 'function') return;
    try {
      var threadId = AndroidNativeConfig.takePendingThreadId();
      var replyId = typeof AndroidNativeConfig.takePendingReplyId === 'function'
        ? AndroidNativeConfig.takePendingReplyId()
        : null;
      openDeepLink(threadId, replyId);
    } catch (e) {
      console.warn('Pending feedback thread deep link failed:', e);
    }
  }

  // Warm-start deep link (fast path): MainActivity pushes the ids straight
  // into the WebView via evaluateJavascript when a notification tap resumes an
  // already-running app. No visibilitychange dependency. Because MainActivity
  // ALWAYS stores the ids in SharedPreferences (so cold starts where the push
  // no-ops still work), this handler must clear those one-shot prefs after
  // opening — otherwise the visibilitychange fallback would re-open the same
  // thread a moment later (double render/scroll).
  window.handleFeedbackDeepLink = function(threadId, replyId) {
    var target = resolveThreadTarget(threadId, replyId);
    // Only consume the one-shot prefs when we ACTUALLY opened the thread — if
    // the target couldn't be resolved yet (e.g. allMessages still loading on a
    // cold-ish start), leave the prefs so the setup()/visibilitychange fallback
    // can pick them up instead of losing the deep link.
    if (target && typeof window.openFeedbackThread === 'function') {
      // Read mode + one-frame defer: no keyboard pop and no double animation.
      window.openFeedbackThread(target, { focus: false, defer: true });
      try {
        if (typeof AndroidNativeConfig !== 'undefined' && AndroidNativeConfig) {
          if (typeof AndroidNativeConfig.takePendingThreadId === 'function') AndroidNativeConfig.takePendingThreadId();
          if (typeof AndroidNativeConfig.takePendingReplyId === 'function') AndroidNativeConfig.takePendingReplyId();
        }
      } catch (e) {}
    }
  };

  // On resume (warm start from a notification tap) the page is already loaded
  // so setup() won't re-run — check for a pending thread again. Debounced via
  // a flag so a burst of visibility events only opens the thread once. This is
  // a fallback to the evaluateJavascript push above (and covers cold starts
  // where setup() consumed nothing yet).
  var resumeDeepLinkPending = false;
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible' || resumeDeepLinkPending) return;
    resumeDeepLinkPending = true;
    setTimeout(function() {
      resumeDeepLinkPending = false;
      consumePendingThreadDeepLink();
    }, 300);
  });

  async function setup() {
    try {
      const res = await fetch(api('/api/groups/feedback/info'));
      const data = await res.json();
      if (data.exists) {
        feedbackHub = data.hub;
        if (!feedbackHub.members.includes(currentUser.id)) {
          await fetch(api('/api/feedback/auto-join'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
          });
          feedbackHub.members.push(currentUser.id);
        }
      } else {
        showToast('Feedback hub not ready, try again later', 'error');
      }
    } catch (e) {
      console.warn('Feedback hub unavailable:', e);
    }

    // Static DOM listeners + observer bind ONCE per page; only socket events
    // re-bind when the session socket reference changes (account switch).
    // Without this guard, re-running setup on every login would stack
    // duplicate click handlers (double toggles, double bug submissions).
    if (!listenersBound) {
      listenersBound = true;
      $('#feedbackBtn')?.addEventListener('click', toggleDashboard);
      wireModals();
      observeConversationChanges();
    }
    if (socket !== boundSocket) {
      boundSocket = socket;
      wireSocketEvents();
    }
    refreshUnreadBadge();
    // Preload hub messages so the Notifications drawer + bell badge reflect
    // unread for-me thread replies from the moment the app opens.
    loadMessages().then(function() {
      consumePendingThreadDeepLink();
    });
  }

  // Public reset — called by app.js on logout and on (re)login so the hub
  // follows the active session instead of the account from page load.
  window.resetFeedbackHub = function() {
    if (dashboardOpen) closeDashboardInternal();
    closeThreadPanel();
    // Drop all per-session state from the previous account.
    currentUser = null;
    socket = null;
    feedbackHub = null;
    usersMap = {};
    allMessages = [];
    feedbackNotifs = [];
    dashboardEl = null;
    dashboardOpen = false;
    currentFilter = 'all';
    threadParentId = null;
    // NOTE: boundSocket is intentionally NOT reset here. enterChat() always
    // creates a fresh socket object on login, so setup()'s reference check
    // (socket !== boundSocket) naturally re-wires events on a real account
    // switch. Nulling it here would let the same socket be wired twice when
    // setup() runs again for an unchanged session (duplicate handlers).
    startPolling();
  };

  function toggleDashboard() {
    if (dashboardOpen) closeDashboard();
    else openDashboard();
  }

  async function openDashboard() {
    if (dashboardOpen) return;
    dashboardOpen = true;
    await loadMessages();

    dashboardEl = document.createElement('div');
    dashboardEl.id = 'feedbackDashboard';
    dashboardEl.className = 'fb-dashboard';
    dashboardEl.setAttribute('role', 'region');
    dashboardEl.setAttribute('aria-label', 'Feedback Hub');

    const chatArea = $('#chatArea');
    if (chatArea) {
      // On mobile (#chatArea is display:none unless .chat-open), force it visible
      const chatAppEl = document.getElementById('chatApp');
      if (chatAppEl) {
        dashboardForcedChatOpen = chatAppEl.classList.contains('chat-open');
        chatAppEl.classList.add('chat-open');
      }
      const empty = $('#emptyState');
      const active = $('#activeChat');
      if (empty) empty.style.display = 'none';
      if (active) active.style.display = 'none';
      chatArea.appendChild(dashboardEl);
    }

    renderDashboard();
    renderFeed('all');
    $('#feedbackBtn')?.classList.add('active');

    // Register with the global navigation stack so device/browser back
    // (and iOS swipe-back) closes the hub step-by-step.
    if (window.Nav) window.Nav.push('feedback', closeDashboardInternal);
  }

  // DOM cleanup only — no history calls. Driven by Nav._pop.
  function closeDashboardInternal() {
    if (!dashboardEl && !dashboardOpen) return;
    dashboardOpen = false;
    if (dashboardEl && dashboardEl.parentNode) {
      dashboardEl.parentNode.removeChild(dashboardEl);
    }
    dashboardEl = null;
    const empty = $('#emptyState');
    const active = $('#activeChat');
    if (window.activeChat) {
      if (empty) empty.style.display = 'none';
      if (active) active.style.display = 'flex';
    } else {
      if (empty) empty.style.display = '';
      if (active) active.style.display = 'none';
    }
    $('#feedbackBtn')?.classList.remove('active');
    const chatAppEl = document.getElementById('chatApp');
    if (chatAppEl && !dashboardForcedChatOpen) chatAppEl.classList.remove('chat-open');
    dashboardForcedChatOpen = false;
    closeThreadPanel();
  }

  // Public close — used by the in-app back button / toggle. Navigates back
  // through the history stack (which triggers Nav._pop -> closeDashboardInternal).
  function closeDashboard() {
    if (window.Nav) window.Nav.back();
    else closeDashboardInternal();
  }

  function renderDashboard() {
    const isAdmin = feedbackHub && feedbackHub.admins.includes(currentUser.id);
    dashboardEl.innerHTML = `
      <div class="fb-header">
        <button class="fb-back-btn" id="fbBackBtn" title="Back" aria-label="Back to conversations">‹</button>
        <h2>HiFi Feedback</h2>
        <div class="fb-header-actions">
          <button class="fb-header-btn" data-action="bug" title="Report a bug">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Bug
          </button>
          <button class="fb-header-btn" data-action="feature" title="Suggest a feature">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg> Feature
          </button>
          <button class="fb-header-btn" data-action="poll" title="Create priority poll">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Poll
          </button>
        </div>
      </div>
      <div class="fb-tabs" role="tablist">
        <button class="fb-tab active" data-filter="all" role="tab">All</button>
        <button class="fb-tab" data-filter="bug" role="tab">Bugs</button>
        <button class="fb-tab" data-filter="feature" role="tab">Features</button>
        <button class="fb-tab" data-filter="poll" role="tab">Polls</button>
      </div>
      <div class="fb-list" id="fbList" role="tabpanel"></div>
    `;

    dashboardEl.querySelector('#fbBackBtn')?.addEventListener('click', closeDashboard);

    dashboardEl.querySelectorAll('.fb-header-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'bug') openBugModal();
        else if (action === 'feature') openFeatureModal();
        else if (action === 'poll') openPollModal();
      });
    });

    dashboardEl.querySelectorAll('.fb-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        dashboardEl.querySelectorAll('.fb-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.dataset.filter;
        renderFeed(currentFilter);
      });
    });
  }

  function renderFeed(filter) {
    const list = $('#fbList');
    if (!list) return;

    let msgs = allMessages.filter(m => !m._threadReply && !m.deleted);
    if (filter && filter !== 'all') {
      msgs = msgs.filter(m => m['_' + filter]);
    }

    if (msgs.length === 0) {
      list.innerHTML = '<div class="fb-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><p>No ' + (filter === 'all' ? '' : filter + ' ') + 'feedback yet.</p></div>';
      return;
    }

    list.innerHTML = msgs.map(m => {
      if (m._bug) return renderBugCard(m);
      if (m._feature) return renderFeatureCard(m);
      if (m._poll) return renderPollCard(m);
      return '';
    }).join('');

    list.querySelectorAll('.fb-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.fb-status-select') || e.target.closest('.fb-vote-btn') || e.target.closest('.poll-cell')) return;
        const id = card.dataset.messageId;
        if (id) openThread(id);
      });
    });

    list.querySelectorAll('.fb-status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.messageId;
        const type = sel.dataset.type;
        const status = sel.value;
        try {
          const res = await fetch(api('/api/' + type + 's/' + id + '/status'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, requestedBy: currentUser.id })
          });
          const data = await res.json();
          if (data.success) showToast('Status updated');
          else showToast(data.error || 'Failed to update', 'error');
        } catch (e) {
          showToast('Failed to update status', 'error');
        }
      });
    });

    list.querySelectorAll('.fb-vote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.messageId;
        if (id) socket.emit('vote_feature', { messageId: id, userId: currentUser.id });
      });
    });

    list.querySelectorAll('.fb-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.messageId;
        socket.emit('feedback_delete_message', { messageId: id, userId: currentUser.id });
      });
    });

    list.querySelectorAll('.poll-cell').forEach(cell => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = cell.dataset.messageId;
        const quadrant = cell.dataset.quadrant;
        if (id) socket.emit('vote_poll', { messageId: id, userId: currentUser.id, cell: quadrant });
      });
    });
  }

  function renderBugCard(m) {
    const isAdmin = feedbackHub && feedbackHub.admins.includes(currentUser.id);
    const canDelete = m.from === currentUser.id || isAdmin;
    const unread = getThreadUnreadCount(m.id);
    return '<div class="fb-card" data-message-id="' + m.id + '">' +
      '<div class="fb-card-icon bug"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
      '<div class="fb-card-body"><div class="fb-card-title">' + escapeHtml(m.text) + '</div>' +
      '<div class="fb-card-meta"><span class="fb-badge ' + m._bug.status + '">' + m._bug.status + '</span>' + unreadPillHtml(unread) +
      (isAdmin ? '<select class="fb-status-select" data-message-id="' + m.id + '" data-type="bug">' +
        '<option value="open"' + (m._bug.status === 'open' ? ' selected' : '') + '>Open</option>' +
        '<option value="confirmed"' + (m._bug.status === 'confirmed' ? ' selected' : '') + '>Confirmed</option>' +
        '<option value="in-progress"' + (m._bug.status === 'in-progress' ? ' selected' : '') + '>In Progress</option>' +
        '<option value="fixed"' + (m._bug.status === 'fixed' ? ' selected' : '') + '>Fixed</option>' +
        '<option value="wontfix"' + (m._bug.status === 'wontfix' ? ' selected' : '') + ">Won't Fix</option></select>" : '') +
      '<span class="fb-card-author">' + escapeHtml(getUserName(m.from)) + hubAdminBadge(m.from) + '</span>' +
      '<span class="fb-card-time">' + timeAgo(m.timestamp) + '</span>' +
      (canDelete ? '<button class="fb-delete-btn" data-message-id="' + m.id + '" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>' : '') +
      '</div></div></div>';
  }

  function renderFeatureCard(m) {
    const isAdmin = feedbackHub && feedbackHub.admins.includes(currentUser.id);
    const canDelete = m.from === currentUser.id || isAdmin;
    const votes = m._feature.votes ? m._feature.votes.length : 0;
    const voted = m._feature.votes && m._feature.votes.includes(currentUser.id);
    const unread = getThreadUnreadCount(m.id);
    return '<div class="fb-card" data-message-id="' + m.id + '">' +
      '<div class="fb-card-icon feature"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg></div>' +
      '<div class="fb-card-body"><div class="fb-card-title">' + escapeHtml(m.text) + '</div>' +
      '<div class="fb-card-meta"><span class="fb-badge ' + m._feature.status + '">' + m._feature.status + '</span>' + unreadPillHtml(unread) +
      (isAdmin ? '<select class="fb-status-select" data-message-id="' + m.id + '" data-type="feature">' +
        '<option value="suggested"' + (m._feature.status === 'suggested' ? ' selected' : '') + '>Suggested</option>' +
        '<option value="under-review"' + (m._feature.status === 'under-review' ? ' selected' : '') + '>Under Review</option>' +
        '<option value="planned"' + (m._feature.status === 'planned' ? ' selected' : '') + '>Planned</option>' +
        '<option value="in-progress"' + (m._feature.status === 'in-progress' ? ' selected' : '') + '>In Progress</option>' +
        '<option value="completed"' + (m._feature.status === 'completed' ? ' selected' : '') + '>Completed</option>' +
        '<option value="declined"' + (m._feature.status === 'declined' ? ' selected' : '') + '>Declined</option></select>' : '') +
      '<button class="fb-vote-btn" data-message-id="' + m.id + '" style="background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:3px;font-size:0.78rem;color:' + (voted ? 'var(--accent)' : 'var(--text-muted)') + ';padding:2px 6px;border-radius:6px;">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="' + (voted ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg> ' + votes + '</button>' +
      '<span class="fb-card-author">' + escapeHtml(getUserName(m.from)) + hubAdminBadge(m.from) + '</span>' +
      '<span class="fb-card-time">' + timeAgo(m.timestamp) + '</span>' +
      (canDelete ? '<button class="fb-delete-btn" data-message-id="' + m.id + '" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>' : '') +
      '</div></div></div>';
  }

  function renderPollCard(m) {
    const quadrants = m._poll.quadrant || ['Must have now', 'Should have soon', 'Quick wins', 'Nice to have'];
    const votes = m._poll.votes || {};
    const userVote = votes[currentUser.id] || null;
    const counts = {};
    quadrants.forEach(function(q) { counts[q] = 0; });
    Object.values(votes).forEach(function(v) { if (counts[v] !== undefined) counts[v]++; });
    const total = Object.keys(votes).length;
    const isAdmin = feedbackHub && feedbackHub.admins.includes(currentUser.id);
    const canDelete = m.from === currentUser.id || isAdmin;
    const unread = getThreadUnreadCount(m.id);

    let cellsHtml = '';
    quadrants.forEach(function(q) {
      cellsHtml += '<div class="poll-cell' + (userVote === q ? ' selected' : '') + '" data-message-id="' + m.id + '" data-quadrant="' + attrEsc(q) + '">' +
        '<div class="poll-cell-label">' + escapeHtml(q) + '</div>' +
        '<div class="poll-cell-count">' + (counts[q] || 0) + ' vote' + (counts[q] !== 1 ? 's' : '') + '</div></div>';
    });

    return '<div class="fb-card" data-message-id="' + m.id + '" style="flex-direction:column;">' +
      '<div style="display:flex;align-items:flex-start;gap:10px;width:100%;">' +
      '<div class="fb-card-icon poll"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>' +
      '<div class="fb-card-body"><div class="fb-card-title">' + escapeHtml(m.text) + '</div>' +
      '<div class="fb-card-meta"><span class="fb-card-author">' + escapeHtml(getUserName(m.from)) + hubAdminBadge(m.from) + '</span>' +
      '<span class="fb-card-votes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ' + total + '</span>' +
      '<span class="fb-card-time">' + timeAgo(m.timestamp) + '</span>' + unreadPillHtml(unread) +
      (canDelete ? '<button class="fb-delete-btn" data-message-id="' + m.id + '" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>' : '') +
      '</div></div></div>' +
      '<div class="poll-grid" style="width:100%;">' + cellsHtml + '</div></div>';
  }

  function wireModals() {
    $('#submitBugBtn')?.addEventListener('click', submitBug);
    $('#cancelBugBtn')?.addEventListener('click', function() { closeModal('bugModal'); });
    $('#closeBugModal')?.addEventListener('click', function() { closeModal('bugModal'); });
    $('#submitFeatureBtn')?.addEventListener('click', submitFeature);
    $('#cancelFeatureBtn')?.addEventListener('click', function() { closeModal('featureModal'); });
    $('#closeFeatureModal')?.addEventListener('click', function() { closeModal('featureModal'); });
    $('#createPollBtn')?.addEventListener('click', createPoll);
    $('#cancelPollBtn')?.addEventListener('click', function() { closeModal('pollModal'); });
    $('#closePollModal')?.addEventListener('click', function() { closeModal('pollModal'); });
    $('#closeThreadPanel')?.addEventListener('click', closeThreadPanel);
    $('#threadPanel')?.addEventListener('click', function(e) {
      if (e.target === e.currentTarget) closeThreadPanel();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && $('#threadPanel')?.classList.contains('open')) {
        closeThreadPanel();
      }
    });
    $('#threadSendBtn')?.addEventListener('click', sendThreadReply);
    $('#threadInput')?.addEventListener('input', updateMentionPopup);
    $('#threadInput')?.addEventListener('keydown', function(e) {
      if (mentionPopup.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSelection(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionSelection(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(); return; }
        if (e.key === 'Escape') {
          // Must not bubble to the document-level Escape handler, which would
          // close the entire thread panel — here we only dismiss the popup.
          e.preventDefault(); e.stopPropagation(); closeMentionPopup(); return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadReply(); }
    });
    $('#threadMentionPopup')?.addEventListener('mousedown', function(e) {
      e.preventDefault();
      const item = e.target.closest('.thread-mention-item');
      if (!item) { closeMentionPopup(); return; }
      mentionPopup.active = parseInt(item.dataset.index, 10) || 0;
      selectMention();
    });
    $('#threadJumpMentions')?.addEventListener('click', function() { jumpToLatest('mention'); });
    $('#threadJumpReplies')?.addEventListener('click', function() { jumpToLatest('reply'); });
  }

  // ===== @MENTIONS IN DISCUSSION THREAD =====
  function getMentionCandidates(query) {
    const q = (query || '').toLowerCase();
    const selfId = String(currentUser ? currentUser.id : '');

    // Only people who are actually part of THIS discussion thread: the author
    // of the original post plus everyone who has replied in the thread. Never
    // suggest hub members who haven't participated here.
    const userIds = new Set();
    if (threadParentId) {
      const parent = allMessages.find(m => m.id === threadParentId);
      if (parent && parent.from) userIds.add(String(parent.from));
      allMessages.forEach(m => {
        if (m.parentId === threadParentId && m._threadReply && m.from) userIds.add(String(m.from));
      });
    }

    const users = [];
    userIds.forEach(id => {
      const u = usersMap[id];
      if (u && String(u.id) !== selfId) users.push(u);
    });

    return users
      .filter(u => !q || String(u.username || '').toLowerCase().includes(q) || String(u.displayName || '').toLowerCase().includes(q))
      .slice(0, 8);
  }

  function updateMentionPopup() {
    const input = $('#threadInput');
    if (!input) { closeMentionPopup(); return; }
    const text = input.value;
    const caret = input.selectionStart != null ? input.selectionStart : text.length;
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s]*)$/);
    if (!m) { closeMentionPopup(); return; }
    const items = getMentionCandidates(m[1]);
    if (!items.length) { closeMentionPopup(); return; }
    mentionPopup = { open: true, items, active: 0, queryStart: caret - m[0].length };
    renderMentionPopup();
  }

  function renderMentionPopup() {
    const popup = $('#threadMentionPopup');
    if (!popup) return;
    if (!mentionPopup.open) { popup.hidden = true; return; }
    popup.hidden = false;
    popup.innerHTML = mentionPopup.items.map((u, i) => {
      const name = u.displayName || u.username || 'User';
      const uname = u.username ? '@' + u.username : '';
      return '<div class="thread-mention-item' + (i === mentionPopup.active ? ' active' : '') + '" data-index="' + i + '">' +
        '<span class="thread-mention-avatar">' + escapeHtml(name.charAt(0).toUpperCase()) + '</span>' +
        '<span class="thread-mention-name">' + escapeHtml(name) + '</span>' +
        '<span class="thread-mention-handle">' + escapeHtml(uname) + '</span></div>';
    }).join('');
  }

  function moveMentionSelection(dir) {
    if (!mentionPopup.open || !mentionPopup.items.length) return;
    mentionPopup.active = (mentionPopup.active + dir + mentionPopup.items.length) % mentionPopup.items.length;
    renderMentionPopup();
  }

  function selectMention() {
    if (!mentionPopup.open || !mentionPopup.items.length) return;
    const input = $('#threadInput');
    if (!input) return;
    const u = mentionPopup.items[mentionPopup.active];
    const text = input.value;
    const caret = input.selectionStart != null ? input.selectionStart : text.length;
    const insert = '@' + (u.username || u.displayName || 'user') + ' ';
    input.value = text.slice(0, mentionPopup.queryStart) + insert + text.slice(caret);
    const pos = mentionPopup.queryStart + insert.length;
    input.setSelectionRange(pos, pos);
    closeMentionPopup();
    input.focus();
  }

  function closeMentionPopup() {
    mentionPopup.open = false;
    const popup = $('#threadMentionPopup');
    if (popup) popup.hidden = true;
  }

  // Collect mentioned user ids from @tokens in the reply text (username or
  // display name, case-insensitive). Never self-mentions.
  function extractMentions(text) {
    if (!text) return [];
    const ids = [];
    const seen = new Set();
    const lookup = {};
    Object.keys(usersMap).forEach(id => {
      const u = usersMap[id];
      if (!u) return;
      if (u.username) lookup[String(u.username).toLowerCase()] = id;
      if (u.displayName) lookup[String(u.displayName).toLowerCase()] = id;
    });
    // Match @handles the same way the popup does — at a word boundary, so
    // email-like or mid-word '@' (e.g. foo@bar) never count as mentions.
    const re = /(?:^|[^\w])@([A-Za-z0-9_]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = m[1].replace(/[.,!?;:]+$/, '').toLowerCase();
      const id = lookup[key];
      if (id && String(id) !== String(currentUser.id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  // Escape first, then highlight only known @usernames with a styled span.
  function renderThreadText(text) {
    if (!text) return '';
    let safe = escapeHtml(text);
    const known = {};
    Object.keys(usersMap).forEach(id => {
      const u = usersMap[id];
      if (u && u.username) known[String(u.username).toLowerCase()] = true;
    });
    safe = safe.replace(/@([A-Za-z0-9_]+)/g, (full, name) => {
      return known[name.toLowerCase()] ? '<span class="thread-mention">' + full + '</span>' : full;
    });
    return safe;
  }

  function openBugModal() {
    $('#bugDescription').value = '';
    $('#bugError').textContent = '';
    const sevs = $('#bugSeverity');
    if (sevs) {
      const medium = sevs.querySelector('input[value="medium"]');
      if (medium) medium.checked = true;
    }
    openModal('bugModal');
    $('#bugDescription')?.focus();
  }

  function openFeatureModal() {
    $('#featureDescription').value = '';
    $('#featureError').textContent = '';
    openModal('featureModal');
    $('#featureDescription')?.focus();
  }

  function openPollModal() {
    $('#pollQuestion').value = '';
    $('#pollError').textContent = '';
    openModal('pollModal');
    $('#pollQuestion')?.focus();
  }

  function openModal(id) {
    const el = $('#' + id);
    if (el) { el.classList.add('show'); el.setAttribute('aria-hidden', 'false'); }
  }

  function closeModal(id) {
    const el = $('#' + id);
    if (el) { el.classList.remove('show'); el.setAttribute('aria-hidden', 'true'); }
  }

  // These form modals only toggle a CSS class (never a Nav entry), so register
  // them with the overlay closer registry — the Android back button closes them.
  if (window.registerOverlayCloser) {
    ['bugModal', 'featureModal', 'pollModal'].forEach(function(id) {
      window.registerOverlayCloser({
        id: id,
        isOpen: function() {
          const el = document.getElementById(id);
          return !!(el && el.classList.contains('show'));
        },
        close: function() { closeModal(id); }
      });
    });
  }

  function waitForFeedbackEvent(type) {
    return new Promise(function(resolve, reject) {
      var timeout = setTimeout(function() {
        socket.off('feedback_success', onSuccess);
        socket.off('feedback_error', onError);
        reject(new Error('Timeout'));
      }, 5000);
      function onSuccess(data) {
        if (data.type === type) {
          clearTimeout(timeout);
          socket.off('feedback_success', onSuccess);
          socket.off('feedback_error', onError);
          resolve(data);
        }
      }
      function onError(data) {
        clearTimeout(timeout);
        socket.off('feedback_success', onSuccess);
        socket.off('feedback_error', onError);
        reject(data);
      }
      socket.on('feedback_success', onSuccess);
      socket.on('feedback_error', onError);
    });
  }

  async function submitBug() {
    const text = $('#bugDescription')?.value?.trim();
    if (!text) { $('#bugError').textContent = 'Please describe the bug.'; return; }
    const severity = $('#bugSeverity')?.querySelector('input[name="bugSeverity"]:checked')?.value || 'medium';
    $('#submitBugBtn').disabled = true;
    $('#bugError').textContent = '';
    socket.emit('submit_bug', { from: currentUser.id, text: text + '\nSeverity: ' + severity });
    try {
      await waitForFeedbackEvent('bug');
      closeModal('bugModal');
      showToast('Bug reported');
      await loadMessages();
      renderFeed(currentFilter);
    } catch (e) {
      if (e && e.error) $('#bugError').textContent = e.error;
      else $('#bugError').textContent = 'Failed to submit';
    }
    $('#submitBugBtn').disabled = false;
  }

  async function submitFeature() {
    const text = $('#featureDescription')?.value?.trim();
    if (!text) { $('#featureError').textContent = 'Please describe the feature.'; return; }
    $('#submitFeatureBtn').disabled = true;
    $('#featureError').textContent = '';
    socket.emit('submit_feature', { from: currentUser.id, text });
    try {
      await waitForFeedbackEvent('feature');
      closeModal('featureModal');
      showToast('Feature suggested');
      await loadMessages();
      renderFeed(currentFilter);
    } catch (e) {
      if (e && e.error) $('#featureError').textContent = e.error;
      else $('#featureError').textContent = 'Failed to submit';
    }
    $('#submitFeatureBtn').disabled = false;
  }

  async function createPoll() {
    const question = $('#pollQuestion')?.value?.trim();
    if (!question) { $('#pollError').textContent = 'Please enter a question.'; return; }
    const quadrant = [
      $('#quadrant1')?.value?.trim() || 'Must have now',
      $('#quadrant2')?.value?.trim() || 'Should have soon',
      $('#quadrant3')?.value?.trim() || 'Quick wins',
      $('#quadrant4')?.value?.trim() || 'Nice to have'
    ];
    $('#createPollBtn').disabled = true;
    $('#pollError').textContent = '';
    socket.emit('create_poll', { from: currentUser.id, question, quadrant });
    try {
      await waitForFeedbackEvent('poll');
      closeModal('pollModal');
      showToast('Poll created');
      await loadMessages();
      renderFeed(currentFilter);
    } catch (e) {
      if (e && e.error) $('#pollError').textContent = e.error;
      else $('#pollError').textContent = 'Failed to create poll';
    }
    $('#createPollBtn').disabled = false;
  }

  function openThread(messageId, opts) {
    opts = opts || {};
    threadParentId = messageId;
    const panel = $('#threadPanel');
    if (!panel) return;
    const parent = allMessages.find(function(m) { return m.id === messageId; });
    if (!parent) return;

    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');

    var iconType = parent._bug ? 'bug' : parent._feature ? 'feature' : 'poll';
    var iconSvg = parent._bug
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      : parent._feature
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

    var parentEl = $('#threadParent');
    parentEl.innerHTML = '<div class="fb-card" style="cursor:default;background:var(--bg);padding:0;margin:0;">' +
      '<div class="fb-card-icon ' + iconType + '">' + iconSvg + '</div>' +
      '<div class="fb-card-body"><div class="fb-card-title">' + escapeHtml(parent.text) + '</div>' +
      '<div class="fb-card-meta"><span class="fb-card-author">' + escapeHtml(getUserName(parent.from)) + hubAdminBadge(parent.from) + '</span>' +
      '<span class="fb-card-time">' + formatTime(parent.timestamp) + '</span></div></div></div>';

    renderThreadReplies();
    // Opening the thread marks all its replies as read by me (server + local).
    markThreadRead();
    $('#threadInput').value = '';
    // Focus AFTER the 250ms slide-in finishes. Focusing mid-animation pops the
    // on-screen keyboard during the transform transition, which resizes the
    // viewport and makes the drawer visibly jump/freak on mobile WebViews.
    // Guarded so a fast close (tap on the overlay/back within 260ms) doesn't
    // pop the keyboard over an already-closed panel.
    // Read-mode opens (notification deep links pass focus:false) skip the
    // keyboard entirely — the panel is arriving over a freshly opened
    // dashboard and the keyboard pop makes it visibly lurch.
    if (opts.focus !== false) {
      setTimeout(function() {
        if ($('#threadPanel')?.classList.contains('open')) $('#threadInput')?.focus();
      }, 260);
    }
  }

  function renderThreadReplies() {
    // allMessages arrives newest-first (server sorts desc), but a thread reads
    // like a chat: oldest reply on top, newest at the bottom — so the
    // scroll-to-bottom below lands on the LATEST replies when the panel opens.
    const replies = allMessages
      .filter(function(m) { return m.parentId === threadParentId && m._threadReply; })
      .sort(function(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
    const container = $('#threadReplies');
    if (!container) return;

    if (replies.length === 0) {
      container.innerHTML = '<div class="fb-empty" style="padding:20px;"><p>No replies yet.</p></div>';
      updateThreadJumpBtn();
      return;
    }

    // The parent post — a reply is a "direct reply to my message" when the
    // thread's original post was authored by me and the reply isn't mine.
    const parent = allMessages.find(function(m) { return m.id === threadParentId; });
    const myId = String(currentUser ? currentUser.id : '');
    const parentIsMine = parent && String(parent.from) === myId;

    container.innerHTML = replies.map(function(r) {
      const fromMine = String(r.from) === myId;
      const mentionedMe = !fromMine && Array.isArray(r.mentions) && r.mentions.some(function(id) { return String(id) === myId; });
      const repliedToMe = !fromMine && parentIsMine;
      let cls = 'thread-reply';
      let badge = '';
      if (mentionedMe) {
        cls += ' mention-me';
        badge = '<span class="thread-reply-badge mention">@ mentioned you</span>';
      } else if (repliedToMe) {
        cls += ' reply-to-me';
        badge = '<span class="thread-reply-badge reply">↩ replied to your post</span>';
      }
      return '<div class="' + cls + '" data-reply-id="' + r.id + '">' +
        '<div class="thread-reply-avatar">' + getAvatarChar(r.from) + '</div>' +
        '<div class="thread-reply-body"><div class="thread-reply-author">' + escapeHtml(getUserName(r.from)) + hubAdminBadge(r.from) + badge + '</div>' +
        '<div class="thread-reply-text">' + renderThreadText(r.text) + '</div>' +
        '<div class="thread-reply-time">' + formatTime(r.timestamp) + '</div></div></div>';
    }).join('');

    updateThreadJumpBtn();
    // Scroll to the latest replies after the browser has painted the freshly
    // injected list. Same-frame scrollTop can be lost while the drawer's
    // slide-in transform is still compositing, leaving the list pinned to the
    // top instead of the newest reply.
    requestAnimationFrame(function() {
      container.scrollTop = container.scrollHeight;
    });
  }

  // Show the segmented header shortcut whenever any reply in this thread is
  // "for me": either it @mentions me (mention chip) or it replies to a post I
  // authored (reply chip). Each chip shows its own live count and jumps to the
  // latest matching reply, pulsing it so it's unmistakable. Clicking a chip
  // also toggles which mode is active.
  function updateThreadJumpBtn() {
    const bar = $('#threadJumpBar');
    if (!bar) return;
    const myId = String(currentUser ? currentUser.id : '');
    const parent = allMessages.find(function(m) { return m.id === threadParentId; });
    const parentIsMine = parent && String(parent.from) === myId;

    const mentions = allMessages.filter(function(m) {
      return m.parentId === threadParentId && m._threadReply && String(m.from) !== myId &&
        Array.isArray(m.mentions) && m.mentions.some(function(id) { return String(id) === myId; });
    });
    const repliesToMe = parentIsMine ? allMessages.filter(function(m) {
      return m.parentId === threadParentId && m._threadReply && String(m.from) !== myId;
    }) : [];

    const latest = function(list) {
      if (!list.length) return null;
      return list.reduce(function(a, b) { return new Date(a.timestamp) > new Date(b.timestamp) ? a : b; });
    };
    const latestMention = latest(mentions);
    const latestReply = latest(repliesToMe);

    if (!latestMention && !latestReply) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'inline-flex';

    const mCnt = $('#threadMentionCount');
    if (mCnt) mCnt.textContent = mentions.length;
    const rCnt = $('#threadReplyCount');
    if (rCnt) rCnt.textContent = repliesToMe.length;

    const mBtn = $('#threadJumpMentions');
    const rBtn = $('#threadJumpReplies');
    if (mBtn) { mBtn.dataset.latestMention = latestMention ? latestMention.id : ''; mBtn.classList.toggle('dim', !latestMention); }
    if (rBtn) { rBtn.dataset.latestReply = latestReply ? latestReply.id : ''; rBtn.classList.toggle('dim', !latestReply); }

    // Toggle state: keep the previously active mode if it still has targets,
    // otherwise fall back to whichever mode has replies (mentions preferred).
    const prev = bar.dataset.jumpMode || '';
    const next = (prev === 'reply' && latestReply) ? 'reply'
      : (prev === 'mention' && latestMention) ? 'mention'
      : latestMention ? 'mention' : 'reply';
    bar.dataset.jumpMode = next;
    if (mBtn) mBtn.classList.toggle('active', next === 'mention');
    if (rBtn) rBtn.classList.toggle('active', next === 'reply');
  }

  function jumpToLatest(mode) {
    const bar = $('#threadJumpBar');
    const container = $('#threadReplies');
    if (!bar || !container) return;
    const mBtn = $('#threadJumpMentions');
    const rBtn = $('#threadJumpReplies');
    const id = mode === 'reply' ? (rBtn ? rBtn.dataset.latestReply : '') : (mBtn ? mBtn.dataset.latestMention : '');
    if (!id) return;
    bar.dataset.jumpMode = mode;
    if (mBtn) mBtn.classList.toggle('active', mode === 'mention');
    if (rBtn) rBtn.classList.toggle('active', mode === 'reply');
    const target = container.querySelector('[data-reply-id="' + id + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('jump-flash');
    void target.offsetWidth; // restart the animation
    target.classList.add('jump-flash');
    setTimeout(function() { target.classList.remove('jump-flash'); }, 1600);
  }

  // ===== UNREAD 'FOR ME' THREAD REPLIES =====
  // A reply is "for me" when it @mentions me or replies to a post I authored;
  // it's unread until MY id is in its readBy (per-user — Bob reading never
  // clears my badge). The server computes the authoritative total for the nav
  // badge; card pills are computed locally from allMessages for instant sync.

  // Shared "for me" predicate — a reply is for me when it @mentions me or
  // replies to a post I authored (never my own reply). Single source of truth
  // for the pills, the nav badge, and mark-read, so mention semantics can't
  // drift between them.
  function isReplyForMe(m) {
    if (!m || !m._threadReply || m.deleted) return false;
    const myId = String(currentUser ? currentUser.id : '');
    if (String(m.from) === myId) return false;
    const mentionedMe = Array.isArray(m.mentions) && m.mentions.some(function(id) { return String(id) === myId; });
    if (mentionedMe) return true;
    const parent = allMessages.find(function(p) { return p.id === m.parentId; });
    return !!(parent && String(parent.from) === myId);
  }

  function isReplyUnreadForMe(m) {
    if (!isReplyForMe(m)) return false;
    const myId = String(currentUser ? currentUser.id : '');
    return !(Array.isArray(m.readBy) && m.readBy.some(function(id) { return String(id) === myId; }));
  }

  // How many replies under this thread are unread 'for me'.
  function getThreadUnreadCount(parentId) {
    if (!parentId || !allMessages.length) return 0;
    let n = 0;
    allMessages.forEach(function(m) {
      if (m.parentId === parentId && isReplyUnreadForMe(m)) n++;
    });
    return n;
  }

  function unreadPillHtml(count) {
    return count > 0 ? '<span class="fb-card-unread">' + count + ' new</span>' : '';
  }

  // ===== FEEDBACK NOTIFICATIONS (Notifications drawer) =====
  // Every unread thread reply that is "for me" (mentions me or replies to a
  // post I authored) becomes an item in the app's Notifications drawer. The
  // in-app toast banner was removed: the drawer + bell badge + hub badge are
  // the only surfaces. Rebuilt from allMessages on load and on every live
  // reply so it stays in sync with mark-read.
  function rebuildFeedbackNotifs() {
    feedbackNotifs = [];
    if (!currentUser || !allMessages.length) return;
    const myId = String(currentUser.id);
    allMessages.forEach(function(m) {
      if (!m || !m._threadReply || m.deleted || !isReplyUnreadForMe(m)) return;
      const parent = allMessages.find(function(p) { return p.id === m.parentId; });
      const mentioned = Array.isArray(m.mentions) && m.mentions.some(function(id) { return String(id) === myId; });
      const u = usersMap[m.from];
      feedbackNotifs.push({
        replyId: m.id,
        parentId: m.parentId,
        from: m.from,
        fromName: u ? (u.displayName || u.username) : getUserName(m.from),
        parentText: parent ? (parent.text || '') : '',
        text: m.text || '',
        timestamp: m.timestamp,
        type: mentioned ? 'mention' : 'reply'
      });
    });
    feedbackNotifs.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  }

  // Single refresh path: rebuild the drawer list, refresh the hub nav badge
  // (server-computed count), and nudge the app's drawer + bell badge.
  function refreshHubNotifications() {
    rebuildFeedbackNotifs();
    refreshUnreadBadge();
    if (typeof window.refreshNotificationsDrawer === 'function') window.refreshNotificationsDrawer();
  }

  window.getFeedbackNotifs = function() { return feedbackNotifs; };
  window.getFeedbackUnreadCount = function() { return feedbackNotifs.length; };

  // Jump from a drawer item straight into the discussion thread. opts:
  //   focus:false — read mode, don't pop the on-screen keyboard (used by
  //                 notification deep links so the panel doesn't lurch)
  //   defer:true  — wait one frame so a freshly opened dashboard paints
  //                 before the panel slides in (avoids two overlapping
  //                 transforms on Android WebViews)
  window.openFeedbackThread = async function(parentId, opts) {
    opts = opts || {};
    try {
      if (!dashboardOpen) await openDashboard();
      else if (!allMessages.length) await loadMessages();
      const parent = allMessages.find(function(m) { return m.id === parentId; });
      if (!parent) return;
      const doOpen = function() { openThread(parent.id, opts); };
      if (opts.defer) requestAnimationFrame(doOpen);
      else doOpen();
    } catch (e) {
      console.warn('openFeedbackThread failed:', e);
    }
  };

  // Drawer "Mark all read" also clears every unread for-me thread reply.
  // Only already-unread ids are emitted (same discipline as markThreadRead) so
  // tapping it repeatedly never spams the server with already-read ids.
  window.markAllFeedbackRead = function() {
    if (!socket || !currentUser) return;
    const myId = String(currentUser.id);
    const ids = [];
    allMessages.forEach(function(m) {
      if (!m || !m._threadReply || m.deleted) return;
      if (String(m.from) === myId) return;
      if (!Array.isArray(m.readBy)) m.readBy = [];
      if (!m.readBy.some(function(id) { return String(id) === myId; })) {
        m.readBy.push(myId);
        if (!m.readAt) m.readAt = {};
        m.readAt[myId] = new Date().toISOString();
        ids.push(m.id);
      }
    });
    if (ids.length) socket.emit('mark_read', { messageIds: ids });
    refreshHubNotifications();
    showToast('Feedback notifications marked read');
  };

  // Fetch the server-computed total and update the Feedback Hub nav badge.
  // Works even before the dashboard (and its messages) are ever loaded.
  async function refreshUnreadBadge() {
    const badge = $('#feedbackUnreadBadge');
    if (!badge || !currentUser) return;
    try {
      const res = await fetch(api('/api/feedback/unread'));
      const data = await res.json();
      const count = data && data.count ? data.count : 0;
      if (count > 0) {
        badge.style.display = 'inline-flex';
        badge.textContent = count > 99 ? '99+' : String(count);
      } else {
        badge.style.display = 'none';
        badge.textContent = '';
      }
    } catch (e) {
      // Badge is a nicety — never block the UI on a fetch failure.
    }
  }

  // Mark every reply under the open thread as read by me: emit the existing
  // mark_read socket event (records per-user readBy + first-read readAt on the
  // server) and optimistically update local state so pills clear instantly.
  function markThreadRead() {
    if (!threadParentId || !socket) return;
    const myId = String(currentUser ? currentUser.id : '');
    const ids = [];
    let changed = false;
    allMessages.forEach(function(m) {
      if (m.parentId !== threadParentId || !m._threadReply || m.deleted) return;
      if (String(m.from) === myId) return;
      ids.push(m.id);
      if (!Array.isArray(m.readBy)) m.readBy = [];
      if (!m.readBy.some(function(id) { return String(id) === myId; })) {
        m.readBy.push(myId);
        if (!m.readAt) m.readAt = {};
        m.readAt[myId] = new Date().toISOString();
        changed = true;
      }
    });
    // Nothing newly unread — skip the network call and the re-render.
    if (!changed) return;
    if (ids.length) socket.emit('mark_read', { messageIds: ids });
    if (dashboardOpen) renderFeed(currentFilter);
    refreshHubNotifications();
  }

  function closeThreadPanel() {
    const panel = $('#threadPanel');
    if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
    threadParentId = null;
    closeMentionPopup();
  }

  function sendThreadReply() {
    const input = $('#threadInput');
    const text = input?.value?.trim();
    if (!text || !threadParentId) return;
    input.value = '';
    closeMentionPopup();
    socket.emit('thread_reply', {
      from: currentUser.id,
      parentId: threadParentId,
      text,
      mentions: extractMentions(text)
    });
  }

  function wireSocketEvents() {
    socket.on('new_group_message', function(msg) {
      if (msg.groupId !== FEEDBACK_HUB_ID) return;
      allMessages.unshift(msg);
      if (dashboardOpen) renderFeed(currentFilter);
      if (threadParentId && (msg.parentId === threadParentId || msg.id === threadParentId)) {
        renderThreadReplies();
        // A new reply landing while the thread is open is seen on arrival —
        // markThreadRead also refreshes the badge, so avoid a second fetch.
        if (msg._threadReply && msg.parentId === threadParentId) { markThreadRead(); return; }
      }
      // A for-me reply (mention or reply to my post) that I'm not already
      // reading: play a sound so the user knows — the alert itself lives in
      // the Notifications drawer, not as a toast over the app.
      if (msg._threadReply && isReplyUnreadForMe(msg)) {
        if (typeof window.playNotificationSound === 'function') window.playNotificationSound();
      }
      refreshHubNotifications();
    });

    socket.on('feedback_error', function(data) {
      showToast(data.error || 'Error', 'error');
    });

    socket.on('feature_votes_updated', function(data) {
      var msg = allMessages.find(function(m) { return m.id === data.messageId; });
      if (msg && msg._feature) {
        msg._feature.votes = data.votes;
        if (dashboardOpen) renderFeed(currentFilter);
      }
    });

    socket.on('poll_votes_updated', function(data) {
      var msg = allMessages.find(function(m) { return m.id === data.messageId; });
      if (msg && msg._poll) {
        msg._poll.votes = data.votes;
        if (dashboardOpen) renderFeed(currentFilter);
      }
    });

    socket.on('bug_status_updated', function(data) {
      var msg = allMessages.find(function(m) { return m.id === data.messageId; });
      if (msg && msg._bug) {
        msg._bug.status = data.status;
        if (dashboardOpen) renderFeed(currentFilter);
      }
    });

    socket.on('feature_status_updated', function(data) {
      var msg = allMessages.find(function(m) { return m.id === data.messageId; });
      if (msg && msg._feature) {
        msg._feature.status = data.status;
        if (dashboardOpen) renderFeed(currentFilter);
      }
    });

    socket.on('message_deleted', function(data) {
      var idx = allMessages.findIndex(function(m) { return m.id === data.messageId; });
      if (idx > -1) {
        allMessages.splice(idx, 1);
        if (dashboardOpen) renderFeed(currentFilter);
        if (threadParentId === data.messageId) closeThreadPanel();
      }
    });

    // Someone @mentioned you in a thread reply. The alert now lives in the
    // Notifications drawer (new_group_message rebuilds + refreshes it), so
    // this handler is only a lightweight safety refresh — no toast banner.
    socket.on('feedback_mention', function(data) {
      if (!data || String(data.to) !== String(currentUser.id)) return;
      if (typeof window.refreshNotificationsDrawer === 'function') window.refreshNotificationsDrawer();
    });
  }

  async function loadMessages() {
    try {
      var res = await fetch(api('/api/feedback/messages?hubId=' + FEEDBACK_HUB_ID));
      var data = await res.json();
      if (data.messages) allMessages = data.messages.filter(m => !m.deleted);
      if (data.users) {
        usersMap = {};
        data.users.forEach(function(u) { usersMap[u.id] = u; });
      }
      refreshHubNotifications();
    } catch (e) {
      console.warn('Failed to load feedback messages:', e);
    }
  }

  function observeConversationChanges() {
    var convList = $('#conversationsList');
    if (!convList) return;
    var obs = new MutationObserver(function() {
      var activeChat = $('#activeChat');
      if (activeChat && activeChat.style.display !== 'none' && dashboardOpen) {
        closeDashboard();
      }
    });
    obs.observe(convList, { childList: true, subtree: true });
  }

  window.toggleDashboard = toggleDashboard;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
