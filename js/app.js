// ===== APP STATE =====
if (window.Capacitor || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  document.body.classList.add('native-app');
}
if (/Android/i.test(navigator.userAgent)) {
  document.body.classList.add('is-android');
}

// True on ANY Android device — the Capacitor native shell AND the Android
// mobile browser ("android web"). The .is-android class is UA-based, so both
// surfaces get the same behavior.
const IS_ANDROID_DEVICE = document.body.classList.contains('is-android') || /Android/i.test(navigator.userAgent);

// Mobile Visual Viewport Manager — shrinks the app shell to the visible area when
// the on-screen keyboard opens, on the WEB platform (iOS Safari/Chrome + Android
// Chrome). Android native already resizes its own WebView, so there we only keep
// the shell height in sync (historical behavior).
if (window.visualViewport) {
  const KB_THRESHOLD = 100; // px — ignore iOS toolbar/URL-bar changes (no real keyboard)
  let kbOpen = false;
  // While the keyboard is open on web, the BACKGROUND must stay locked: only the
  // chat messages area (and any open overlay) may scroll — everything else is
  // prevented from panning the page/visual viewport.
  const KB_ALLOW_SELECTOR = '#chatMessages, .chat-input-area, .modal-overlay, .thread-panel-overlay, .lightbox-overlay, .emoji-picker, .reply-preview, .search-results, .conversations, .user-panel-content';
  const isKbAllowed = (t) => t && typeof t.closest === 'function' && !!t.closest(KB_ALLOW_SELECTOR);
  const blockKbScroll = (e) => { if (!isKbAllowed(e.target)) e.preventDefault(); };
  let kbGuardAttached = false;
  const attachKbGuard = () => {
    if (kbGuardAttached) return;
    document.addEventListener('touchmove', blockKbScroll, { passive: false, capture: true });
    document.addEventListener('wheel', blockKbScroll, { passive: false, capture: true });
    // Pin the layout viewport so iOS/the browser can't pan the page behind the
    // keyboard (preserving any existing scroll offset).
    document.body.style.position = 'fixed';
    document.body.style.top = `${-window.scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.classList.add('kb-open');
    kbGuardAttached = true;
  };
  const detachKbGuard = () => {
    if (!kbGuardAttached) return;
    document.removeEventListener('touchmove', blockKbScroll, { capture: true });
    document.removeEventListener('wheel', blockKbScroll, { capture: true });
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.classList.remove('kb-open');
    kbGuardAttached = false;
  };
  const syncVisualViewport = () => {
    const vv = window.visualViewport;
    const app = document.getElementById('chatApp');
    if (!app) return;
    const vvH = vv.height;
    const layoutH = window.innerHeight;
    const nowOpen = vvH < layoutH - KB_THRESHOLD;
    const isWeb = !window.Capacitor;
    if (nowOpen) {
      // Keyboard open — shrink the shell to the visible area (like Android native).
      app.style.height = `${vvH}px`;
      if (isWeb) {
        // Lock the background: block page/visual-viewport panning, keep the
        // chat messages (and overlays) scrollable.
        attachKbGuard();
        // iOS pans the visual viewport while fixed elements stay on the layout
        // viewport; pin the shell to the visual viewport so the composer sits
        // exactly above the keyboard. No-op on Android web (offsetTop stays 0).
        app.style.top = `${vv.offsetTop}px`;
        // Mobile chat-open: .chat-area becomes position:fixed; inset:0 (full
        // viewport), so it ignores the shrunk shell. Pin its bottom to the
        // keyboard height so the composer lands exactly above the keyboard.
        // No-op anywhere else (static/flex context ignores `bottom`).
        const area = document.getElementById('chatArea');
        if (area) {
          area.style.bottom = `${Math.max(0, layoutH - vvH)}px`;
          area.style.top = `${vv.offsetTop}px`;
        }
        // Re-pin the newest message once, right after the shrink settles.
        if (!kbOpen && typeof scrollToBottom === 'function') {
          requestAnimationFrame(scrollToBottom);
        }
      }
    } else if (isWeb) {
      // Keyboard closed — restore the full-screen shell and unlock the background.
      detachKbGuard();
      app.style.height = '';
      app.style.top = '';
      const area = document.getElementById('chatArea');
      if (area) { area.style.bottom = ''; area.style.top = ''; }
    } else {
      // Native: mirror the visual height (historical behavior).
      app.style.height = `${vvH}px`;
    }
    kbOpen = nowOpen;
  };
  window.visualViewport.addEventListener('resize', syncVisualViewport);
  window.visualViewport.addEventListener('scroll', syncVisualViewport);
  document.addEventListener('DOMContentLoaded', syncVisualViewport);
  syncVisualViewport();
}

// ===== BACKGROUND SCROLL LOCK (web platform) =====
// While any overlay/drawer/lightbox is open, add body.scroll-locked so the CSS
// rule below pins every background scroller (overflow:hidden). Wheel/touch input
// can then never move the content behind an open modal on the web.
(function initScrollLock() {
  if (!document.body) return;
  const OVERLAY_SELECTORS = [
    '.modal-overlay.show',
    '.thread-panel-overlay.open',
    '.lightbox-overlay.show'
  ];
  const EXTRA_IDS = ['p2pInfoModal'];
  const hasOpenOverlay = () => {
    if (document.querySelector(OVERLAY_SELECTORS.join(','))) return true;
    for (const id of EXTRA_IDS) {
      const el = document.getElementById(id);
      if (el && el.style.display && el.style.display !== 'none') return true;
    }
    return false;
  };
  const sync = () => document.body.classList.toggle('scroll-locked', hasOpenOverlay());
  new MutationObserver(sync).observe(document.body, {
    attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true
  });
  sync();
})();

let currentUser = null;
let socket = null;
let activeChat = null; // { type: 'dm'|'group', id: userId|groupId, ... }
let chatEntered = false;
let conversations = [];
let selectedGroupMembers = [];
let typingTimeout = null;
let replyingTo = null;
let editingMsg = null;
let currentFilter = 'all';
let favorites = new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));
let blockedUsers = new Set();
let mutedConversations = new Set();
let selectionMode = false;
let selectedMessages = new Set();
let activeTyping = {};
const SINGLE_TICK_SVG = `<svg class="tick-svg" viewBox="0 0 24 24" width="12" height="12" style="display:inline-block;vertical-align:middle;margin-left:2px;"><path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOUBLE_TICK_SVG = `<svg class="tick-svg" viewBox="0 0 24 24" width="16" height="12" style="display:inline-block;vertical-align:middle;margin-left:2px;"><path d="M16 6L8 14L4.5 10.5" stroke="currentColor" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 6L13 14L11 12" stroke="currentColor" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ===== DOM ELEMENTS =====
const authPage = document.getElementById('authPage');
const chatApp = document.getElementById('chatApp');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const authTabs = document.querySelectorAll('.auth-tab');
const conversationsList = document.getElementById('conversationsList');
const searchInput = document.getElementById('searchInput');
const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const emptyState = document.getElementById('emptyState');
const activeChatDiv = document.getElementById('activeChat');
const chatHeader = document.getElementById('chatHeader');
const groupModal = document.getElementById('groupModal');
const fileInput = document.getElementById('fileInput');
const replyPreview = document.getElementById('replyPreview');
const cancelReplyBtn = document.getElementById('cancelReply');
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const userPanelEmpty = document.getElementById('userPanelEmpty');
const userPanelContent = document.getElementById('userPanelContent');
const addMemberModal = document.getElementById('addMemberModal');
const navUser = document.getElementById('navUser');
const logoutBtn = document.getElementById('logoutBtn');

// ===== CLEARED CHATS PERSISTENCE =====
let clearedChats = {};
try {
  clearedChats = JSON.parse(localStorage.getItem('cleared_chats') || '{}');
} catch (e) {
  clearedChats = {};
}

function markChatCleared(chatId) {
  if (!chatId) return;
  clearedChats[String(chatId)] = Date.now();
  localStorage.setItem('cleared_chats', JSON.stringify(clearedChats));
}

function filterClearedMessages(chatId, messages) {
  if (!chatId || !clearedChats[String(chatId)] || !Array.isArray(messages)) return messages || [];
  const clearedTime = Number(clearedChats[String(chatId)]);
  return messages.filter(m => {
    const msgTime = new Date(m.timestamp || m.createdAt || Date.now()).getTime();
    return msgTime > clearedTime;
  });
}

// Pull the user's server-side cleared-chat state (GET /api/cleared) so clearing
// syncs across devices and survives reinstall / localStorage wipe. Merged into
// the local clearedChats map (localStorage stays as an offline cache). Called
// at boot and whenever the app regains focus, mirroring loadConversations().
async function syncClearedChats() {
  if (!currentUser) return;
  try {
    const res = await fetch(api('/api/cleared'));
    if (!res.ok) return;
    const data = await res.json();
    const cleared = (data && data.cleared) || {};
    let changed = false;
    for (const [chatId, ts] of Object.entries(cleared)) {
      if (clearedChats[chatId] !== ts) { clearedChats[chatId] = ts; changed = true; }
    }
    if (changed) {
      localStorage.setItem('cleared_chats', JSON.stringify(clearedChats));
      // If the currently open chat was cleared on another device, re-filter it.
      if (activeChat && clearedChats[String(activeChat.id)] && typeof refreshCurrentChat === 'function') {
        refreshCurrentChat();
      }
    }
  } catch (e) { /* offline — the local cache still applies */ }
}

// ===== NAVIGATION HISTORY STACK =====
// Treats the conversation list as the root "page". Opening a chat, the
// Feedback Hub, or the profile modal pushes a history entry; the device /
// browser back button (and iOS swipe-back) pops one step at a time.
// At the root the stack is empty, so back exits the app (normal).
const Nav = {
  stack: [],
  push(name, onBack) {
    this.stack.push({ name, onBack });
    try {
      history.pushState({ nav: this.stack.length }, '');
    } catch (e) {
      console.warn('history.pushState not available', e);
    }
  },
  has(name) { return this.stack.some(e => e.name === name); },
  back() {
    if (this.stack.length) {
      try { history.back(); } catch (e) { console.warn('history.back not available', e); }
    }
  },
  _pop() {
    const entry = this.stack.pop();
    if (entry && typeof entry.onBack === 'function') entry.onBack();
  }
};
window.Nav = Nav;
window.addEventListener('popstate', () => {
  if (Nav.stack.length) Nav._pop();
});

// ===== OVERLAY CLOSER REGISTRY (Android back gesture) =====
// The Nav stack only tracks page-level navigation (chats, big panels, and the
// modals that explicitly call Nav.push). Several lighter overlays — seen-by
// popup, report modal, bug/feature/poll forms, appeal form, emoji picker — just
// toggle a CSS class and never touch Nav, so the Android back button ignored
// them (and could even exit the app while one was open). Each untracked overlay
// registers a { isOpen, close } pair here; the back handler closes the topmost
// open one before falling back to the Nav stack.
window.overlayClosers = window.overlayClosers || [];
window.registerOverlayCloser = function(entry) {
  if (!entry || typeof entry.isOpen !== 'function' || typeof entry.close !== 'function') return;
  window.overlayClosers.push(entry);
};
// Close the most-recently-registered visible overlay (last registered = closest
// to the top of the screen). Returns true if one was closed.
window.closeTopOverlay = function() {
  const closers = window.overlayClosers || [];
  for (let i = closers.length - 1; i >= 0; i--) {
    const c = closers[i];
    try {
      if (c.isOpen()) { c.close(); return true; }
    } catch (e) { /* skip broken closer */ }
  }
  return false;
};

// Untracked overlays owned by app.js (function declarations are hoisted, so
// these can reference closeAppealModal / closeSeenByPopup defined below).
window.registerOverlayCloser({
  id: 'appealModal',
  isOpen: function() {
    const el = document.getElementById('appealModal');
    return !!(el && el.classList.contains('show'));
  },
  close: closeAppealModal
});
window.registerOverlayCloser({
  id: 'seenByModal',
  isOpen: function() {
    const el = document.getElementById('seenByModal');
    return !!(el && el.classList.contains('show'));
  },
  close: closeSeenByPopup
});
window.registerOverlayCloser({
  id: 'emojiPicker',
  isOpen: function() { return !!(emojiPicker && emojiPicker.style.display === 'flex'); },
  close: function() { if (emojiPicker) emojiPicker.style.display = 'none'; }
});
window.registerOverlayCloser({
  id: 'compatModal',
  isOpen: function() {
    const el = document.getElementById('compatModal');
    return !!(el && el.classList.contains('show'));
  },
  close: closeCompatModal
});

// ===== BACKEND BASE URL =====
// All API / socket / uploaded-asset traffic is routed through apiBase so the
// frontend can talk to a deployed backend (e.g. Render) from any origin
// (local dev, static host, or a Capacitor native shell). Empty = same-origin.
const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
const api = (p) => API_BASE + p;
const absUrl = (u) => (u && typeof u === 'string' && u.startsWith('/') && API_BASE) ? API_BASE + u : u;

// ===== SESSION TOKEN =====
// Opaque server-issued bearer token (never the user id). Restored from storage
// at boot, refreshed on login/signup, cleared on logout. Attached to every API
// request via the fetch interceptor below and to the socket.io handshake.
window.APP_TOKEN = null;
try {
  window.APP_TOKEN = localStorage.getItem('token') || null;
} catch (e) {}

// Intercept fetch so every API request carries Authorization automatically.
// Requests to external URLs (avatars, link previews, etc.) are left untouched
// so the token is never leaked to third-party origins.
(function() {
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    init.headers = init.headers || {};
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url;
    const isApi = url.startsWith('/') || (API_BASE && url.startsWith(API_BASE));
    if (isApi && window.APP_TOKEN) {
      init.headers['Authorization'] = 'Bearer ' + window.APP_TOKEN;
    }
    return origFetch.call(this, input, init).then((res) => {
      // Expired / invalid session → bounce back to the login screen.
      // (login/signup/logout are excluded: their 401s are normal control flow.)
      if (res && res.status === 401 && isApi &&
          url.indexOf('/api/login') === -1 && url.indexOf('/api/signup') === -1 &&
          url.indexOf('/api/logout') === -1 && url.indexOf('/api/appeals') === -1 &&
          typeof window.handleUnauthorized === 'function') {
        window.handleUnauthorized();
      }
      // Rate limited — surface the server's message once (login/signup are
      // excluded because they render inline errors on the form).
      if (res && res.status === 429 && isApi &&
          url.indexOf('/api/login') === -1 && url.indexOf('/api/signup') === -1 &&
          typeof showToast === 'function') {
        try {
          res.clone().json().then(d => { if (d && d.error) showToast(d.error, 'error'); }).catch(() => {});
        } catch (e) {}
      }
      return res;
    });
  };
})();

// ===== ICON HELPER =====
function icon(name, size = 18) {
  const svgs = {
    search: `<path d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>`,
    users: `<path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/>`,
    bell: `<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>`,
    logout: `<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>`,
    menu: `<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>`,
    smile: `<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>`,
    image: `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`,
    mic: `<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>`,
    'map-pin': `<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>`,
    send: `<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>`,
    'chevron-left': `<polyline points="15 18 9 12 15 6"/>`,
    'more-vertical': `<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>`,
    flag: `<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>`,
    x: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
    star: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
    'star-outline': `<path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 4.8L8 14l-6-4.8h7.6z"/>`,
    check: `<polyline points="20 6 9 17 4 12"/>`,
    'check-double': `<polyline points="18 6 7 17 2 12"/><polyline points="22 6 11 17 9 15"/>`,
    plus: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
    user: `<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
    sun: `<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>`,
    reply: `<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 00-4-4H4"/>`,
    forward: `<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 014-4h12"/>`,
    copy: `<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>`,
    edit: `<path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>`,
    trash: `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>`,
    block: `<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>`,
    unblock: `<circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/>`,
    'volume-x': `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>`,
    'volume-1': `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/>`,
    crown: `<path d="M2 19l3-14 4 7 4-7 3 14"/><path d="M2 19h20"/>`,
    info: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`,
    'check-circle': `<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`,
    'x-circle': `<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>`,
    'message-circle': `<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>`,
    heart: `<path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>`,
    'thumbs-up': `<path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.31l1.38-5a2 2 0 00-.07-1.57 2 2 0 00-1.59-1.12H15zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/>`,
    'alert-triangle': `<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
    'sparkles': `<path d="M12 3v4M12 17v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M3 12h4M17 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>`,
    forbidden: `<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>`,
    link: `<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>`
  };
  if (!svgs[name]) return '';
  const sizeAttr = size ? `width="${size}" height="${size}"` : '';
  return `<svg ${sizeAttr} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgs[name]}</svg>`;
}
// ===== AUTH SOUND WAVE BACKGROUND =====
const authWaveCanvas = document.getElementById('authWaveCanvas');
const authWave = {
  canvas: authWaveCanvas,
  ctx: authWaveCanvas ? authWaveCanvas.getContext('2d') : null,
  bars: [],
  rafId: null,
  width: 0,
  height: 0,
  dpr: 1,
  started: false,
  resizeBound: false
};

function createAuthWaveBars() {
  authWave.bars = [];
  const count = 40;
  for (let i = 0; i < count; i++) {
    authWave.bars.push({
      phase: Math.random() * Math.PI * 2,
      speed: 1.8 + Math.random() * 2.2,
      amp: 0.4 + Math.random() * 0.6,
      width: 0.8 + Math.random() * 0.4
    });
  }
}

function resizeAuthWave() {
  if (!authWave.canvas || !authWave.ctx) return;
  const rect = authPage.getBoundingClientRect();
  authWave.dpr = Math.min(window.devicePixelRatio || 1, 2);
  authWave.width = Math.max(1, Math.round(rect.width));
  authWave.height = Math.max(1, Math.round(rect.height));
  authWave.canvas.width = Math.round(authWave.width * authWave.dpr);
  authWave.canvas.height = Math.round(authWave.height * authWave.dpr);
  authWave.ctx.setTransform(authWave.dpr, 0, 0, authWave.dpr, 0, 0);
}

function drawAuthWave(now) {
  if (!authWave.canvas || !authWave.ctx) return;
  if (authPage.style.display === 'none') {
    authWave.started = false;
    authWave.rafId = null;
    return;
  }

  const ctx = authWave.ctx;
  const w = authWave.width;
  const h = authWave.height;
  const time = now * 0.001;
  const waveTop = h * 0.7;
  const waveHeight = h * 0.22;
  const barCount = authWave.bars.length;
  const totalWidth = w * 0.7;
  const startX = (w - totalWidth) / 2;
  const spacing = totalWidth / barCount;
  const drift = Math.sin(time * 0.15) * w * 0.01;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;

  for (let i = 0; i < barCount; i++) {
    const bar = authWave.bars[i];
    const x = startX + i * spacing + drift;
    const val = Math.sin(time * bar.speed + bar.phase) * bar.amp;
    const barH = Math.max(4, (val + 1) * 0.5 * waveHeight);
    const y = waveTop - barH;

    ctx.strokeRect(x, y, Math.max(1, bar.width), barH);
  }

  // Subtle connecting line across bar tops for a wave feel
  ctx.beginPath();
  for (let i = 0; i < barCount; i++) {
    const bar = authWave.bars[i];
    const x = startX + i * spacing + drift;
    const val = Math.sin(time * bar.speed + bar.phase) * bar.amp;
    const barH = Math.max(4, (val + 1) * 0.5 * waveHeight);
    const y = waveTop - barH;
    if (i === 0) ctx.moveTo(x + bar.width / 2, y);
    else ctx.lineTo(x + bar.width / 2, y);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  authWave.rafId = requestAnimationFrame(drawAuthWave);
}

function startAuthWave() {
  if (!authWave.canvas || !authWave.ctx || authWave.started) return;
  if (!authWave.bars.length) createAuthWaveBars();
  resizeAuthWave();
  authWave.started = true;
  authWave.rafId = requestAnimationFrame(drawAuthWave);
}

function stopAuthWave() {
  if (authWave.rafId) cancelAnimationFrame(authWave.rafId);
  authWave.rafId = null;
  authWave.started = false;
  if (authWave.ctx) authWave.ctx.clearRect(0, 0, authWave.width, authWave.height);
}

function initAuthWave() {
  const canvas = document.getElementById('authWaveCanvas');
  if (!canvas) return;
  authWave.canvas = canvas;
  authWave.ctx = canvas.getContext('2d');
  if (!authWave.ctx) return;

  if (!authWave.resizeBound) {
    window.addEventListener('resize', resizeAuthWave);
    authWave.resizeBound = true;
  }
  startAuthWave();
}

// ===== LOGO WAVE (small inline animation above HiFi logo) =====
const logoWave = {
  canvas: null,
  ctx: null,
  bars: [],
  rafId: null,
  width: 0,
  height: 0,
  dpr: 1,
  started: false
};

function createLogoWaveBars() {
  logoWave.bars = [];
  const count = 14;
  for (let i = 0; i < count; i++) {
    logoWave.bars.push({
      phase: Math.random() * Math.PI * 2,
      speed: 1.8 + Math.random() * 2.2,
      amp: 0.2 + Math.random() * 0.4,
      width: 1.0 + Math.random() * 0.5
    });
  }
}

function resizeLogoWave() {
  if (!logoWave.canvas) return;
  const rect = logoWave.canvas.getBoundingClientRect();
  logoWave.dpr = Math.min(window.devicePixelRatio || 1, 2);
  logoWave.width = rect.width;
  logoWave.height = rect.height;
  logoWave.canvas.width = Math.round(rect.width * logoWave.dpr);
  logoWave.canvas.height = Math.round(rect.height * logoWave.dpr);
  logoWave.ctx.setTransform(logoWave.dpr, 0, 0, logoWave.dpr, 0, 0);
}

function drawLogoWave(now) {
  if (!logoWave.canvas || !logoWave.ctx) return;
  if (authPage.style.display === 'none') {
    logoWave.started = false;
    logoWave.rafId = null;
    return;
  }

  const ctx = logoWave.ctx;
  const w = logoWave.width;
  const h = logoWave.height;
  const time = now * 0.001;
  const barCount = logoWave.bars.length;
  const totalWidth = w * 0.8;
  const startX = (w - totalWidth) / 2;
  const spacing = totalWidth / barCount;
  const midY = h / 2;
  const maxBarH = h * 0.8;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.8;

  for (let i = 0; i < barCount; i++) {
    const bar = logoWave.bars[i];
    const x = startX + i * spacing;
    const val = Math.sin(time * bar.speed + bar.phase) * bar.amp;
    const barH = Math.max(2, (val + 1) * 0.5 * maxBarH);
    const y = midY - barH;
    ctx.strokeRect(x, y, Math.max(1, bar.width), barH);
  }

  logoWave.rafId = requestAnimationFrame(drawLogoWave);
}

function startLogoWave() {
  if (!logoWave.canvas || !logoWave.ctx || logoWave.started) return;
  if (!logoWave.bars.length) createLogoWaveBars();
  resizeLogoWave();
  logoWave.started = true;
  logoWave.rafId = requestAnimationFrame(drawLogoWave);
}

function stopLogoWave() {
  if (logoWave.rafId) cancelAnimationFrame(logoWave.rafId);
  logoWave.rafId = null;
  logoWave.started = false;
  if (logoWave.ctx) logoWave.ctx.clearRect(0, 0, logoWave.canvas.width, logoWave.canvas.height);
}

function initLogoWave() {
  logoWave.canvas = document.getElementById('authLogoWave');
  if (!logoWave.canvas) return;
  logoWave.ctx = logoWave.canvas.getContext('2d');
  startLogoWave();
}

// ===== AUTH TABS =====
authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    authTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const tabName = tab.dataset.tab;
    if (tabName === 'login') {
      loginForm.style.display = 'block';
      signupForm.style.display = 'none';
    } else {
      loginForm.style.display = 'none';
      signupForm.style.display = 'block';
    }
  });
});

// ===== LOGIN =====
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }

  const submitBtn = loginForm.querySelector('button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Logging in...'; }

  try {
    const res = await fetch(api('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.success && data.token && data.user) {
      currentUser = data.user;
      window.currentUser = currentUser;
      window.APP_TOKEN = data.token;
      unauthorizedHandling = false;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      enterChat();
    } else {
      if (errorEl) {
        errorEl.textContent = data.error || 'Invalid username or password';
        errorEl.classList.add('show');
      }
      // Banned account → surface the appeal flow right on the login screen.
      const appealBtn = document.getElementById('appealLinkBtn');
      if (data.banned === true && appealBtn) {
        appealBtn.style.display = '';
        const appealUser = document.getElementById('appealUsername');
        if (appealUser) appealUser.value = username;
      } else if (appealBtn) {
        appealBtn.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('Login error:', err);
    if (errorEl) {
      errorEl.textContent = 'Connection error. Please check backend connection.';
      errorEl.classList.add('show');
    }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Login'; }
  }
});

// ===== BAN APPEAL =====
document.getElementById('appealLinkBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('appealModal');
  if (!modal) return;
  const err = document.getElementById('appealError');
  if (err) { err.textContent = ''; err.classList.remove('show'); }
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('appealReason')?.focus();
});

document.getElementById('closeAppealModal')?.addEventListener('click', closeAppealModal);
document.getElementById('cancelAppealBtn')?.addEventListener('click', closeAppealModal);

function closeAppealModal() {
  const modal = document.getElementById('appealModal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

document.getElementById('submitAppealBtn')?.addEventListener('click', async () => {
  const username = document.getElementById('appealUsername')?.value.trim();
  const reason = document.getElementById('appealReason')?.value.trim();
  const err = document.getElementById('appealError');
  const btn = document.getElementById('submitAppealBtn');
  if (err) { err.textContent = ''; err.classList.remove('show'); }
  if (!username || !reason) {
    if (err) { err.textContent = 'Please enter your username and an explanation.'; err.classList.add('show'); }
    return;
  }
  // Mirror the server's minimum length so users get instant feedback.
  if (reason.length < 10) {
    if (err) { err.textContent = 'Please explain in a few sentences (at least 10 characters).'; err.classList.add('show'); }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(api('/api/appeals'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, reason })
    });
    // The appeals endpoint only exists on updated backends — an old server
    // answers 401/404. Show a helpful message instead of a bare error.
    if (res.status === 401 || res.status === 404) {
      if (err) {
        err.textContent = "The server hasn't been updated yet — appeal submissions aren't available.";
        err.classList.add('show');
      }
      return;
    }
    const data = await res.json();
    if (data.success) {
      closeAppealModal();
      const loginError = document.getElementById('loginError');
      if (loginError) {
        loginError.textContent = data.alreadyAppealed
          ? 'You already have an appeal under review.'
          : 'Appeal submitted! An admin will review it. Try logging in again later.';
        loginError.classList.add('show');
      }
    } else {
      if (err) { err.textContent = data.error || 'Failed to submit appeal'; err.classList.add('show'); }
    }
  } catch (e) {
    if (err) { err.textContent = 'Connection error'; err.classList.add('show'); }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ===== SIGNUP =====
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const displayName = document.getElementById('signupName').value.trim();
  const username = document.getElementById('signupUsername').value.trim();
  const password = document.getElementById('signupPassword').value;
  const errorEl = document.getElementById('signupError');
  if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }

  const submitBtn = signupForm.querySelector('button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing up...'; }

  try {
    const res = await fetch(api('/api/signup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName, password })
    });
    const data = await res.json();

    if (data.success && data.token && data.user) {
      currentUser = data.user;
      window.currentUser = currentUser;
      window.APP_TOKEN = data.token;
      unauthorizedHandling = false;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      enterChat();
    } else {
      if (errorEl) {
        errorEl.textContent = data.error || 'Signup failed';
        errorEl.classList.add('show');
      }
    }
  } catch (err) {
    console.error('Signup error:', err);
    if (errorEl) {
      errorEl.textContent = 'Connection error. Please check backend connection.';
      errorEl.classList.add('show');
    }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign Up'; }
  }
});

// Session expired / invalid token → clear auth state and return to login.
// Bound to window so the fetch interceptor can trigger it on 401 responses.
let unauthorizedHandling = false;
window.handleUnauthorized = function() {
  if (unauthorizedHandling) return;
  if (!window.currentUser && !localStorage.getItem('token')) return;
  unauthorizedHandling = true;
  doLogout('Session expired. Please log in again.');
  setTimeout(() => { unauthorizedHandling = false; }, 500);
};

function doLogout(message) {
  // Best-effort server-side session revocation (token is still attached by
  // the fetch interceptor until we clear it below).
  try {
    fetch(api('/api/logout'), { method: 'POST' }).catch(() => {});
  } catch (e) {}
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('hifi_user');
  window.APP_TOKEN = null;
  currentUser = null;
  window.currentUser = null;
  activeChat = null;
  chatEntered = false;
  conversations = [];
  if (conversationsList) conversationsList.innerHTML = '';
  if (chatMessages) chatMessages.innerHTML = '';
  if (emptyState) emptyState.style.display = 'flex';
  if (activeChatDiv) activeChatDiv.style.display = 'none';
  if (socket) {
    try { socket.disconnect(); } catch(e){}
    socket = null;
    window.socket = null;
  }
  if (chatApp) chatApp.style.display = 'none';
  if (authPage) authPage.style.display = 'flex';
  if (typeof closeSeenByPopup === 'function') closeSeenByPopup();
  // Detach the Feedback Hub from the old account so the next login rebinds it
  // to the new user + new socket (instead of staying stale until a reload).
  if (typeof resetFeedbackHub === 'function') resetFeedbackHub();
  if (typeof startAuthWave === 'function') startAuthWave();
  if (typeof startLogoWave === 'function') startLogoWave();
  showToast(message || 'Logged out successfully', 'info');
}

// ===== ENTER CHAT =====
async function syncCurrentUserProfile() {
  if (!currentUser) return;
  try {
    const res = await fetch(api(`/api/users/${currentUser.id}`));
    const user = await res.json();
    if (user && user.id) {
      if (user.displayName !== undefined) currentUser.displayName = user.displayName;
      if (user.bio !== undefined) currentUser.bio = user.bio;
      if (user.avatar !== undefined) currentUser.avatar = user.avatar;
      
      localStorage.setItem('user', JSON.stringify(currentUser));
      localStorage.setItem('hifi_user', JSON.stringify(currentUser));
      
      const navName = document.getElementById('navUserName');
      if (navName) navName.textContent = currentUser.displayName || currentUser.username || 'User';
      const navAv = document.getElementById('navAvatar');
      if (navAv) navAv.innerHTML = avatarHtml(currentUser.avatar, currentUser.displayName || currentUser.username || 'User');
    }
  } catch (err) {
    console.error('Failed to sync profile', err);
  }
}

// ============ IN-APP SELF-UPDATE (WEB OTA) ============
// Tells the native layer the app booted OK — this arms the rollback guard so
// a bad OTA bundle falls back to the previous version on the next launch.
function notifyNativeAppReady() {
  if (window.AndroidNativeConfig && typeof window.AndroidNativeConfig.notifyAppReady === 'function') {
    try { window.AndroidNativeConfig.notifyAppReady(); } catch(e) {}
  }
}

// Native → JS: a web update finished downloading (applies on next cold start).
window.handleUpdateReady = function(version) {
  maybeShowUpdateBanner(version);
};

// Native → JS: an update (web or APK) failed — surface it, don't crash.
window.handleUpdateError = function(msg) {
  hideApkProgressBar();
  if (typeof window.showToast === 'function') {
    window.showToast(String(msg || 'Update failed'), 'error');
  }
};

// Native → JS: a Tier 2 APK install finished. status is 'installing' (system
// confirm dialog on screen), 'installed', or 'error'. The system dialog is
// itself the user-visible confirmation, so we only surface the result here.
window.handleApkUpdateResult = function(status, msg) {
  // Download finished — hide the in-app progress bar (the system dialog or
  // toast takes over from here).
  hideApkProgressBar();
  if (status === 'installing') return; // system dialog already on screen
  if (typeof window.showToast === 'function') {
    if (status === 'installed') {
      window.showToast('✅ HiFi updated — open the app to use the new version', 'success');
    } else {
      window.showToast('⚠️ ' + String(msg || 'Update failed'), 'error');
    }
  }
};

// ---- In-app APK download progress bar ----
// Native → JS: APK download progress (0-100). Shows a slim progress bar pinned
// above the composer so the user sees the download move in real time, matching
// the system-tray notification posted by UpdateManager. The bar hides itself
// when the download completes (handleApkUpdateResult / handleUpdateError).
let __apkProgressEl = null;
let __apkProgressFill = null;
let __apkProgressPct = null;

function hideApkProgressBar() {
  if (__apkProgressEl) {
    const el = __apkProgressEl;
    el.classList.remove('show');
    el.classList.add('hide');
    // Remove after the fade-out so a later download can rebuild it fresh.
    // Capture `el` locally: if a NEW download starts within the 400ms window,
    // __apkProgressEl points at the new bar and must NOT be removed.
    setTimeout(() => {
      if (el && el.isConnected) el.remove();
      if (__apkProgressEl === el) {
        __apkProgressEl = null;
        __apkProgressFill = null;
        __apkProgressPct = null;
      }
    }, 400);
  }
}

window.handleApkDownloadProgress = function(percent) {
  try {
    const num = Number(percent);
    const indeterminate = !isFinite(num) || num < 0; // unknown total size
    const p = indeterminate ? 0 : Math.max(0, Math.min(100, Math.round(num)));
    if (!__apkProgressEl) {
      __apkProgressEl = document.createElement('div');
      __apkProgressEl.id = 'apkProgressBar';
      __apkProgressEl.className = 'apk-progress-bar';
      __apkProgressEl.innerHTML =
        '<div class="apk-progress-inner">' +
          '<div class="apk-progress-icon">📲</div>' +
          '<div class="apk-progress-body">' +
            '<div class="apk-progress-text"><span>Downloading HiFi update…</span><strong class="apk-progress-pct">0%</strong></div>' +
            '<div class="apk-progress-track"><div class="apk-progress-fill"></div></div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(__apkProgressEl);
      __apkProgressFill = __apkProgressEl.querySelector('.apk-progress-fill');
      __apkProgressPct = __apkProgressEl.querySelector('.apk-progress-pct');
      requestAnimationFrame(() => __apkProgressEl.classList.add('show'));
    }
    if (__apkProgressEl.classList.contains('indeterminate')) __apkProgressEl.classList.remove('indeterminate');
    if (indeterminate) {
      // No total size known — show a shimmering indeterminate bar.
      if (__apkProgressEl) __apkProgressEl.classList.add('indeterminate');
      if (__apkProgressPct) __apkProgressPct.textContent = '…';
    } else {
      if (__apkProgressFill) __apkProgressFill.style.width = p + '%';
      if (__apkProgressPct) __apkProgressPct.textContent = p + '%';
    }
  } catch (e) { /* progress bar is best-effort */ }
};

// Shows a slim, dismissible banner when a web update is downloaded but not
// yet applied. Tapping "Apply now" swaps the bundle immediately (native
// reloads the WebView from the new base path). Only ever shown once per boot.
function maybeShowUpdateBanner(version) {
  if (!window.AndroidNativeConfig || typeof window.AndroidNativeConfig.getPendingUpdate !== 'function') return;
  if (window.__updateBannerShown) return;
  let pending = null;
  try { pending = JSON.parse(window.AndroidNativeConfig.getPendingUpdate() || ''); } catch(e) {}
  if (!pending || !pending.version) return;
  const v = version || pending.version;
  window.__updateBannerShown = true;

  let banner = document.getElementById('updateReadyBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'updateReadyBanner';
    banner.className = 'update-banner';
    banner.innerHTML =
      '<div class="update-banner-inner">' +
        '<div class="update-banner-icon">🔄</div>' +
        '<div class="update-banner-text"><strong>Update v' + v + ' ready</strong><span>Restart to apply</span></div>' +
        '<button type="button" id="updateApplyBtn" class="update-banner-btn">Apply now</button>' +
        '<button type="button" id="updateDismissBtn" class="update-banner-x" aria-label="Dismiss">✕</button>' +
      '</div>';
    document.body.appendChild(banner);

    const applyBtn = document.getElementById('updateApplyBtn');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        try { window.AndroidNativeConfig.applyPendingUpdate(); } catch(e) {}
        banner.classList.remove('show');
      });
    }
    const dismissBtn = document.getElementById('updateDismissBtn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => banner.classList.remove('show'));
    }
  }
  // Give the DOM a beat so the slide-up transition runs.
  requestAnimationFrame(() => banner.classList.add('show'));
}

function enterChat() {
  if (!currentUser) {
    const saved = localStorage.getItem('user') || localStorage.getItem('hifi_user');
    if (saved) {
      try { currentUser = JSON.parse(saved); window.currentUser = currentUser; } catch(e){}
    }
  }
  if (!currentUser) return;

  // Guard: disconnect old socket when re-entering chat
  if (socket) {
    try { socket.disconnect(); } catch(e){}
    socket = null;
  }
  chatEntered = true;

  stopAuthWave();
  stopLogoWave();
  if (authPage) authPage.style.display = 'none';
  if (chatApp) chatApp.style.display = 'flex';

  // Set nav avatar + name to current user
  const displayName = currentUser.displayName || currentUser.username || currentUser.name || 'User';
  const navAvatar = document.getElementById('navAvatar');
  if (navAvatar) {
    navAvatar.innerHTML = avatarHtml(currentUser.avatar, displayName);
    navAvatar.title = displayName;
  }
  const navUserName = document.getElementById('navUserName');
  if (navUserName) navUserName.textContent = displayName;
  
  const navUserEl = document.getElementById('navUser');
  if (navUserEl && !navUserEl.__profileBound) {
    navUserEl.__profileBound = true;
    navUserEl.addEventListener('click', showProfileModal);
  }
  if (window.AndroidNativeConfig && window.AndroidNativeConfig.setUserId) {
    try { window.AndroidNativeConfig.setUserId(String(currentUser.id)); } catch(e) {}
  }
  if (window.AndroidNativeConfig && window.AndroidNativeConfig.setToken) {
    try { window.AndroidNativeConfig.setToken(String(window.APP_TOKEN || localStorage.getItem('token') || '')); } catch(e) {}
  }

  // Load conversations immediately
  loadConversations();
  // Pull server-side cleared-chat state so a reinstall / second device hides
  // the same messages the user already cleared.
  syncClearedChats();

  // Connect socket with authenticated handshake (opaque session token)
  socket = io(API_BASE || undefined, { auth: { token: window.APP_TOKEN || localStorage.getItem('token') } });
  window.socket = socket;

  // Rebind the Feedback Hub to this session (new user + new socket). Called on
  // every login/boot — harmless when the session didn't change, essential when
  // the account was switched so votes/replies/admin checks use the new user.
  if (typeof resetFeedbackHub === 'function') resetFeedbackHub();

  // Sync latest profile from server
  syncCurrentUserProfile();

  // ---- In-app self-update (web OTA) integration ----
  // Surface any downloaded-but-unapplied web update as a banner.
  // NOTE: notifyNativeAppReady() intentionally does NOT live here — it must
  // fire at boot REGARDLESS of login (see the AUTO LOGIN section) so the
  // native rollback guard is armed even when the app opens to the login
  // screen; otherwise the next relaunch would roll back a good update.
  maybeShowUpdateBanner();

  const debounceLoad = (function() {
    let timer = null;
    return function() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { loadConversations(); timer = null; }, 250);
    };
  })();

  socket.on('connect', () => {
    socket.emit('user_online', currentUser.id);
    setupP2PSocketListeners();
    loadConversations();
    if (activeChat) refreshCurrentChat();
    // Cold-start notification tap deep link: open the conversation that a
    // message/reaction notification tap targeted (one-shot prefs).
    consumePendingChatDeepLink();
  });

  socket.on('reconnect', () => {
    socket.emit('user_online', currentUser.id);
    loadConversations();
    syncClearedChats();
    if (activeChat) refreshCurrentChat();
  });

  // Another device of THIS user cleared a chat → update local state live so
  // the hidden messages disappear here too (server is the source of truth).
  socket.on('chat_cleared', (data) => {
    if (!data || !data.targetId) return;
    clearedChats[String(data.targetId)] = data.clearedAt || Date.now();
    localStorage.setItem('cleared_chats', JSON.stringify(clearedChats));
    if (activeChat && String(activeChat.id) === String(data.targetId)) {
      if (typeof refreshCurrentChat === 'function') refreshCurrentChat();
    }
    loadConversations();
  });

  // Handshake rejection (missing/invalid/expired token) → back to login.
  socket.on('connect_error', (err) => {
    if (err && err.message === 'Unauthorized') {
      window.handleUnauthorized();
    }
  });

  // Auto-sync real-time state whenever app/tab regains focus or visibility
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) {
      if (socket) {
        if (!socket.connected) socket.connect();
        socket.emit('user_online', currentUser.id);
      }
      loadConversations();
      syncClearedChats();
      if (activeChat) refreshCurrentChat();
      syncCurrentUserProfile();
    }
  });

  window.addEventListener('focus', () => {
    if (currentUser) {
      if (socket && !socket.connected) socket.connect();
      loadConversations();
      syncClearedChats();
      if (activeChat) refreshCurrentChat();
      syncCurrentUserProfile();
    }
  });

  // Load blocked users list + muted conversations
  loadBlockedUsers();
  loadMutedConversations();

  socket.on('user_status', (data) => {
    updateUserStatus(data.userId, data.online);
  });

  socket.on('online_users', (userIds) => {
    userIds.forEach(id => updateUserStatus(id, true));
  });

  socket.on('new_message', (msg) => {
    if (!msg) return;
    updateConversationFromMessage(msg);
    // Guard: Never play notification or sound for messages sent by oneself
    if (String(msg.from) === String(currentUser.id)) {
      if (activeChat && activeChat.type === 'dm' && (String(activeChat.id) === String(msg.to) || String(activeChat.id) === String(msg.from))) {
        if (window.checkBirthdayMessage) window.checkBirthdayMessage(msg);
        if (window.checkAngryMessage) window.checkAngryMessage(msg);
        if (window.checkLoveMessage) window.checkLoveMessage(msg);
        renderMessage(msg);
        scrollToBottom();
      }
      debounceLoad();
      return;
    }
    const isCurrentDm = activeChat && activeChat.type === 'dm' &&
      (String(activeChat.id) === String(msg.from) || String(activeChat.id) === String(msg.to));

    if (isCurrentDm) {
      if (window.checkBirthdayMessage) window.checkBirthdayMessage(msg);
        if (window.checkAngryMessage) window.checkAngryMessage(msg);
      if (window.checkLoveMessage) window.checkLoveMessage(msg);
      renderMessage(msg);
      scrollToBottom();
      socket.emit('mark_read', { messageIds: [msg.id], userId: currentUser.id });
    } else {
      if (!isMuted(msg.from)) {
        playNotificationSound();
        const senderName = userNameCache[msg.from] || (conversations.find(c => String(c.id) === String(msg.from))?.name) || 'New Message';
        sendPushNotification(senderName, msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'location' ? '📍 Location' : msg.type === 'voice' ? '🎤 Voice message' : 'New message'), msg.id);
        if (!userNameCache[msg.from]) prefetchNames([msg.from]).catch(() => {});
      }
    }
    debounceLoad();
  });

  socket.on('message_sent', (msg) => {
    if (!msg) return;
    updateConversationFromMessage(msg);
    if (activeChat && activeChat.type === 'dm' && (String(activeChat.id) === String(msg.to) || String(activeChat.id) === String(msg.from))) {
      if (window.checkBirthdayMessage) window.checkBirthdayMessage(msg);
        if (window.checkAngryMessage) window.checkAngryMessage(msg);
      if (window.checkLoveMessage) window.checkLoveMessage(msg);
      renderMessage(msg);
      scrollToBottom();
    }
    debounceLoad();
  });

  socket.on('message_blocked', (data) => {
    showToast(data.error || 'Message not sent — user is blocked', 'error');
    messageInput.value = '';
    cancelReply();
  });

  // Per-user rate limit hit. Fire-and-forget events have no ack, so the
  // server emits this so the user knows why nothing happened and when to retry.
  socket.on('rate_limited', (data) => {
    if (typeof showToast === 'function') {
      showToast(data.message || 'Too many requests — please slow down.', 'error');
    }
  });

  socket.on('new_group_message', (msg) => {
    if (!msg) return;
    // The Feedback Hub owns its own notifications (drawer items + sound in
    // feedback.js). Skip the generic group path so hub mentions/replies don't
    // double-sound or fire a system push for feedback-global-hub messages.
    if (msg.groupId === 'feedback-global-hub') return;
    updateConversationFromMessage(msg);
    // Guard: Never play notification or sound for messages sent by oneself
    if (String(msg.from) === String(currentUser.id)) {
      if (activeChat && activeChat.type === 'group' && String(activeChat.id) === String(msg.groupId)) {
        renderMessage(msg);
        scrollToBottom();
      }
      debounceLoad();
      return;
    }
    const isCurrentGroup = activeChat && activeChat.type === 'group' && String(activeChat.id) === String(msg.groupId);

    if (isCurrentGroup) {
      if (window.checkBirthdayMessage) window.checkBirthdayMessage(msg);
        if (window.checkAngryMessage) window.checkAngryMessage(msg);
      prefetchNames([msg.from]).then(() => {
        renderMessage(msg);
        scrollToBottom();
      }).catch(() => {
        renderMessage(msg);
        scrollToBottom();
      });
      socket.emit('mark_read', { messageIds: [msg.id], userId: currentUser.id });
    } else {
      if (!isMuted(msg.groupId)) {
        playNotificationSound();
        const groupConv = conversations.find(c => String(c.id) === String(msg.groupId));
        const groupTitle = groupConv ? `Group: ${groupConv.name}` : 'Group Message';
        const senderName = userNameCache[msg.from] || 'Someone';
        sendPushNotification(groupTitle, `${senderName}: ${msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'voice' ? '🎤 Voice' : msg.type === 'location' ? '📍 Location' : 'New message')}`, msg.id);
        if (!userNameCache[msg.from]) prefetchNames([msg.from]).catch(() => {});
      }
    }
    debounceLoad();
  });

  socket.on('group_message_sent', (msg) => {
    if (!msg) return;
    updateConversationFromMessage(msg);
    if (activeChat && activeChat.type === 'group' && String(activeChat.id) === String(msg.groupId)) {
      renderMessage(msg);
      scrollToBottom();
    }
    debounceLoad();
  });

  socket.on('user_typing', (data) => {
    const chatId = data.groupId || data.from;
    if (data.from === currentUser.id) return;
    // The backend now sends the display name so group typing indicators can
    // show real names without waiting on a name-cache prefetch.
    if (data.name) userNameCache[data.from] = data.name;
    prefetchRole(data.from);
    if (!activeTyping[chatId]) {
      activeTyping[chatId] = new Set();
    }
    activeTyping[chatId].add(data.from);

    if (activeChat && activeChat.id === chatId) {
      showTypingIndicator(data.from);
      updateChatHeaderStatus();
    }
  });

  socket.on('user_stop_typing', (data) => {
    const chatId = data.groupId || data.from;
    if (activeTyping[chatId]) {
      activeTyping[chatId].delete(data.from);
      if (activeTyping[chatId].size === 0) {
        delete activeTyping[chatId];
      }
    }

    if (activeChat && activeChat.id === chatId) {
      hideTypingIndicator(data.from);
      updateChatHeaderStatus();
    }
  });

  socket.on('messages_read', (data) => {
    data.messageIds.forEach(id => {
      const el = document.querySelector(`[data-msg-id="${id}"]`);
      if (el) {
        // Update tick
        const tick = el.querySelector('.msg-tick');
        if (tick) {
          tick.innerHTML = DOUBLE_TICK_SVG;
          tick.classList.add('read');
        }
        // Read receipts v2: record the reader (name + first-read time) on the
        // message data and rebuild the avatar stack / Seen-by panel.
        if (activeChat && activeChat.type === 'group' && data.userId && el._msgData) {
          if (data.displayName) userNameCache[data.userId] = data.displayName;
          prefetchRole(data.userId);
          if (!el._msgData.readBy) el._msgData.readBy = [];
          if (!el._msgData.readBy.includes(data.userId)) {
            el._msgData.readBy.push(data.userId);
            if (!el._msgData.readAt) el._msgData.readAt = {};
            el._msgData.readAt[data.userId] = (data.readAt && data.readAt[id]) || new Date().toISOString();
          }
          refreshReadReceipts(el, el._msgData);
        }
      }
    });
    // Keep the open "Seen By" popup live as readers arrive.
    if (typeof refreshSeenByPopup === 'function') refreshSeenByPopup();
  });

  // --- Reaction toast aggregation ---
  // Multiple reactions to the SAME message within a short window collapse into
  // ONE toast ("Pawan and 2 others reacted 👍 to your message"), mirroring the
  // Android tray grouping. Keyed by messageId; a 1.2s debounce window collects
  // burst reactions, then a single aggregated toast fires.
  const _pendingReactionToasts = {}; // messageId -> { names:Set, emoji, groupName, timer }
  window.queueReactionToast = function queueReactionToast(data) {
    const key = data.messageId;
    const entry = _pendingReactionToasts[key] || {
      names: new Set(),
      emoji: data.emoji || '👍',
      groupName: data.groupName || null,
      timer: null
    };
    entry.names.add(data.reactorName || 'Someone');
    if (data.emoji) entry.emoji = data.emoji; // newest emoji wins
    if (data.groupName) entry.groupName = data.groupName;
    _pendingReactionToasts[key] = entry;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const names = Array.from(entry.names);
      const count = names.length;
      let who = names[0];
      if (count === 2) who = names[0] + ' and ' + names[1];
      else if (count > 2) who = names[0] + ' and ' + (count - 1) + ' others';
      const gName = entry.groupName;
      showToast(gName
        ? `${who} reacted ${entry.emoji} to your message in ${gName}`
        : `${who} reacted ${entry.emoji} to your message`, 'info', 4000);
      delete _pendingReactionToasts[key];
    }, 1200);
  };

  socket.on('message_reacted', (data) => {
    // Live chat-list preview: when someone reacts to MY message, show
    // "reacted 🧐 to your message" as that conversation's preview line and
    // count it as unread (same rule as the server's conversations endpoint).
    // Only when I'm not looking at that chat, and only for reactions to my
    // own messages.
    try {
      if (typeof currentUser !== 'undefined' && currentUser && data.authorId
          && String(data.authorId) === String(currentUser.id)
          && data.reactorId && String(data.reactorId) !== String(currentUser.id)
          && data.added !== false) {   // only real adds count as new activity
        const convId = data.groupId || data.dmPartnerId || '';
        const chatOpen = activeChat && activeChat.id != null && (
          (activeChat.type === 'group' && String(activeChat.id) === String(data.groupId))
          || (activeChat.type === 'dm' && String(activeChat.id) === String(data.dmPartnerId))
        );
        if (!chatOpen && convId) {
          const conv = conversations.find(c => String(c.id) === String(convId));
          if (conv) {
            const preview = 'reacted ' + (data.emoji || '👍') + ' to your message';
            // Bump to top + preview + unread (reaction newer than last msg).
            conv.lastMessage = preview;
            conv.lastMessageTime = Date.now();
            conv.unread = (conv.unread || 0) + 1;
            conversations.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
            renderConversations();
          }
        }
      }
    } catch (e) { /* live preview is best-effort */ }
    // WhatsApp-style toast: someone reacted to MY message while I'm not
    // looking at that chat. The backend now ships authorId (whose message it
    // is) + conversation ids + who reacted, so we can notify without a lookup.
    // Multiple reactions to the SAME message within a short window aggregate
    // into ONE toast ("Pawan and 2 others reacted 👍 to your message") — same
    // grouping rule as the Android notification tray.
    try {
      if (typeof currentUser !== 'undefined' && currentUser && data.authorId
          && String(data.authorId) === String(currentUser.id)
          && data.reactorId && String(data.reactorId) !== String(currentUser.id)
          && data.added !== false   // never toast on un-reacts
          && typeof isConversationMuted === 'function') {
        const convId = data.groupId || data.dmPartnerId || '';
        const chatOpen = activeChat && activeChat.id != null && (
          (activeChat.type === 'group' && String(activeChat.id) === String(data.groupId))
          || (activeChat.type === 'dm' && String(activeChat.id) === String(data.dmPartnerId))
        );
        if (!chatOpen && convId && !isConversationMuted(convId) && typeof showToast === 'function') {
          queueReactionToast(data);
        }
      }
    } catch (e) { /* toast is best-effort */ }
    const el = document.querySelector(`[data-msg-id="${data.messageId}"]`);
    if (el) {
      let reactEl = el.querySelector('.msg-reactions');
      if (!reactEl && Object.keys(data.reactions).length > 0) {
        reactEl = document.createElement('div');
        reactEl.className = 'msg-reactions';
        
        let wrapper = el.querySelector('.message-bubble-wrapper') || el;
        wrapper.appendChild(reactEl);

      }
      if (reactEl) {
        reactEl.innerHTML = renderReactionsHtml(data.reactions);
        attachReactionTooltips();

        // Force repaint on the message container for Android
        

        // Ensure spacing is applied
        const bubble = el.querySelector('.message-bubble');
        if (bubble) bubble.style.marginBottom = '12px';

        if (Object.keys(data.reactions).length === 0) {
          reactEl.remove();
          if (bubble) bubble.style.marginBottom = '';
        }
      }
    }
  });

  socket.on('message_deleted', (data) => {
    // If the "Seen By" popup is showing the deleted message, close it.
    if (seenByPopupMsgId && String(data.messageId) === String(seenByPopupMsgId)) {
      if (typeof closeSeenByPopup === 'function') closeSeenByPopup();
    }
    const el = document.querySelector(`[data-msg-id="${data.messageId}"]`);
    if (el) {
      el.classList.add('deleted');
      if (el._msgData && !el._msgData.deleted) {
        el._msgData.deleted = true;
        if (typeof decrementChatInfoStatsInstant === 'function') {
          decrementChatInfoStatsInstant(el._msgData);
        }
      }
      el.querySelector('.message-actions')?.remove();
      const bubble = el.querySelector('.message-bubble');
      if (bubble) {
        bubble.innerHTML = '<div style="color:var(--text-muted);font-style:italic;font-size:0.75rem;display:flex;align-items:center;gap:6px;justify-content:center;">' + icon('forbidden', 12) + ' This message was deleted</div>';
      }
    }
    debounceLoad();
  });

  // Avatar (DP) updated by any user or another device of current user
  socket.on('user_avatar_updated', (data) => {
    if (!data || !data.userId) return;

    // 1. If it's MY OWN account updated from another device:
    if (currentUser && String(currentUser.id) === String(data.userId)) {
      currentUser.avatar = data.avatarUrl || null;
      localStorage.setItem('user', JSON.stringify(currentUser));
      localStorage.setItem('hifi_user', JSON.stringify(currentUser));
      const navAv = document.getElementById('navAvatar');
      if (navAv) navAv.innerHTML = avatarHtml(data.avatarUrl, currentUser.displayName || currentUser.username);
      const profAv = document.getElementById('profileAvatar');
      if (profAv) profAv.innerHTML = avatarHtml(data.avatarUrl, currentUser.displayName || currentUser.username);
    }

    // 2. If it's the currently open DM chat:
    if (activeChat && String(activeChat.id) === String(data.userId) && activeChat.type === 'dm') {
      activeChat.avatar = data.avatarUrl || null;
      renderActiveChat();
      const upAvatar = document.querySelector('.up-profile .up-avatar');
      if (upAvatar && document.getElementById('userPanelContent')?.style.display !== 'none') {
        upAvatar.innerHTML = avatarHtml(data.avatarUrl, activeChat.name);
      }
    }

    debounceLoad();
  });

  // Profile (name/bio) updated by any user or another device of current user
  socket.on('user_profile_updated', (data) => {
    if (!data || !data.userId) return;
    if (data.displayName) userNameCache[data.userId] = data.displayName;

    // If it's MY OWN account updated from another device:
    if (currentUser && String(currentUser.id) === String(data.userId)) {
      if (data.displayName) currentUser.displayName = data.displayName;
      if (data.bio !== undefined) currentUser.bio = data.bio;
      localStorage.setItem('user', JSON.stringify(currentUser));
      localStorage.setItem('hifi_user', JSON.stringify(currentUser));
      const navName = document.getElementById('navUserName');
      if (navName) navName.textContent = currentUser.displayName || currentUser.username;
      const navAv = document.getElementById('navAvatar');
      if (navAv) navAv.innerHTML = avatarHtml(currentUser.avatar, currentUser.displayName || currentUser.username);
    }

    if (activeChat && String(activeChat.id) === String(data.userId) && activeChat.type === 'dm') {
      activeChat.name = data.displayName || activeChat.name;
      renderActiveChat();
      const upName = document.querySelector('.up-profile h3');
      if (upName && document.getElementById('userPanelContent')?.style.display !== 'none') {
        upName.textContent = activeChat.name;
      }
    }

    debounceLoad();
  });

  // Request notification permission
  requestNotificationPermission();

  socket.on('message_edited', (data) => {
    const el = document.querySelector(`[data-msg-id="${data.messageId}"]`);
    if (el) {
      const textEl = el.querySelector('.message-text');
      if (textEl) {
        textEl.innerHTML = formatMessageText(data.text) + '<span class="edited-marker">(edited)</span>';
      }
    }
  });

  socket.on('group_updated', (data) => {
    if (activeChat && activeChat.id === data.groupId) {
      if (data.name) activeChat.name = data.name;
      if (data.avatar !== undefined) activeChat.avatar = data.avatar;
      if (data.countdown !== undefined) {
        if (data.countdown) activeChat.countdown = data.countdown;
        else delete activeChat.countdown;
      }
      renderActiveChat();
    }
    debounceLoad();
  });

  socket.on('removed_from_group', (data) => {
    if (activeChat && activeChat.id === data.groupId) {
      activeChat = null;
      renderConversations();
      showToast('You were removed from the group', 'info');
    }
    loadConversations();
  });

  socket.on('group_deleted', (data) => {
    if (activeChat && activeChat.id === data.groupId) {
      activeChat = null;
      showToast(`Group "${data.name}" was deleted`, 'info');
    }
    loadConversations();
  });

  // Load conversations
  loadConversations();

  // Mark all conversations as read
  window.markAllRead = function() {
    conversations.forEach(conv => {
      if (conv.unread > 0 && socket && conv.type === 'dm') {
        fetch(api(`/api/messages?from=${currentUser.id}&to=${conv.id}`)).then(r => r.json()).then(d => {
          const ids = d.messages.filter(m => m.from !== currentUser.id && !(m.readBy || []).includes(currentUser.id)).map(m => m.id);
          if (ids.length > 0) socket.emit('mark_read', { messageIds: ids, userId: currentUser.id });
        }).catch(() => {});
      }
    });
    showToast('Marked all as read', 'success');
    setTimeout(loadConversations, 1000);
  };
}

// ===== COPY MESSAGE =====
function copyMessageText(text) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Message copied', 'success');
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Message copied', 'success');
  } catch (e) {
    showToast('Failed to copy', 'error');
  }
}

// ===== SEARCH USERS =====
let searchTimeout = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const query = searchInput.value.trim();
    if (!query) {
      loadConversations();
      return;
    }

    try {
      const res = await fetch(api(`/api/users/search?q=${encodeURIComponent(query)}&exclude=${currentUser.id}`));
      const data = await res.json();
      renderSearchResults(data.users);
    } catch (err) {
      console.error('Search error:', err);
    }
  }, 300);
});

function renderSearchResults(users) {
  users.forEach(u => { if (u && u.isAdmin) userRoleCache[u.id] = true; });
  if (users.length === 0) {
    conversationsList.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">No users found</div>';
    return;
  }

  conversationsList.innerHTML = users.map(user => `
    <div class="conv-item" data-user-id="${user.id}" data-type="dm">
      <div class="conv-avatar">${avatarHtml(user.avatar, user.displayName || user.username)}</div>
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(user.displayName || user.username)}${user.isAdmin ? `<span class="admin-badge" title="${ADMIN_BADGE_TITLE}">${icon('crown', 12)}</span>` : ''}</div>
        <div class="conv-last">@${escapeHtml(user.username)}</div>
      </div>
    </div>
  `).join('');

  // Click handlers
  conversationsList.querySelectorAll('.conv-item').forEach(item => {
    item.addEventListener('click', () => {
      const userId = item.dataset.userId;
      openDM(userId);
    });
  });
}

// ===== LOAD CONVERSATIONS =====
async function loadConversations() {
  try {
    const res = await fetch(api(`/api/conversations/${currentUser.id}`));
    const data = await res.json();
    conversations = data.conversations || [];
    conversations.forEach(c => {
      if (c.name) userNameCache[c.id] = c.name;
      if (c.type === 'dm' && typeof c.isAdmin === 'boolean') userRoleCache[c.id] = c.isAdmin;
    });
    renderConversations();
  } catch (err) {
    console.error('Load conversations error:', err);
  }
}

function renderConversations() {
  // Apply active filter (All / Unread / Favorites)
  let list = conversations.filter(c => c.id !== 'feedback-global-hub');
  if (currentFilter === 'unread') list = list.filter(c => c.unread > 0);
  else if (currentFilter === 'favorites') list = list.filter(c => favorites.has(c.id));

  if (conversations.length === 0) {
    conversationsList.innerHTML = `
      <div class="conv-empty">No conversations yet.<br>Search people above to start chatting!</div>`;
    return;
  }
  if (list.length === 0) {
    // The feedback hub is always excluded from this list, so a user whose only
    // conversation is the hub (or an empty filter result) must not get a
    // misleading "No favorites yet" — say what's actually true per filter.
    const label = currentFilter === 'unread' ? 'No unread messages'
      : currentFilter === 'favorites' ? 'No favorites yet'
      : 'No conversations yet.<br>Search people above to start chatting!';
    conversationsList.innerHTML = `<div class="conv-empty">${label}</div>`;
    return;
  }

  conversationsList.innerHTML = list.map(conv => {
    const isActive = activeChat && activeChat.id === conv.id;
    const badgeHtml = conv.unread > 0 ? `<span class="unread-dot">${conv.unread}</span>` : '';
    const isFav = favorites.has(conv.id);
    return `
      <div class="conv-item ${isActive ? 'active' : ''}${conv.blocked ? ' conv-blocked' : ''}" data-conv-id="${conv.id}" data-type="${conv.type}">
        <div class="conv-avatar">${avatarHtml(conv.avatar, conv.name)}</div>
        <div class="conv-info">
          <div class="conv-name">${escapeHtml(conv.name)} ${conv.type === 'dm' ? adminBadgeHtml(conv.id) : ''} ${conv.blocked ? '<span style="color:var(--text-muted);font-size:0.7rem;">(blocked)</span>' : ''} ${conv.muted ? '<span style="color:var(--text-muted);font-size:0.7rem;">🔇</span>' : ''} ${conv.countdown ? '<span class="conv-countdown-chip" title="Group countdown">⏳</span>' : ''}</div>
          <div class="conv-last">${escapeHtml(conv.lastMessage || (conv.type === 'group' ? conv.members.length + ' members' : 'Click to chat'))}</div>
        </div>
        <div class="conv-meta">
          ${badgeHtml}
          <button class="fav-btn ${isFav ? 'on' : ''}" data-fav="${conv.id}" title="Favorite">${isFav ? icon('star', 16) : icon('star-outline', 16)}</button>
        </div>
      </div>
    `;
  }).join('');

  // Click handlers
  conversationsList.querySelectorAll('.conv-item').forEach(item => {
    item.addEventListener('click', () => {
      const convId = item.dataset.convId;
      const type = item.dataset.type;
      if (type === 'group') {
        openGroup(convId);
      } else {
        openDM(convId);
      }
    });
  });

  // Favorite toggle handlers
  conversationsList.querySelectorAll('.fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.fav;
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      localStorage.setItem('favorites', JSON.stringify([...favorites]));
      renderConversations();
    });
  });

  updateNotificationsBadge();
}

// ===== LIST FILTER TABS =====
document.querySelectorAll('.list-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.list-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    renderConversations();
  });
});

// Mark all as read button
document.getElementById('markAllReadBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (window.markAllRead) window.markAllRead();
});

// ===== OPEN DM =====
async function openDM(userId) {
  exitSelectionMode();
  const fbDash = document.getElementById('feedbackDashboard');
  if (fbDash && fbDash.parentNode) fbDash.parentNode.removeChild(fbDash);
  document.getElementById('feedbackBtn')?.classList.remove('active');

  const enteringFromList = !activeChat;

  const existingConv = conversations.find(c => String(c.id) === String(userId));
  if (existingConv) existingConv.unread = 0;
  updateNotificationsBadge();

  const cachedName = existingConv ? existingConv.name : (userNameCache[userId] || 'Chat');
  const cachedAvatar = existingConv ? existingConv.avatar : null;

  activeChat = {
    type: 'dm',
    id: userId,
    name: cachedName,
    avatar: cachedAvatar,
    online: false,
    lastSeen: null
  };

  // 1. INSTANT UI TRANSITION (0ms delay)
  renderActiveChat();
  renderConversations();
  chatMessages.innerHTML = '<div class="conv-empty" style="opacity:0.6;">Loading messages...</div>';
  showUserPanelSkeleton(); // instant feedback: shimmer while the chat info loads
  if (enteringFromList) Nav.push('chat', closeChatView);

  try {
    // 2. Fetch user profile + messages concurrently in parallel
    const [userRes, msgsRes] = await Promise.all([
      fetch(api(`/api/users/${userId}`)),
      fetch(api(`/api/messages?from=${currentUser.id}&to=${userId}`))
    ]);

    const data = await userRes.json();
    const msgsData = await msgsRes.json();
    const user = data.user;
    let messages = msgsData.messages || [];
    messages = filterClearedMessages(userId, messages);

    if (user) {
      activeChat.name = user.displayName || user.username;
      activeChat.avatar = user.avatar || null;
      activeChat.online = user.online;
      activeChat.lastSeen = user.lastSeen;
      userNameCache[user.id] = activeChat.name;
    }

    renderActiveChat();
    renderMessages(messages);
    scrollToBottom();
    markChatRead(messages);
    // Build the info panel off the switch critical path so the chat paints
    // first; skip if the user already moved to another chat.
    if (user) deferUserPanelRender('dm', user, messages);
  } catch (err) {
    console.error('Open DM error:', err);
    showToast('Failed to load chat', 'error');
    closeChatView();
  }
}

// ===== MARK READ =====
function markChatRead(messages) {
  if (activeChat) {
    const conv = conversations.find(c => String(c.id) === String(activeChat.id));
    if (conv) conv.unread = 0;
    updateNotificationsBadge();
    renderConversations();
  }

  // Per-user read state: only messages THIS user hasn't read yet are marked
  // read (their id not yet in readBy). The old global `m.read` flag was the
  // bug: once ANY member read a group message, everyone else skipped sending
  // mark_read — so late readers never appeared in receipts and never saw unread.
  const unreadMessages = (messages || []).filter(m =>
    m.from !== currentUser.id && !(m.readBy || []).includes(currentUser.id));
  const unreadIds = unreadMessages.map(m => m.id);
  
  if (unreadIds.length > 0 && socket) {
    socket.emit('mark_read', { messageIds: unreadIds, userId: currentUser.id });
    
    // Trigger animations for newly read messages
    unreadMessages.forEach(msg => {
      if (window.checkBirthdayMessage) window.checkBirthdayMessage(msg);
    });
  }

  // Clear "reacted to your message" unread for this conversation: the server
  // stamps readAt on all reactions targeting me here, so the chat-list preview
  // + unread count reset until the next reaction arrives.
  if (socket && activeChat && activeChat.id != null) {
    socket.emit('mark_reactions_read', { conversationId: String(activeChat.id) });
  }
}

// ===== OPTIMISTIC SIDEBAR SYNC =====
// Update the conversation list instantly when a message arrives, instead of
// waiting for the debounced REST refetch (debounceLoad) to round-trip. The
// server refetch still runs afterwards to reconcile authoritative state.
let lastSyncedMsgId = null;
let optimisticRenderTimer = null;
function updateConversationFromMessage(msg) {
  if (!msg || !msg.id || msg.id === lastSyncedMsgId) return;
  lastSyncedMsgId = msg.id;
  if (!conversations) return;

  const isGroup = !!msg.groupId;
  let convId = isGroup ? msg.groupId : msg.from;
  let conv = conversations.find(c => String(c.id) === String(convId));
  // Self-sent DMs: the conversation is keyed by the recipient, not the sender.
  if (!conv && !isGroup && msg.to && String(msg.from) === String(currentUser.id)) {
    conv = conversations.find(c => String(c.id) === String(msg.to));
  }
  if (!conv) return;

  const isActive = activeChat && String(activeChat.id) === String(conv.id);
  const preview = msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'voice' ? '🎤 Voice' : msg.type === 'location' ? '📍 Location' : msg.type === 'p2p' ? '📎 File' : 'New message');
  conv.lastMessage = preview;
  conv.lastMessageTime = msg.timestamp || conv.lastMessageTime || 0;
  // Match the server: unread is counted for ALL incoming messages regardless
  // of mute (mute only suppresses sound/push in the socket handlers — the
  // server's dmUnread/groupUnread computation has no mute exclusion).
  if (!isActive && String(msg.from) !== String(currentUser.id)) {
    conv.unread = (conv.unread || 0) + 1;
  }

  // Newest activity first (matches the server's lastMessageTime sort)
  const idx = conversations.indexOf(conv);
  if (idx > 0) {
    conversations.splice(idx, 1);
    conversations.unshift(conv);
  }
  // The data mutation above is cheap; coalesce the DOM rebuild so a burst of
  // messages re-renders the sidebar once instead of N+1 times.
  if (optimisticRenderTimer) clearTimeout(optimisticRenderTimer);
  optimisticRenderTimer = setTimeout(() => {
    optimisticRenderTimer = null;
    renderConversations();
    updateNotificationsBadge();
  }, 100);
}

// ===== OPEN GROUP =====
async function openGroup(groupId) {
  exitSelectionMode();
  const fbDash = document.getElementById('feedbackDashboard');
  if (fbDash && fbDash.parentNode) fbDash.parentNode.removeChild(fbDash);
  document.getElementById('feedbackBtn')?.classList.remove('active');

  const enteringFromList = !activeChat;
  const conv = conversations.find(c => String(c.id) === String(groupId));
  if (!conv) return;

  conv.unread = 0;
  updateNotificationsBadge();

  activeChat = {
    type: 'group',
    id: groupId,
    name: conv.name,
    avatar: conv.avatar || null,
    members: conv.members || [],
    admins: conv.admins || [],
    createdBy: conv.createdBy,
    countdown: conv.countdown || null
  };

  // 1. INSTANT UI TRANSITION (0ms delay)
  renderActiveChat();
  renderConversations();
  chatMessages.innerHTML = '<div class="conv-empty" style="opacity:0.6;">Loading messages...</div>';
  showUserPanelSkeleton(); // instant feedback: shimmer while the chat info loads
  if (enteringFromList) Nav.push('chat', closeChatView);

  try {
    // 2. Fetch group messages
    const msgsRes = await fetch(api(`/api/messages?groupId=${groupId}`));
    const msgsData = await msgsRes.json();
    let messages = msgsData.messages || [];
    messages = filterClearedMessages(groupId, messages);

    renderActiveChat();
    renderMessages(messages);
    scrollToBottom();
    markChatRead(messages);
    // Build the info panel off the switch critical path (see openDM).
    deferUserPanelRender('group', conv, messages);

    // 3. Background prefetch missing member display names asynchronously. Only
    // re-render if any name was actually fetched — otherwise this is a wasted
    // full rebuild of the entire chat on every group open.
    const memberIds = [...new Set([...messages.map(m => m.from), ...(conv.members || [])])];
    prefetchNames(memberIds).then((fetchedCount) => {
      if (fetchedCount > 0 && activeChat && String(activeChat.id) === String(groupId)) {
        renderMessages(messages);
      }
    }).catch(() => {});

    // Reader (readBy) names were never prefetched — without this, reopening a
    // group full of read messages shows '…' in the receipt avatars and the Seen
    // By card until a live read event happens. Fetch them, refresh in place.
    prefetchReceiptReaderNames(messages).catch(() => {});

  } catch (err) {
    console.error('Open group error:', err);
    // Escape hatch: never leave the shimmer skeleton stuck if the fetch fails.
    resetUserPanel();
  }
}

// ===== ANDROID NOTIFICATION TAP DEEP LINK =====
// Tapping a message or reaction notification opens the SPECIFIC conversation.
// MainActivity pushes (openChatType, openChatId) two ways: warm start via
// window.handleChatDeepLink(type, id) (instant evaluateJavascript), and cold
// start via one-shot prefs consumed through AndroidNativeConfig.
//
// One-shot semantics mirror the feedback-thread deep link: the handler clears
// the pending prefs ONLY when it actually opens the chat, so a warm-start push
// can't be re-opened by the visibilitychange fallback (double render/Nav.push),
// and a cold start whose conversation list is still loading doesn't lose the
// link — it retries briefly instead.
function openChatDeepLink(type, id) {
  if (!type || !id) return;
  try {
    if (type === 'group') {
      const conv = conversations.find(c => String(c.id) === String(id));
      if (conv) {
        openGroup(id);
        clearPendingChatPrefs();
      } else {
        // Cold start: loadConversations() is fire-and-forget, so the group may
        // not be in the list yet. Retry briefly instead of dropping the link.
        retryChatDeepLink(type, id, 0);
      }
    } else if (type === 'dm') {
      openDM(id);
      clearPendingChatPrefs();
    }
  } catch (e) {
    console.warn('Chat deep link open failed:', e);
  }
}

// Retry opening a group chat until it appears in the loaded conversation list
// (up to ~5s), then clear the one-shot prefs so the fallback can't re-open it.
function retryChatDeepLink(type, id, attempt) {
  if (attempt >= 10) return; // give up quietly after 10 tries
  setTimeout(function() {
    const conv = conversations.find(c => String(c.id) === String(id));
    if (conv) {
      openGroup(id);
      clearPendingChatPrefs();
    } else {
      retryChatDeepLink(type, id, attempt + 1);
    }
  }, 500);
}

// Clear the native one-shot chat deep link prefs (idempotent — no-op when the
// interface or values are absent). Called only after the chat actually opened.
function clearPendingChatPrefs() {
  try {
    if (typeof AndroidNativeConfig !== 'undefined' && AndroidNativeConfig) {
      if (typeof AndroidNativeConfig.takePendingChatType === 'function') AndroidNativeConfig.takePendingChatType();
      if (typeof AndroidNativeConfig.takePendingChatId === 'function') AndroidNativeConfig.takePendingChatId();
    }
  } catch (e) { /* best-effort */ }
}
window.handleChatDeepLink = openChatDeepLink;

// Cold-start / resume fallback: read the one-shot prefs the native side
// stashed for a chat notification tap. Debounced on resume like the
// feedback-thread deep link.
function consumePendingChatDeepLink() {
  if (!window.currentUser || !window.socket) return;
  if (typeof AndroidNativeConfig === 'undefined' || !AndroidNativeConfig
      || typeof AndroidNativeConfig.takePendingChatType !== 'function') return;
  try {
    const type = AndroidNativeConfig.takePendingChatType();
    const id = typeof AndroidNativeConfig.takePendingChatId === 'function'
      ? AndroidNativeConfig.takePendingChatId()
      : null;
    openChatDeepLink(type, id);
  } catch (e) {
    console.warn('Pending chat deep link failed:', e);
  }
}

var resumeChatDeepLinkPending = false;
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible' || resumeChatDeepLinkPending) return;
  resumeChatDeepLinkPending = true;
  setTimeout(function() {
    resumeChatDeepLinkPending = false;
    consumePendingChatDeepLink();
  }, 300);
});

// ===== RIGHT USER-INFO PANEL (Bento) =====
function renderUserPanel(kind, info, messages) {
  userPanelEmpty.style.display = 'none';
  userPanelContent.style.display = 'flex';
  const groupIsAdmin = kind === 'group' && info.admins && info.admins.includes(currentUser.id);

  // Collect shared media + links from loaded messages. Only scan the most
  // recent messages — running the link regex over an entire long history is
  // what made the info panel slow to open — and dedupe repeated links.
  const PANEL_SCAN_LIMIT = 200;
  const recentMsgs = messages.slice(-PANEL_SCAN_LIMIT);
  const media = recentMsgs.filter(m => m.mediaUrl && !m.deleted && (m.type === 'image' || /\.(jpg|jpeg|png|gif|webp|bmp|heic)(\?.*)?$/i.test(m.mediaUrl)));
  const links = [];
  const seenLinks = new Set();
  recentMsgs.forEach(m => {
    if (m.deleted) return;
    if (m.type === 'location' && m.mediaUrl) {
      if (!seenLinks.has(m.mediaUrl)) {
        seenLinks.add(m.mediaUrl);
        links.push({ url: m.mediaUrl, label: '📍 Location', icon: 'map' });
      }
    } else if (m.text) {
      const extracted = extractLinksFromText(m.text);
      extracted.forEach(l => {
        if (!seenLinks.has(l.url)) {
          seenLinks.add(l.url);
          links.push(l);
        }
      });
    }
  });

  let html = '';

  if (kind === 'dm') {
    const name = info.displayName || info.username;
    const online = info.online;
    const statusText = online ? 'Online' : (info.lastSeen ? 'last seen ' + formatLastSeen(info.lastSeen) : 'Offline');
    const isBlocked = blockedUsers.has(info.id);
    const isSelf = info.id === currentUser.id;
      html += `
      <div class="up-profile">
        <div class="up-avatar">${avatarHtml(info.avatar, name)}</div>
        <h3>${escapeHtml(name)}</h3>
        <div class="up-username">@${escapeHtml(info.username || '')}</div>
        <div class="up-status ${online ? 'online' : ''}">${escapeHtml(statusText)}</div>
        ${!isSelf ? `
        <button class="up-block-dd" data-target="${info.id}">
          <span class="dropdown-icon">${isBlocked ? icon('check-circle', 16) : icon('block', 16)}</span>
          <span>${isBlocked ? 'Unblock User' : 'Block User'}</span>
        </button>
        <button class="up-mute-btn" data-target="${info.id}">
          <span class="dropdown-icon">${isMuted(info.id) ? icon('volume-1', 16) : icon('volume-x', 16)}</span>
          <span>${isMuted(info.id) ? 'Unmute' : 'Mute'}</span>
        </button>
        <button class="up-clear-btn" data-target="${info.id}">
          <span class="dropdown-icon">${icon('trash', 16)}</span>
          <span>Clear Chat</span>
        </button>` : ''}
      </div>`;
  } else {
    html += `
      <div class="up-profile">
        <div class="up-avatar${groupIsAdmin ? ' up-avatar-editable' : ''}" data-group-id="${info.id}">${avatarHtml(info.avatar, info.name)}</div>
        <h3${groupIsAdmin ? ' class="up-group-name" style="cursor:pointer;"' : ''} data-group-id="${info.id}">${escapeHtml(info.name)}</h3>
        <div class="up-username">${(info.members ? info.members.length : 0)} members</div>
        <button class="up-mute-btn" data-target="${info.id}">
          <span class="dropdown-icon">${isMuted(info.id) ? icon('volume-1', 16) : icon('volume-x', 16)}</span>
          <span>${isMuted(info.id) ? 'Unmute' : 'Mute'}</span>
        </button>
        <button class="up-clear-btn" data-target="${info.id}">
          <span class="dropdown-icon">${icon('trash', 16)}</span>
          <span>Clear Chat</span>
        </button>
      </div>`;
  }

  const isMyProfile = info.id === currentUser.id;

  // About (bio) card for DM / My Profile
  if (kind === 'dm' || isMyProfile) {
    const userBio = info.bio || userSettings.statusBio || '';
    html += `<div class="up-card profile-bio-card"><h4>About</h4><p style="font-size:0.88rem;line-height:1.5;color:var(--text-secondary);">${escapeHtml(userBio) || '<span style="color:var(--text-muted);font-style:italic;">No bio</span>'}</p></div>`;
  }

  // Friend Compatibility (DM only, not self) — the server computes the score
  // from the real DM history; this card fetches it async so the panel never
  // blocks on the request. Re-fetches on every panel render, but cheap.
  if (kind === 'dm' && !isMyProfile) {
    html += `<div class="up-card compat-card">
      <h4>✨ Friend Compatibility</h4>
      <div class="up-compat-body" id="upCompatBody">
        <div class="compat-loading"><span class="shimmer compat-shimmer"></span></div>
      </div>
    </div>`;
  }

  // Shared media - hidden for my profile
  if (!isMyProfile) {
    html += `<div class="up-card"><h4>Shared Media</h4>`;
    if (media.length > 0) {
      // Cap the grid — rendering hundreds of <img> nodes + lightbox listeners
      // per chat open is the other big chunk of the switch latency. Show the
      // most recent MAX_PANEL_MEDIA; older ones are still in the chat itself.
      const MAX_PANEL_MEDIA = 12;
      const shownMedia = media.slice(-MAX_PANEL_MEDIA).reverse();
      const hiddenMediaCount = media.length - shownMedia.length;
      const isScrollable = media.length > 6;
      html += `<div class="up-media-grid${isScrollable ? ' scrollable' : ''}">${shownMedia.map(m => {
        const src = safeUrl(absUrl(m.mediaUrl), true);
        return src ? `<img src="${attrEsc(src)}" data-full="${attrEsc(src)}" alt="media" loading="lazy" decoding="async">` : '';
      }).join('')}</div>`;
      if (hiddenMediaCount > 0) {
        html += `<div class="up-more-note">+${hiddenMediaCount} more in chat</div>`;
      }
    } else {
      html += `<div class="up-empty-note">No media shared yet</div>`;
    }
    html += `</div>`;
  }

  // Group members
  if (kind === 'group' && info.members && info.members.length) {
    html += `<div class="up-card"><h4>Members (${info.members.length})</h4>`;
    html += info.members.map(id => {
      const nm = id === currentUser.id ? 'You' : getUserName(id);
      const isMemberAdmin = info.admins && info.admins.includes(id);
      const isGlobalAdmin = info.memberAdmins && info.memberAdmins.includes(id);
      const canRemove = groupIsAdmin && id !== currentUser.id && id !== info.createdBy;
      return `<div class="up-member">
        <div class="conv-avatar">${getInitials(nm)}</div>
        <span>${escapeHtml(nm)}${isGlobalAdmin ? `<span class="admin-badge" title="${ADMIN_BADGE_TITLE}">${icon('crown', 12)}</span>` : ''}${isMemberAdmin ? `<span class="admin-badge group-admin" title="Group admin">${icon('crown', 12)}</span>` : ''}</span>
        ${canRemove ? `<button class="remove-member-btn" data-group-id="${info.id}" data-user-id="${id}">✕</button>` : ''}
      </div>`;
    }).join('');
    if (groupIsAdmin) {
      html += `<button class="up-add-members-btn" data-group-id="${info.id}">${icon('plus', 14)} Add Members</button>`;
      html += `<button class="up-delete-group-btn" data-group-id="${info.id}">${icon('trash', 14)} Delete Group</button>`;
    } else {
      html += `<button class="up-leave-group-btn" data-group-id="${info.id}">Leave Group</button>`;
    }
    html += `</div>`;
  }

  // Shared links - hidden for my profile
  if (!isMyProfile) {
    html += `<div class="up-card profile-links-card"><h4>Links & Locations</h4>`;
    if (links.length > 0) {
      html += `<div class="up-links-list">${links.slice(-8).reverse().map(l =>
        `<a class="up-link" href="${l.url}" target="_blank" rel="noopener"><span class="up-link-ic">${l.icon === 'map' ? icon('map-pin', 14) : icon('link', 14)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.label)}</span></a>`
      ).join('')}</div>`;
    } else {
      html += `<div class="up-empty-note">No links shared yet</div>`;
    }
    html += `</div>`;
  }

  userPanelContent.innerHTML = html;

  // Friend Compatibility meter (DM only, not self) — loads async so the
  // panel's own listeners below are never blocked.
  if (kind === 'dm' && !isMyProfile && info.id) {
    loadFriendCompatibility(info.id);
  }

  // Open media full-size in lightbox
  userPanelContent.querySelectorAll('.up-media-grid img').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.dataset.full));
  });

  // Block/unblock button
  const blockBtn = userPanelContent.querySelector('.up-block-dd');
  if (blockBtn) {
    blockBtn.addEventListener('click', async () => {
      const targetId = blockBtn.dataset.target;
      const action = blockedUsers.has(targetId) ? 'unblock' : 'block';
      await handleBlockUser(targetId, action);
      renderUserPanel(kind, info, messages);
    });
  }
  // Mute/unmute button
  const muteBtn = userPanelContent.querySelector('.up-mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', async () => {
      const targetId = muteBtn.dataset.target;
      const action = isMuted(targetId) ? 'unmute' : 'mute';
      await handleMuteConversation(targetId, action);
      renderUserPanel(kind, info, messages);
    });
  }

  // Clear chat button (desktop user panel)
  const clearPanelBtn = userPanelContent.querySelector('.up-clear-btn');
  if (clearPanelBtn) {
    clearPanelBtn.addEventListener('click', async () => {
      if (!activeChat) return;
      const targetId = activeChat.id;
      const isGroup = activeChat.type === 'group';
      markChatCleared(targetId);

      if (chatMessages) chatMessages.innerHTML = '';
      const conv = conversations.find(c => String(c.id) === String(targetId));
      if (conv) {
        conv.lastMessage = '';
        renderConversations();
      }

      if (socket) {
        socket.emit('clear_chat', { targetId, isGroup });
      }
      try {
        const res = await fetch(api('/api/messages/clear'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId, isGroup })
        });
        // Adopt the server's authoritative clear time (device clocks may differ).
        if (res.ok) {
          const d = await res.json().catch(() => null);
          if (d && d.clearedAt) {
            clearedChats[String(targetId)] = d.clearedAt;
            localStorage.setItem('cleared_chats', JSON.stringify(clearedChats));
          }
        }
      } catch (err) {}
      showToast('Chat cleared', 'info');
      renderUserPanel(kind, info, []);
    });
  }

  // Add members button (group)
  const addMemBtn = userPanelContent.querySelector('.up-add-members-btn');
  if (addMemBtn) {
    addMemBtn.addEventListener('click', () => showAddMemberModal(addMemBtn.dataset.groupId));
  }

  // Leave group button
  const leaveBtn = userPanelContent.querySelector('.up-leave-group-btn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => leaveGroup(leaveBtn.dataset.groupId));
  }

  // Remove member buttons (group)
  userPanelContent.querySelectorAll('.remove-member-btn').forEach(btn => {
    btn.addEventListener('click', () => removeGroupMember(btn.dataset.groupId, btn.dataset.userId));
  });

  // Delete group button (admin, desktop)
  const delGroupBtn = userPanelContent.querySelector('.up-delete-group-btn');
  if (delGroupBtn) {
    delGroupBtn.addEventListener('click', () => {
      if (confirm('Delete this group for everyone? This cannot be undone.')) {
        deleteGroup(delGroupBtn.dataset.groupId);
      }
    });
  }

  // Edit group name (admin, desktop)
  const groupNameEl = userPanelContent.querySelector('.up-group-name');
  if (groupNameEl) {
    groupNameEl.addEventListener('click', async () => {
      const gid = groupNameEl.dataset.groupId;
      const newName = prompt('Enter new group name:', activeChat ? activeChat.name : '');
      if (newName && newName.trim()) {
        await updateGroupInfo(gid, { name: newName.trim() });
      }
    });
  }

  // Upload group DP (admin, desktop)
  const avatarEditable = userPanelContent.querySelector('.up-avatar-editable');
  if (avatarEditable) {
    avatarEditable.addEventListener('click', () => {
      const gid = avatarEditable.dataset.groupId;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = async () => {
        const file = input.files[0];
        document.body.removeChild(input);
        if (!file) return;
        try {
          const data = await uploadFile(file);
          if (data.success) {
            await updateGroupInfo(gid, { avatar: data.url });
          }
        } catch (err) {
          showToast('Failed to upload', 'error');
        }
      };
      input.click();
    });
  }
}

// Build the user info panel on the next frame instead of synchronously inside
// the chat-switch critical path, so messages paint first. Skips the build if
// the user has already switched to a different chat (avoids a stale panel).
function deferUserPanelRender(kind, info, messages) {
  const chatId = activeChat ? activeChat.id : null;
  const chatType = activeChat ? activeChat.type : null;
  requestAnimationFrame(() => {
    if (!activeChat || activeChat.id !== chatId || activeChat.type !== chatType) return;
    renderUserPanel(kind, info, messages);
  });
}

// ===== FRIEND COMPATIBILITY METER =====
// Renders a fun "how compatible are you two" card in the DM info panel using
// the server-computed /api/compatibility/:userId score, plus a shareable card
// modal (copy summary / native share).
let compatShareData = null;
// Cache of the last compat result so the mobile chat-info modal (which clones
// the panel's HTML and loses async content + listeners) can re-render the card
// instantly instead of re-fetching or showing a stuck shimmer.
let lastCompatPartnerId = null;
let lastCompatData = null;
// Unique gradient id counter. The ring SVG references its gradient via
// url(#id), but the Chat Info modal clones the panel's innerHTML — so a fixed
// id like "compatGrad" ends up duplicated in the DOM. On Android WebView the
// stroke then resolves to the hidden panel copy and the ring renders invisible
// (score floats with no circle). Each render gets its own id so the gradient
// always resolves to a visible, self-contained def.
let compatGradSeq = 0;

async function loadFriendCompatibility(partnerId, targetEl) {
  const chatAtRequest = activeChat && activeChat.type === 'dm' ? String(activeChat.id) : null;
  try {
    const res = await fetch(api(`/api/compatibility/${partnerId}`));
    const data = await res.json();
    // Stale guard: the user may have switched chats while the fetch was in
    // flight — never paint another chat's score into this panel.
    if (chatAtRequest !== String(activeChat?.id)) return;
    const el = targetEl || document.getElementById('upCompatBody');
    if (!el) return;
    lastCompatPartnerId = String(partnerId);
    lastCompatData = data;
    renderCompatCard(el, data);
  } catch (e) {
    const el = targetEl || document.getElementById('upCompatBody');
    if (el) el.innerHTML = '<div class="compat-error">Couldn\'t load compatibility.</div>';
  }
}

function renderCompatCard(el, d) {
  if (!d || typeof d.score !== 'number') {
    el.innerHTML = '<div class="compat-error">Couldn\'t load compatibility.</div>';
    return;
  }
  // No chat history yet — show a friendly "say hi" state instead of a fake
  // 50/100 ring (the server returns hasData:false for empty threads).
  if (d.hasData === false) {
    const theirName = escapeHtml(d.theirName || 'Friend');
    el.innerHTML = `<div class="compat-empty">
      <div class="compat-empty-emoji">👋</div>
      <div class="compat-empty-title">No messages yet</div>
      <div class="compat-empty-sub">Say hi to ${theirName} — your compatibility score unlocks after a few messages.</div>
    </div>`;
    return;
  }
  const score = Math.max(0, Math.min(100, Math.round(d.score)));
  const R = 34, C = 2 * Math.PI * R;
  const offset = C * (1 - score / 100);
  const shared = (d.sharedEmojis || []).map(escapeHtml).join(' ');
  const yourName = escapeHtml((currentUser && (currentUser.displayName || currentUser.username)) || 'You');
  const theirName = escapeHtml(d.theirName || 'Friend');
  const youShare = Math.max(4, Math.min(96, d.youSharePct != null ? d.youSharePct : 50));
  // Unique per-render gradient id: the ring must never share an id with the
  // panel's card (the mobile modal clones it), or WebView paints no stroke.
  const gradId = 'compatGrad' + (++compatGradSeq);
  el.innerHTML = `
    <div class="compat-hero">
      <svg class="compat-ring" viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">
        <defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#b8a4f8"/><stop offset="100%" stop-color="#7c5cfc"/>
        </linearGradient></defs>
        <circle cx="40" cy="40" r="${R}" class="compat-ring-bg"/>
        <circle cx="40" cy="40" r="${R}" class="compat-ring-fg" stroke="url(#${gradId}) #7c5cfc" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
      </svg>
      <div class="compat-score">${score}<small>/100</small></div>
      <div class="compat-verdict">${escapeHtml(d.verdict)} ${escapeHtml(d.emoji || '')}</div>
    </div>
    <div class="compat-bar">
      <div class="compat-bar-label"><span>You · ${d.youCount || 0}</span><span>${d.themCount || 0} · ${theirName}</span></div>
      <div class="compat-bar-track"><div class="compat-bar-fill" style="width:${youShare}%"></div></div>
    </div>
    <div class="compat-facts">
      ${d.emojiOverlapPct != null ? `<div class="compat-fact">🎭 ${d.emojiOverlapPct}% same emojis${shared ? ` · <b>${shared}</b>` : ''}</div>` : ''}
      <div class="compat-fact">⚡ ${escapeHtml(d.replyLine || '')}</div>
      <div class="compat-fact">📅 ${d.friendshipDays} day${d.friendshipDays === 1 ? '' : 's'} together · ${d.activeDays || 0} active day${d.activeDays === 1 ? '' : 's'}</div>
    </div>
    <button class="compat-share-btn" data-compat-share="1">📤 Share card</button>`;
  const shareBtn = el.querySelector('[data-compat-share]');
  if (shareBtn) shareBtn.addEventListener('click', () => {
    openCompatShareModal(d, yourName, theirName);
    // Android native + Android web: the Chat Info modal sits underneath the
    // share card. Closing it after tapping "Share card" keeps the share card
    // as the single surface on screen (desktop web keeps the panel open).
    if (IS_ANDROID_DEVICE && typeof closeChatInfoModal === 'function') {
      closeChatInfoModal();
    }
  });
}

function openCompatShareModal(d, yourName, theirName) {
  compatShareData = d;
  const inner = document.getElementById('compatShareInner');
  if (!inner) return;
  const score = Math.max(0, Math.min(100, Math.round(d.score)));
  const R = 40, C = 2 * Math.PI * R;
  const offset = C * (1 - score / 100);
  const shared = (d.sharedEmojis || []).map(escapeHtml).join(' ');
  inner.innerHTML = `
    <div class="compat-share-card">
      <div class="compat-share-head">
        <div class="compat-share-ava">${escapeHtml((yourName || 'Y').trim().charAt(0).toUpperCase() || 'Y')}</div>
        <div class="compat-share-heart">💞</div>
        <div class="compat-share-ava">${escapeHtml((theirName || 'F').trim().charAt(0).toUpperCase() || 'F')}</div>
      </div>
      <div class="compat-share-names"><span>${yourName}</span><span>${theirName}</span></div>
      <div class="compat-share-ringwrap">
        <svg class="compat-share-ring" viewBox="0 0 96 96" width="96" height="96" aria-hidden="true">
          <defs><linearGradient id="compatGradBig" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#b8a4f8"/><stop offset="100%" stop-color="#7c5cfc"/>
          </linearGradient></defs>
          <circle cx="48" cy="48" r="${R}" class="compat-ring-bg"/>
          <circle cx="48" cy="48" r="${R}" class="compat-ring-fg" stroke="url(#compatGradBig)" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
        </svg>
        <div class="compat-share-score">${score}<small>/100</small></div>
      </div>
      <div class="compat-share-verdict">${escapeHtml(d.verdict)} ${escapeHtml(d.emoji || '')}</div>
      <div class="compat-share-stats">
        <span>💬 ${d.youCount || 0}·${d.themCount || 0}</span>
        <span>🎭 ${d.emojiOverlapPct || 0}%</span>
        <span>📅 ${d.friendshipDays || 0}d</span>
      </div>
      ${shared ? `<div class="compat-share-emojis">${shared}</div>` : ''}
      <div class="compat-share-foot">Computed by HiFi Messenger</div>
    </div>`;
  const modal = document.getElementById('compatModal');
  if (modal) {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }
  const nativeShareBtn = document.getElementById('compatNativeShareBtn');
  if (nativeShareBtn) nativeShareBtn.style.display = (navigator.share && typeof navigator.share === 'function') ? '' : 'none';
}

function closeCompatModal() {
  const modal = document.getElementById('compatModal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

async function copyCompatSummary() {
  if (!compatShareData || !compatShareData.shareText) {
    showToast('Nothing to copy yet', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(compatShareData.shareText);
    showToast('Compatibility summary copied!', 'success');
  } catch (e) {
    showToast('Could not copy', 'error');
  }
}

async function nativeCompatShare() {
  if (!compatShareData || !compatShareData.shareText) return;
  if (navigator.share && typeof navigator.share === 'function') {
    try { await navigator.share({ text: compatShareData.shareText }); } catch (e) { /* cancelled */ }
  } else {
    copyCompatSummary();
  }
}

document.getElementById('closeCompatModal')?.addEventListener('click', closeCompatModal);
document.getElementById('compatCopyBtn')?.addEventListener('click', copyCompatSummary);
document.getElementById('compatNativeShareBtn')?.addEventListener('click', nativeCompatShare);

// Instantly return the info panel to its empty state when a chat switch
// starts. Without this, the panel keeps showing the PREVIOUS chat's info for
// the whole loading window (measured ~1-1.3s in the user's screen recording).
function resetUserPanel() {
  if (userPanelEmpty) userPanelEmpty.style.display = '';
  if (userPanelContent) userPanelContent.style.display = 'none';
}

// Show an animated shimmer skeleton in the info panel while a chat switch is
// in flight — instant feedback + perceived progress instead of a blank panel
// (which read as lag in the screen recording). renderUserPanel() replaces the
// skeleton when the data lands, so this is purely a loading placeholder.
function showUserPanelSkeleton() {
  if (userPanelEmpty) userPanelEmpty.style.display = 'none';
  if (!userPanelContent) return;
  userPanelContent.style.display = 'flex';
  userPanelContent.innerHTML = `
    <div class="up-skeleton" aria-hidden="true">
      <div class="up-skeleton-avatar shimmer"></div>
      <div class="up-skeleton-name shimmer"></div>
      <div class="up-skeleton-line shimmer"></div>
      <div class="up-skeleton-card shimmer"></div>
      <div class="up-skeleton-card shimmer"></div>
    </div>`;
}

async function updateGroupInfo(groupId, updates) {
  try {
    const res = await fetch(api(`/api/groups/${groupId}/update`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...updates, requestedBy: currentUser.id })
    });
    const result = await res.json();
    if (result.success) {
      showToast('Group updated', 'success');
      if (activeChat && activeChat.id === groupId) {
        if (updates.name) activeChat.name = updates.name;
        if (updates.avatar !== undefined) activeChat.avatar = updates.avatar;
        renderActiveChat();
      }
      loadConversations();
    } else {
      showToast(result.error || 'Failed to update group', 'error');
    }
  } catch (err) {
    showToast('Failed to update group', 'error');
  }
}

// ===== RENDER ACTIVE CHAT =====
function renderActiveChat() {
  window.activeChat = activeChat;
  applyActiveChatWallpaper();
  if (!activeChat) {
    if (activeChatDiv) activeChatDiv.style.display = 'none';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';
  if (document.getElementById('feedbackDashboard')) {
    activeChatDiv.style.display = 'none';
  } else {
    activeChatDiv.style.display = 'flex';
  }

  // On mobile, slide the chat view in over the list
  chatApp.classList.add('chat-open');

  chatHeader.innerHTML = `
    <button class="back-btn" id="backBtn" title="Back">‹</button>
    <div class="conv-avatar">${avatarHtml(activeChat.avatar, activeChat.name)}</div>
    <div class="chat-header-info">
      <h3>${escapeHtml(activeChat.name)}</h3>
      <p></p>
    </div>
    <div class="chat-header-actions" style="display:flex;align-items:center;gap:4px;margin-left:auto;">
      <button class="nav-icon-btn" id="chatSearchBtn" title="Search Messages">${icon('search', 18)}</button>
      <button class="nav-icon-btn" id="chatWallpaperBtn" title="Chat Background" style="font-size:16px;">🖼️</button>
      ${(activeChat.type === 'group' && activeChat.admins && activeChat.admins.includes(currentUser.id)) ? '<button class="nav-icon-btn" id="chatCountdownBtn" title="Set Countdown" style="font-size:16px;">⏳</button>' : ''}
      <button class="chat-options-btn" id="chatOptionsBtn" title="Options">⋮</button>
    </div>
  `;
  updateChatHeaderStatus();

  // Back button returns to the conversation list on mobile
  const backBtn = document.getElementById('backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => Nav.back());
  }

  // Search messages button
  const chatSearchBtn = document.getElementById('chatSearchBtn');
  if (chatSearchBtn) {
    chatSearchBtn.addEventListener('click', () => {
      openMessageSearchModal();
    });
  }

  // Chat wallpaper button
  const chatWallpaperBtn = document.getElementById('chatWallpaperBtn');
  if (chatWallpaperBtn) {
    chatWallpaperBtn.addEventListener('click', () => {
      openWallpaperModal();
    });
  }

  // Group countdown button (groups only) — opens the countdown modal directly,
  // prefilled with the current countdown so it doubles as Set / Edit.
  const chatCountdownBtn = document.getElementById('chatCountdownBtn');
  if (chatCountdownBtn) {
    chatCountdownBtn.addEventListener('click', () => {
      openCountdownModal();
    });
  }

  // Chat options (3-dot) dropdown
  const optBtn = document.getElementById('chatOptionsBtn');
  if (optBtn) {
    optBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = ensureChatDropdown();
      // Dynamically set block/unblock item
      let blockItem = dd.querySelector('[data-act="block"]');
      if (activeChat && activeChat.type === 'dm') {
        const isBlocked = blockedUsers.has(activeChat.id);
        if (!blockItem) {
          blockItem = document.createElement('button');
          blockItem.className = 'dropdown-item';
          blockItem.dataset.act = 'block';
          const sep = dd.querySelector('[data-act="clear"]');
          sep.insertAdjacentElement('afterend', blockItem);
          blockItem.addEventListener('click', () => {
            dd.classList.remove('show');
            const action = blockedUsers.has(activeChat.id) ? 'unblock' : 'block';
            handleBlockUser(activeChat.id, action);
          });
        }
        blockItem.innerHTML = `<span class="dropdown-icon">${isBlocked ? icon('check-circle', 16) : icon('block', 16)}</span><span>${isBlocked ? 'Unblock User' : 'Block User'}</span>`;
        blockItem.style.display = '';
      } else if (blockItem) {
        blockItem.style.display = 'none';
      }
      // Dynamically set mute/unmute item
      let muteItem = dd.querySelector('[data-act="mute"]');
      if (activeChat) {
        if (!muteItem) {
          muteItem = document.createElement('button');
          muteItem.className = 'dropdown-item';
          muteItem.dataset.act = 'mute';
          const ref = blockItem && blockItem.style.display !== 'none' ? blockItem : dd.querySelector('[data-act="clear"]');
          ref.insertAdjacentElement('afterend', muteItem);
          muteItem.addEventListener('click', () => {
            dd.classList.remove('show');
            const action = isMuted(activeChat.id) ? 'unmute' : 'mute';
            handleMuteConversation(activeChat.id, action);
          });
        }
        muteItem.innerHTML = `<span class="dropdown-icon">${isMuted(activeChat.id) ? icon('volume-1', 16) : icon('volume-x', 16)}</span><span>${isMuted(activeChat.id) ? 'Unmute' : 'Mute'}</span>`;
        muteItem.style.display = '';
      } else if (muteItem) {
        muteItem.style.display = 'none';
      }
      // Set / remove group countdown (group admins only)
      let cdItem = dd.querySelector('[data-act="countdown"]');
      if (activeChat && activeChat.type === 'group' && activeChat.admins && activeChat.admins.includes(currentUser.id)) {
        if (!cdItem) {
          cdItem = document.createElement('button');
          cdItem.className = 'dropdown-item';
          cdItem.dataset.act = 'countdown';
          const ref = (muteItem && muteItem.style.display !== 'none') ? muteItem : (blockItem && blockItem.style.display !== 'none' ? blockItem : dd.querySelector('[data-act="clear"]'));
          ref.insertAdjacentElement('afterend', cdItem);
          cdItem.addEventListener('click', () => {
            dd.classList.remove('show');
            if (activeChat && activeChat.countdown) removeCountdown(activeChat.id);
            else openCountdownModal();
          });
        }
        const hasCd = !!(activeChat.countdown && activeChat.countdown.target);
        cdItem.innerHTML = `<span class="dropdown-icon">⏳</span><span>${hasCd ? 'Remove Countdown' : 'Set Countdown'}</span>`;
        cdItem.style.display = '';
      } else if (cdItem) {
        cdItem.style.display = 'none';
      }
      // Show/hide Delete Group button for group admins
      const delGroupBtn = dd.querySelector('[data-act="deletegroup"]');
      if (delGroupBtn) {
        delGroupBtn.style.display = (activeChat && activeChat.type === 'group' && activeChat.admins && activeChat.admins.includes(currentUser.id)) ? '' : 'none';
      }
      const willOpen = !dd.classList.contains('show');
      closeAllDropdowns();
      if (willOpen) {
        dd.classList.add('show');
        // Anchor the menu to the ⋮ button so it stays aligned in every layout
        // (desktop header, and the full-screen mobile chat where the top-nav is
        // hidden and the header sits at the very top). The fixed CSS offsets
        // drift when the header moves, so measure the button and place the menu
        // right under it — flipping above if it would overflow the viewport.
        const rect = optBtn.getBoundingClientRect();
        dd.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
        const ddH = dd.offsetHeight || 0;
        let top = rect.bottom + 6;
        if (top + ddH > window.innerHeight - 8) top = Math.max(8, rect.top - ddH - 6);
        top = Math.min(top, Math.max(8, window.innerHeight - ddH - 8));
        dd.style.top = top + 'px';
        if (window.Nav && !window.Nav.has('chatDropdown')) {
          window.Nav.push('chatDropdown', () => dd.classList.remove('show'));
        }
      }
    });
  }
  renderCountdownBanner();
}

// Close the active chat and return to the conversation list (used by Nav back)
function closeChatView() {
  chatApp.classList.remove('chat-open');
  activeChat = null;
  window.activeChat = null;
  stopCountdownTick();
  if (activeChatDiv) activeChatDiv.style.display = 'none';
  if (emptyState) emptyState.style.display = 'flex';
  resetUserPanel(); // returning to the list shouldn't keep the last chat's info
  renderConversations();
}

// Build the chat-options dropdown once and reuse it
function ensureChatDropdown() {
  let dd = document.getElementById('chatDropdown');
  if (!dd) {
    dd = document.createElement('div');
    dd.className = 'chat-dropdown';
    dd.id = 'chatDropdown';
    dd.innerHTML = `
      <button class="dropdown-item" data-act="info"><span class="dropdown-icon">${icon('info', 16)}</span><span>View Info</span></button>
      <button class="dropdown-item" data-act="search"><span class="dropdown-icon">${icon('search', 16)}</span><span>Search Messages</span></button>
      <button class="dropdown-item" data-act="wallpaper"><span class="dropdown-icon">🖼️</span><span>Chat Background</span></button>
      <button class="dropdown-item" data-act="clear"><span class="dropdown-icon">${icon('trash', 16)}</span><span>Clear Chat</span></button>
      <button class="dropdown-item" data-act="deletegroup" style="display:none;color:var(--danger);"><span class="dropdown-icon">${icon('block', 16)}</span><span>Delete Group</span></button>`;
    document.body.appendChild(dd);
    dd.querySelector('[data-act="info"]')?.addEventListener('click', () => { dd.classList.remove('show'); showChatInfoModal(); });
    dd.querySelector('[data-act="search"]')?.addEventListener('click', () => { dd.classList.remove('show'); openMessageSearchModal(); });
    dd.querySelector('[data-act="wallpaper"]')?.addEventListener('click', () => { dd.classList.remove('show'); openWallpaperModal(); });
    dd.querySelector('[data-act="clear"]').addEventListener('click', async () => {
      dd.classList.remove('show');
      if (!activeChat) return;
      const targetId = activeChat.id;
      const isGroup = activeChat.type === 'group';
      markChatCleared(targetId);

      if (chatMessages) chatMessages.innerHTML = '';
      const conv = conversations.find(c => String(c.id) === String(targetId));
      if (conv) {
        conv.lastMessage = '';
        renderConversations();
      }

      if (socket) {
        socket.emit('clear_chat', { targetId, isGroup });
      }
      try {
        const res = await fetch(api('/api/messages/clear'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId, isGroup })
        });
        // Adopt the server's authoritative clear time (device clocks may differ).
        if (res.ok) {
          const d = await res.json().catch(() => null);
          if (d && d.clearedAt) {
            clearedChats[String(targetId)] = d.clearedAt;
            localStorage.setItem('cleared_chats', JSON.stringify(clearedChats));
          }
        }
      } catch (err) {}
      showToast('Chat cleared', 'info');
    });
    dd.querySelector('[data-act="deletegroup"]').addEventListener('click', () => {
      dd.classList.remove('show');
      if (activeChat && confirm('Delete this group for everyone? This cannot be undone.')) {
        deleteGroup(activeChat.id);
      }
    });
  }
  return dd;
}

// ===== BLOCKED USERS =====
async function loadBlockedUsers() {
  try {
    const res = await fetch(api(`/api/users/${currentUser.id}/blocked`));
    const data = await res.json();
    blockedUsers = new Set((data.blockedUsers || []).map(u => u.id));
  } catch (e) {
    console.error('Failed to load blocked users:', e);
  }
}

async function handleBlockUser(targetUserId, action) {
  try {
    const res = await fetch(api(`/api/users/${currentUser.id}/block`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId, action })
    });
    const data = await res.json();
    if (data.success) {
      if (action === 'block') blockedUsers.add(targetUserId);
      else blockedUsers.delete(targetUserId);
      showToast(action === 'block' ? 'User blocked' : 'User unblocked', 'success');
      if (activeChat && activeChat.id === targetUserId) renderActiveChat();
      renderConversations();
    }
  } catch (e) {
    showToast('Failed to update block status', 'error');
  }
}

function syncMutedConversationsToNative() {
  if (window.AndroidNativeConfig && window.AndroidNativeConfig.setMutedChats) {
    try {
      const arr = Array.from(mutedConversations);
      window.AndroidNativeConfig.setMutedChats(JSON.stringify(arr));
    } catch (e) {}
  }
}

// ===== MUTE CONVERSATIONS =====
async function loadMutedConversations() {
  try {
    const res = await fetch(api(`/api/users/${currentUser.id}/muted`));
    const data = await res.json();
    mutedConversations = new Set((data.mutedConversations || []).map(id => String(id)));
    syncMutedConversationsToNative();
  } catch (e) {
    console.error('Failed to load muted conversations:', e);
  }
}

async function handleMuteConversation(conversationId, action) {
  try {
    const cid = String(conversationId);
    const res = await fetch(api(`/api/users/${currentUser.id}/mute`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: cid, action })
    });
    const data = await res.json();
    if (data.success) {
      if (action === 'mute') mutedConversations.add(cid);
      else mutedConversations.delete(cid);
      syncMutedConversationsToNative();
      showToast(action === 'mute' ? 'Conversation muted' : 'Conversation unmuted', 'success');
      if (activeChat && String(activeChat.id) === cid) renderActiveChat();
      renderConversations();
    }
  } catch (e) {
    showToast('Failed to update mute status', 'error');
  }
}

function isMuted(conversationId) {
  if (!conversationId) return false;
  return mutedConversations.has(String(conversationId));
}

// ===== LIGHTBOX =====
function downloadImageWeb(src, fileName) {
  if (!src) return;
  const name = fileName || `HiFi_Image_${Date.now()}.png`;

  if (src.startsWith('data:')) {
    try {
      const parts = src.split(',');
      const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
      const bstr = atob(parts[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      const blob = new Blob([u8arr], { type: mime });
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      return;
    } catch (err) {
      console.error('[Web Download] Base64 blob conversion failed:', err);
    }
  }

  const a = document.createElement('a');
  a.href = src;
  a.download = name;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function closeLightboxInternal() {
  document.getElementById('lightboxOverlay')?.classList.remove('show');
  const img = document.getElementById('lightboxImage');
  if (img) img.src = '';
}

function closeLightbox() {
  if (window.Nav && window.Nav.has('lightbox')) {
    window.Nav.back();
  } else {
    closeLightboxInternal();
  }
}

function openLightbox(src) {
  const img = document.getElementById('lightboxImage');
  img.src = src;
  document.getElementById('lightboxOverlay')?.classList.add('show');
  if (window.Nav && !window.Nav.has('lightbox')) {
    window.Nav.push('lightbox', closeLightboxInternal);
  }
}

document.getElementById('lightboxClose')?.addEventListener('click', closeLightbox);
document.getElementById('lightboxOverlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('lightboxOverlay').classList.contains('show')) {
    closeLightbox();
  }
  const sbModal = document.getElementById('seenByModal');
  if (e.key === 'Escape' && sbModal && sbModal.classList.contains('show')) {
    closeSeenByPopup();
  }
});

// Seen By popover close: ✕ button, or tapping anywhere outside the card.
const closeSeenByBtn = document.getElementById('closeSeenByModal');
if (closeSeenByBtn) closeSeenByBtn.addEventListener('click', (e) => { e.stopPropagation(); closeSeenByPopup(); });
document.addEventListener('click', (e) => {
  const pop = document.getElementById('seenByModal');
  if (pop && pop.classList.contains('show') && !pop.contains(e.target)) closeSeenByPopup();
});

const lightboxSaveBtn = document.getElementById('lightboxSaveBtn');
if (lightboxSaveBtn) {
  lightboxSaveBtn.addEventListener('click', (e) => {
    if (window.Capacitor && window.Capacitor.isNativePlatform()) return;

    e.preventDefault();
    e.stopPropagation();

    const img = document.getElementById('lightboxImage');
    if (img && img.src) {
      downloadImageWeb(img.src);
    }
  });
}

// ===== RENDER MESSAGES =====
function renderMessages(messages) {
  chatMessages.innerHTML = '';
  const fragment = document.createDocumentFragment();
  let lastDate = '';
  messages.forEach(msg => {
    const d = new Date(msg.timestamp).toDateString();
    if (d !== lastDate) {
      lastDate = d;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${formatDateLabel(msg.timestamp)}</span>`;
      fragment.appendChild(sep);
    }
    renderMessage(msg, fragment, true);
  });

  chatMessages.appendChild(fragment);

  // Read receipts v2: prefetch reader display names so the avatar stack shows
  // real names + tooltips, then refresh the stacks once names resolve.
  const rrIds = [];
  messages.forEach(m => {
    (m.readBy || []).forEach(id => {
      if (id && String(id) !== String(currentUser.id) && !rrIds.includes(id)) rrIds.push(id);
    });
  });
  if (rrIds.length) {
    prefetchNames(rrIds).then(() => {
      messages.forEach(m => {
        const el = chatMessages.querySelector(`[data-msg-id="${m.id}"]`);
        if (el) refreshReadReceipts(el, m);
      });
    }).catch(() => {});
  }

  // Render typing indicator bubble if active user is currently typing
  if (activeChat) {
    const typers = activeTyping[activeChat.id];
    if (typers && typers.size > 0) {
      const nextTyper = Array.from(typers)[0];
      showTypingIndicator(nextTyper);
    }
  }
}

// ===== SCROLL TO BOTTOM =====
function scrollToBottom() {
  if (!chatMessages) return;
  const doScroll = () => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };
  doScroll();
  requestAnimationFrame(doScroll);
  setTimeout(doScroll, 40);
  setTimeout(doScroll, 120);
  setTimeout(doScroll, 300);
}

// ===== JUMP TO LATEST BUTTON (floating ⌄) =====
// Appears over the chat when the user scrolls up the history; tapping it
// glides back to the newest message. Bound exactly once per page load.
(function initJumpToLatest() {
  if (window.__jumpToLatestBound) return;
  window.__jumpToLatestBound = true;
  const btn = document.getElementById('jumpToLatestBtn');
  if (!btn || !chatMessages) return;
  const SHOW_AFTER = 100; // px scrolled away from the bottom before showing
  // While a jump is animating, the scroll listener fires with intermediate
  // positions that are far from the bottom — without this flag the arrow
  // would flash back on mid-jump (and could stay visible if the final
  // scroll event is ever missed). During a jump we only ever hide.
  let jumpInProgress = false;
  // Visibility is driven by the .show class (display:flex). The [hidden]
  // attribute must NOT be used: an author display:flex rule overrides the
  // browser's [hidden] display:none, so the arrow would show in every chat.
  const setVisible = (v) => btn.classList.toggle('show', !!v);
  const updateBtn = () => {
    if (jumpInProgress) {
      setVisible(false);
      return;
    }
    const nearBottom = (chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight) <= SHOW_AFTER;
    setVisible(!nearBottom);
  };
  // Re-arm normal show/hide behavior once the jump has settled. Prefer the
  // modern scrollend event; fall back to a timeout on older WebViews.
  const settleJump = () => {
    jumpInProgress = false;
    updateBtn();
  };
  // Scroll events fire for programmatic scrolls too, so scrollToBottom()
  // automatically hides the button when a new message lands.
  chatMessages.addEventListener('scroll', updateBtn, { passive: true });
  if ('onscrollend' in chatMessages) {
    chatMessages.addEventListener('scrollend', settleJump, { passive: true });
  }
  // Re-check when messages render / the chat switches (layout can change
  // without a scroll event, e.g. opening a chat with a short history).
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(updateBtn);
    mo.observe(chatMessages, { childList: true, subtree: false });
  }
  btn.addEventListener('click', () => {
    jumpInProgress = true;
    setVisible(false);
    if ('scrollTo' in chatMessages) {
      try {
        chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
      } catch (e) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    } else {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    // Safety net: if the scroll never settles (interrupted, missed event),
    // re-arm after a generous beat so the arrow still works afterwards.
    if ('onscrollend' in chatMessages) {
      setTimeout(() => { if (jumpInProgress) settleJump(); }, 800);
    } else {
      setTimeout(settleJump, 600);
    }
  });
})();

// ===== REFRESH CURRENT CHAT (REAL-TIME SYNC ON RESUME/CONNECT) =====
// Signature of the last message set rendered for the current chat, used to
// skip no-op re-renders (e.g. focus/visibility events where nothing changed).
// Scoped per chat: keyed by chat id so a signature from a previous chat can
// never suppress a legitimate re-render of the newly opened one.
let lastRenderedChatSig = {};
function chatRenderSignature(messages) {
  if (!messages || !messages.length) return 'empty';
  const last = messages[messages.length - 1];
  return messages.length + ':' + last.id + ':' + (last.timestamp || '');
}

async function refreshCurrentChat() {
  if (!activeChat || !currentUser) return;
  try {
    if (activeChat.type === 'dm') {
      const msgsRes = await fetch(api(`/api/messages?from=${currentUser.id}&to=${activeChat.id}`));
      const msgsData = await msgsRes.json();
      if (activeChat && msgsData.messages) {
        const sig = chatRenderSignature(msgsData.messages);
        if (sig === lastRenderedChatSig[activeChat.id]) return;
        lastRenderedChatSig[activeChat.id] = sig;
        renderMessages(msgsData.messages);
        scrollToBottom();
        markChatRead(msgsData.messages);
      }
    } else if (activeChat.type === 'group') {
      const msgsRes = await fetch(api(`/api/messages?groupId=${activeChat.id}`));
      const msgsData = await msgsRes.json();
      if (activeChat && msgsData.messages) {
        const sig = chatRenderSignature(msgsData.messages);
        if (sig === lastRenderedChatSig[activeChat.id]) return;
        lastRenderedChatSig[activeChat.id] = sig;
        await prefetchNames([...new Set(msgsData.messages.map(m => m.from))]);
        renderMessages(msgsData.messages);
        scrollToBottom();
        markChatRead(msgsData.messages);
        // Reader names too — refresh receipt avatars + Seen By card in place.
        prefetchReceiptReaderNames(msgsData.messages).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Refresh current chat error:', err);
  }
}

// Background / Visibility / Resume listeners for real-time sync
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser) {
    if (socket && !socket.connected) socket.connect();
    loadConversations();
    if (activeChat) refreshCurrentChat();
  }
});

window.addEventListener('focus', () => {
  if (currentUser) {
    if (socket && !socket.connected) socket.connect();
    loadConversations();
    if (activeChat) refreshCurrentChat();
  }
});

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
    if (state.isActive && currentUser) {
      if (socket && !socket.connected) socket.connect();
      loadConversations();
      if (activeChat) refreshCurrentChat();
    }
  });
}

// ===== ULTRA-SMOOTH 60FPS GPU SWIPE TO REPLY GESTURE =====
function enableSwipeToReply(msgEl, msg) {
  const bubble = msgEl.querySelector('.message-bubble');
  if (!bubble) return;

  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let isSwiping = false;
  let isHorizontal = false;
  let animFrameId = null;

  let swipeIcon = msgEl.querySelector('.swipe-reply-icon');
  if (!swipeIcon) {
    swipeIcon = document.createElement('div');
    swipeIcon.className = 'swipe-reply-icon';
    swipeIcon.innerHTML = icon('reply', 16);
    msgEl.insertBefore(swipeIcon, bubble);
  }

  const renderTransform = () => {
    if (!isSwiping && currentX === 0) return;
    const translateX = Math.min(Math.pow(currentX, 0.85) * 1.8, 68);
    bubble.style.transform = `translate3d(${translateX}px, 0, 0)`;

    if (swipeIcon) {
      const progress = Math.min(translateX / 42, 1);
      swipeIcon.style.opacity = String(progress);
      swipeIcon.style.transform = `translate3d(0, -50%, 0) scale(${0.4 + progress * 0.6}) rotate(${progress * 15}deg)`;
    }
  };

  const resetBubble = () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    bubble.style.transition = 'transform 0.32s cubic-bezier(0.175, 0.885, 0.32, 1.25)';
    bubble.style.transform = 'translate3d(0, 0, 0)';
    if (swipeIcon) {
      swipeIcon.style.transition = 'all 0.25s ease';
      swipeIcon.style.opacity = '0';
      swipeIcon.style.transform = 'translate3d(0, -50%, 0) scale(0.4) rotate(0deg)';
    }
    isSwiping = false;
    isHorizontal = false;
    currentX = 0;
  };

  bubble.addEventListener('touchstart', (e) => {
    if (selectionMode || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentX = 0;
    isSwiping = true;
    isHorizontal = false;
    bubble.style.transition = 'none';
    if (swipeIcon) swipeIcon.style.transition = 'none';
  }, { passive: true });

  bubble.addEventListener('touchmove', (e) => {
    if (!isSwiping || e.touches.length !== 1) return;
    const touchX = e.touches[0].clientX;
    const touchY = e.touches[0].clientY;
    const diffX = touchX - startX;
    const diffY = Math.abs(touchY - startY);

    if (!isHorizontal) {
      if (diffX > 6 && diffX > diffY * 1.8) {
        isHorizontal = true;
      } else if (diffY > 8 || diffX < -6) {
        isSwiping = false;
        return;
      }
    }

    if (isHorizontal && diffX > 0) {
      currentX = diffX;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      animFrameId = requestAnimationFrame(renderTransform);
    }
  }, { passive: true });

  bubble.addEventListener('touchend', () => {
    if (!isSwiping) return;
    const finalTranslate = Math.min(Math.pow(currentX, 0.85) * 1.8, 68);
    if (isHorizontal && finalTranslate >= 42) {
      if (navigator.vibrate) try { navigator.vibrate(22); } catch(e) {}
      startReply(msg);
    }
    resetBubble();
  });

  bubble.addEventListener('touchcancel', resetBubble);
}

function appendSharedMediaInstant(msg) {
  if (!msg || !msg.mediaUrl || msg.deleted) return;
  const isImage = msg.type === 'image' || /\.(jpg|jpeg|png|gif|webp|bmp|heic)(\?.*)?$/i.test(msg.mediaUrl);
  if (!isImage) return;

  const fullUrl = absUrl(msg.mediaUrl);

  document.querySelectorAll('.up-media-grid').forEach(grid => {
    if (grid.querySelector(`img[src="${fullUrl}"]`)) return;

    const card = grid.closest('.up-card');
    if (card) {
      const emptyNote = card.querySelector('.up-empty-note');
      if (emptyNote) emptyNote.remove();
    }

    const newImg = document.createElement('img');
    newImg.src = fullUrl;
    newImg.dataset.full = fullUrl;
    newImg.alt = 'media';
    newImg.setAttribute('loading', 'lazy');
    newImg.setAttribute('decoding', 'async');
    newImg.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(fullUrl);
    });

    grid.insertBefore(newImg, grid.firstChild);

    if (card) {
      const h4 = card.querySelector('h4');
      if (h4 && h4.textContent.includes('Shared Media')) {
        const count = grid.querySelectorAll('img').length;
        h4.textContent = `Shared Media (${count})`;
      }
    }
  });
}

function extractLinksFromText(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+|(?:www\.|[a-zA-Z0-9-]+\.)[a-zA-Z]{2,}(?:\/[^\s]*)?)/gi;
  const matches = text.match(urlRegex);
  if (!matches) return [];

  const results = [];
  matches.forEach(raw => {
    let clean = raw.replace(/[.,;!?)]+$/, '');
    if (!clean) return;
    // Skip image URLs (they belong in Shared Media)
    if (/\.(jpg|jpeg|png|gif|webp|bmp|heic|svg)(\?.*)?$/i.test(clean)) return;

    const href = /^https?:\/\//i.test(clean) ? clean : 'https://' + clean;
    results.push({ url: href, label: clean, icon: '🔗' });
  });
  return results;
}

function extractDomain(url) {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return parsed.hostname.replace(/^www\./, '');
  } catch (e) {
    return url;
  }
}

function getFaviconUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function extractUrls(text) {
  if (!text) return [];
  const extracted = extractLinksFromText(text);
  return extracted.map(l => l.url);
}

function generateLinkPreviewSync(url) {
  if (!url) return null;
  const domain = extractDomain(url);
  const fullUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  const favicon = getFaviconUrl(domain);
  let title = domain;

  if (domain.includes('github.com')) title = 'GitHub Repository / Code';
  else if (domain.includes('youtube.com') || domain.includes('youtu.be')) title = 'YouTube Video';
  else if (domain.includes('twitter.com') || domain.includes('x.com')) title = 'X (formerly Twitter)';
  else if (domain.includes('wikipedia.org')) title = 'Wikipedia Article';
  else if (domain.includes('reddit.com')) title = 'Reddit Community';
  else if (domain.includes('instagram.com')) title = 'Instagram Post';
  else if (domain.includes('facebook.com')) title = 'Facebook';
  else if (domain.includes('google.com')) title = 'Google Search';

  return {
    url: fullUrl,
    domain: domain,
    title: title,
    favicon: favicon
  };
}

function generateLinkPreview(url) {
  return Promise.resolve(generateLinkPreviewSync(url));
}

function generateLinkPreviewHtml(preview) {
  if (!preview) return '';
  return `
    <a href="${attrEsc(preview.url)}" target="_blank" rel="noopener" class="link-preview" style="display:flex;align-items:center;gap:10px;margin-top:8px;padding:9px 12px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.12);border-radius:12px;text-decoration:none;transition:all 0.15s ease;">
      <img src="${attrEsc(preview.favicon)}" loading="lazy" decoding="async" style="width:24px;height:24px;border-radius:5px;flex-shrink:0;object-fit:cover;" alt="icon" onerror="this.style.display='none'">
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.85rem;font-weight:600;color:var(--text-main,#f8fafc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview.title)}</div>
        <div style="font-size:0.72rem;color:var(--accent,#38bdf8);margin-top:1px;">${escapeHtml(preview.domain)} ↗</div>
      </div>
    </a>`;
}

function appendSharedLinkInstant(msg) {
  if (!msg || msg.deleted) return;

  const foundLinks = [];
  if (msg.type === 'location' && msg.mediaUrl) {
    foundLinks.push({ url: msg.mediaUrl, label: '📍 Location', icon: 'map' });
  } else if (msg.text) {
    const extracted = extractLinksFromText(msg.text);
    foundLinks.push(...extracted);
  }

  if (foundLinks.length === 0) return;

  document.querySelectorAll('.profile-links-card').forEach(card => {
    let listEl = card.querySelector('.up-links-list');
    if (!listEl) {
      const emptyNote = card.querySelector('.up-empty-note');
      if (emptyNote) emptyNote.remove();
      listEl = document.createElement('div');
      listEl.className = 'up-links-list';
      card.appendChild(listEl);
    }

    foundLinks.forEach(link => {
      if (listEl.querySelector(`a[href="${link.url}"]`)) return;

      const domain = extractDomain(link.url);
      const favicon = getFaviconUrl(domain);

      const a = document.createElement('a');
      a.className = 'up-link';
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.display = 'flex';
      a.style.alignItems = 'center';
      a.style.gap = '10px';
      a.style.padding = '8px 10px';
      a.style.borderRadius = '10px';
      a.style.background = 'rgba(255,255,255,0.03)';
      a.style.border = '1px solid rgba(255,255,255,0.07)';
      a.style.marginTop = '6px';
      a.style.textDecoration = 'none';

      if (link.icon === 'map') {
        a.innerHTML = `<span class="up-link-ic" style="flex-shrink:0;">📍</span><span style="font-size:0.85rem;font-weight:600;color:var(--text-main);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Location Pin</span>`;
      } else {
        a.innerHTML = `
          <img src="${attrEsc(favicon)}" loading="lazy" decoding="async" style="width:20px;height:20px;border-radius:4px;flex-shrink:0;object-fit:cover;" onerror="this.style.display='none'">
          <div style="flex:1;min-width:0;overflow:hidden;">
            <div style="font-size:0.82rem;font-weight:600;color:var(--text-main);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(link.label)}</div>
            <div style="font-size:0.7rem;color:var(--accent);margin-top:1px;">${escapeHtml(domain)} ↗</div>
          </div>`;
      }

      listEl.insertBefore(a, listEl.firstChild);
    });

    const h4 = card.querySelector('h4');
    if (h4 && h4.textContent.includes('Links')) {
      const count = listEl.querySelectorAll('.up-link').length;
      h4.textContent = `Links & Locations (${count})`;
    }
  });
}

function updateChatInfoStatsInstant(msg) {
  if (!msg || msg.deleted || msg.type === 'p2p') return;
  document.querySelectorAll('.up-stats').forEach(statsEl => {
    const msgNumEl = statsEl.querySelector('.up-stat:first-child .up-stat-num');
    if (msgNumEl) {
      const currentVal = parseInt(msgNumEl.textContent, 10) || 0;
      msgNumEl.textContent = currentVal + 1;
    }
    const isImage = msg.type === 'image' || (msg.mediaUrl && /\.(jpg|jpeg|png|gif|webp|bmp|heic)(\?.*)?$/i.test(msg.mediaUrl));
    if (isImage) {
      const mediaNumEl = statsEl.querySelector('.up-stat:nth-child(2) .up-stat-num');
      if (mediaNumEl) {
        const currentMedia = parseInt(mediaNumEl.textContent, 10) || 0;
        mediaNumEl.textContent = currentMedia + 1;
      }
    }
  });
}

function decrementChatInfoStatsInstant(msg) {
  if (!msg || msg.type === 'p2p') return;
  document.querySelectorAll('.up-stats').forEach(statsEl => {
    const msgNumEl = statsEl.querySelector('.up-stat:first-child .up-stat-num');
    if (msgNumEl) {
      const currentVal = parseInt(msgNumEl.textContent, 10) || 0;
      msgNumEl.textContent = Math.max(0, currentVal - 1);
    }
    const isImage = msg.type === 'image' || (msg.mediaUrl && /\.(jpg|jpeg|png|gif|webp|bmp|heic)(\?.*)?$/i.test(msg.mediaUrl));
    if (isImage) {
      const mediaNumEl = statsEl.querySelector('.up-stat:nth-child(2) .up-stat-num');
      if (mediaNumEl) {
        const currentMedia = parseInt(mediaNumEl.textContent, 10) || 0;
        mediaNumEl.textContent = Math.max(0, currentMedia - 1);
      }
      
      if (msg.mediaUrl) {
        const fullUrl = absUrl(msg.mediaUrl);
        document.querySelectorAll('.up-media-grid').forEach(grid => {
          const img = grid.querySelector(`img[src="${fullUrl}"]`);
          if (img) img.remove();
          if (grid.children.length === 0) {
            grid.outerHTML = '<div class="up-empty-note">No media shared yet</div>';
          }
        });
      }
    }
  });
}

function renderMessage(msg, container = chatMessages, skipInstant = false) {
  if (!msg || !msg.id) return;
  const existingMsgEl = chatMessages.querySelector(`[data-msg-id="${msg.id}"]`);
  if (existingMsgEl) return;
  // Bulk renders (renderMessages) skip the per-message panel-sync helpers:
  // each one scans the whole document (querySelectorAll), which is O(N) global
  // queries for N messages. The user panel is rebuilt from the full list right
  // after (renderUserPanel), so these are only needed for real-time arrivals.
  if (!skipInstant) {
    if (msg.mediaUrl) appendSharedMediaInstant(msg);
    appendSharedLinkInstant(msg);
    updateChatInfoStatsInstant(msg);
  }

  const isSent = msg.from === currentUser.id;
  const sender = msg.from === currentUser.id ? 'You' : getUserName(msg.from);

  const msgEl = document.createElement('div');
  msgEl.className = `message ${isSent ? 'sent' : 'received'}${msg.deleted ? ' deleted' : ''}`;
  msgEl.dataset.msgId = msg.id;
  msgEl._msgData = msg;

  if (msg.deleted) {
    msgEl.innerHTML = `<div class="message-bubble-wrapper" style="position: relative; display: flex; flex-direction: column;">
      <div class="message-bubble">
        <div style="color:var(--text-muted);font-style:italic;font-size:0.75rem;display:flex;align-items:center;gap:6px;justify-content:center;">${icon('forbidden', 12)} This message was deleted</div></div>`;
    container.appendChild(msgEl);
    return;
  }

  let mediaContent = '';
  if (msg.type === 'image' && msg.mediaUrl) {
    const mediaSrc = safeUrl(msg.mediaUrl, true);
    mediaContent = mediaSrc
      ? `<div class="message-media" data-media-url="${attrEsc(msg.mediaUrl)}"><img src="${attrEsc(mediaSrc)}" alt="image" loading="lazy" decoding="async"></div>`
      : '<div class="message-media" style="padding:8px 12px;color:var(--text-muted);font-size:0.8rem;">📷 Media unavailable</div>';
  } else if (msg.type === 'location') {
    const locUrl = safeUrl(msg.mediaUrl, false);
    mediaContent = locUrl
      ? `<a href="${attrEsc(locUrl)}" target="_blank" rel="noopener noreferrer" class="message-location">📍 View Location</a>`
      : '<div class="message-location" style="padding:8px 12px;color:var(--text-muted);font-size:0.8rem;">📍 Location</div>';
  } else if (msg.type === 'voice' && msg.mediaUrl) {
    const duration = msg.duration || 0;
    const m = Math.floor(duration / 60);
    const s = duration % 60;
    mediaContent = `<div class="voice-message">
      <button class="voice-play-btn" data-audio="${attrEsc(msg.mediaUrl)}">▶</button>
      <div class="voice-progress"><div class="voice-progress-bar" style="width:0%"></div></div>
      <span class="voice-duration">${m}:${s.toString().padStart(2, '0')}</span>
    </div>`;
  } else if (msg.type === 'p2p') {
    let meta = { p2pId: msg.p2pId || msg.id, fileName: 'File', fileSize: 0 };
    if (msg.mediaUrl && typeof msg.mediaUrl === 'string' && msg.mediaUrl.startsWith('{')) {
      try { meta = JSON.parse(msg.mediaUrl); } catch(e) {}
    } else if (msg.p2pMeta) {
      meta = msg.p2pMeta;
    }

    // pId is interpolated into DOM ids and inline onclick handlers, so restrict
    // it to safe identifier characters (it can be attacker-controlled via the
    // parsed mediaUrl meta). Prevents onclick attribute/JS-string injection.
    const pId = String(meta.p2pId || msg.p2pId || (msg.p2pMeta && msg.p2pMeta.transferId) || msg.id).replace(/[^A-Za-z0-9_-]/g, '') || 'transfer';
    const isSender = String(msg.from) === String(currentUser ? currentUser.id : '');
    const t = p2pTransfers[pId];
    const savedStatus = p2pStatusMap[pId] ||
                        (meta.p2pId && p2pStatusMap[meta.p2pId]) ||
                        (msg.p2pId && p2pStatusMap[msg.p2pId]) ||
                        (msg.id && p2pStatusMap[msg.id]) ||
                        msg.p2pStatus ||
                        (t ? (t.completed ? 'completed' : (t.declined ? 'declined' : '')) : '');

    let statusText = isSender ? 'Waiting for recipient to accept...' : 'Incoming P2P Transfer Invitation';
    let progress = 0;
    let speedText = '';
    let showAccept = !isSender && (!t || !t.accepted) && !savedStatus;

    if (savedStatus === 'completed' || (t && t.completed)) {
      statusText = '⚡ Transfer Complete!';
      progress = 100;
      speedText = 'Done';
      showAccept = false;
    } else if (savedStatus === 'declined' || savedStatus === 'rejected') {
      statusText = '❌ Transfer Rejected';
      speedText = 'Rejected';
      showAccept = false;
    } else if (savedStatus === 'failed' || savedStatus === 'lost') {
      statusText = '⚠️ Connection Lost';
      speedText = 'Lost';
      showAccept = false;
    } else if (t) {
      if (t.accepted) {
        statusText = 'Connecting P2P...';
        showAccept = false;
      } else if (t.active) {
        statusText = 'Transferring...';
        showAccept = false;
      }
    }

    mediaContent = `
      <div class="p2p-card" id="card_${pId}">
        <div class="p2p-header">
          <div class="p2p-icon">⚡</div>
          <div class="p2p-meta">
            <div class="p2p-filename" title="${attrEsc(meta.fileName)}">${escapeHtml(meta.fileName)}</div>
            <div class="p2p-filesize">${formatBytes(meta.fileSize)} • Direct P2P Share</div>
          </div>
        </div>
        <div class="p2p-progress-bg">
          <div class="p2p-progress-bar" id="bar_${pId}" style="width: ${progress}%"></div>
        </div>
        <div class="p2p-info-row">
          <span id="status_${pId}">${statusText}</span>
          <span id="speed_${pId}">${speedText}</span>
        </div>
        ${showAccept ? `
          <div class="p2p-actions" id="actions_${pId}">
            <button class="p2p-btn p2p-btn-accept" onclick="acceptP2PTransfer('${pId}', this)">Accept Direct Share</button>
            <button class="p2p-btn p2p-btn-decline" onclick="declineP2PTransfer('${pId}', this)">Decline</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  let replyHtml = '';
  if (msg.replyTo) {
    const rt = msg.replyTo;
    const isSelf = String(rt.from) === String(currentUser ? currentUser.id : '');
    const displayName = isSelf ? 'You' : (rt.fromName || getUserName(rt.from) || 'User');

    let mediaTag = '';
    let previewText = rt.text || '';

    if (rt.type === 'image') {
      mediaTag = `<span class="reply-type-tag">${icon('image', 13)} Photo</span>`;
    } else if (rt.type === 'voice') {
      mediaTag = `<span class="reply-type-tag">${icon('mic', 13)} Voice</span>`;
    } else if (rt.type === 'location') {
      mediaTag = `<span class="reply-type-tag">${icon('map-pin', 13)} Location</span>`;
    }

    replyHtml = `
      <div class="reply-quote" data-target-id="${attrEsc(rt.id || '')}" title="Click to scroll to original message">
        <div class="reply-quote-header">
          <span class="reply-quote-name">${escapeHtml(displayName)}</span>
        </div>
        <div class="reply-quote-body">
          ${mediaTag}
          <span class="reply-quote-text">${escapeHtml(previewText)}</span>
        </div>
      </div>`;
  }

  // Link previews (Synchronous 0ms render — zero layout shift or flickering)
  let linkPreviewHtml = '';
  if (msg.text && (msg.type === 'text' || !msg.type)) {
    const urls = extractUrls(msg.text);
    if (urls.length > 0) {
      const preview = generateLinkPreviewSync(urls[0]);
      if (preview) {
        linkPreviewHtml = generateLinkPreviewHtml(preview);
      }
    }
  }

  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let tickHtml = '';
  if (isSent && activeChat && activeChat.type === 'dm') {
    const read = msg.read;
    tickHtml = `<span class="msg-tick${read ? ' read' : ''}">${read ? DOUBLE_TICK_SVG : SINGLE_TICK_SVG}</span>`;
  } else if (isSent && activeChat && activeChat.type === 'group') {
    const read = msg.read || (msg.readBy && msg.readBy.length > 0);
    tickHtml = `<span class="msg-tick${read ? ' read' : ''}">${read ? DOUBLE_TICK_SVG : SINGLE_TICK_SVG}</span>`;
  }

  let reactionsHtml = '';
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    reactionsHtml = `<div class="msg-reactions">${renderReactionsHtml(msg.reactions)}</div>`;
  }

  const formatText = msg.text && msg.type === 'text' ? formatMessageText(msg.text) : (msg.text && msg.type !== 'p2p' ? escapeHtml(msg.text) : '');
  const editedMarker = msg.edited ? '<span class="edited-marker">(edited)</span>' : '';

  const isPlainTextMessage = (!msg.type || msg.type === 'text') && Boolean(msg.text) && extractUrls(msg.text).length === 0;

  msgEl.innerHTML = `
    <div class="sel-checkbox"></div>
    <div class="message-actions">
      <button class="msg-action-btn" data-act="react" title="React">${icon('heart', 14)}</button>
      <button class="msg-action-btn more-btn" data-act="more" title="More">${icon('more-vertical', 16)}</button>
      <div class="more-menu" id="moreMenu_${msg.id}">
        <button class="more-menu-item" data-act="reply"><span>${icon('reply', 14)}</span> Reply</button>
        <button class="more-menu-item" data-act="forward"><span>${icon('forward', 14)}</span> Forward</button>
        ${isPlainTextMessage ? `<button class="more-menu-item" data-act="copy"><span>${icon('copy', 14)}</span> Copy</button>` : ''}
        ${isSent && isPlainTextMessage ? `<button class="more-menu-item" data-act="edit"><span>${icon('edit', 14)}</span> Edit</button>` : ''}
        ${isSent ? `<button class="more-menu-item" data-act="delete" style="color:var(--danger);"><span>${icon('trash', 14)}</span> Delete</button>` : ''}
        ${!isSent ? `<button class="more-menu-item" data-act="report" style="color:var(--warning);"><span>${icon('flag', 14)}</span> Report</button>` : ''}
      </div>
    </div>
    <div class="message-bubble">
      ${!isSent && activeChat && activeChat.type === 'group' ? `<div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px; display:flex; align-items:center; gap:2px;">${escapeHtml(sender)}${adminBadgeHtml(msg.from)}</div>` : ''}
      ${replyHtml}
      ${mediaContent}
      ${formatText ? `<div class="message-text">${formatText}${editedMarker}</div>` : ''}
      ${linkPreviewHtml}
      <div class="message-time">${time} ${tickHtml}</div>
      ${renderReadReceiptsHtml(msg)}
      </div>
      ${reactionsHtml}
    </div>
  `;

  msgEl.querySelector('.sel-checkbox')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectionMode) toggleMessageSelection(msg.id);
  });

  // ⋮ More menu toggle
  const moreBtn = msgEl.querySelector('[data-act="more"]');
  const moreMenu = msgEl.querySelector('.more-menu');
  const msgActions = msgEl.querySelector('.message-actions');
  const closeMenuInternal = () => { moreMenu.classList.remove('open'); if (msgActions) msgActions.classList.remove('show-menu'); };
  const closeMenu = () => {
    closeMenuInternal();
    if (window.Nav) {
      const idx = window.Nav.stack.findIndex(e => e.name === 'moreMenu');
      if (idx !== -1) window.Nav.stack.splice(idx, 1);
    }
  };

  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.reaction-popup, .full-reaction-picker').forEach(p => p.remove());

    const opening = !moreMenu.classList.contains('open');
    document.querySelectorAll('.more-menu.open').forEach(m => {
      m.classList.remove('open');
      m.closest('.message')?.querySelector('.message-actions')?.classList.remove('show-menu');
    });
    if (opening) {
      const msgRect = msgEl.getBoundingClientRect();
      const chatRect = chatMessages.getBoundingClientRect();
      const menuHeight = 220;
      const spaceBelow = chatRect.bottom - msgRect.bottom;
      const spaceAbove = msgRect.top - chatRect.top;
      moreMenu.classList.remove('up', 'down');
      if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
        moreMenu.classList.add('up');
      } else {
        moreMenu.classList.add('down');
      }
      moreMenu.classList.add('open');
      if (msgActions) msgActions.classList.add('show-menu');
      if (window.Nav && !window.Nav.has('moreMenu')) {
        window.Nav.push('moreMenu', closeMenuInternal);
      }
    } else {
      closeMenu();
    }
  });

  // Action handlers via more-menu
  msgEl.querySelector('[data-act="reply"]')?.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); startReply(msg); });
  msgEl.querySelector('[data-act="forward"]')?.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); showForwardModal(msg); });
  msgEl.querySelector('[data-act="copy"]')?.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); copyMessageText(msg.text || ''); });
  msgEl.querySelector('[data-act="edit"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    startEdit(msg);
  });
  msgEl.querySelector('[data-act="delete"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    if (socket) socket.emit('delete_message', { messageId: msg.id, userId: currentUser.id });
  });
  msgEl.querySelector('[data-act="report"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    if (typeof window.openReportModal === 'function') window.openReportModal(msg);
  });

  // React button
  msgEl.querySelector('[data-act="react"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close 3-dot dropdown menu if open
    closeMenu();
    document.querySelectorAll('.more-menu.open').forEach(m => {
      m.classList.remove('open');
      m.closest('.message')?.querySelector('.message-actions')?.classList.remove('show-menu');
    });
    showReactionPicker(e.currentTarget, msg.id);
  });

  // Voice play button
  const playBtn = msgEl.querySelector('.voice-play-btn');
  if (playBtn) {
    let audioObj = null;
    playBtn.addEventListener('click', () => {
      if (audioObj && !audioObj.paused) {
        audioObj.pause();
        audioObj.currentTime = 0;
        playBtn.textContent = '▶';
        return;
      }
      audioObj = new Audio(playBtn.dataset.audio);
      const bar = msgEl.querySelector('.voice-progress-bar');
      playBtn.textContent = '⏸';
      audioObj.addEventListener('timeupdate', () => {
        if (bar && audioObj.duration) {
          bar.style.width = `${(audioObj.currentTime / audioObj.duration) * 100}%`;
        }
      });
      audioObj.addEventListener('ended', () => {
        playBtn.textContent = '▶';
        if (bar) bar.style.width = '0%';
      });
      audioObj.play().catch(() => { playBtn.textContent = '▶'; });
    });
  }
  // Attach swipe to reply gesture
  enableSwipeToReply(msgEl, msg);

  const typing = document.getElementById('typingIndicator');
  if (typing && container === chatMessages) {
    container.insertBefore(msgEl, typing);
  } else {
    container.appendChild(msgEl);
  }
  attachReactionTooltips();
}

// ===== SELECTION MODE (Batch Delete) =====
function exitSelectionModeInternal() {
  selectionMode = false;
  selectedMessages.clear();
  document.querySelectorAll('.message').forEach(el => {
    el.classList.remove('selection-mode', 'selected');
  });
  hideSelectionBar();
}

function exitSelectionMode() {
  if (window.Nav && window.Nav.has('selectionMode')) {
    window.Nav.back();
  } else {
    exitSelectionModeInternal();
  }
}

function enterSelectionMode() {
  selectionMode = true;
  selectedMessages.clear();
  document.querySelectorAll('.message').forEach(el => el.classList.add('selection-mode'));
  showSelectionBar();
  if (window.Nav && !window.Nav.has('selectionMode')) {
    window.Nav.push('selectionMode', exitSelectionModeInternal);
  }
}

function toggleMessageSelection(msgId) {
  if (!selectionMode) return;
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!el) return;
  if (selectedMessages.has(msgId)) {
    selectedMessages.delete(msgId);
    el.classList.remove('selected');
  } else {
    selectedMessages.add(msgId);
    el.classList.add('selected');
  }
  updateSelectionBar();
}

function showSelectionBar() {
  let bar = document.getElementById('selectionBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selectionBar';
    bar.className = 'selection-bar';
    bar.innerHTML = `
      <span class="sel-count" id="selCount">0 selected</span>
      <div class="sel-actions">
        <button class="sel-delete-btn" id="selDeleteBtn">Delete Selected</button>
        <button class="sel-cancel-btn" id="selCancelBtn">Cancel</button>
      </div>
    `;
    bar.querySelector('#selDeleteBtn').addEventListener('click', deleteSelectedMessages);
    bar.querySelector('#selCancelBtn').addEventListener('click', exitSelectionMode);
    document.getElementById('activeChat').appendChild(bar);
  }
  bar.style.display = 'flex';
}

function hideSelectionBar() {
  const bar = document.getElementById('selectionBar');
  if (bar) bar.style.display = 'none';
}

function updateSelectionBar() {
  const count = selectedMessages.size;
  const countEl = document.getElementById('selCount');
  const deleteBtn = document.getElementById('selDeleteBtn');
  if (countEl) countEl.textContent = `${count} selected`;
  if (deleteBtn) deleteBtn.textContent = count > 0 ? `Delete Selected (${count})` : 'Delete Selected';
}

function deleteSelectedMessages() {
  if (selectedMessages.size === 0) return;
  // The server only allows authors to delete their own messages, so skip
  // received messages instead of silently no-oping them.
  let own = 0;
  let skipped = 0;
  selectedMessages.forEach(msgId => {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    const isOwn = el && el._msgData ? String(el._msgData.from) === String(currentUser.id) : false;
    if (isOwn) {
      own++;
      socket.emit('delete_message', { messageId: msgId });
    } else {
      skipped++;
    }
  });
  if (skipped > 0) {
    showToast(skipped + ' received message' + (skipped > 1 ? 's' : '') + ' skipped — you can only delete your own messages', 'info');
  }
  exitSelectionMode();
}

// Click on message area toggles selection
// Delegate media image clicks (replaces removed inline onclick)
chatMessages.addEventListener('click', (e) => {
  const mediaDiv = e.target.closest('.message-media');
  if (mediaDiv && mediaDiv.dataset.mediaUrl) {
    e.preventDefault();
    openLightbox(mediaDiv.dataset.mediaUrl);
    return;
  }
  const linkPreview = e.target.closest('.link-preview');
  if (linkPreview && linkPreview.dataset.linkUrl) {
    e.preventDefault();
    window.open(linkPreview.dataset.linkUrl, '_blank');
    return;
  }
  // Click on a message's read-receipt avatars → open the "Seen By" popup.
  // Only outside selection mode; in selection mode receipt clicks stay part of
  // the message and toggle selection like any other tap.
  const rrWrap = e.target.closest('.read-receipts');
  if (rrWrap && !selectionMode) {
    const msgEl = rrWrap.closest('.message');
    if (msgEl && msgEl._msgData) {
      e.preventDefault();
      e.stopPropagation();
      openSeenByPopup(msgEl._msgData);
      return;
    }
  }
  if (!selectionMode) return;
  if (e.target.closest('button, a, input, .more-menu, .voice-play-btn, .sel-checkbox')) return;
  const msgEl = e.target.closest('.message');
  if (msgEl) toggleMessageSelection(msgEl.dataset.msgId);
});

// Global delegate listener for shared media grid images across all panels and modals
document.addEventListener('click', (e) => {
  const upMediaImg = e.target.closest('.up-media-grid img');
  if (upMediaImg) {
    const src = upMediaImg.dataset.full || upMediaImg.src;
    if (src) {
      e.stopPropagation();
      openLightbox(src);
    }
  }
});

// Avatar image load error fallback (replaces removed inline onerror)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof Element && img.tagName === 'IMG' && img.dataset.avatarFallback) {
    img.style.display = 'none';
    const parent = img.parentElement;
      if (parent && !parent.querySelector('.avatar-fallback-text')) {
        const fallback = document.createElement('span');
        fallback.className = 'avatar-fallback-text';
        fallback.textContent = img.dataset.avatarFallback;
        parent.appendChild(fallback);
      }
    }
}, true);

// ===== DOUBLE-TAP / DOUBLE-CLICK TO QUICK-REACT (❤️) =====
let _lastQuickReact = 0;
function quickReact(msgEl) {
  const now = Date.now();
  if (now - _lastQuickReact < 500) return;
  _lastQuickReact = now;
  if (!msgEl || !socket || selectionMode) return;
  if (msgEl.id === 'typingIndicator' || msgEl.classList.contains('deleted') || msgEl._msgData?.deleted) return;
  const msgId = msgEl.dataset.msgId;
  if (!msgId) return;
  
  const emoji = '❤️';
  const uId = currentUser ? currentUser.id : 'me';

  // Emit to server
  socket.emit('react', { messageId: msgId, userId: uId, emoji: emoji });
  showHeartBurst(msgEl);
  
  // Bulletproof optimistic update for native Android
  try {
    let reactEl = msgEl.querySelector('.msg-reactions');
    const bubble = msgEl.querySelector('.message-bubble') || msgEl;
    
    if (!reactEl) {
      reactEl = document.createElement('div');
      reactEl.className = 'msg-reactions';
      
      let wrapper = msgEl.querySelector('.message-bubble-wrapper') || msgEl;
      wrapper.appendChild(reactEl);

    }
    
    if (msgEl._msgData) {
      if (!msgEl._msgData.reactions) msgEl._msgData.reactions = {};
      msgEl._msgData.reactions[uId] = emoji;
      reactEl.innerHTML = renderReactionsHtml(msgEl._msgData.reactions);
    } else {
      // Hard fallback if _msgData is detached in webview
      reactEl.innerHTML = `<span class="reaction-item" data-userids="${uId}">${emoji}</span>`;
    }

    // Force Android WebView to reflow the ENTIRE message row to ensure the absolute element paints
    
    
    // Add margin manually since :has() might not be supported in older WebViews
    bubble.style.marginBottom = '12px';
  } catch(e) {
    console.error('Optimistic reaction error:', e);
  }
}

// Floating heart pop animation with cute confetti burst
function showHeartBurst(msgEl) {
  const bubble = msgEl.querySelector('.message-bubble') || msgEl;
  
  const container = document.createElement('div');
  container.className = 'heart-burst-container';
  
  // Main heart
  const mainHeart = document.createElement('div');
  mainHeart.className = 'heart-burst-main';
  mainHeart.textContent = '❤️';
  container.appendChild(mainHeart);
  
  // Confetti particles
  const emojis = ['✨', '💖', '⭐', '❤️', '💕'];
  for (let i = 0; i < 6; i++) {
    const p = document.createElement('div');
    p.className = 'heart-burst-particle';
    p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    
    // Calculate burst angles
    const angle = (i * 60 + (Math.random() * 30 - 15)) * (Math.PI / 180);
    const distance = 40 + Math.random() * 30;
    p.style.setProperty('--tx', `${Math.cos(angle) * distance}px`);
    p.style.setProperty('--ty', `${Math.sin(angle) * distance}px`);
    p.style.setProperty('--delay', `${Math.random() * 0.1}s`);
    
    container.appendChild(p);
  }

  bubble.appendChild(container);
  setTimeout(() => container.remove(), 1200);
}

// ===== TAP AND HOLD (LONG PRESS) & DOUBLE-TAP FOR MESSAGES =====
let _lastTapTime = 0;
let _lastTapEl = null;
let longPressTimer = null;
let longPressStartPos = { x: 0, y: 0 };
let isLongPressTriggered = false;

// Tap-and-hold is a mobile gesture: keep it on Android/iOS (native app AND
// mobile browsers), disable it on desktop web (e.g. Windows browsers) where
// the hold/right-click menu is unwanted. Message actions remain reachable on
// desktop via the ⋮ more-menu button on each bubble.
const IS_MOBILE_PLATFORM = !!(window.Capacitor || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

function showMobileHoldMenu(msgEl) {
  if (!msgEl || msgEl.classList.contains('deleted') || msgEl._msgData?.deleted) return;
  const msgId = msgEl.dataset.msgId;
  if (!msgId) return;

  const bubble = msgEl.querySelector('.message-bubble') || msgEl;
  const isSent = msgEl.classList.contains('sent');
  const msg = msgEl._msgData || {
    id: msgId,
    text: msgEl.querySelector('.message-text')?.textContent || '',
    type: msgEl.querySelector('img') ? 'image' : 'text'
  };

  // Remove existing overlays
  document.querySelectorAll('.mobile-hold-overlay, .mobile-hold-menu, .reaction-popup, .full-reaction-picker').forEach(el => el.remove());
  document.querySelectorAll('.more-menu.open').forEach(m => {
    m.classList.remove('open');
    m.closest('.message')?.querySelector('.message-actions')?.classList.remove('show-menu');
  });

  // Create backdrop overlay
  const overlay = document.createElement('div');
  overlay.className = 'mobile-hold-overlay';

  // Create menu container
  const menu = document.createElement('div');
  menu.className = 'mobile-hold-menu holding-active';
  setTimeout(() => menu.classList.remove('holding-active'), 350);

  // 1. GREEN BOX: Emoji Reaction Bar (Placed UPPER / ABOVE)
  const reactionEmojis = ['👍', '❤️', '😂', '😮', '😢'];
  const reactionBar = document.createElement('div');
  reactionBar.className = 'mobile-reaction-bar';
  reactionBar.innerHTML = reactionEmojis.map(e => `<span data-emoji="${e}">${e}</span>`).join('')
    + `<span class="reaction-more">+</span>`;

  function closeMobileHoldInternal() {
    overlay.remove();
    menu.remove();
  }

  function closeMenuForAction() {
    closeMobileHoldInternal();
    if (window.Nav) {
      const idx = window.Nav.stack.findIndex(e => e.name === 'mobileHold');
      if (idx !== -1) window.Nav.stack.splice(idx, 1);
    }
  }

  function closeMenu() {
    if (window.Nav && window.Nav.has('mobileHold')) {
      window.Nav.back();
    } else {
      closeMobileHoldInternal();
    }
  }

  reactionBar.querySelectorAll('span:not(.reaction-more)').forEach(span => {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.classList.contains('holding-active')) return;
      if (socket) socket.emit('react', { messageId: msgId, userId: currentUser.id, emoji: span.dataset.emoji });
      closeMenuForAction();
    });
  });

  reactionBar.querySelector('.reaction-more')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('holding-active')) return;
    closeMenuForAction();
    openFullEmojiPicker(bubble, msgId);
  });

  // 2. BLUE BOX: Actions Menu List (Placed DIRECTLY BELOW Green Box)
  const actionsList = document.createElement('div');
  actionsList.className = 'mobile-actions-list';

  const msgText = msg.text || msgEl.querySelector('.message-text')?.textContent || '';
  const isPlainTextMessage = (!msg.type || msg.type === 'text') && Boolean(msgText) && extractUrls(msgText).length === 0;

  let actionsHtml = `
    <button class="mobile-action-item" data-act="reply"><span class="icon-slot">${icon('reply', 16)}</span><span>Reply</span></button>
    <button class="mobile-action-item" data-act="forward"><span class="icon-slot">${icon('forward', 16)}</span><span>Forward</span></button>
  `;

  if (isPlainTextMessage) {
    actionsHtml += `<button class="mobile-action-item" data-act="copy"><span class="icon-slot">${icon('copy', 16)}</span><span>Copy</span></button>`;
  }

  if (isSent) {
    if (isPlainTextMessage) {
      actionsHtml += `<button class="mobile-action-item" data-act="edit"><span class="icon-slot">${icon('edit', 16)}</span><span>Edit</span></button>`;
    }
    actionsHtml += `<button class="mobile-action-item danger-item" data-act="delete"><span class="icon-slot">${icon('trash', 16)}</span><span>Delete</span></button>`;
  } else {
    // Received messages only: report to admins (matches the web ⋮ menu's Report).
    actionsHtml += `<button class="mobile-action-item warn-item" data-act="report"><span class="icon-slot">${icon('flag', 16)}</span><span>Report</span></button>`;
  }

  actionsList.innerHTML = actionsHtml;

  actionsList.addEventListener('click', (e) => {
    if (menu.classList.contains('holding-active')) return;
    const item = e.target.closest('.mobile-action-item');
    if (!item) return;
    const act = item.dataset.act;
    closeMenuForAction();

    if (act === 'reply') {
      startReply(msg);
    } else if (act === 'forward') {
      showForwardModal(msg);
    } else if (act === 'copy') {
      copyMessageText(msg.text || msgEl.querySelector('.message-text')?.textContent || '');
    } else if (act === 'edit') {
      startEdit(msg);
    } else if (act === 'delete') {
      if (socket) socket.emit('delete_message', { messageId: msg.id, userId: currentUser.id });
    } else if (act === 'report') {
      if (typeof window.openReportModal === 'function') window.openReportModal(msg);
    }
  });

  // Stack Green Box upper / above Blue Box
  menu.appendChild(reactionBar);
  menu.appendChild(actionsList);

  document.body.appendChild(overlay);
  document.body.appendChild(menu);

  // Position calculation
  const rect = bubble.getBoundingClientRect();
  const menuWidth = 240;
  let top = rect.top - 120;
  let left = isSent ? (rect.right - menuWidth) : rect.left;

  if (left < 16) left = 16;
  if (left + menuWidth > window.innerWidth - 16) left = window.innerWidth - menuWidth - 16;
  if (top < 60) top = rect.bottom + 10;
  if (top + 280 > window.innerHeight) top = window.innerHeight - 290;

  menu.style.top = top + 'px';
  menu.style.left = left + 'px';

  overlay.addEventListener('click', closeMenu);
  if (window.Nav && !window.Nav.has('mobileHold')) {
    window.Nav.push('mobileHold', closeMobileHoldInternal);
  }
}

// Document-level Tap & Hold (Long Press) & Double-Tap detector for Android Native & Web

document.addEventListener('touchstart', (e) => {
  if (!IS_MOBILE_PLATFORM) return; // tap-and-hold is disabled on desktop web
  const msgEl = e.target.closest('.message');
  if (!msgEl) return;
  if (e.target.closest('button, a, input, .more-menu, .voice-play-btn, .sel-checkbox, .msg-reactions, .reaction-popup, .mobile-hold-menu, .mobile-hold-overlay')) return;

  const touch = e.touches[0];
  longPressStartPos = { x: touch.clientX, y: touch.clientY };
  isLongPressTriggered = false;

  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    isLongPressTriggered = true;
    if (navigator.vibrate) { try { navigator.vibrate(40); } catch {} }
    showMobileHoldMenu(msgEl);
    longPressTimer = null;
  }, 280);
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!longPressTimer) return;
  const touch = e.touches[0];
  if (touch) {
    const dx = Math.abs(touch.clientX - longPressStartPos.x);
    const dy = Math.abs(touch.clientY - longPressStartPos.y);
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (isLongPressTriggered) {
    isLongPressTriggered = false;
    try { e.preventDefault(); } catch {}
    return;
  }

  const msgEl = e.target.closest('.message');
  if (!msgEl || e.target.closest('button, a, input, .more-menu, .voice-play-btn, .sel-checkbox, .msg-reactions, .reaction-popup, .mobile-hold-menu')) {
    _lastTapEl = null;
    return;
  }
  const now = Date.now();
  if (_lastTapEl === msgEl && now - _lastTapTime < 300) {
    quickReact(msgEl);
    _lastTapTime = 0;
    _lastTapEl = null;
  } else {
    _lastTapTime = now;
    _lastTapEl = msgEl;
  }
});

document.addEventListener('contextmenu', (e) => {
  if (!IS_MOBILE_PLATFORM) return; // no hold menu on desktop web
  const msgEl = e.target.closest('.message');
  if (msgEl && !e.target.closest('input, textarea, a, button')) {
    e.preventDefault();
    if (navigator.vibrate) { try { navigator.vibrate(40); } catch {} }
    showMobileHoldMenu(msgEl);
  }
});

document.addEventListener('dblclick', (e) => {
  if (e.target.closest('button, a, input, .more-menu, .voice-play-btn, .sel-checkbox, .msg-reactions')) return;
  const msgEl = e.target.closest('.message');
  if (msgEl) { e.preventDefault(); quickReact(msgEl); }
});

// Close more-menus & reaction popups when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.more-btn') && !e.target.closest('.more-menu') && !e.target.closest('.msg-action-btn') && !e.target.closest('.reaction-popup')) {
    document.querySelectorAll('.more-menu.open').forEach(m => {
      m.classList.remove('open');
      m.closest('.message')?.querySelector('.message-actions')?.classList.remove('show-menu');
    });
  }
});

// ===== FORWARD MESSAGE =====
let forwardMsg = null;
let forwardModal = null;

function showForwardModal(msg) {
  forwardMsg = msg;
  if (!forwardModal) {
    forwardModal = document.createElement('div');
    forwardModal.className = 'modal-overlay';
    forwardModal.id = 'forwardModal';
    document.body.appendChild(forwardModal);
    forwardModal.addEventListener('click', (e) => { if (e.target === forwardModal) closeForwardModal(); });
  }
  forwardModal.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="closeForwardModal" title="Close">${icon('x', 16)}</button>
      <h3>${icon('forward', 18)} Forward Message</h3>
      <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px;">${escapeHtml((msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'voice' ? '🎤 Voice' : msg.type === 'location' ? '📍 Location' : 'Message')).substring(0, 80))}</p>
      <div class="form-group">
        <input type="text" class="form-input" id="forwardSearchInput" placeholder="Search users or groups...">
      </div>
      <div class="search-results" id="forwardResults" style="max-height:240px;"></div>
      <div id="forwardSelected" style="margin-bottom:12px;display:none;">
        <div class="selected-user-chip" id="forwardTargetChip">
          <span id="forwardTargetName"></span>
          <button id="forwardClearBtn">×</button>
        </div>
      </div>
      <button class="btn-primary" id="forwardSendBtn" disabled>Forward</button>
    </div>`;
  forwardModal.classList.add('show');
  if (window.Nav && !window.Nav.has('forwardModal')) {
    window.Nav.push('forwardModal', closeForwardModalInternal);
  }

  let selectedTarget = null;

  const renderForwardList = (items) => {
    const activeId = activeChat ? String(activeChat.id) : null;
    const currentId = currentUser ? String(currentUser.id) : null;
    const validItems = (items || []).filter(c => {
      const cId = String(c.id);
      return cId !== currentId && cId !== activeId && c.id !== 'feedback-global-hub';
    });
    let html = '';
    validItems.forEach(c => {
      html += `<div class="search-result-item" data-type="${c.type === 'group' ? 'group' : 'user'}" data-id="${c.id}" data-name="${attrEsc(c.name)}">
        <div class="conv-avatar">${c.type === 'group' ? '👥' : avatarHtml(c.avatar, c.name)}</div>
        <span style="flex:1;">${escapeHtml(c.name)}</span>
      </div>`;
    });
    if (!html) html = '<div style="padding:12px;text-align:center;color:var(--text-muted);">No contacts found</div>';
    const resEl = document.getElementById('forwardResults');
    if (resEl) {
      resEl.innerHTML = html;
      resEl.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
          selectedTarget = { type: item.dataset.type, id: item.dataset.id, name: item.dataset.name };
          document.getElementById('forwardSelected').style.display = 'block';
          document.getElementById('forwardTargetName').textContent = item.dataset.name;
          document.getElementById('forwardSendBtn').disabled = false;
          document.getElementById('forwardSearchInput').value = item.dataset.name;
          document.getElementById('forwardResults').innerHTML = '';
        });
      });
    }
  };

  renderForwardList(conversations);

  document.getElementById('closeForwardModal').addEventListener('click', closeForwardModal);
  document.getElementById('forwardClearBtn')?.addEventListener('click', () => {
    selectedTarget = null;
    document.getElementById('forwardSelected').style.display = 'none';
    document.getElementById('forwardSendBtn').disabled = true;
    document.getElementById('forwardSearchInput').value = '';
    renderForwardList(conversations);
  });

  document.getElementById('forwardSearchInput').addEventListener('input', () => {
    clearTimeout(window._fwSearch);
    window._fwSearch = setTimeout(async () => {
      const q = document.getElementById('forwardSearchInput').value.trim();
      if (!q) { renderForwardList(conversations); return; }
      try {
        const userRes = await fetch(api(`/api/users/search?q=${encodeURIComponent(q)}&exclude=${currentUser.id}`));
        const userData = await userRes.json();
        const groupRes = await fetch(api(`/api/groups/${currentUser.id}`));
        const groupData = await groupRes.json();
        const matchedGroups = (groupData.groups || []).filter(g => g.name.toLowerCase().includes(q.toLowerCase()));
        
        const combined = [];
        (userData.users || []).forEach(u => combined.push({ type: 'dm', id: u.id, name: u.displayName || u.username, avatar: u.avatar }));
        matchedGroups.forEach(g => combined.push({ type: 'group', id: g.id, name: g.name, avatar: null }));
        
        renderForwardList(combined);
      } catch {
        const filtered = conversations.filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
        renderForwardList(filtered);
      }
    }, 250);
  });

  document.getElementById('forwardSendBtn').addEventListener('click', () => {
    if (!selectedTarget || !socket) return;

    let fwdText = msg.text ? `📤 Forwarded: ${msg.text}` : (msg.type === 'image' ? '' : msg.type === 'voice' ? '' : '📤 Forwarded Message');
    let fwdType = msg.type || 'text';
    let fwdMedia = msg.mediaUrl || null;

    if (!fwdText && !fwdMedia) {
      fwdText = '📤 Forwarded Message';
    }

    const payload = {
      from: currentUser.id,
      text: fwdText,
      type: fwdType,
      mediaUrl: fwdMedia
    };

    if (selectedTarget.type === 'user' || selectedTarget.type === 'dm') {
      payload.to = selectedTarget.id;
      socket.emit('send_message', payload);
    } else {
      payload.groupId = selectedTarget.id;
      socket.emit('send_group_message', payload);
    }

    showToast(`Forwarded to ${selectedTarget.name}`, 'success');
    closeForwardModal();
  });
}

function closeForwardModalInternal() {
  if (forwardModal) {
    forwardModal.classList.remove('show');
    forwardMsg = null;
  }
}

function closeForwardModal() {
  if (window.Nav && window.Nav.has('forwardModal')) {
    window.Nav.back();
  } else {
    closeForwardModalInternal();
  }
}

// ===== REACTION PICKER =====
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥'];
function showReactionPicker(anchor, messageId) {
  document.querySelectorAll('.reaction-popup').forEach(p => p.remove());
  const popup = document.createElement('div');
  popup.className = 'reaction-popup';
  popup.innerHTML = REACTION_EMOJIS.slice(0, 5).map(e => `<span data-emoji="${e}">${e}</span>`).join('')
    + `<span class="reaction-more" id="reactionMoreBtn">+</span>`;
  document.body.appendChild(popup);
  const rect = anchor.getBoundingClientRect();
  popup.style.top = (rect.top - 48) + 'px';
  popup.style.left = rect.left + 'px';
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth) popup.style.left = (window.innerWidth - pr.width - 8) + 'px';
    if (pr.left < 0) popup.style.left = '8px';
    if (pr.top < 0) popup.style.top = '8px';
    if (pr.bottom > window.innerHeight) popup.style.top = (window.innerHeight - pr.height - 8) + 'px';
  });
  popup.querySelectorAll('span:not(.reaction-more)').forEach(s => {
    s.addEventListener('click', () => {
      socket.emit('react', { messageId, userId: currentUser.id, emoji: s.dataset.emoji });
      popup.remove();
    });
  });
  popup.querySelector('.reaction-more')?.addEventListener('click', (e) => {
    e.stopPropagation();
    popup.remove();
    openFullEmojiPicker(anchor, messageId);
  });
  if (window.Nav && !window.Nav.has('reactionPopup')) {
    window.Nav.push('reactionPopup', () => popup.remove());
  }

  setTimeout(() => {
    document.addEventListener('click', function close(ev) {
      if (!popup.contains(ev.target)) {
        if (window.Nav && window.Nav.has('reactionPopup')) window.Nav.back();
        else popup.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 0);
}

function aggregateReactions(reactions) {
  if (!reactions) return [];
  const grouped = {};
  Object.entries(reactions).forEach(([userId, emoji]) => {
    if (!grouped[emoji]) grouped[emoji] = { count: 0, userIds: [] };
    grouped[emoji].count++;
    grouped[emoji].userIds.push(userId);
  });
  return Object.entries(grouped).map(([emoji, data]) => ({ emoji, ...data }));
}

function renderReactionsHtml(reactions) {
  return aggregateReactions(reactions).map(({ emoji, count, userIds }) =>
    `<span class="reaction-item" data-userids="${userIds.join(',')}">${emoji}${count > 1 ? `<small>${count}</small>` : ''}</span>`
  ).join('');
}

function attachReactionTooltips() {
  // uses event delegation on document — no duplicate handlers
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('.reaction-item');
  if (!el) { document.querySelectorAll('.reaction-tooltip').forEach(t => t.remove()); return; }
  e.stopPropagation();
  document.querySelectorAll('.reaction-tooltip').forEach(t => t.remove());
  const userIds = el.dataset.userids.split(',');
  const names = userIds.map(id => getUserName(id));
  const tooltip = document.createElement('div');
  tooltip.className = 'reaction-tooltip';
  tooltip.textContent = names.join(', ');
  const rect = el.getBoundingClientRect();
  tooltip.style.top = (rect.top - 8) + 'px';
  tooltip.style.left = rect.left + 'px';
  document.body.appendChild(tooltip);
  requestAnimationFrame(() => {
    const tr = tooltip.getBoundingClientRect();
    if (tr.top < 0) { tooltip.style.top = (rect.bottom + 8) + 'px'; tooltip.style.transform = 'none'; }
    if (tr.right > window.innerWidth) tooltip.style.left = (window.innerWidth - tr.width - 8) + 'px';
    if (tr.left < 0) tooltip.style.left = '8px';
  });
  setTimeout(() => {
    document.addEventListener('click', function close() {
      tooltip.remove(); document.removeEventListener('click', close);
    }, { once: true });
  }, 0);
});

function openFullEmojiPicker(anchorEl, messageId) {
  document.querySelectorAll('.reaction-popup, .full-reaction-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'full-reaction-picker';
  const ep = document.createElement('emoji-picker');
  picker.appendChild(ep);
  document.body.appendChild(picker);

  const msgEl = anchorEl.closest('.message') || anchorEl;
  const rect = msgEl.getBoundingClientRect();
  picker.style.top = (rect.bottom + 8) + 'px';
  picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 320)) + 'px';
  requestAnimationFrame(() => {
    const pr = picker.getBoundingClientRect();
    if (pr.bottom > window.innerHeight) picker.style.top = (window.innerHeight - pr.height - 8) + 'px';
    if (pr.top < 0) picker.style.top = '8px';
    if (pr.left < 0) picker.style.left = '8px';
    if (pr.right > window.innerWidth) picker.style.left = (window.innerWidth - pr.width - 8) + 'px';
  });

  ep.addEventListener('emoji-click', (e) => {
    socket.emit('react', { messageId, userId: currentUser.id, emoji: e.detail.unicode });
    picker.remove();
  });

  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); }
    });
  }, 0);
}

function startReply(msg) {
  cancelReply();
  const fromName = msg.from === currentUser.id ? 'You' : getUserName(msg.from);
  const preview = msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'location' ? '📍 Location' : '');
  replyingTo = { id: msg.id, from: msg.from, fromName, text: msg.text, type: msg.type };
  document.getElementById('replyText').textContent = `Replying to ${fromName}: ${preview}`;
  replyPreview.style.display = 'flex';
  messageInput.focus();
}

function startEdit(msg) {
  cancelReply();
  editingMsg = msg;
  messageInput.value = msg.text || '';
  document.getElementById('replyText').textContent = 'Editing message';
  replyPreview.style.display = 'flex';
  replyPreview.classList.add('edit-mode');
  messageInput.focus();
}

function cancelReply() {
  replyingTo = null;
  editingMsg = null;
  replyPreview.style.display = 'none';
  replyPreview.classList.remove('edit-mode');
  messageInput.value = '';
}

cancelReplyBtn.addEventListener('click', cancelReply);

// ===== SEND MESSAGE =====
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !activeChat) return;

  // Blocked user check
  if (activeChat.type === 'dm' && blockedUsers.has(activeChat.id)) {
    showToast('You have blocked this user. Unblock to send messages.', 'error');
    return;
  }

  // Edit mode
  if (editingMsg) {
    if (text === editingMsg.text) { cancelReply(); return; }
    socket.emit('edit_message', { messageId: editingMsg.id, text });
    messageInput.value = '';
    cancelReply();
    return;
  }

  const replyTo = replyingTo ? { id: replyingTo.id, from: replyingTo.from, fromName: replyingTo.fromName, text: replyingTo.text, type: replyingTo.type } : null;

  if (activeChat.type === 'dm') {
    socket.emit('send_message', {
      from: currentUser.id,
      to: activeChat.id,
      text,
      type: 'text',
      replyTo
    });
  } else {
    socket.emit('send_group_message', {
      from: currentUser.id,
      groupId: activeChat.id,
      text,
      type: 'text',
      replyTo
    });
  }

  messageInput.value = '';
  cancelReply();
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendMessage();
  }
});
messageInput.addEventListener('focus', () => {
  scrollToBottom();
  // Chrome Android ignores autocomplete="off" from page-load HTML but re-reads
  // the attribute at focus time — set it dynamically so its autofill suggestion
  // bar (key/card/pin icons) never appears above the keyboard.
  messageInput.setAttribute('autocomplete', 'off');
});

// Same focus-time hardening for the other non-login inputs (thread reply, nav
// search, group name). The login form keeps its autofill hints.
['threadInput', 'searchInput', 'groupName'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('focus', () => {
    el.setAttribute('autocomplete', 'off');
  });
});

messageInput.addEventListener('input', () => {
  if (!activeChat) return;
  // Emit typing indicators on input change, fully compatible with mobile virtual keyboards.
  // Capture the chat identity up front so the delayed stop_typing always targets the
  // ORIGINAL chat even if the user switches chats within the 2s window (previously it
  // read activeChat.id at fire time, leaving the old chat's indicator stuck forever).
  const chatId = activeChat.id;
  const isGroup = activeChat.type === 'group';
  socket.emit('typing', isGroup
    ? { from: currentUser.id, groupId: chatId }
    : { from: currentUser.id, to: chatId });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit('stop_typing', isGroup
      ? { from: currentUser.id, groupId: chatId }
      : { from: currentUser.id, to: chatId });
  }, 2000);
});

// ===== HELPER: COMPRESS IMAGE FOR WEB/MOBILE WEB =====
function compressImage(file, maxWidth = 1280, maxHeight = 1280, quality = 0.75) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('Invalid image file'));
    }
    // If file is already small (<= 100KB), read directly as data URL
    if (file.size <= 102400) {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          if (width / height > maxWidth / maxHeight) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.onerror = (err) => reject(err);
      img.src = e.target.result;
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

// ===== SEND PHOTO =====
const attachBtn = document.getElementById('attachBtn');
if (attachBtn) {
  attachBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ovMenu = document.getElementById('overflowMenu');
    if (ovMenu) ovMenu.classList.remove('show');
    if (fileInput) fileInput.click();
  });
}

if (fileInput) {
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !activeChat) return;

    const tempId = 'sending-photo-' + Date.now();
    const previewUrl = URL.createObjectURL(file);
    const tempEl = document.createElement('div');
    tempEl.className = 'message sent uploading';
    tempEl.id = tempId;
    tempEl.innerHTML = `
      <div class="message-bubble photo-upload-bubble" style="position:relative; display:inline-block; padding:0; overflow:hidden;">
        <div class="message-media">
          <img src="${previewUrl}" alt="image" style="display:block; opacity:0.85;">
        </div>
        <div class="win-loader-overlay" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none;">
          <div class="win-loader">
            <div></div><div></div><div></div><div></div><div></div>
          </div>
        </div>
      </div>`;
    chatMessages.appendChild(tempEl);
    scrollToBottom();

    const minAnimPromise = new Promise(r => setTimeout(r, 900));

    try {
      const dataUrl = await compressImage(file);

      if (activeChat.type === 'dm') {
        socket.emit('send_message', {
          from: currentUser.id,
          to: activeChat.id,
          text: '',
          type: 'image',
          mediaUrl: dataUrl
        });
      } else {
        socket.emit('send_group_message', {
          from: currentUser.id,
          groupId: activeChat.id,
          text: '',
          type: 'image',
          mediaUrl: dataUrl
        });
      }
      await minAnimPromise;
      if (tempEl.parentNode) tempEl.remove();
    } catch (err) {
      console.error('[Web Photo] Error processing or sending photo:', err);
      showToast('Failed to send photo', 'error');
      if (tempEl.parentNode) tempEl.remove();
    } finally {
      fileInput.value = '';
    }
  });
}

// ===== SEND LOCATION =====
document.getElementById('locationBtn').addEventListener('click', () => {
  if (!navigator.geolocation || !activeChat) return;

  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;

    if (activeChat.type === 'dm') {
      socket.emit('send_message', {
        from: currentUser.id,
        to: activeChat.id,
        text: `📍 My Location`,
        type: 'location',
        mediaUrl: mapsUrl
      });
    } else {
      socket.emit('send_group_message', {
        from: currentUser.id,
        groupId: activeChat.id,
        text: `📍 My Location`,
        type: 'location',
        mediaUrl: mapsUrl
      });
    }
  }, () => {
    alert('Location access denied');
  });
});

// ===== GROUP CREATION =====
function closeGroupModalInternal() {
  if (groupModal) {
    groupModal.classList.remove('show');
    document.getElementById('groupName').value = '';
    document.getElementById('groupMemberSearch').value = '';
    document.getElementById('groupSearchResults').innerHTML = '';
    selectedGroupMembers = [];
    renderSelectedMembers();
  }
}

function closeGroupModal() {
  if (window.Nav && window.Nav.has('groupModal')) {
    window.Nav.back();
  } else {
    closeGroupModalInternal();
  }
}

document.getElementById('newGroupBtn').addEventListener('click', () => {
  groupModal.classList.add('show');
  if (window.Nav && !window.Nav.has('groupModal')) {
    window.Nav.push('groupModal', closeGroupModalInternal);
  }
  selectedGroupMembers = [];
  renderSelectedMembers();
});

document.getElementById('cancelGroupBtn').addEventListener('click', closeGroupModal);
document.getElementById('closeGroupModal').addEventListener('click', closeGroupModal);

// Close when clicking outside the modal box
groupModal.addEventListener('click', (e) => {
  if (e.target === groupModal) closeGroupModal();
});

document.getElementById('groupMemberSearch').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const query = document.getElementById('groupMemberSearch').value.trim();
    if (!query) {
      document.getElementById('groupSearchResults').innerHTML = '';
      return;
    }

    try {
      const res = await fetch(api(`/api/users/search?q=${encodeURIComponent(query)}&exclude=${currentUser.id}`));
      const data = await res.json();
      renderGroupSearchResults(data.users);
    } catch (err) {
      console.error(err);
    }
  }, 300);
});

function renderGroupSearchResults(users) {
  const container = document.getElementById('groupSearchResults');
  container.innerHTML = users.map(user => `
    <div class="search-result-item" data-user-id="${user.id}" data-name="${attrEsc(user.displayName || user.username)}">
      <div class="conv-avatar">${avatarHtml(user.avatar, user.displayName || user.username)}</div>
      <span>${escapeHtml(user.displayName || user.username)}</span>
    </div>
  `).join('');

  container.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const userId = item.dataset.userId;
      const userName = item.dataset.name;
      if (!selectedGroupMembers.find(m => m.id === userId)) {
        selectedGroupMembers.push({ id: userId, name: userName });
        renderSelectedMembers();
      }
      document.getElementById('groupMemberSearch').value = '';
      container.innerHTML = '';
    });
  });
}

function renderSelectedMembers() {
  const container = document.getElementById('selectedMembers');
  container.innerHTML = selectedGroupMembers.map(m => `
    <div class="selected-user-chip">
      ${escapeHtml(m.name)}
      <button data-user-id="${m.id}">×</button>
    </div>
  `).join('');

  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedGroupMembers = selectedGroupMembers.filter(m => m.id !== btn.dataset.userId);
      renderSelectedMembers();
    });
  });
}

document.getElementById('createGroupBtn').addEventListener('click', async () => {
  const groupName = document.getElementById('groupName').value.trim();
  if (!groupName) return alert('Enter group name');
  if (selectedGroupMembers.length === 0) return alert('Add at least one member');

  try {
      const res = await fetch(api('/api/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: groupName,
        members: selectedGroupMembers.map(m => m.id),
        createdBy: currentUser.id
      })
    });
    const data = await res.json();

    if (data.success) {
      closeGroupModal();
      document.getElementById('groupName').value = '';
      document.getElementById('groupMemberSearch').value = '';
      selectedGroupMembers = [];
      loadConversations();
      openGroup(data.group.id);
    }
  } catch (err) {
    console.error('Create group error:', err);
  }
});

// ===== GROUP MEMBER MANAGEMENT =====
function closeAddMemberModalInternal() {
  if (addMemberModal) {
    addMemberModal.classList.remove('show');
    document.getElementById('addMemberSearch').value = '';
    document.getElementById('addMemberSearchResults').innerHTML = '';
    document.getElementById('addMemberSelected').innerHTML = '';
  }
}

function closeAddMemberModal() {
  if (window.Nav && window.Nav.has('addMemberModal')) {
    window.Nav.back();
  } else {
    closeAddMemberModalInternal();
  }
}

function showAddMemberModal(groupId) {
  document.getElementById('chatInfoModal')?.classList.remove('show');
  addMemberModal.classList.add('show');
  if (window.Nav && !window.Nav.has('addMemberModal')) {
    window.Nav.push('addMemberModal', closeAddMemberModalInternal);
  }
  document.getElementById('addMemberSearch').value = '';
  document.getElementById('addMemberSearchResults').innerHTML = '';
  document.getElementById('addMemberSelected').innerHTML = '';
  addMemberModal.dataset.groupId = groupId;
}

let addMemberSearchTimeout;
let addMemberSelected = [];

document.getElementById('closeAddMemberModal').addEventListener('click', closeAddMemberModal);
document.getElementById('cancelAddMemberBtn').addEventListener('click', closeAddMemberModal);
addMemberModal.addEventListener('click', (e) => { if (e.target === addMemberModal) closeAddMemberModal(); });

document.getElementById('addMemberSearch').addEventListener('input', () => {
  clearTimeout(addMemberSearchTimeout);
  addMemberSearchTimeout = setTimeout(async () => {
    const query = document.getElementById('addMemberSearch').value.trim();
    if (!query) { document.getElementById('addMemberSearchResults').innerHTML = ''; return; }
    try {
      const res = await fetch(api(`/api/users/search?q=${encodeURIComponent(query)}&exclude=${currentUser.id}`));
      const data = await res.json();
      const container = document.getElementById('addMemberSearchResults');
      container.innerHTML = data.users.map(user => `
        <div class="search-result-item" data-user-id="${user.id}" data-name="${attrEsc(user.displayName || user.username)}">
          <div class="conv-avatar">${avatarHtml(user.avatar, user.displayName || user.username)}</div>
          <span>${escapeHtml(user.displayName || user.username)}</span>
        </div>
      `).join('');
      container.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
          const uid = item.dataset.userId;
          const uname = item.dataset.name;
          if (!addMemberSelected.find(m => m.id === uid)) {
            addMemberSelected.push({ id: uid, name: uname });
            const selContainer = document.getElementById('addMemberSelected');
            selContainer.innerHTML = addMemberSelected.map(m =>
              `<div class="selected-user-chip">${escapeHtml(m.name)}<button data-user-id="${m.id}">×</button></div>`
            ).join('');
            selContainer.querySelectorAll('button').forEach(b => {
              b.addEventListener('click', () => {
                addMemberSelected = addMemberSelected.filter(m => m.id !== b.dataset.userId);
                b.parentElement.remove();
              });
            });
          }
          document.getElementById('addMemberSearch').value = '';
          container.innerHTML = '';
        });
      });
    } catch (err) { console.error(err); }
  }, 300);
});

document.getElementById('confirmAddMemberBtn').addEventListener('click', async () => {
  const groupId = addMemberModal.dataset.groupId;
  if (!groupId || addMemberSelected.length === 0) return;
  try {
    for (const m of addMemberSelected) {
      const res = await fetch(api(`/api/groups/${groupId}/members`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: m.id, requestedBy: currentUser.id })
      });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Failed', 'error'); return; }
    }
    showToast('Members added', 'success');
    closeAddMemberModal();
    addMemberSelected = [];
    loadConversations();
    if (activeChat && activeChat.id === groupId) openGroup(groupId);
  } catch (err) { showToast('Failed to add members', 'error'); }
});

async function removeGroupMember(groupId, userId) {
  if (!confirm('Remove this member from the group?')) return;
  try {
    const res = await fetch(api(`/api/groups/${groupId}/remove-member`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, requestedBy: currentUser.id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Member removed', 'success');
      loadConversations();
      if (activeChat && activeChat.id === groupId) openGroup(groupId);
    } else {
      showToast(data.error || 'Failed to remove member', 'error');
    }
  } catch (err) { showToast('Failed to remove member', 'error'); }
}

async function leaveGroup(groupId) {
  if (!confirm('Leave this group?')) return;
  try {
    const res = await fetch(api(`/api/groups/${groupId}/remove-member`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, requestedBy: currentUser.id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('You left the group', 'info');
      activeChat = null;
      loadConversations();
    } else {
      showToast(data.error || 'Failed to leave group', 'error');
    }
  } catch (err) { showToast('Failed to leave group', 'error'); }
}

async function deleteGroup(groupId) {
  try {
    const res = await fetch(api(`/api/groups/${groupId}/delete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: currentUser.id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Group deleted', 'info');
      activeChat = null;
      loadConversations();
    } else {
      showToast(data.error || 'Failed to delete group', 'error');
    }
  } catch (err) { showToast('Failed to delete group', 'error'); }
}

// ===== NAV DROPDOWN MENU (mobile) =====
const navMenuBtn = document.getElementById('navMenuBtn');
const navDropdown = document.getElementById('navDropdown');

function closeAllDropdowns() {
  if (navDropdown) navDropdown.classList.remove('show');
  const chatDd = document.getElementById('chatDropdown');
  if (chatDd) chatDd.classList.remove('show');
  const ovMenu = document.getElementById('overflowMenu');
  if (ovMenu) ovMenu.classList.remove('show');
}

if (navMenuBtn) {
  navMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = navDropdown && !navDropdown.classList.contains('show');
    closeAllDropdowns();
    if (willOpen && navDropdown) {
      navDropdown.classList.add('show');
      if (window.Nav && !window.Nav.has('navDropdown')) {
        window.Nav.push('navDropdown', () => navDropdown.classList.remove('show'));
      }
    }
  });
}

// Nav dropdown actions (Safely guarded)
document.getElementById('dropdownProfile')?.addEventListener('click', () => {
  if (navDropdown) navDropdown.classList.remove('show');
  showProfileModal();
});
document.getElementById('dropdownNotifications')?.addEventListener('click', () => {
  if (navDropdown) navDropdown.classList.remove('show');
  openNotificationsDrawer();
});

// ===== UNREAD NOTIFICATIONS DRAWER =====
function updateNotificationsBadge() {
  const notifBtn = document.getElementById('notificationsBtn');
  if (!notifBtn) return;
  // The Feedback Hub conversation itself is never a chat notification — its
  // unread "for me" replies are tracked separately (getFeedbackUnreadCount),
  // so exclude the hub from the chat-conversation sum to avoid double-counting.
  let totalUnread = conversations.reduce((sum, c) => sum + (c.id === 'feedback-global-hub' ? 0 : (c.unread || 0)), 0);
  // Feedback Hub "for me" thread replies (mentions + replies to my posts)
  // also count toward the bell badge.
  if (typeof window.getFeedbackUnreadCount === 'function') {
    totalUnread += (window.getFeedbackUnreadCount() || 0);
  }
  if (totalUnread > 0) {
    notifBtn.classList.add('has-dot');
    notifBtn.title = `Notifications (${totalUnread} unread)`;
  } else {
    notifBtn.classList.remove('has-dot');
    notifBtn.title = 'Notifications';
  }
}

function closeNotificationsDrawerInternal() {
  document.getElementById('notificationsOverlay')?.classList.remove('open');
}

function closeNotificationsDrawer() {
  if (window.Nav && window.Nav.has('notifications')) {
    window.Nav.back();
  } else {
    closeNotificationsDrawerInternal();
  }
}

function openNotificationsDrawer() {
  const overlay = document.getElementById('notificationsOverlay');
  const listEl = document.getElementById('notificationsList');
  if (!overlay || !listEl) return;

  // The Feedback Hub is not a chat notification — its unread replies render
  // as feedback items below, so never show it as a generic group conversation.
  const unreadConvs = conversations.filter(c => c.unread > 0 && c.id !== 'feedback-global-hub');
  const fbNotifs = (typeof window.getFeedbackNotifs === 'function') ? (window.getFeedbackNotifs() || []) : [];

  if (unreadConvs.length === 0 && fbNotifs.length === 0) {
    listEl.innerHTML = `
      <div style="padding:40px 16px;text-align:center;color:var(--text-muted);">
        <div style="font-size:2rem;margin-bottom:12px;">🔔</div>
        <h4 style="color:var(--text);font-size:0.95rem;font-weight:600;">All Caught Up!</h4>
        <p style="font-size:0.8rem;margin-top:4px;opacity:0.7;">You have no unread notifications.</p>
      </div>`;
  } else {
    // Chat conversation notifications
    const convItems = unreadConvs.map(c => {
      const lastText = c.lastMessage ? (c.lastMessage.text || (c.lastMessage.type === 'image' ? '📷 Photo' : c.lastMessage.type === 'voice' ? '🎤 Voice' : c.lastMessage.type === 'location' ? '📍 Location' : 'New message')) : 'New message';
      const timeStr = c.lastMessage && c.lastMessage.timestamp ? timeAgo(c.lastMessage.timestamp) : '';
      return `
        <div class="notif-item" data-id="${c.id}" data-type="${c.type}">
          <div class="notif-avatar">${avatarHtml(c.avatar, c.name)}</div>
          <div class="notif-details">
            <div class="notif-title-row">
              <span class="notif-name">${escapeHtml(c.name)}</span>
              <span class="notif-time">${timeStr}</span>
            </div>
            <div class="notif-text">${escapeHtml(lastText)}</div>
          </div>
          <div class="notif-badge">${c.unread}</div>
        </div>`;
    }).join('');

    // Feedback Hub "for me" thread replies (mentions + replies to my posts)
    // — tapping one jumps straight into the discussion thread.
    const fbItems = fbNotifs.map(n => {
      const char = (n.fromName || '?').charAt(0).toUpperCase();
      return `
        <div class="notif-item notif-feedback" data-fb-parent="${n.parentId}" data-fb-reply="${n.replyId}">
          <div class="notif-avatar">${escapeHtml(char)}</div>
          <div class="notif-details">
            <div class="notif-title-row">
              <span class="notif-name">${escapeHtml(n.fromName || 'Someone')}</span>
              <span class="notif-time">${timeAgo(n.timestamp)}</span>
            </div>
            <div class="notif-fb-label">${n.type === 'mention' ? '@ mentioned you' : '↩ replied to your post'}</div>
            <div class="notif-fb-quote">${escapeHtml(n.parentText || n.text)}</div>
          </div>
        </div>`;
    }).join('');

    listEl.innerHTML = convItems + fbItems;

    // Chat items → open the conversation (the hub is filtered out above and
    // feedback items are handled separately, so only real chats land here)
    listEl.querySelectorAll('.notif-item[data-id]').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        const type = item.dataset.type;
        closeNotificationsDrawer();
        if (type === 'group') {
          openGroup(id);
        } else {
          openDM(id);
        }
      });
    });

    // Feedback items → open the discussion thread. Use the internal close
    // (no history.back) so the pending popstate can't pop the 'feedback'
    // Nav entry that openDashboard() pushes right after this handler runs.
    listEl.querySelectorAll('.notif-item[data-fb-parent]').forEach(item => {
      item.addEventListener('click', () => {
        const parentId = item.dataset.fbParent;
        closeNotificationsDrawerInternal();
        if (typeof window.openFeedbackThread === 'function') window.openFeedbackThread(parentId);
      });
    });
  }

  overlay.classList.add('open');
  if (window.Nav && !window.Nav.has('notifications')) {
    window.Nav.push('notifications', closeNotificationsDrawerInternal);
  }
}

// Live refresh hook — feedback.js calls this whenever its "for me" thread
// notification list changes (new mention/reply, mark-read). Re-renders the
// drawer when open and always syncs the bell badge + count.
window.refreshNotificationsDrawer = function() {
  const overlay = document.getElementById('notificationsOverlay');
  if (overlay && overlay.classList.contains('open')) openNotificationsDrawer();
  updateNotificationsBadge();
};

document.getElementById('notificationsBtn')?.addEventListener('click', openNotificationsDrawer);
document.getElementById('closeNotificationsDrawer')?.addEventListener('click', closeNotificationsDrawer);
document.getElementById('notificationsOverlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeNotificationsDrawer();
});
document.getElementById('notifMarkAllReadBtn')?.addEventListener('click', () => {
  if (window.markAllRead) window.markAllRead();
  // "Mark all read" also clears Feedback Hub "for me" thread replies.
  if (typeof window.markAllFeedbackRead === 'function') window.markAllFeedbackRead();
  setTimeout(openNotificationsDrawer, 300);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('notificationsOverlay')?.classList.contains('open')) {
    closeNotificationsDrawer();
  }
});
document.getElementById('dropdownProfile')?.addEventListener('click', () => {
  navDropdown.classList.remove('show');
  showProfileModal();
});
document.getElementById('dropdownSettings')?.addEventListener('click', () => {
  navDropdown.classList.remove('show');
  openSettingsModal();
});
document.getElementById('dropdownNewGroup')?.addEventListener('click', () => {
  navDropdown.classList.remove('show');
  document.getElementById('newGroupBtn')?.click();
});
document.getElementById('logoutBtn')?.addEventListener('click', doLogout);
document.getElementById('dropdownLogout')?.addEventListener('click', () => {
  navDropdown.classList.remove('show');
  doLogout();
});
document.getElementById('dropdownTheme')?.addEventListener('click', () => {
  navDropdown.classList.remove('show');
  showToast('HiFi Dark Theme Active', 'info');
});
document.getElementById('dropdownFeedback')?.addEventListener('click', () => {
  navDropdown.classList.remove('show');
  if (typeof toggleDashboard === 'function') toggleDashboard();
});

// ===== OVERFLOW MENU (+) =====
const overflowBtn = document.getElementById('overflowBtn');
const overflowMenu = document.getElementById('overflowMenu');
overflowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const opening = !overflowMenu.classList.contains('show');
  closeAllDropdowns();
  if (opening) {
    overflowMenu.classList.add('show');
    if (window.Nav && !window.Nav.has('overflowMenu')) {
      window.Nav.push('overflowMenu', () => overflowMenu.classList.remove('show'));
    }
  }
});
// Close overflow menu when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.input-overflow')) {
    overflowMenu.classList.remove('show');
  }
});

// Close dropdowns on outside click / Escape
document.addEventListener('click', (e) => {
  if (!e.target.closest('.nav-dropdown') && !e.target.closest('#navMenuBtn') &&
      !e.target.closest('.chat-dropdown') && !e.target.closest('.chat-options-btn')) {
    closeAllDropdowns();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllDropdowns(); });

// ===== PROFILE MODAL (UPGRADED) =====
function closeProfileModal() {
  const m = document.getElementById('profileModal');
  if (m) m.classList.remove('show');
}

function showProfileModal() {
  let modal = document.getElementById('profileModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'profileModal';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) Nav.back(); });
  }
  const name = currentUser.displayName || currentUser.username;
  const bio = currentUser.bio || '';
  const msgCount = conversations.reduce((sum, c) => sum + c.unread, 0);
  const formattedMemberSince = currentUser.createdAt 
    ? new Date(currentUser.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
    : 'N/A';
  modal.innerHTML = `
    <div class="modal" style="max-width:400px;text-align:center;">
      <button class="modal-close" id="closeProfileModal" title="Close">${icon('x', 16)}</button>
      <h3>My Profile</h3>
      <div class="up-profile" style="margin-bottom:16px;">
        <div class="up-avatar" id="profileAvatar" title="Tap to change profile picture" style="cursor:pointer;position:relative;overflow:hidden;margin:0 auto 10px;width:80px;height:80px;border-radius:50%;box-shadow:0 4px 12px rgba(0,0,0,0.3);border:2px solid var(--accent);">${avatarHtml(currentUser.avatar, name)}</div>
        <h3 id="profileDisplayName" style="margin:6px 0 2px;font-size:1.15rem;">${escapeHtml(name)}</h3>
        <div class="up-username" style="font-size:0.85rem;color:var(--text-muted);">@${escapeHtml(currentUser.username)}</div>
        <div class="up-status online" style="margin-top:6px;font-size:0.8rem;color:#10b981;">● Online</div>
        <button class="btn-secondary" id="removeProfilePicBtn" style="margin-top:10px;font-size:0.78rem;padding:4px 10px;${currentUser.avatar ? '' : 'display:none;'}">Remove Picture</button>
      </div>
      <div class="profile-bio-section" style="margin-top:12px;">
        <div id="profileBioDisplay">
          <div class="profile-bio" id="profileBio" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:12px;text-align:left;font-size:0.88rem;color:var(--text-main);">${escapeHtml(bio) || '<span style="color:var(--text-muted);font-style:italic;">No bio set</span>'}</div>
        </div>
      </div>
    </div>`;
  if (!modal.classList.contains('show')) Nav.push('profile', closeProfileModal);
  modal.classList.add('show');
  modal.querySelector('#closeProfileModal').addEventListener('click', () => Nav.back());

  // Avatar (DP) upload handler - Tap avatar to upload new DP
  modal.querySelector('#profileAvatar').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async () => {
      const file = input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      try {
        const data = await uploadFile(file);
        if (data.success) {
          const profileRes = await fetch(api(`/api/users/${currentUser.id}/profile`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar: data.url })
          });
          const profileData = await profileRes.json();
          if (profileData.success) {
            currentUser.avatar = data.url;
            localStorage.setItem('user', JSON.stringify(currentUser));
            localStorage.setItem('hifi_user', JSON.stringify(currentUser));
            modal.querySelector('#profileAvatar').innerHTML = avatarHtml(data.url, name);
            const navAv = document.getElementById('navAvatar');
            if (navAv) navAv.innerHTML = avatarHtml(data.url, name);
            socket.emit('update_avatar', { userId: currentUser.id, avatarUrl: data.url });
            loadConversations();
            
            const removePicBtn = modal.querySelector('#removeProfilePicBtn');
            if (removePicBtn) removePicBtn.style.display = 'inline-block';
            
            showToast('Profile picture updated!', 'success');
          }
        }
      } catch (err) {
        console.error('Upload error:', err);
        showToast(err.message || 'Failed to upload', 'error');
      }
    };
    input.click();
  });

  // Remove Picture handler
  const removePicBtn = modal.querySelector('#removeProfilePicBtn');
  if (removePicBtn) {
    removePicBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await fetch(api(`/api/users/${currentUser.id}/profile`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ avatar: null })
        });
        const data = await res.json();
        if (data.success) {
          currentUser.avatar = null;
          localStorage.setItem('user', JSON.stringify(currentUser));
          localStorage.setItem('hifi_user', JSON.stringify(currentUser));
          const name2 = currentUser.displayName || currentUser.username;
          modal.querySelector('#profileAvatar').innerHTML = avatarHtml(null, name2);
          const navAv = document.getElementById('navAvatar');
          if (navAv) navAv.innerHTML = avatarHtml(null, name2);
          socket.emit('update_avatar', { userId: currentUser.id, avatarUrl: null });
          removePicBtn.style.display = 'none';
          loadConversations();
          showToast('Profile picture removed', 'success');
        }
      } catch (e) {
        showToast('Failed to remove picture', 'error');
      }
    });
  }
}

// ===== CHAT INFO MODAL (mobile — mirrors the right panel) =====
function closeChatInfoModalInternal() {
  const modal = document.getElementById('chatInfoModal');
  if (modal) modal.classList.remove('show');
}

function closeChatInfoModal() {
  if (window.Nav && window.Nav.has('chatInfoModal')) {
    window.Nav.back();
  } else {
    closeChatInfoModalInternal();
  }
}

function showChatInfoModal() {
  let modal = document.getElementById('chatInfoModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'chatInfoModal';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeChatInfoModal(); });
  }
  // Reuse the content already built into the right user panel
  const info = userPanelContent.innerHTML || '<div class="up-empty-note">No details available</div>';
  modal.innerHTML = `
    <div class="modal chat-info-modal-card">
      <button class="modal-close" id="closeChatInfoModal" title="Close">${icon('x', 16)}</button>
      <h3 class="chat-info-title">Chat Info</h3>
      <div class="chat-info-body">${info}</div>
    </div>`;
  modal.classList.add('show');
  if (window.Nav && !window.Nav.has('chatInfoModal')) {
    window.Nav.push('chatInfoModal', closeChatInfoModalInternal);
  }
  modal.querySelector('#closeChatInfoModal').addEventListener('click', closeChatInfoModal);
  modal.querySelectorAll('.up-media-grid img').forEach(img => {
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(img.dataset.full || img.src);
    });
  });
  // Re-attach group management event listeners for mobile (modal reuses innerHTML, losing listeners)
  const body = modal.querySelector('.chat-info-body');
  body.querySelector('.up-add-members-btn')?.addEventListener('click', (e) => showAddMemberModal(e.currentTarget.dataset.groupId));
  body.querySelector('.up-leave-group-btn')?.addEventListener('click', (e) => leaveGroup(e.currentTarget.dataset.groupId));
  body.querySelectorAll('.remove-member-btn').forEach(btn => {
    btn.addEventListener('click', () => removeGroupMember(btn.dataset.groupId, btn.dataset.userId));
  });
  body.querySelector('.up-delete-group-btn')?.addEventListener('click', (e) => {
    if (confirm('Delete this group for everyone? This cannot be undone.')) {
      deleteGroup(e.currentTarget.dataset.groupId);
    }
  });
  body.querySelector('.up-mute-btn')?.addEventListener('click', async (e) => {
    const targetId = e.currentTarget.dataset.target;
    const action = isMuted(targetId) ? 'unmute' : 'mute';
    await handleMuteConversation(targetId, action);
    modal.classList.remove('show');
  });
  // Edit group name (modal)
  body.querySelector('.up-group-name')?.addEventListener('click', async (e) => {
    const gid = e.currentTarget.dataset.groupId;
    const newName = prompt('Enter new group name:', activeChat ? activeChat.name : '');
    if (newName && newName.trim()) {
      await updateGroupInfo(gid, { name: newName.trim() });
      modal.classList.remove('show');
    }
  });
  // Upload group DP (modal)
  body.querySelector('.up-avatar-editable')?.addEventListener('click', (e) => {
    const gid = e.currentTarget.dataset.groupId;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async () => {
      const file = input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      try {
        const data = await uploadFile(file);
        if (data.success) {
          await updateGroupInfo(gid, { avatar: data.url });
          modal.classList.remove('show');
        }
      } catch (err) {
        showToast('Failed to upload', 'error');
      }
    };
    input.click();
  });
  // Friend Compatibility card in the mobile modal: the modal clones the panel's
  // innerHTML, which (a) loses the async-loaded score (stuck on the shimmer)
  // and (b) loses the Share button's click listener. Re-render the card into
  // the modal's copy from the cache, or fetch it fresh into this exact body.
  const modalCompatBody = body.querySelector('.up-compat-body');
  if (modalCompatBody && activeChat && activeChat.type === 'dm' && String(activeChat.id) !== String(currentUser.id)) {
    if (lastCompatData && lastCompatPartnerId === String(activeChat.id)) {
      renderCompatCard(modalCompatBody, lastCompatData);
    } else {
      loadFriendCompatibility(String(activeChat.id), modalCompatBody);
    }
  }
}

// ===== EMOJI PICKER (INPUT) — CATEGORIES =====
emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!emojiPicker.querySelector('emoji-picker')) {
    buildEmojiPicker();
  }
  emojiPicker.style.display = emojiPicker.style.display === 'flex' ? 'none' : 'flex';
});

function buildEmojiPicker() {
  emojiPicker.innerHTML = '<emoji-picker id="chatEmojiPicker"></emoji-picker>';
  document.getElementById('chatEmojiPicker').addEventListener('emoji-click', (e) => {
    messageInput.value += e.detail.unicode;
    messageInput.focus();
  });
}

document.addEventListener('click', (e) => {
  if (emojiPicker.style.display === 'flex' && !emojiPicker.contains(e.target) && !emojiBtn.contains(e.target)) {
    emojiPicker.style.display = 'none';
  }
});

// ===== HELPERS =====
function formatLastSeen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'today at ' + time;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'yesterday at ' + time;
  return d.toLocaleDateString() + ' ' + time;
}

function formatDateLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

function getInitials(name) {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(api('/api/upload'), { method: 'POST', body: formData });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(text || res.statusText || 'Upload failed');
  }
  if (!res.ok || !data.success) {
    throw new Error((data && data.error) || 'Upload failed');
  }
  return data;
}

function avatarHtml(url, name) {
  if (!url) return getInitials(name || '?');
  const src = safeUrl(absUrl(url), true);
  if (!src) return getInitials(name || '?');
  return `<img src="${attrEsc(src)}" alt="${attrEsc(name || 'Avatar')}" data-avatar-fallback="${attrEsc(getInitials(name || '?'))}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Attribute-context escaping (quotes + angle brackets). escapeHtml() above is
// fine for text nodes but does NOT escape double quotes, so any user-controlled
// value placed inside an attribute (title, src, data-*) must go through this.
// Named attrEsc (not attrEscape) to avoid shadowing admin.js's global of the
// same name — both load on the same page and top-level function declarations
// would otherwise override each other silently.
function attrEsc(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ===== READ RECEIPTS V2 =====
// Deterministic accent color per user for the mini read-receipt avatars.
const RR_COLORS = ['#7c5cfc', '#5a8dee', '#e08a3c', '#3fae8f', '#d6638f', '#8e7cf0'];
function initialsColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return RR_COLORS[h % RR_COLORS.length];
}

// Who has read a sent group message (excludes me + the author).
function readReceiptReaders(msg) {
  if (!msg || !activeChat || activeChat.type !== 'group') return [];
  if (String(msg.from) !== String(currentUser.id)) return [];
  return (msg.readBy || []).filter(id =>
    String(id) !== String(currentUser.id) && String(id) !== String(msg.from));
}

function readReceiptNames(msg) {
  return readReceiptReaders(msg).map(id => getUserName(id) || 'Someone');
}

// Render the "seen by" avatar stack: up to 4 initials + a +N overflow chip.
// Readers whose display name isn't cached yet get a '…' placeholder that is
// swapped for the real initial once prefetchReceiptReaderNames() resolves.
function renderReadReceiptsHtml(msg) {
  const readers = readReceiptReaders(msg);
  if (!readers.length) return '';
  const MAX = 4;
  const shown = readers.slice(0, MAX);
  const overflow = readers.length - shown.length;
  const title = readReceiptNames(msg).join(', ');
  const chips = shown.map(id => {
    const nm = userNameCache[id] || '';
    const label = nm ? getInitials(nm) : '…';
    return `<span class="mini-avatar${nm ? '' : ' rr-loading'}" data-rr="${attrEsc(id)}" title="${attrEsc(nm || 'Loading name…')}" style="background:${initialsColor(id)};">${escapeHtml(label)}</span>`;
  }).join('');
  const chip = overflow > 0 ? `<span class="rr-overflow" title="${attrEsc(title)}">+${overflow}</span>` : '';
  return `<div class="read-receipts" title="${attrEsc(title)}"><div class="read-receipt-avatars">${chips}${chip}</div></div>`;
}

// Refresh (or remove) the read-receipt stack on a rendered message element.
function refreshReadReceipts(msgEl, msg) {
  if (!msgEl || !msg) return;
  const old = msgEl.querySelector('.read-receipts');
  if (old) old.remove();
  const html = renderReadReceiptsHtml(msg);
  if (!html) return;
  const bubble = msgEl.querySelector('.message-bubble');
  (bubble || msgEl).insertAdjacentHTML('beforeend', html);
}

// ===== SEEN BY POPUP (click the receipt avatars on a sent group message) =====
// Opens a compact reader list (name + read time) for one sent group message,
// using the same readBy/readAt data as the bubble avatar stack. Only the
// current user's own sent messages can have "seen by" info that is meaningful.

// Format a read timestamp compactly: "4:42 PM" today, "Jul 28, 4:42 PM" older.
function formatReadTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const isToday = d.toDateString() === new Date().toDateString();
  return isToday ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

// Readers of a sent group message: [{ id, name, at }], oldest read first.
// name is '' while the display name is still loading (shimmer placeholder).
function seenByReaders(msg) {
  if (!msg || String(msg.from) !== String(currentUser.id)) return [];
  return (msg.readBy || []).map(id => ({
    id,
    name: userNameCache[id] || '',
    at: (msg.readAt && msg.readAt[id]) || ''
  })).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

let seenByPopupMsgId = null;

// Open the popup for a sent group message (from clicking its receipt avatars).
function openSeenByPopup(msg) {
  if (!msg || !activeChat || activeChat.type !== 'group') return;
  if (String(msg.from) !== String(currentUser.id)) return;
  seenByPopupMsgId = String(msg.id);
  renderSeenByPopup(msg);
  const pop = document.getElementById('seenByModal');
  if (pop) {
    pop.classList.add('show');
    pop.setAttribute('aria-hidden', 'false');
  }
  // Resolve any still-loading reader names so the list fills in immediately.
  if (typeof prefetchReceiptReaderNames === 'function') {
    prefetchReceiptReaderNames([msg]).catch(() => {});
  }
}


// Render the reader list (name + read time) into the open popup.
function renderSeenByPopup(msg) {
  const modal = document.getElementById('seenByModal');
  if (!modal) return;
  const previewEl = modal.querySelector('.seenby-popup-preview');
  if (previewEl && msg) {
    previewEl.textContent = (msg.text ||
      (msg.type === 'image' ? '📷 Photo' : msg.type === 'voice' ? '🎤 Voice' : msg.type === 'location' ? '📍 Location' : ''));
    previewEl.title = msg.text ? String(msg.text) : '';
  }
  const listEl = modal.querySelector('.seenby-popup-list');
  if (!listEl) return;
  const readers = seenByReaders(msg);
  if (!readers.length) {
    listEl.innerHTML = '<div class="up-empty-note">No one has read this yet.</div>';
    return;
  }
  listEl.innerHTML = readers.map(r => `
    <div class="up-seenby-reader" data-reader-id="${attrEsc(r.id)}" role="button" tabindex="0" title="Open chat with ${escapeHtml(r.name || 'this user')}">
      <span class="mini-avatar${r.name ? '' : ' rr-loading'}" style="background:${initialsColor(r.id)};">${r.name ? escapeHtml(getInitials(r.name)) : '…'}</span>
      ${r.name
        ? `<span class="up-seenby-name">${escapeHtml(r.name)}${adminBadgeHtml(r.id)}</span>`
        : '<span class="up-seenby-name"><span class="up-seenby-name-loading shimmer"></span></span>'}
      <span class="up-seenby-time">${escapeHtml(formatReadTime(r.at))}</span>
    </div>`).join('');
  // Tapping a reader opens a direct chat with them and closes the popup.
  listEl.querySelectorAll('.up-seenby-reader').forEach(row => {
    const openChat = (e) => {
      e.stopPropagation();
      const uid = row.dataset.readerId;
      if (!uid) return;
      closeSeenByPopup();
      openDM(uid);
    };
    row.addEventListener('click', openChat);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(e); }
    });
  });
}

// Close the popup.
function closeSeenByPopup() {
  seenByPopupMsgId = null;
  const modal = document.getElementById('seenByModal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
}

// Live-refresh the open popup from the freshest DOM message data.
function refreshSeenByPopup() {
  if (!seenByPopupMsgId) return;
  const el = chatMessages.querySelector(`[data-msg-id="${seenByPopupMsgId}"]`);
  if (el && el._msgData) renderSeenByPopup(el._msgData);
}

// Prefetch display names for every READER (readBy) in a batch of messages, then
// refresh the rendered receipt avatars and the Chat Info "Seen By" card in
// place. Sender/member names were already prefetched on chat open — reader
// names were not, which left '…' placeholders until a live read event arrived.
// Returns how many names were newly fetched.
async function prefetchReceiptReaderNames(messages) {
  const readerIds = [];
  (messages || []).forEach(m => {
    (m.readBy || []).forEach(id => { if (id && !readerIds.includes(id)) readerIds.push(id); });
  });
  const fetched = await prefetchNames(readerIds);
  if (fetched > 0) {
    // Bubbles: rebuild the receipt stacks with resolved names.
    chatMessages.querySelectorAll('[data-msg-id]').forEach(el => {
      if (el._msgData && String(el._msgData.from) === String(currentUser.id)) {
        refreshReadReceipts(el, el._msgData);
      }
    });
    // Open "Seen By" popup (if any) with resolved reader names.
    if (typeof refreshSeenByPopup === 'function') refreshSeenByPopup();
  }
  return fetched;
}

// Sanitize a user-supplied URL before it is placed into a src/href attribute.
// Returns the URL only when it matches an allowed scheme, otherwise '' so the
// caller can fall back to a safe placeholder. Combined with escapeHtml() at
// the call sites this blocks attribute-breakout stored XSS (e.g.
// 'x" onerror=...') and dangerous schemes (javascript:). `allowDataImage`
// additionally permits data:image/* URLs (inline camera/avatar flows).
function safeUrl(url, allowDataImage) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  // Reject any URL carrying characters that could break out of an HTML
  // attribute even after escaping: quotes, angle brackets, backticks, and
  // control/whitespace-injection chars. Defense in depth — call sites still
  // use attrEsc(), but a hostile URL like https://x/" onerror=... must never
  // get past this gate in the first place.
  if (/["'<>`\u0000-\u001f]/.test(trimmed)) return '';
  if (/^data:image\//i.test(trimmed)) return allowDataImage ? trimmed : '';
  // Same-origin paths (/uploads/...) and absolute http(s) URLs are allowed.
  if (/^\/(?!\/)/.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;
  return '';
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateUserStatus(userId, online) {
  if (activeChat && activeChat.type === 'dm' && activeChat.id === userId) {
    activeChat.online = online;
    renderActiveChat();
  }
}

function updateChatHeaderStatus() {
  const statusEl = chatHeader?.querySelector('.chat-header-info p');
  if (!statusEl || !activeChat) return;

  const typers = activeTyping[activeChat.id];
  if (typers && typers.size > 0) {
    const names = Array.from(typers).map(id => getUserName(id) || 'Someone');
    let text;
    if (activeChat.type === 'group') {
      if (names.length > 1) {
        text = `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and others' : ''} are typing...`;
      } else {
        text = `${names[0]} is typing...`;
      }
    } else {
      text = 'typing...';
    }
    statusEl.className = 'online';
    statusEl.innerHTML = `<span style="color:var(--accent); font-weight:500; display:inline-flex; align-items:center; gap:4px;">${text}</span>`;
    return;
  }

  const isOnline = activeChat.type === 'dm' && activeChat.online;
  let statusText;
  if (activeChat.type === 'group') {
    statusText = activeChat.members.length + ' members';
  } else if (isOnline) {
    statusText = 'Online';
  } else {
    statusText = activeChat.lastSeen ? 'last seen ' + formatLastSeen(activeChat.lastSeen) : 'Offline';
  }
  const isBlocked = activeChat.type === 'dm' && blockedUsers.has(activeChat.id);
  statusEl.className = isOnline ? 'online' : '';
  statusEl.innerHTML = `${escapeHtml(statusText)}${isBlocked ? ' · Blocked' : ''}${isMuted(activeChat.id) ? ' · 🔇 Muted' : ''}`;
}

function showTypingIndicator(fromUserId) {
  let el = document.getElementById('typingIndicator');
  if (!el) {
    el = document.createElement('div');
    el.className = 'message received';
    el.id = 'typingIndicator';
    chatMessages.appendChild(el);
  }

  if (activeChat && activeChat.type === 'group') {
    // Aggregate EVERY member currently typing in this group, e.g.
    // "Alice is typing…" / "Alice and Bob are typing…" / "Alice, Bob +2 are typing…".
    const typers = activeTyping[activeChat.id];
    const names = typers ? Array.from(typers).map(id => getUserName(id)).filter(n => n && n !== '...') : [];
    let label;
    if (names.length === 1) label = `${names[0]} is typing`;
    else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`;
    else if (names.length > 2) label = `${names.slice(0, 2).join(', ')} and ${names.length - 2} other${names.length - 2 > 1 ? 's' : ''} are typing`;
    else label = 'Someone is typing';
    el.innerHTML = `
      <div class="message-bubble typing-bubble" style="padding: 10px 14px;">
        <div class="typing-bubble-text">${escapeHtml(label)}</div>
        <div class="typing-indicator" style="padding-top: 2px;">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="message-bubble typing-bubble" style="padding: 10px 14px; align-items: center; justify-content: center; width: 68px;">
        <div class="typing-indicator">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    `;
  }

  scrollToBottom();
}

function hideTypingIndicator(fromUserId) {
  if (activeChat && activeChat.type === 'group') {
    const typers = activeTyping[activeChat.id];
    if (typers && typers.size > 0) {
      const nextTyper = Array.from(typers)[0];
      showTypingIndicator(nextTyper);
      return;
    }
  }
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

// Removed - using loadConversations() instead

// Store user names cache
const userNameCache = {};

// Cached global-admin flags per user id (populated alongside prefetchNames and
// conversation loads). Powers the gold crown badges next to admin names.
const userRoleCache = {};

function isCachedAdmin(userId) {
  return !!(userId && userRoleCache[userId]);
}

// Crown badge shown next to a user's name when they're a global admin.
// Tooltip on every global-admin crown — makes clear the badge is server-
// assigned, not self-appointed. One constant keeps all surfaces in sync.
const ADMIN_BADGE_TITLE = 'Verified admin — assigned by the server';

function adminBadgeHtml(userId, size = 12) {
  return isCachedAdmin(userId)
    ? `<span class="admin-badge" title="${ADMIN_BADGE_TITLE}">${icon('crown', size)}</span>`
    : '';
}

// Background-fetch just the admin flag for an id whose name is already cached
// (socket handlers like messages_read cache names without a role, so badges
// would otherwise silently stay missing until a full reload).
function prefetchRole(userId) {
  if (!userId || userRoleCache[userId] !== undefined) return;
  fetch(api(`/api/users/${userId}`)).then(r => r.json()).then(d => {
    if (d && d.user && typeof d.user.isAdmin === 'boolean') {
      userRoleCache[userId] = d.user.isAdmin;
      // A reader just arrived — refresh an open Seen By popup so the crown pops in.
      if (typeof refreshSeenByPopup === 'function') refreshSeenByPopup();
    }
  }).catch(() => {});
}

// Synchronous name lookup (cache must be pre-populated via prefetchNames)
function getUserName(userId) {
  return userNameCache[userId] || '...';
}

// Prefetch + cache display names for a list of user IDs
async function prefetchNames(userIds) {
  const missing = userIds.filter(id => id && !userNameCache[id]);
  await Promise.all(missing.map(async id => {
    try {
      const res = await fetch(api(`/api/users/${id}`));
      const data = await res.json();
      userNameCache[id] = data.user.displayName || data.user.username;
      if (data.user && typeof data.user.isAdmin === 'boolean') userRoleCache[id] = data.user.isAdmin;
    } catch { userNameCache[id] = 'Unknown'; }
  }));
  return missing.length; // how many names were actually fetched this call
}

// ===== TOAST NOTIFICATIONS =====
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: icon('check-circle', 16), error: icon('x-circle', 16), info: icon('info', 16) };
  toast.innerHTML = `${icons[type] || 'ℹ️'} ${escapeHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ===== PUSH NOTIFICATIONS =====
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendPushNotification(title, body, tag) {
  if (typeof userSettings !== 'undefined' && userSettings.pushEnabled === false) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Guard: Never show push notification if app tab is focused and user is in active chat
  if (document.hasFocus() && document.visibilityState === 'visible' && activeChat) return;
  try {
    new Notification(title, { body, tag, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%230088cc"/><text x="50" y="65" text-anchor="middle" font-size="50" fill="white" font-family="sans-serif">H</text></svg>' });
  } catch {}
}

// ===== NOTIFICATION SOUND =====
function playNotificationSound(force = false) {
  if (!force && typeof userSettings !== 'undefined' && userSettings.soundEnabled === false) return;
  // Guard: Do not play notification sound if app is currently focused and in active conversation
  if (!force && document.hasFocus() && document.visibilityState === 'visible' && activeChat) return;
  try {
    const audio = document.getElementById('notificationSound');
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    }
  } catch {}
}

// ===== LINK PREVIEW DETECTION =====
function extractUrls(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
  const matches = text.match(urlRegex) || [];
  return matches.map(u => u.toLowerCase().startsWith('www.') ? 'https://' + u : u);
}

async function generateLinkPreview(url) {
  try {
    const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}&callback=`);
    const data = await res.json();
    if (!data.contents) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(data.contents, 'text/html');
    const title = doc.querySelector('meta[property="og:title"]')?.content || doc.title || url;
    const desc = doc.querySelector('meta[property="og:description"]')?.content || '';
    const domain = new URL(url).hostname.replace('www.', '');
    return { title, desc, domain, url };
  } catch {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      return { title: url, desc: '', domain, url };
    } catch { return null; }
  }
}

function generateLinkPreviewHtml(preview) {
  if (!preview) return '';
  return `<div class="link-preview" data-link-url="${attrEsc(preview.url)}">
    <div class="lp-title">${escapeHtml(preview.title)}</div>
    ${preview.desc ? `<div class="lp-desc">${escapeHtml(preview.desc)}</div>` : ''}
    <div class="lp-domain">${escapeHtml(preview.domain)}</div>
  </div>`;
}

// ===== MARKDOWN FORMATTING (simple) =====
function formatMessageText(text) {
  if (!text) return '';
  let formatted = escapeHtml(text);
  // Code blocks
  formatted = formatted.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  formatted = formatted.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Strikethrough
  formatted = formatted.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Blockquote
  formatted = formatted.replace(/^&gt;\s(.+)$/gm, '<blockquote>$1</blockquote>');
  // Links
  formatted = formatted.replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  // Line breaks
  formatted = formatted.replace(/\n/g, '<br>');
  return formatted;
}

// ===== VOICE RECORDER =====
let mediaRecorder = null;
let audioChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;
let recordedBlob = null;
let audioContext = null;
let analyser = null;

const voiceRecorderOverlay = document.getElementById('voiceRecorderOverlay');
const voiceTimer = document.getElementById('voiceTimer');
const startRecordBtn = document.getElementById('startRecordBtn');
const stopRecordBtn = document.getElementById('stopRecordBtn');
const sendVoiceBtn = document.getElementById('sendVoiceBtn');
const cancelVoiceBtn = document.getElementById('cancelVoiceBtn');
const voiceCanvas = document.getElementById('voiceCanvas');

function closeVoiceRecorderInternal() {
  if (voiceRecorderOverlay) {
    voiceRecorderOverlay.classList.remove('show');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    resetVoiceRecorder();
  }
}

function closeVoiceRecorder() {
  if (window.Nav && window.Nav.has('voiceRecorder')) {
    window.Nav.back();
  } else {
    closeVoiceRecorderInternal();
  }
}

document.getElementById('voiceBtn')?.addEventListener('click', () => {
  voiceRecorderOverlay.classList.add('show');
  if (window.Nav && !window.Nav.has('voiceRecorder')) {
    window.Nav.push('voiceRecorder', closeVoiceRecorderInternal);
  }
  resetVoiceRecorder();
});

document.getElementById('closeVoiceRecorder')?.addEventListener('click', closeVoiceRecorder);
cancelVoiceBtn?.addEventListener('click', closeVoiceRecorder);
voiceRecorderOverlay?.addEventListener('click', (e) => {
  if (e.target === voiceRecorderOverlay) closeVoiceRecorder();
});

function resetVoiceRecorder() {
  audioChunks = [];
  recordedBlob = null;
  recordingSeconds = 0;
  voiceTimer.textContent = '0:00';
  startRecordBtn.style.display = 'inline-block';
  stopRecordBtn.style.display = 'none';
  sendVoiceBtn.style.display = 'none';
  cancelVoiceBtn.style.display = 'none';
  if (audioContext) { audioContext.close(); audioContext = null; }
  clearCanvas();
}

function clearCanvas() {
  if (!voiceCanvas) return;
  const ctx = voiceCanvas.getContext('2d');
  ctx.clearRect(0, 0, voiceCanvas.width, voiceCanvas.height);
}

startRecordBtn?.addEventListener('click', async () => {
  // Clean up any previous recording session first
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); }
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  audioChunks = [];
  recordedBlob = null;
  recordingSeconds = 0;
  clearCanvas();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    audioChunks = [];

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    source.connect(analyser);
    drawWaveform();

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recordedBlob = new Blob(audioChunks, { type: 'audio/webm' });
      clearInterval(recordingTimer);
    };

    mediaRecorder.start();
    startRecordBtn.style.display = 'none';
    stopRecordBtn.style.display = 'inline-block';
    cancelVoiceBtn.style.display = 'inline-block';
    recordingSeconds = 0;
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      const m = Math.floor(recordingSeconds / 60);
      const s = recordingSeconds % 60;
      voiceTimer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);
  } catch {
    showToast('Microphone access denied', 'error');
  }
});

function drawWaveform() {
  if (!analyser || !voiceCanvas) return;
  const canvas = voiceCanvas;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (mediaRecorder && mediaRecorder.state === 'inactive') { clearCanvas(); return; }
    requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);
    ctx.fillStyle = '#333333';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    const sliceWidth = canvas.width / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = v * canvas.height / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }
  draw();
}

stopRecordBtn?.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    clearInterval(recordingTimer);
    stopRecordBtn.style.display = 'none';
    sendVoiceBtn.style.display = 'inline-block';
    cancelVoiceBtn.style.display = 'inline-block';
  }
});

sendVoiceBtn?.addEventListener('click', () => {
  if (!recordedBlob || !activeChat) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const audioDataUrl = ev.target.result;
    if (activeChat.type === 'dm') {
      socket.emit('send_message', {
        from: currentUser.id, to: activeChat.id, text: '', type: 'voice',
        mediaUrl: audioDataUrl, duration: recordingSeconds
      });
    } else {
      socket.emit('send_group_message', {
        from: currentUser.id, groupId: activeChat.id, text: '', type: 'voice',
        mediaUrl: audioDataUrl, duration: recordingSeconds
      });
    }
    closeVoiceRecorder();
    showToast('Voice message sent!', 'success');
  };
  reader.readAsDataURL(recordedBlob);
});

// ===== MESSAGE SEARCH =====
const msgSearchOverlay = document.getElementById('msgSearchOverlay');
const msgSearchInput = document.getElementById('msgSearchInput');
const msgSearchResults = document.getElementById('msgSearchResults');

function closeMessageSearchInternal() {
  if (msgSearchOverlay) {
    msgSearchOverlay.classList.remove('show');
  }
}

function closeMessageSearch() {
  if (window.Nav && window.Nav.has('msgSearch')) {
    window.Nav.back();
  } else {
    closeMessageSearchInternal();
  }
}

function openMessageSearchModal() {
  if (!msgSearchOverlay) return;
  msgSearchOverlay.classList.add('show');
  if (window.Nav && !window.Nav.has('msgSearch')) {
    window.Nav.push('msgSearch', closeMessageSearchInternal);
  }
  msgSearchInput.value = '';
  msgSearchResults.innerHTML = '';
  if (activeChat) {
    msgSearchInput.placeholder = `Search in ${activeChat.name}...`;
  } else {
    msgSearchInput.placeholder = 'Search messages...';
  }
  msgSearchInput.focus();
}

document.getElementById('dropdownSearchMessages')?.addEventListener('click', () => {
  navDropdown.classList.remove('show');
  openMessageSearchModal();
});
document.getElementById('closeMsgSearch')?.addEventListener('click', closeMessageSearch);
msgSearchOverlay?.addEventListener('click', (e) => { if (e.target === msgSearchOverlay) closeMessageSearch(); });

let msgSearchTimeout = null;
msgSearchInput?.addEventListener('input', () => {
  clearTimeout(msgSearchTimeout);
  const q = msgSearchInput.value.trim();
  if (!q) { msgSearchResults.innerHTML = ''; return; }
  msgSearchTimeout = setTimeout(async () => {
    try {
      let url;
      if (activeChat && activeChat.type === 'group') {
        url = api(`/api/messages/search?q=${encodeURIComponent(q)}&groupId=${activeChat.id}`);
      } else {
        url = api(`/api/messages/search?q=${encodeURIComponent(q)}&userId=${currentUser.id}`);
      }
      const res = await fetch(url);
      const data = await res.json();
      let messages = data.messages || [];

      // First filter out messages that were cleared locally for their respective chats
      messages = messages.filter(m => {
        const chatId = String(m.groupId || (String(m.from) === String(currentUser.id) ? m.to : m.from));
        if (clearedChats[chatId]) {
          const clearedTime = Number(clearedChats[chatId]);
          const msgTime = new Date(m.timestamp || m.createdAt || Date.now()).getTime();
          return msgTime > clearedTime;
        }
        return true;
      });

      // Filter results strictly to the current active open chat
      if (activeChat) {
        if (activeChat.type === 'dm') {
          messages = messages.filter(m => (String(m.from) === String(activeChat.id) || String(m.to) === String(activeChat.id)));
        } else if (activeChat.type === 'group') {
          messages = messages.filter(m => String(m.groupId) === String(activeChat.id));
        }
      }

      if (messages.length > 0) {
        msgSearchResults.innerHTML = messages.slice(0, 30).map(msg => {
          const text = msg.text || (msg.type === 'image' ? '📷 Photo' : msg.type === 'voice' ? '🎤 Voice' : msg.type === 'location' ? '📍 Location' : '');
          const date = new Date(msg.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
          return `<div class="msg-search-item" data-msg-id="${msg.id}">
            <span class="msg-search-text">${escapeHtml(text.substring(0, 80))}</span>
            <span class="msg-search-date">${date}</span>
          </div>`;
        }).join('');
        msgSearchResults.querySelectorAll('.msg-search-item').forEach(item => {
          item.addEventListener('click', () => {
            msgSearchOverlay.classList.remove('show');
            const targetMsg = messages.find(m => String(m.id) === item.dataset.msgId);
            if (!targetMsg) return;

            let chatToOpenId = null;
            let isGroup = false;
            if (targetMsg.groupId) {
              chatToOpenId = targetMsg.groupId;
              isGroup = true;
            } else {
              chatToOpenId = (String(targetMsg.from) === String(currentUser.id)) ? targetMsg.to : targetMsg.from;
            }

            const jumpToMsg = () => {
              const el = document.querySelector(`[data-msg-id="${item.dataset.msgId}"]`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('message-highlight-flash');
                setTimeout(() => el.classList.remove('message-highlight-flash'), 2000);
              }
            };

            if (!activeChat || String(activeChat.id) !== String(chatToOpenId)) {
              if (isGroup) openGroup(chatToOpenId);
              else openDM(chatToOpenId);
              setTimeout(jumpToMsg, 800);
            } else {
              jumpToMsg();
            }
          });
        });
      } else {
        msgSearchResults.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-muted);">No messages found ${activeChat ? 'in ' + escapeHtml(activeChat.name) : ''}</div>`;
      }
    } catch { msgSearchResults.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);">Search failed</div>'; }
  }, 300);
});

// ===== CLICK REPLY QUOTE TO SMOOTH SCROLL & HIGHLIGHT TARGET MESSAGE =====
document.addEventListener('click', (e) => {
  const quote = e.target.closest('.reply-quote');
  if (quote && quote.dataset.targetId) {
    const targetEl = document.querySelector(`[data-msg-id="${quote.dataset.targetId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('message-highlight-flash');
      setTimeout(() => {
        targetEl.classList.remove('message-highlight-flash');
      }, 2000);
    }
  }
});

// ===== AUTO LOGIN & AUTH ANIMATIONS =====
initAuthWave();
initLogoWave();

// Tell the native layer the web bundle booted OK — fired at the earliest safe
// moment, BEFORE login. The rollback guard must be armed whenever the bundle
// renders at all, otherwise an app that boots to the login screen (expired
// session) would never confirm ready and the next launch would revert a good
// OTA update to the old version.
notifyNativeAppReady();

const savedToken = localStorage.getItem('token');
window.APP_TOKEN = savedToken || null;
const savedUser = localStorage.getItem('user');
if (savedToken && savedUser) {
  try {
    currentUser = JSON.parse(savedUser);
    window.currentUser = currentUser;
    enterChat();
  } catch (e) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.APP_TOKEN = null;
    currentUser = null;
    window.currentUser = null;
    authPage.style.display = 'flex';
    chatApp.style.display = 'none';
    initAuthWave();
    initLogoWave();
  }
} else {
  authPage.style.display = 'flex';
  chatApp.style.display = 'none';
  initAuthWave();
  initLogoWave();
}

// ============ WEBRTC DIRECT P2P FILE TRANSFER ENGINE ============
const p2pTransfers = {}; // transferId -> { pc, dc, file, chunks, totalReceived, meta, startTime }
const pendingP2PAccept = new Set(); // transferIds the user already tapped Accept on (offer may arrive later)
let p2pStatusMap = {};
try { p2pStatusMap = JSON.parse(localStorage.getItem('p2p_status') || '{}'); } catch(e){}

function setP2PStatus(pId, status, msgId = null) {
  if (pId) p2pStatusMap[pId] = status;
  if (msgId) p2pStatusMap[msgId] = status;
  try { localStorage.setItem('p2p_status', JSON.stringify(p2pStatusMap)); } catch(e){}
  if (socket) {
    socket.emit('p2p_update_status', { transferId: pId, msgId, status });
  }
}

const p2pAttachBtn = document.getElementById('p2pAttachBtn');
const p2pFileInput = document.getElementById('p2pFileInput');

if (p2pAttachBtn && p2pFileInput) {
  p2pAttachBtn.addEventListener('click', () => {
    if (overflowMenu) overflowMenu.classList.remove('show');
    if (!activeChat || activeChat.type === 'group') {
      alert('P2P Direct Sharing is available for 1-on-1 direct chats.');
      return;
    }
    p2pFileInput.click();
  });

  p2pFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    startP2PSender(file);
    p2pFileInput.value = '';
  });
}

const p2pInfoBtn = document.getElementById('p2pInfoBtn');
const p2pInfoModal = document.getElementById('p2pInfoModal');
const p2pInfoClose = document.getElementById('p2pInfoClose');
const p2pInfoBackdrop = document.getElementById('p2pInfoBackdrop');

if (p2pInfoBtn && p2pInfoModal) {
  p2pInfoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (overflowMenu) overflowMenu.classList.remove('show');
    p2pInfoModal.style.display = 'flex';
    Nav.push('p2pInfoModal', () => {
      p2pInfoModal.style.display = 'none';
    });
  });

  const closeP2PModal = () => {
    if (Nav.has('p2pInfoModal')) {
      Nav.back();
    } else {
      p2pInfoModal.style.display = 'none';
    }
  };
  if (p2pInfoClose) p2pInfoClose.addEventListener('click', closeP2PModal);
  if (p2pInfoBackdrop) p2pInfoBackdrop.addEventListener('click', closeP2PModal);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelay',
      credential: 'openrelay'
    }
  ],
  iceCandidatePoolSize: 10
};

// Re-send the offer for a sender transfer. Used by the answer watchdog, the
// p2p_error/p2p_queued recovery paths, and p2p_request_offer from the receiver
// (who may have reloaded or lost the original offer). Each re-send restarts
// ICE so fresh candidates trickle to a receiver whose previous PC was lost.
function resendP2POffer(transferId) {
  const t = p2pTransfers[transferId];
  if (!t || t.role !== 'sender' || !socket || t.completed || t.accepted || t.active) return;
  (async () => {
    let offer = t.lastOffer;
    // ICE restart is best-effort: in 'have-local-offer' state (first offer set,
    // no answer yet) some engines throw InvalidStateError. Never let that kill
    // the whole resend — re-sending the known SDP is always valid and the
    // receiver's duplicate-offer path rebuilds cleanly.
    try { if (typeof t.pc.restartIce === 'function') t.pc.restartIce(); } catch (e) {}
    try {
      offer = await t.pc.createOffer();
      await t.pc.setLocalDescription(offer);
      t.lastOffer = offer;
    } catch (e) {
      // Always fall back to the last COMMITTED offer. (If createOffer succeeded
      // but setLocalDescription threw, `offer` would hold an uncommitted SDP
      // whose ICE credentials won't match our local description — emitting it
      // would guarantee a dead connection.)
      offer = t.lastOffer;
      if (!offer) return; // renegotiation impossible and no stored offer
    }
    if (socket) {
      socket.emit('p2p_signal', {
        from: currentUser.id,
        to: t.toId,
        transferId,
        fileMeta: t.meta,
        signal: { type: 'offer', sdp: offer }
      });
    }
    updateP2PCardUI(transferId, {
      statusText: '↻ Re-sending connection request...',
      speedText: '...'
    });
  })();
}

// 1. Sender initializes WebRTC PeerConnection & DataChannel
async function startP2PSender(file) {
  if (!activeChat || !currentUser) return;

  const transferId = 'p2p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const pc = new RTCPeerConnection(RTC_CONFIG);

  const dc = pc.createDataChannel('fileTransfer', { ordered: true });
  dc.binaryType = 'arraybuffer';

  const meta = {
    p2pId: transferId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream'
  };

  p2pTransfers[transferId] = {
    role: 'sender',
    pc,
    dc,
    file,
    meta,
    toId: activeChat.id,
    startTime: 0,
    active: false,
    pendingCandidates: [],
    lastOffer: null,
    iceRestarted: false
  };

  pc.onicecandidate = (event) => {
    const t = p2pTransfers[transferId];
    if (event.candidate && socket && t) {
      socket.emit('p2p_signal', {
        from: currentUser.id,
        to: t.toId || activeChat.id,
        transferId,
        fileMeta: meta,
        signal: { type: 'candidate', candidate: event.candidate }
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const t = p2pTransfers[transferId];
    if (!t) return;
    const st = pc.iceConnectionState;
    if ((st === 'failed' || st === 'disconnected') && t.active && !t.completed) {
      // Try one ICE restart before declaring failure — transient mobile network
      // blips frequently recover with a fresh candidate pass + new offer.
      if (!t.iceRestarted && typeof pc.restartIce === 'function') {
        t.iceRestarted = true;
        (async () => {
          try {
            pc.restartIce();
            const newOffer = await pc.createOffer();
            await pc.setLocalDescription(newOffer);
            t.lastOffer = newOffer;
            updateP2PCardUI(transferId, {
              statusText: '↻ Reconnecting...',
              speedText: '...'
            });
            if (socket) {
              socket.emit('p2p_signal', {
                from: currentUser.id,
                to: t.toId || (activeChat ? activeChat.id : null),
                transferId,
                fileMeta: t.meta,
                signal: { type: 'offer', sdp: newOffer }
              });
            }
          } catch (e) {
            t.iceRestarted = false;
          }
        })();
        return;
      }
      setP2PStatus(transferId, 'failed');
      if (socket) socket.emit('p2p_failed', { to: t.toId || (activeChat ? activeChat.id : null), transferId });
      updateP2PCardUI(transferId, {
        statusText: '⚠️ Connection Lost',
        speedText: 'Lost',
        showAccept: false
      });
    } else if (st === 'connected' && t) {
      t.iceRestarted = false;
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  p2pTransfers[transferId].lastOffer = offer;

  if (socket) {
    // Send persistent P2P message so bubble is saved in DB and rendered in chat history
    socket.emit('send_message', {
      from: currentUser.id,
      to: activeChat.id,
      text: file.name,
      type: 'p2p',
      mediaUrl: JSON.stringify(meta),
      p2pId: transferId,
      p2pMeta: meta
    });

    socket.emit('p2p_signal', {
      from: currentUser.id,
      to: activeChat.id,
      transferId,
      fileMeta: meta,
      signal: { type: 'offer', sdp: offer }
    });
  }

  // Answer watchdog: if the recipient hasn't answered within a few seconds
  // (dropped signal, socket race, receiver mid-reconnect), re-send the offer
  // automatically up to 3 times instead of making the user reload.
  let offerResendCount = 0;
  const offerWatchdog = setInterval(() => {
    const t = p2pTransfers[transferId];
    if (!t || t.completed || t.accepted || t.active) {
      clearInterval(offerWatchdog);
      return;
    }
    offerResendCount++;
    if (offerResendCount > 3) {
      clearInterval(offerWatchdog);
      updateP2PCardUI(transferId, {
        statusText: '⚠️ No response from recipient',
        speedText: 'Retry'
      });
      return;
    }
    resendP2POffer(transferId);
  }, 6000);

  dc.onopen = () => {
    p2pTransfers[transferId].active = true;
    p2pTransfers[transferId].startTime = Date.now();
    sendFileChunks(transferId);
  };
}

// Stream file in 256KB high-speed chunks over DataChannel (0ms event pipeline)
function sendFileChunks(transferId) {
  const t = p2pTransfers[transferId];
  if (!t || !t.dc || t.dc.readyState !== 'open') return;

  const file = t.file;
  const chunkSize = 256 * 1024; // 256KB high-throughput chunk size
  const MAX_BUFFER = 4 * 1024 * 1024; // 4MB buffer capacity for 5G/LAN
  let offset = 0;
  let isSending = false;

  t.dc.bufferedAmountLowThreshold = 1024 * 1024; // 1MB threshold

  function pushNextChunk() {
    if (isSending || offset >= file.size || !t.dc || t.dc.readyState !== 'open') return;

    if (t.dc.bufferedAmount >= MAX_BUFFER) return;

    isSending = true;
    const slice = file.slice(offset, offset + chunkSize);
    const reader = new FileReader();

    reader.onload = (e) => {
      isSending = false;
      if (!t.dc || t.dc.readyState !== 'open') return;

      try {
        t.dc.send(e.target.result);
        offset += e.target.result.byteLength;
        updateProgress();

        if (offset >= file.size) {
          t.completed = true;
          t.active = false;
          setP2PStatus(transferId, 'completed');
          updateP2PCardUI(transferId, {
            progress: 100,
            statusText: '⚡ Transfer Complete!',
            speedText: 'Done'
          });
        } else if (t.dc.bufferedAmount < MAX_BUFFER) {
          pushNextChunk();
        }
      } catch (err) {}
    };

    reader.readAsArrayBuffer(slice);
  }

  t.dc.onbufferedamountlow = () => {
    pushNextChunk();
  };

  function updateProgress() {
    const elapsedSec = (Date.now() - t.startTime) / 1000 || 0.1;
    const progress = Math.min(100, Math.round((offset / file.size) * 100));
    const speed = offset / elapsedSec; // bytes per sec
    updateP2PCardUI(transferId, {
      progress,
      statusText: `Sending... ${progress}%`,
      speedText: `${formatBytes(speed)}/s`
    });
  }

  pushNextChunk();
}

// 2. Handle incoming P2P signals (Receiver or Sender ICE/Answer)
function setupP2PSocketListeners() {
  // Bind once per socket object. socket.io reuses the same Socket across
  // reconnects, and socket.id CHANGES on reconnect — the old guard compared
  // against socket.id, so after any reconnect every handler got re-registered,
  // stacking duplicates that each created their own PeerConnection (a big
  // source of "doesn't connect until I reload").
  if (!socket || socket.__p2pBound) return;
  socket.__p2pBound = true;

  socket.on('p2p_signal', async (data) => {
    const { from, signal, transferId, fileMeta } = data;

    if (signal.type === 'offer') {
      // Receiver gets offer. A re-sent offer can arrive (sender watchdog retry,
      // ICE restart, or a late duplicate).
      const existing = p2pTransfers[transferId];
      if (existing && existing.pc) {
        if (existing.completed) return;
        if (existing.accepted || existing.active) {
          // We already answered this transfer (an ICE-restart / renegotiation
          // offer from the sender). Re-answer so the restart can complete —
          // otherwise the sender's recovery would never finish.
          try {
            await existing.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            const answer = await existing.pc.createAnswer();
            await existing.pc.setLocalDescription(answer);
            if (socket) {
              socket.emit('p2p_signal', {
                from: currentUser.id,
                to: existing.fromUserId,
                transferId,
                signal: { type: 'answer', sdp: answer }
              });
            }
          } catch (e) {}
          return;
        }
        // Pending (not yet accepted) duplicate offer — rebuild cleanly and
        // close the old PC so we don't leak a gathering PeerConnection.
        try { existing.pc.close(); } catch (e) {}
      }
      const pc = new RTCPeerConnection(RTC_CONFIG);

      p2pTransfers[transferId] = {
        role: 'receiver',
        pc,
        dc: null,
        fromUserId: from,
        meta: fileMeta,
        chunks: [],
        totalReceived: 0,
        offerSignal: signal.sdp,
        startTime: 0,
        pendingCandidates: []
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('p2p_signal', {
            from: currentUser.id,
            to: from,
            transferId,
            signal: { type: 'candidate', candidate: event.candidate }
          });
        }
      };

      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        p2pTransfers[transferId].dc = dc;

        dc.onmessage = (e) => {
          const t = p2pTransfers[transferId];
          if (!t) return;
          t.active = true;
          t.chunks.push(e.data);
          t.totalReceived += e.data.byteLength;

          const elapsedSec = (Date.now() - t.startTime) / 1000 || 0.1;
          const progress = Math.min(100, Math.round((t.totalReceived / t.meta.fileSize) * 100));
          const speed = t.totalReceived / elapsedSec;

          if (t.totalReceived >= t.meta.fileSize) {
            t.completed = true;
            setP2PStatus(transferId, 'completed');
            const blob = new Blob(t.chunks, { type: t.meta?.fileType || 'application/octet-stream' });
            const downloadUrl = URL.createObjectURL(blob);
            saveP2PFileToDB(transferId, blob);

            if (socket) {
              socket.emit('p2p_complete', { to: t.fromUserId, transferId });
            }

            updateP2PCardUI(transferId, {
              progress: 100,
              statusText: '⚡ Transfer Complete!',
              speedText: 'Ready',
              downloadUrl
            });
          } else {
            updateP2PCardUI(transferId, {
              progress,
              statusText: `Receiving... ${progress}%`,
              speedText: `${formatBytes(speed)}/s`
            });
          }
        };
      };

      // User tapped Accept before the offer landed (reload / lost offer) —
      // accept automatically now that we have a fresh PeerConnection.
      if (pendingP2PAccept.has(transferId)) {
        pendingP2PAccept.delete(transferId);
        setTimeout(() => acceptP2PTransfer(transferId, null), 50);
      }

    } else if (signal.type === 'answer') {
      const t = p2pTransfers[transferId];
      if (t && t.pc) {
        t.accepted = true;
        await t.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        updateP2PCardUI(transferId, {
          statusText: 'Recipient Accepted! Connecting P2P...',
          speedText: '0 KB/s'
        });
        // Flush any pending ICE candidates
        if (t.pendingCandidates && t.pendingCandidates.length > 0) {
          for (const cand of t.pendingCandidates) {
            try { await t.pc.addIceCandidate(cand); } catch(e) {}
          }
          t.pendingCandidates = [];
        }
      }
    } else if (signal.type === 'candidate') {
      const t = p2pTransfers[transferId];
      if (t && t.pc) {
        if (t.pc.remoteDescription && t.pc.remoteDescription.type) {
          try { await t.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) {}
        } else {
          if (!t.pendingCandidates) t.pendingCandidates = [];
          t.pendingCandidates.push(new RTCIceCandidate(signal.candidate));
        }
      }
    }
  });

  socket.on('p2p_complete', (data) => {
    const { transferId } = data;
    setP2PStatus(transferId, 'completed');
    const t = p2pTransfers[transferId];
    if (t) {
      t.completed = true;
      t.active = false;
    }
    updateP2PCardUI(transferId, {
      progress: 100,
      statusText: '⚡ Transfer Complete!',
      speedText: 'Done',
      showAccept: false
    });
  });

  socket.on('p2p_failed', (data) => {
    const { transferId } = data;
    setP2PStatus(transferId, 'failed');
    const t = p2pTransfers[transferId];
    if (t) {
      if (t.dc) try { t.dc.close(); } catch(e) {}
      if (t.pc) try { t.pc.close(); } catch(e) {}
      t.active = false;
      delete p2pTransfers[transferId];
    }
    pendingP2PAccept.delete(transferId);
    updateP2PCardUI(transferId, {
      statusText: '⚠️ Connection Lost',
      speedText: 'Lost',
      showAccept: false,
      progress: 0
    });
  });

  socket.on('p2p_cancel', (data) => {
    const { transferId } = data;
    setP2PStatus(transferId, 'declined');
    const t = p2pTransfers[transferId];
    if (t) {
      if (t.dc) try { t.dc.close(); } catch(e) {}
      if (t.pc) try { t.pc.close(); } catch(e) {}
      t.active = false;
      delete p2pTransfers[transferId];
    }
    pendingP2PAccept.delete(transferId);
    updateP2PCardUI(transferId, {
      statusText: '❌ Transfer Rejected',
      speedText: 'Rejected',
      showAccept: false,
      progress: 0
    });
  });

  // ==== SENDER-SIDE RECOVERY EVENTS ====
  // Recipient offline / offer parked server-side: keep the card honest and
  // re-send the offer automatically instead of forcing a manual reload.
  socket.on('p2p_error', (data) => {
    const { transferId } = data || {};
    const t = p2pTransfers[transferId];
    if (!t || t.role !== 'sender') return;
    updateP2PCardUI(transferId, {
      statusText: '⏳ Recipient offline — retrying...',
      speedText: '...'
    });
    setTimeout(() => resendP2POffer(transferId), 2500);
  });

  socket.on('p2p_queued', (data) => {
    const { transferId } = data || {};
    const t = p2pTransfers[transferId];
    if (!t || t.role !== 'sender') return;
    // The backend already parked our offer and will flush it on user_online,
    // so just update the card here. (The capped 6s watchdog still re-sends a
    // few times as belt-and-suspenders; do NOT schedule another unbounded
    // resend loop here — each resend re-triggers p2p_queued, which would
    // otherwise ping-pong forever while the recipient is offline.)
    updateP2PCardUI(transferId, {
      statusText: '⏳ Waiting for recipient to come online...',
      speedText: 'Queued'
    });
  });

  // Receiver asked us to re-send the offer (they reloaded / lost it).
  socket.on('p2p_request_offer', (data) => {
    const { transferId } = data || {};
    const t = p2pTransfers[transferId];
    if (!t || t.role !== 'sender') return;
    resendP2POffer(transferId);
  });
}

// Window unload handler for page reload ONLY during active file transfer
window.addEventListener('beforeunload', () => {
  for (const transferId in p2pTransfers) {
    const t = p2pTransfers[transferId];
    if (t && t.active && !t.completed) {
      setP2PStatus(transferId, 'failed');
      if (socket) {
        socket.emit('p2p_failed', { to: t.fromUserId || (activeChat ? activeChat.id : null), transferId });
      }
    }
  }
});

// Receiver clicks Accept
async function acceptP2PTransfer(transferId, btnElement) {
  let t = p2pTransfers[transferId];
  if (!t || !t.pc) {
    // The offer never arrived (receiver reloaded, sender reconnected, or the
    // signal was dropped). Ask the sender to re-send it, then auto-accept as
    // soon as the offer lands — no reload required on either side.
    const msgEl = btnElement ? btnElement.closest('.message') : null;
    const fromUserId = (t && t.fromUserId) ||
      (msgEl && msgEl._msgData && msgEl._msgData.from) ||
      (activeChat && activeChat.type === 'dm' ? activeChat.id : null);
    if (fromUserId && socket) {
      pendingP2PAccept.add(transferId);
      socket.emit('p2p_request_offer', { to: fromUserId, transferId });
      updateP2PCardUI(transferId, {
        showAccept: false,
        statusText: '⏳ Requesting connection from sender...',
        speedText: '...'
      });
      if (btnElement) {
        const card = btnElement.closest('.p2p-card');
        if (card) {
          const actions = card.querySelector('.p2p-actions');
          if (actions) actions.style.display = 'none';
          const statusSpan = card.querySelector('.p2p-info-row span:first-child');
          if (statusSpan) statusSpan.innerText = 'Requesting connection...';
        }
      }
    } else {
      updateP2PCardUI(transferId, {
        showAccept: false,
        statusText: '⚠️ Transfer expired — ask sender to re-send',
        speedText: 'Expired'
      });
    }
    return;
  }

  t.accepted = true;
  t.startTime = Date.now();
  await t.pc.setRemoteDescription(new RTCSessionDescription(t.offerSignal));

  // Flush any pending ICE candidates
  if (t.pendingCandidates && t.pendingCandidates.length > 0) {
    for (const cand of t.pendingCandidates) {
      try { await t.pc.addIceCandidate(cand); } catch(e) {}
    }
    t.pendingCandidates = [];
  }

  const answer = await t.pc.createAnswer();
  await t.pc.setLocalDescription(answer);

  if (socket) {
    socket.emit('p2p_signal', {
      from: currentUser.id,
      to: t.fromUserId,
      transferId,
      signal: { type: 'answer', sdp: answer }
    });
  }

  updateP2PCardUI(transferId, {
    showAccept: false,
    statusText: 'Connecting P2P DataChannel...',
    speedText: '0 KB/s'
  });

  if (btnElement) {
    const card = btnElement.closest('.p2p-card');
    if (card) {
      const actions = card.querySelector('.p2p-actions');
      if (actions) actions.style.display = 'none';
      const statusSpan = card.querySelector('.p2p-info-row span:first-child');
      if (statusSpan) statusSpan.innerText = 'Connecting P2P...';
    }
  }
}

// Receiver clicks Decline
function declineP2PTransfer(transferId, btnElement) {
  const t = p2pTransfers[transferId];
  setP2PStatus(transferId, 'declined');

  if (socket) {
    const targetUserId = t ? (t.fromUserId || (activeChat ? activeChat.id : null)) : (activeChat ? activeChat.id : null);
    if (targetUserId) {
      socket.emit('p2p_cancel', { to: targetUserId, transferId });
    }
  }

  if (t) {
    if (t.dc) try { t.dc.close(); } catch(e) {}
    if (t.pc) try { t.pc.close(); } catch(e) {}
    t.active = false;
    delete p2pTransfers[transferId];
  }

  updateP2PCardUI(transferId, {
    showAccept: false,
    statusText: '❌ Transfer Rejected',
    speedText: 'Rejected',
    progress: 0
  });

  if (btnElement) {
    const card = btnElement.closest('.p2p-card');
    if (card) {
      const actions = card.querySelector('.p2p-actions');
      if (actions) actions.style.display = 'none';
      const statusSpan = card.querySelector('.p2p-info-row span:first-child');
      if (statusSpan) statusSpan.innerText = '❌ Transfer Rejected';
      const speedSpan = card.querySelector('.p2p-info-row span:last-child');
      if (speedSpan) speedSpan.innerText = 'Rejected';
    }
  }
}



// ===== INDEXEDDB P2P FILE STORAGE ENGINE =====
const p2pDbPromise = new Promise((resolve) => {
  try {
    const req = indexedDB.open('HiFiP2PFiles', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files');
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => resolve(null);
  } catch(e) {
    resolve(null);
  }
});

async function saveP2PFileToDB(transferId, blob) {
  try {
    const db = await p2pDbPromise;
    if (!db) return;
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    store.put(blob, transferId);
  } catch(e) {
    console.error('Error saving P2P file to IndexedDB:', e);
  }
}

async function getP2PFileFromDB(transferId) {
  try {
    const db = await p2pDbPromise;
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const req = store.get(transferId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch(e) {
    return null;
  }
}

// Universal P2P Download Handler (Web Browser & Android Native Capacitor)
async function downloadP2PFile(transferId, fileName) {
  const t = p2pTransfers[transferId];
  const safeName = fileName || t?.meta?.fileName || 'downloaded_file';
  let blob = null;

  if (t && t.chunks && t.chunks.length > 0) {
    const mimeType = t.meta?.fileType || 'application/octet-stream';
    blob = new Blob(t.chunks, { type: mimeType });
    saveP2PFileToDB(transferId, blob);
  } else {
    // Retrieve from IndexedDB cache if reloaded/re-opened
    blob = await getP2PFileFromDB(transferId);
  }

  if (!blob) {
    alert(`File "${safeName}" data expired or unavailable. Please re-send the file if needed.`);
    return;
  }

  // 1. Capacitor Android Native Filesystem Write
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
    try {
      const Filesystem = window.Capacitor.Plugins.Filesystem;
      if (Filesystem.requestPermissions) {
        try { await Filesystem.requestPermissions(); } catch(e) {}
      }
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = reader.result.split(',')[1];
        try {
          await Filesystem.writeFile({
            path: safeName,
            data: base64Data,
            directory: 'DOCUMENTS',
            recursive: true
          });
          alert(`💾 File saved to Android Documents:\n${safeName}`);
        } catch (err1) {
          try {
            await Filesystem.writeFile({
              path: safeName,
              data: base64Data,
              directory: 'CACHE',
              recursive: true
            });
            alert(`💾 File saved to Android Cache/Downloads:\n${safeName}`);
          } catch (err2) {
            alert(`Download error: ${err2.message || err2}`);
          }
        }
      };
      reader.readAsDataURL(blob);
      return;
    } catch (err) {
      console.error('Capacitor Filesystem write error:', err);
    }
  }

  // 2. Standard Web Browser Download Fallback
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);
}

function updateP2PCardUI(transferId, { progress, statusText, speedText, showAccept, downloadUrl }) {
  let card = document.getElementById(`card_${transferId}`);
  if (!card) {
    card = document.querySelector(`.p2p-card[data-msg-id="${transferId}"]`);
  }
  if (!card) {
    card = document.querySelector(`.message[data-p2p-id="${transferId}"] .p2p-card`);
  }

  const bar = card ? card.querySelector('.p2p-progress-bar') : document.getElementById(`bar_${transferId}`);
  const status = card ? card.querySelector('.p2p-info-row span:first-child') : document.getElementById(`status_${transferId}`);
  const speed = card ? card.querySelector('.p2p-info-row span:last-child') : document.getElementById(`speed_${transferId}`);
  const actions = card ? card.querySelector('.p2p-actions') : document.getElementById(`actions_${transferId}`);

  if (bar && progress !== undefined) bar.style.width = `${progress}%`;
  if (status && statusText !== undefined) status.innerText = statusText;
  if (speed && speedText !== undefined) speed.innerText = speedText;

  if (actions && showAccept === false) {
    actions.style.display = 'none';
  }

  if (downloadUrl && card) {
    let downloadBtn = card.querySelector('.p2p-btn-download');
    if (!downloadBtn) {
      const btnDiv = document.createElement('div');
      btnDiv.className = 'p2p-actions';
      const fileName = p2pTransfers[transferId]?.meta?.fileName || 'download';
      const fileSizeStr = formatBytes(p2pTransfers[transferId]?.meta?.fileSize || 0);
      btnDiv.innerHTML = `<button onclick="downloadP2PFile('${transferId}', '${escapeHtml(fileName)}')" class="p2p-btn p2p-btn-download">💾 Download File (${fileSizeStr})</button>`;
      card.appendChild(btnDiv);
    }
  }
}

window.acceptP2PTransfer = acceptP2PTransfer;
window.declineP2PTransfer = declineP2PTransfer;
window.downloadP2PFile = downloadP2PFile;

// Prevent default Android native text selection popups on tap-and-hold
document.addEventListener('contextmenu', (e) => {
  if (!e.target.matches('input, textarea')) {
    e.preventDefault();
  }
});
document.addEventListener('selectstart', (e) => {
  if (!e.target.matches('input, textarea')) {
    e.preventDefault();
  }
});

// ============ HIGH-PERFORMANCE ZERO-LATENCY WALLPAPER ENGINE ============
let chatWallpapers = {};
try { chatWallpapers = JSON.parse(localStorage.getItem('hifi_chat_wallpapers') || '{}'); } catch(e){}

let selectedWallpaperUrl = null;
let selectedWallpaperOpacity = 40;
let selectedWallpaperFit = 'cover';
let selectedWallpaperScale = 100;

function applyActiveChatWallpaper() {
  const activeChatContainer = document.getElementById('activeChat');
  if (!activeChatContainer) return;

  let bgLayer = activeChatContainer.querySelector('.chat-wallpaper-layer');
  if (!bgLayer) {
    bgLayer = document.createElement('div');
    bgLayer.className = 'chat-wallpaper-layer';
    activeChatContainer.insertBefore(bgLayer, activeChatContainer.firstChild);
  }

  let overlay = bgLayer.querySelector('.chat-wallpaper-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'chat-wallpaper-overlay';
    bgLayer.appendChild(overlay);
  }

  const chatId = activeChat ? String(activeChat.id) : 'global';
  const config = chatWallpapers[chatId] || chatWallpapers['global'] || null;

  if (config && config.url) {
    const opacityVal = config.opacity !== undefined ? Number(config.opacity) / 100 : 0.4;
    const fitMode = config.fit || 'cover';
    const scaleVal = config.scale || 100;

    // Fast DOM Cache Check: Avoid re-decoding image if nothing changed
    const currentKey = `${config.url}_${opacityVal}_${fitMode}_${scaleVal}`;
    if (bgLayer.dataset.cacheKey === currentKey) return;
    bgLayer.dataset.cacheKey = currentKey;

    bgLayer.style.opacity = '1';
    bgLayer.style.backgroundImage = `url("${config.url}")`;
    overlay.style.opacity = String(opacityVal);

    if (fitMode === 'cover') {
      bgLayer.style.backgroundSize = 'cover';
      bgLayer.style.backgroundRepeat = 'no-repeat';
      bgLayer.style.backgroundPosition = 'center';
    } else if (fitMode === 'contain') {
      bgLayer.style.backgroundSize = 'contain';
      bgLayer.style.backgroundRepeat = 'no-repeat';
      bgLayer.style.backgroundPosition = 'center';
    } else if (fitMode === 'repeat') {
      bgLayer.style.backgroundSize = 'auto';
      bgLayer.style.backgroundRepeat = 'repeat';
      bgLayer.style.backgroundPosition = 'top left';
    } else if (fitMode === 'custom') {
      bgLayer.style.backgroundSize = `${scaleVal}% auto`;
      bgLayer.style.backgroundRepeat = 'repeat';
      bgLayer.style.backgroundPosition = 'center';
    }
  } else {
    if (bgLayer.dataset.cacheKey === 'none') return;
    bgLayer.dataset.cacheKey = 'none';
    bgLayer.style.opacity = '0';
    bgLayer.style.backgroundImage = '';
    overlay.style.opacity = '1';
  }
}

// ===== GROUP COUNTDOWN CLOCK =====
let countdownTickTimer = null;
function stopCountdownTick() {
  if (countdownTickTimer) { clearInterval(countdownTickTimer); countdownTickTimer = null; }
}

function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCountdownBanner() {
  const banner = document.getElementById('countdownBanner');
  if (!banner) return;
  const cd = activeChat && activeChat.countdown;
  if (!cd || !cd.target) {
    banner.style.display = 'none';
    banner.classList.remove('countdown-done');
    stopCountdownTick();
    return;
  }
  const target = new Date(cd.target).getTime();
  if (isNaN(target)) { banner.style.display = 'none'; stopCountdownTick(); return; }
  const label = escapeHtml((cd.label || 'Countdown').slice(0, 60));
  const isAdmin = !!(activeChat.admins && activeChat.admins.includes(currentUser.id));
  banner.style.display = 'flex';
  banner.classList.remove('countdown-done');
  // Only admins can remove or edit; members just see the ticking banner.
  banner.innerHTML = `<span class="countdown-emoji">⏳</span><span class="countdown-label">${label}</span><span class="countdown-time"></span>${isAdmin ? '<button class="countdown-remove" title="Remove countdown">✕</button>' : ''}`;
  banner.style.cursor = isAdmin ? 'pointer' : 'default';
  const timeEl = banner.querySelector('.countdown-time');
  const removeBtn = banner.querySelector('.countdown-remove');
  const wasDone = banner.classList.contains('countdown-done');
  const pad = (n) => String(n).padStart(2, '0');
  const update = () => {
    const diff = target - Date.now();
    if (diff <= 0) {
      // Celebrate only on the active -> expired transition (never on re-renders
      // of an already-expired banner, and never repeatedly via the ticker).
      if (!wasDone && typeof window.startConfetti === 'function') { try { window.startConfetti(); } catch (e) {} }
      timeEl.textContent = "It's here! 🎉";
      banner.classList.add('countdown-done');
      stopCountdownTick();
      return;
    }
    banner.classList.remove('countdown-done');
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    timeEl.textContent = `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  };
  if (removeBtn) {
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); if (activeChat) removeCountdown(activeChat.id); });
  }
  if (isAdmin) {
    banner.onclick = (e) => {
      if (e.target.closest('.countdown-remove')) return;
      openCountdownModal();
    };
  } else {
    banner.onclick = null;
  }
  update();
  // Only run the ticker while the target is still in the future — an already
  // expired countdown must not leak an interval that can never be cleared.
  if (target > Date.now()) {
    stopCountdownTick();
    countdownTickTimer = setInterval(update, 1000);
  }
}

function openCountdownModal() {
  const modal = document.getElementById('countdownModal');
  if (!modal) return;
  const labelInput = document.getElementById('countdownLabelInput');
  const targetInput = document.getElementById('countdownTargetInput');
  const cd = activeChat && activeChat.countdown;
  if (labelInput) labelInput.value = cd && cd.label ? cd.label : '';
  if (targetInput) targetInput.value = cd && cd.target ? toLocalInputValue(new Date(cd.target)) : '';
  modal.classList.add('show');
  Nav.push('countdownModal', () => modal.classList.remove('show'));
}

function closeCountdownModal() {
  const modal = document.getElementById('countdownModal');
  if (modal) modal.classList.remove('show');
}

async function saveCountdown() {
  if (!activeChat || activeChat.type !== 'group') return;
  const labelInput = document.getElementById('countdownLabelInput');
  const targetInput = document.getElementById('countdownTargetInput');
  const label = labelInput ? labelInput.value.trim() : '';
  const targetVal = targetInput ? targetInput.value : '';
  const targetMs = new Date(targetVal).getTime();
  if (!targetVal || isNaN(targetMs)) { showToast('Pick a date & time for the countdown', 'error'); return; }
  if (targetMs <= Date.now()) { showToast('Countdown time must be in the future', 'error'); return; }
  try {
    const res = await fetch(api(`/api/groups/${activeChat.id}/countdown`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, target: new Date(targetMs).toISOString() })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not save countdown', 'error'); return; }
    const conv = conversations.find(c => String(c.id) === String(activeChat.id));
    if (conv) conv.countdown = data.countdown;
    if (activeChat) activeChat.countdown = data.countdown;
    closeCountdownModal();
    renderCountdownBanner();
    renderConversations();
    showToast('Countdown pinned ⏳', 'success');
  } catch (err) { showToast('Network error — try again', 'error'); }
}

async function removeCountdown(groupId) {
  if (!groupId) return;
  try {
    const res = await fetch(api(`/api/groups/${groupId}/countdown`), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not remove countdown', 'error'); return; }
    const conv = conversations.find(c => String(c.id) === String(groupId));
    if (conv) delete conv.countdown;
    if (activeChat && String(activeChat.id) === String(groupId)) delete activeChat.countdown;
    renderCountdownBanner();
    renderConversations();
    showToast('Countdown removed', 'info');
  } catch (err) { showToast('Network error — try again', 'error'); }
}

function openWallpaperModal() {
  const modal = document.getElementById('wallpaperModal');
  const opacitySlider = document.getElementById('wallpaperOpacitySlider');
  const opacityVal = document.getElementById('wallpaperOpacityVal');
  const scaleSlider = document.getElementById('wallpaperScaleSlider');
  const scaleVal = document.getElementById('wallpaperScaleVal');
  const scaleGroup = document.getElementById('wallpaperScaleGroup');
  if (!modal) return;

  const chatId = activeChat ? String(activeChat.id) : 'global';
  const currentConfig = chatWallpapers[chatId] || chatWallpapers['global'] || {};
  selectedWallpaperUrl = currentConfig.url || null;
  selectedWallpaperOpacity = currentConfig.opacity !== undefined ? currentConfig.opacity : 40;
  selectedWallpaperFit = currentConfig.fit || 'cover';
  selectedWallpaperScale = currentConfig.scale || 100;

  if (opacitySlider) opacitySlider.value = selectedWallpaperOpacity;
  if (opacityVal) opacityVal.innerText = `${selectedWallpaperOpacity}%`;
  if (scaleSlider) scaleSlider.value = selectedWallpaperScale;
  if (scaleVal) scaleVal.innerText = `${selectedWallpaperScale}%`;

  const fitBtns = modal.querySelectorAll('.wallpaper-fit-options button');
  fitBtns.forEach(btn => {
    if (btn.dataset.fit === selectedWallpaperFit) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (scaleGroup) {
    scaleGroup.style.display = selectedWallpaperFit === 'custom' ? 'block' : 'none';
  }

  modal.classList.add('show');
  Nav.push('wallpaperModal', () => modal.classList.remove('show'));
}

function closeWallpaperModal() {
  const modal = document.getElementById('wallpaperModal');
  if (modal) modal.classList.remove('show');
}

// Event listeners for wallpaper modal controls
document.getElementById('closeWallpaperModal')?.addEventListener('click', closeWallpaperModal);
document.getElementById('closeCountdownModal')?.addEventListener('click', closeCountdownModal);
document.getElementById('cancelCountdownBtn')?.addEventListener('click', closeCountdownModal);
document.getElementById('saveCountdownBtn')?.addEventListener('click', saveCountdown);
document.getElementById('wallpaperOpacitySlider')?.addEventListener('input', (e) => {
  selectedWallpaperOpacity = Number(e.target.value);
  const opacityVal = document.getElementById('wallpaperOpacityVal');
  if (opacityVal) opacityVal.innerText = `${selectedWallpaperOpacity}%`;
});

document.getElementById('wallpaperScaleSlider')?.addEventListener('input', (e) => {
  selectedWallpaperScale = Number(e.target.value);
  const scaleVal = document.getElementById('wallpaperScaleVal');
  if (scaleVal) scaleVal.innerText = `${selectedWallpaperScale}%`;
});

document.querySelectorAll('.wallpaper-fit-options button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.wallpaper-fit-options button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedWallpaperFit = btn.dataset.fit;
    const scaleGroup = document.getElementById('wallpaperScaleGroup');
    if (scaleGroup) {
      scaleGroup.style.display = selectedWallpaperFit === 'custom' ? 'block' : 'none';
    }
  });
});

document.getElementById('uploadWallpaperBtn')?.addEventListener('click', () => {
  document.getElementById('wallpaperFileInput')?.click();
});

document.getElementById('wallpaperFileInput')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  // High Performance Blob URL (0ms memory overhead, no 14MB Base64 string in localStorage)
  const blobUrl = URL.createObjectURL(file);
  selectedWallpaperUrl = blobUrl;
  selectedWallpaperFit = 'cover';
  
  document.querySelectorAll('.wallpaper-fit-options button').forEach(b => {
    if (b.dataset.fit === 'cover') b.classList.add('active');
    else b.classList.remove('active');
  });
  const scaleGroup = document.getElementById('wallpaperScaleGroup');
  if (scaleGroup) scaleGroup.style.display = 'none';

  showToast('Custom GIF background selected!', 'success');
  document.querySelectorAll('.wallpaper-item').forEach(el => el.classList.remove('selected'));
  e.target.value = '';
});

document.getElementById('applyWallpaperBtn')?.addEventListener('click', () => {
  const chatId = activeChat ? String(activeChat.id) : 'global';
  if (selectedWallpaperUrl) {
    chatWallpapers[chatId] = {
      url: selectedWallpaperUrl,
      opacity: selectedWallpaperOpacity,
      fit: selectedWallpaperFit,
      scale: selectedWallpaperScale
    };
  } else {
    delete chatWallpapers[chatId];
  }
  try { localStorage.setItem('hifi_chat_wallpapers', JSON.stringify(chatWallpapers)); } catch(e){}
  applyActiveChatWallpaper();
  closeWallpaperModal();
  showToast('Chat background updated!', 'success');
});

document.getElementById('resetWallpaperBtn')?.addEventListener('click', () => {
  const chatId = activeChat ? String(activeChat.id) : 'global';
  delete chatWallpapers[chatId];
  delete chatWallpapers['global'];
  try { localStorage.setItem('hifi_chat_wallpapers', JSON.stringify(chatWallpapers)); } catch(e){}
  selectedWallpaperUrl = null;
  applyActiveChatWallpaper();
  closeWallpaperModal();
  showToast('Background wallpaper removed', 'info');
});

window.openWallpaperModal = openWallpaperModal;
window.applyActiveChatWallpaper = applyActiveChatWallpaper;

// ============ HIFI APP SETTINGS ENGINE ============
let userSettings = {
  theme: 'dark',
  fontSize: 'medium',
  pushEnabled: true,
  soundEnabled: true,
  readReceipts: true,
  statusBio: 'Hey there! I am using HiFi',
  customColors: {
    accent: '#7c5cfc',
    bgPage: '#0b0e11',
    glassBg: '#13161c',
    text: '#ffffff',
    bubbleSentBg: '#7c5cfc',
    bubbleReceivedBg: '#1a1e26'
  }
};

try {
  const savedSettings = localStorage.getItem('hifi_user_settings');
  if (savedSettings) {
    userSettings = { ...userSettings, ...JSON.parse(savedSettings) };
  }
} catch (e) {}

function applyChatAppShellBg() {
  // The .chat-app shell uses the glass panel color, which is translucent — it
  // lets the darker page color bleed through and exposes seams where the fixed
  // shell meets the browser UI. Composite glass-over-page into ONE opaque color
  // so the app background truly covers the whole screen, in every theme.
  const el = document.getElementById('chatApp');
  if (!el) return;
  // Let the browser normalize any CSS color syntax (hex, rgba, named, hsl…) to
  // rgb()/rgba() — then parse the canonical form.
  const tmp = document.createElement('div');
  const norm = (c) => { tmp.style.color = c; return tmp.style.color; };
  const parse = (c) => {
    const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
    return m ? [+m[1], +m[2], +m[3], m[4] == null ? 1 : parseFloat(m[4])] : null;
  };
  const cs = getComputedStyle(document.body);
  const g = parse(norm(cs.getPropertyValue('--glass-bg').trim()));
  const p = parse(norm(cs.getPropertyValue('--bg-page').trim()));
  if (!g || !p) return;
  const a = Math.min(1, Math.max(0, g[3]));
  const r = Math.round(g[0] * a + p[0] * (1 - a));
  const gg = Math.round(g[1] * a + p[1] * (1 - a));
  const b = Math.round(g[2] * a + p[2] * (1 - a));
  el.style.background = `rgb(${r}, ${gg}, ${b})`;
  // Keep the browser status bar (theme-color) identical to the shell so no
  // darker strip shows above the app on mobile web.
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', `rgb(${r}, ${gg}, ${b})`);
}

function applyUserSettings() {
  document.body.classList.remove('theme-midnight', 'theme-oled', 'theme-light', 'theme-custom');
  
  document.body.style.removeProperty('--accent');
  document.body.style.removeProperty('--bg-page');
  document.body.style.removeProperty('--glass-bg');
  document.body.style.removeProperty('--glass-bg-strong');
  document.body.style.removeProperty('--text');
  document.body.style.removeProperty('--bubble-sent-bg');
  document.body.style.removeProperty('--bubble-received-bg');
  document.body.style.removeProperty('--bubble-sent-text');
  document.body.style.removeProperty('--bubble-received-text');
  
  let tc = '#0b0e11';
  if (userSettings.theme === 'midnight') { document.body.classList.add('theme-midnight'); tc = '#0f172a'; }
  else if (userSettings.theme === 'oled') { document.body.classList.add('theme-oled'); tc = '#000000'; }
  else if (userSettings.theme === 'light') { document.body.classList.add('theme-light'); tc = '#ffffff'; }
  else if (userSettings.theme === 'custom') { 
    document.body.classList.add('theme-custom'); 
    tc = userSettings.customColors?.bgPage || '#0b0e11'; 
    if (userSettings.customColors) {
      document.body.style.setProperty('--accent', userSettings.customColors.accent);
      document.body.style.setProperty('--bg-page', userSettings.customColors.bgPage);
      document.body.style.setProperty('--glass-bg', userSettings.customColors.glassBg);
      document.body.style.setProperty('--glass-bg-strong', userSettings.customColors.glassBg);
      document.body.style.setProperty('--text', userSettings.customColors.text);
      if (userSettings.customColors.bubbleSentBg) document.body.style.setProperty('--bubble-sent-bg', userSettings.customColors.bubbleSentBg);
      if (userSettings.customColors.bubbleReceivedBg) document.body.style.setProperty('--bubble-received-bg', userSettings.customColors.bubbleReceivedBg);
    }
  }
  
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', tc);

  document.body.classList.remove('font-small', 'font-medium', 'font-large');
  document.body.classList.add(`font-${userSettings.fontSize || 'medium'}`);

  // Opaque composite for the app shell so the background fully covers the screen.
  applyChatAppShellBg();
}

function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const masterView = document.getElementById('settingsMasterView');
  const detailView = document.getElementById('settingsDetailView');
  if (!modal) return;

  const isMobile = window.innerWidth < 600;
  if (isMobile) {
    if (masterView) masterView.style.display = 'block';
    if (detailView) detailView.style.display = 'none';
  } else {
    if (masterView) masterView.style.display = 'none';
    if (detailView) detailView.style.display = 'block';
    showSettingsCategory('account');
  }

  const nameInput = document.getElementById('settingDisplayName');
  const bioInput = document.getElementById('settingStatusBio');
  const userIdInput = document.getElementById('settingUserId');
  const fontSizeSelect = document.getElementById('settingFontSize');
  const pushToggle = document.getElementById('settingTogglePush');
  const soundToggle = document.getElementById('settingToggleSound');
  const readToggle = document.getElementById('settingToggleReadReceipts');

  if (currentUser) {
    if (nameInput) nameInput.value = currentUser.displayName || currentUser.username || '';
    if (userIdInput) userIdInput.value = currentUser.id || '';
  }
  if (bioInput) bioInput.value = userSettings.statusBio || '';
  if (fontSizeSelect) fontSizeSelect.value = userSettings.fontSize || 'medium';
  if (pushToggle) pushToggle.checked = userSettings.pushEnabled !== false;
  if (soundToggle) soundToggle.checked = userSettings.soundEnabled !== false;
  if (readToggle) readToggle.checked = userSettings.readReceipts !== false;

  modal.querySelectorAll('.theme-card').forEach(card => {
    if (card.dataset.theme === userSettings.theme) card.classList.add('active');
    else card.classList.remove('active');
  });
  
  const customThemeSection = document.getElementById('customThemeSettings');
  if (customThemeSection) {
    customThemeSection.style.display = userSettings.theme === 'custom' ? 'block' : 'none';
  }
  
  if (userSettings.customColors) {
    const elAccent = document.getElementById('customColorAccent');
    const elBgPage = document.getElementById('customColorBgPage');
    const elGlass = document.getElementById('customColorGlass');
    const elText = document.getElementById('customColorText');
    const elBubbleSent = document.getElementById('customColorBubbleSentBg');
    const elBubbleReceived = document.getElementById('customColorBubbleReceivedBg');
    if (elAccent) elAccent.value = userSettings.customColors.accent;
    if (elBgPage) elBgPage.value = userSettings.customColors.bgPage;
    if (elGlass) elGlass.value = userSettings.customColors.glassBg;
    if (elText) elText.value = userSettings.customColors.text;
    if (elBubbleSent && userSettings.customColors.bubbleSentBg) elBubbleSent.value = userSettings.customColors.bubbleSentBg;
    if (elBubbleReceived && userSettings.customColors.bubbleReceivedBg) elBubbleReceived.value = userSettings.customColors.bubbleReceivedBg;
  }

  modal.classList.add('show');
  Nav.push('settingsModal', () => modal.classList.remove('show'));

  // If the About panel is the one currently displayed (settings were closed
  // while About was open and are being reopened), re-render it so the live
  // manifest data is never stale.
  const aboutPanel = document.getElementById('settingsPanelAbout');
  if (aboutPanel && aboutPanel.style.display !== 'none' && typeof renderAboutPanel === 'function') {
    renderAboutPanel();
  }
}

function showSettingsCategory(tabName) {
  const masterView = document.getElementById('settingsMasterView');
  const detailView = document.getElementById('settingsDetailView');
  const detailTitle = document.getElementById('settingsDetailTitle');
  if (!detailView) return;

  const titleMap = {
    account: '👤 Account & Profile',
    appearance: '🎨 Appearance & Themes',
    privacy: '🔒 Privacy & Security',
    about: 'ℹ️ About HiFi'
  };

  if (detailTitle) detailTitle.innerText = titleMap[tabName] || 'Category Settings';

  // Active desktop tab styling
  document.querySelectorAll('.settings-tab').forEach(t => {
    if (t.dataset.tab === tabName) t.classList.add('active');
    else t.classList.remove('active');
  });

  document.querySelectorAll('.settings-panel').forEach(panel => {
    panel.style.display = panel.id === `settingsPanel${tabName.charAt(0).toUpperCase() + tabName.slice(1)}` ? 'block' : 'none';
  });

  // About shows real, live data — re-render every time the tab is opened so
  // the version/platform/server/latest-release fields are never stale.
  if (tabName === 'about' && typeof renderAboutPanel === 'function') {
    renderAboutPanel();
  }

  if (window.innerWidth < 600) {
    if (masterView) masterView.style.display = 'none';
    detailView.style.display = 'block';
  }
}

function showSettingsMasterList() {
  const masterView = document.getElementById('settingsMasterView');
  const detailView = document.getElementById('settingsDetailView');
  if (masterView) masterView.style.display = 'block';
  if (detailView) detailView.style.display = 'none';
}

// Master list item click event (Mobile)
document.querySelectorAll('.settings-list-item').forEach(item => {
  item.addEventListener('click', () => {
    const tabName = item.dataset.tab;
    showSettingsCategory(tabName);
  });
});

// Desktop tabs click event
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    showSettingsCategory(tabName);
  });
});

// Back to master list button
document.getElementById('settingsBackBtn')?.addEventListener('click', showSettingsMasterList);

// ===== SETTINGS → ABOUT (real app info) =====
// The About tab used to show hardcoded placeholder text. It now renders real
// data from two sources: the build-stamped window.APP_VERSION (written into
// www/config.js by copy-assets.js at build time) and the live update manifest
// from the backend (/api/update/manifest), which also powers the self-update
// system. This keeps About accurate on web AND Android without any hardcoding.
function detectAboutPlatform() {
  if (window.Capacitor && window.Capacitor.getPlatform) {
    const p = window.Capacitor.getPlatform();
    if (p === 'android') return 'Android App';
    if (p === 'ios') return 'iOS App';
    return 'Native App';
  }
  if (/Android/i.test(navigator.userAgent)) return 'Android Web';
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'iOS Web';
  return 'Web';
}

async function renderAboutPanel() {
  const verEl = document.getElementById('aboutVersion');
  const buildEl = document.getElementById('aboutBuild');
  const platEl = document.getElementById('aboutPlatform');
  const serverEl = document.getElementById('aboutServer');
  const builtAtEl = document.getElementById('aboutBuiltAt');
  if (!verEl) return;

  const stamped = window.APP_VERSION || {};
  // Native Android: the true INSTALLED version comes from PackageManager via
  // AndroidNativeConfig. Prefer it over the stamped web-bundle version — a
  // stale swapped OTA bundle can carry an old window.APP_VERSION even after
  // a fresh APK is installed ("About still shows old version/build").
  let nativeName = '', nativeCode = '';
  if (window.AndroidNativeConfig && typeof window.AndroidNativeConfig.getInstalledVersionName === 'function') {
    try { nativeName = window.AndroidNativeConfig.getInstalledVersionName() || ''; } catch(e) {}
  }
  if (window.AndroidNativeConfig && typeof window.AndroidNativeConfig.getInstalledVersionCode === 'function') {
    try { nativeCode = window.AndroidNativeConfig.getInstalledVersionCode() || ''; } catch(e) {}
  }
  // Stamped build info (from copy-assets.js). If missing (e.g. opened straight
  // from the source tree), refreshAboutManifest() fills the version fields from
  // the live manifest's published appVersionName/appVersionCode.
  if (nativeName) verEl.textContent = 'v' + nativeName;
  else if (stamped.name) verEl.textContent = 'v' + stamped.name;
  if (nativeCode) buildEl.textContent = '#' + nativeCode;
  else if (stamped.code) buildEl.textContent = '#' + stamped.code;
  if (platEl) platEl.textContent = detectAboutPlatform();
  if (serverEl) serverEl.textContent = API_BASE || 'Same origin (dev)';
  if (stamped.builtAt) {
    const d = new Date(Number(stamped.builtAt));
    builtAtEl.textContent = isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  }

  // Live update-manifest data (the same source the self-update system uses).
  await refreshAboutManifest();
}

async function refreshAboutManifest() {
  const latestEl = document.getElementById('aboutLatest');
  const statusEl = document.getElementById('aboutUpdateStatus');
  const btn = document.getElementById('aboutCheckUpdatesBtn');
  if (!latestEl) return;
  try {
    if (btn) btn.disabled = true;
    const res = await fetch(api('/api/update/manifest'));
    if (res.status === 404) {
      // No release published yet — the endpoint returns 404 with an error body.
      latestEl.textContent = 'No release published yet';
      if (statusEl) statusEl.textContent = 'No updates have been published to this server yet.';
      return;
    }
    if (!res.ok) throw new Error('bad status ' + res.status);
    const m = await res.json();
    const pubVer = (m.web && m.web.version) ? ('v' + m.web.version) : (m.appVersionName ? 'v' + m.appVersionName : '—');
    const pubDate = m.publishedAt ? new Date(m.publishedAt).toLocaleDateString() : '';
    latestEl.textContent = pubVer + (pubDate ? ' · ' + pubDate : '');
    // When no build stamp is present (dev preview served from the source tree),
    // fill Version/Build from the live manifest so About never shows dashes.
    const stamped = window.APP_VERSION || {};
    if (!stamped.name && m.appVersionName) {
      const verEl = document.getElementById('aboutVersion');
      if (verEl) verEl.textContent = 'v' + m.appVersionName;
    }
    if (!stamped.code && m.appVersionCode) {
      const buildEl = document.getElementById('aboutBuild');
      if (buildEl) buildEl.textContent = '#' + m.appVersionCode;
    }
    if (statusEl) {
      // Compare installed (native on Android, stamped elsewhere) build vs the
      // published release. A release may be APK-only (web:null — the native
      // APK tier updates phones) or web-only (web present — OTA swap), so both
      // paths must be handled. Native getter is the single source of truth so
      // the status line always agrees with the Version/Build fields above.
      let nativeInstalled = 0;
      if (window.AndroidNativeConfig && typeof window.AndroidNativeConfig.getInstalledVersionCode === 'function') {
        try { nativeInstalled = Number(window.AndroidNativeConfig.getInstalledVersionCode()) || 0; } catch(e) {}
      }
      const installed = nativeInstalled || Number((window.APP_VERSION || {}).code) || 0;
      const published = Number((m.web || {}).version) || 0;
      const apkCode = (m.apk && m.apk.versionCode) ? Number(m.apk.versionCode) : 0;
      const minNative = Number(m.minNativeVersion) || 0;
      const isNativeApp = !!window.AndroidNativeConfig ||
        (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      if (installed && apkCode > installed && minNative > installed) {
        // APK-only (or APK-tier) release: the installed APK is older than the
        // published one AND the server requires a newer native build.
        statusEl.textContent = isNativeApp
          ? '📲 HiFi v' + (m.apk.versionName || apkCode) + ' available — download & install it.'
          : '🌐 A newer app build (v' + (m.apk.versionName || apkCode) + ') is published. Install the updated app to keep using HiFi.';
      } else if (installed && published > installed) {
        // The web build cannot self-update (no native UpdateManager) — it only
        // changes when the site is redeployed, so say that plainly instead of
        // implying an in-app auto-update exists on web.
        statusEl.textContent = isNativeApp
          ? '🔄 Update v' + published + ' available — it will apply on the next app restart.'
          : '🌐 A newer release (v' + published + ') is published. The web build updates when this site is redeployed.';
      } else if (installed && (published === installed || (apkCode > 0 && apkCode <= installed))) {
        statusEl.textContent = '✅ You are on the latest published build.';
      } else {
        statusEl.textContent = ((m.web && m.web.notes) || (m.apk && m.apk.notes)) || '';
      }
    }
  } catch (e) {
    latestEl.textContent = 'Could not reach update server';
    if (statusEl) statusEl.textContent = 'The backend is unreachable — check your connection.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById('aboutCheckUpdatesBtn')?.addEventListener('click', () => {
  if (typeof refreshAboutManifest === 'function') {
    refreshAboutManifest();
    const statusEl = document.getElementById('aboutUpdateStatus');
    if (statusEl) statusEl.textContent = 'Checking for updates…';
  }
  // ALSO trigger the REAL native check on Android: the About button used to
  // only re-fetch the manifest JSON — it never asked the native UpdateManager
  // to evaluate and show the APK download dialog. On native, hand it over so
  // an available update actually prompts (fixes "no update getting" when the
  // app has been running since before the release was published).
  if (window.AndroidNativeConfig && typeof window.AndroidNativeConfig.checkForUpdates === 'function') {
    try { window.AndroidNativeConfig.checkForUpdates(); } catch(e) {}
  }
});

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.remove('show');
}

// Theme card selection inside Settings - Immediate live theme application
document.querySelectorAll('.theme-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    userSettings.theme = card.dataset.theme;
    
    const customThemeSection = document.getElementById('customThemeSettings');
    if (customThemeSection) {
      customThemeSection.style.display = userSettings.theme === 'custom' ? 'block' : 'none';
    }
    
    try { localStorage.setItem('hifi_user_settings', JSON.stringify(userSettings)); } catch(e){}
    applyUserSettings();
  });
});

['customColorAccent', 'customColorBgPage', 'customColorGlass', 'customColorText', 'customColorBubbleSentBg', 'customColorBubbleReceivedBg'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    // Input event for real-time preview
    el.addEventListener('input', (e) => {
      const val = e.target.value;
      if (id === 'customColorAccent') userSettings.customColors.accent = val;
      if (id === 'customColorBgPage') userSettings.customColors.bgPage = val;
      if (id === 'customColorGlass') userSettings.customColors.glassBg = val;
      if (id === 'customColorText') userSettings.customColors.text = val;
      if (id === 'customColorBubbleSentBg') userSettings.customColors.bubbleSentBg = val;
      if (id === 'customColorBubbleReceivedBg') userSettings.customColors.bubbleReceivedBg = val;
      if (userSettings.theme === 'custom') applyUserSettings();
    });
    // Change event for saving to local storage
    el.addEventListener('change', (e) => {
      try { localStorage.setItem('hifi_user_settings', JSON.stringify(userSettings)); } catch(err){}
    });
  }
});

const resetCustomThemeBtn = document.getElementById('resetCustomThemeBtn');
if (resetCustomThemeBtn) {
  resetCustomThemeBtn.addEventListener('click', () => {
    userSettings.customColors = {
      accent: '#7c5cfc',
      bgPage: '#0b0e11',
      glassBg: '#13161c',
      text: '#ffffff',
      bubbleSentBg: '#7c5cfc',
      bubbleReceivedBg: '#1a1e26'
    };
    try { localStorage.setItem('hifi_user_settings', JSON.stringify(userSettings)); } catch(err){}
    
    // Update inputs
    const elAccent = document.getElementById('customColorAccent');
    const elBgPage = document.getElementById('customColorBgPage');
    const elGlass = document.getElementById('customColorGlass');
    const elText = document.getElementById('customColorText');
    const elBubbleSent = document.getElementById('customColorBubbleSentBg');
    const elBubbleReceived = document.getElementById('customColorBubbleReceivedBg');
    
    if (elAccent) elAccent.value = userSettings.customColors.accent;
    if (elBgPage) elBgPage.value = userSettings.customColors.bgPage;
    if (elGlass) elGlass.value = userSettings.customColors.glassBg;
    if (elText) elText.value = userSettings.customColors.text;
    if (elBubbleSent) elBubbleSent.value = userSettings.customColors.bubbleSentBg;
    if (elBubbleReceived) elBubbleReceived.value = userSettings.customColors.bubbleReceivedBg;
    
    if (userSettings.theme === 'custom') applyUserSettings();
  });
}


// Font size change - Immediate live font scale application
document.getElementById('settingFontSize')?.addEventListener('change', (e) => {
  userSettings.fontSize = e.target.value;
  try { localStorage.setItem('hifi_user_settings', JSON.stringify(userSettings)); } catch(e){}
  applyUserSettings();
});

// Copy User ID
document.getElementById('copyUserIdBtn')?.addEventListener('click', () => {
  const idVal = document.getElementById('settingUserId')?.value;
  if (idVal) {
    navigator.clipboard.writeText(idVal);
    showToast('User ID copied to clipboard!', 'success');
  }
});

// Test Chime Sound
document.getElementById('testChimeBtn')?.addEventListener('click', () => {
  playNotificationSound(true);
  showToast('Playing notification sound test chime', 'info');
});

// Save Settings button
document.getElementById('saveSettingsBtn')?.addEventListener('click', async () => {
  const newName = document.getElementById('settingDisplayName')?.value.trim();
  const newBio = document.getElementById('settingStatusBio')?.value.trim();
  const fontSize = document.getElementById('settingFontSize')?.value;
  const pushEnabled = document.getElementById('settingTogglePush')?.checked;
  const soundEnabled = document.getElementById('settingToggleSound')?.checked;
  const readReceipts = document.getElementById('settingToggleReadReceipts')?.checked;

  userSettings.fontSize = fontSize;
  userSettings.pushEnabled = pushEnabled;
  userSettings.soundEnabled = soundEnabled;
  userSettings.readReceipts = readReceipts;
  if (newBio) userSettings.statusBio = newBio;

  try { localStorage.setItem('hifi_user_settings', JSON.stringify(userSettings)); } catch(e){}
  applyUserSettings();

  if (currentUser && (newName || newBio)) {
    try {
      const res = await fetch(api(`/api/users/${currentUser.id}/profile`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: newName || currentUser.displayName, bio: newBio || '' })
      });
      const data = await res.json();
      if (data.success && data.user) {
        currentUser.displayName = data.user.displayName;
        currentUser.bio = data.user.bio;
        userNameCache[currentUser.id] = currentUser.displayName || currentUser.username;
        
        // Save to BOTH 'user' and 'hifi_user' keys so auto-login reload restores updated profile
        localStorage.setItem('user', JSON.stringify(currentUser));
        localStorage.setItem('hifi_user', JSON.stringify(currentUser));
        
        // Real-time socket broadcast
        if (socket) {
          socket.emit('user_profile_updated', { userId: currentUser.id, displayName: currentUser.displayName, bio: currentUser.bio });
        }

        // Update nav bar name & avatar initials
        const navName = document.getElementById('navUserName');
        if (navName) navName.textContent = currentUser.displayName;
        const navAv = document.getElementById('navAvatar');
        if (navAv) navAv.innerHTML = avatarHtml(currentUser.avatar, currentUser.displayName);
        
        // Refresh conversations list to update sidebar avatars and names
        loadConversations();
      }
    } catch(e){}
  }

  closeSettingsModal();
  showToast('Settings saved and applied successfully!', 'success');
});

// Bind nav gear icon & dropdown items
document.getElementById('settingsBtn')?.addEventListener('click', openSettingsModal);
document.getElementById('dropdownSettings')?.addEventListener('click', () => {
  closeAllDropdowns();
  openSettingsModal();
});
document.getElementById('closeSettingsModal')?.addEventListener('click', closeSettingsModal);

applyUserSettings();

window.openSettingsModal = openSettingsModal;


// --- Angry Haptics Feature ---
const angryKeywords = ['angry', 'mad', 'hate', 'furious', 'shut up'];
const angryEmojis = ['😡', '🤬', '😠', '👿', '😾'];

function isMessageAngry(msg) {
  if (!msg || !msg.text) return false;
  return msg.text.includes('🔥');
}

function triggerAngryHaptic() {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
      const Haptics = window.Capacitor.Plugins.Haptics;
      let hapticCount = 0;
      const hapticTimer = setInterval(() => {
        hapticCount++;
        if (hapticCount <= 6) {
          Haptics.impact({ style: 'LIGHT' }).catch(()=>{});
        } else if (hapticCount <= 12) {
          Haptics.impact({ style: 'MEDIUM' }).catch(()=>{});
        } else if (hapticCount <= 25) {
          Haptics.impact({ style: 'HEAVY' }).catch(()=>{});
        } else {
          clearInterval(hapticTimer);
        }
      }, 60); // 60ms gap * 25 = 1.5 seconds of continuous angry vibration
    }
    if (navigator.vibrate) {
      navigator.vibrate([10, 10, 10, 10, 20, 10, 20, 10, 50, 10, 50, 10, 100, 10, 200, 10, 200, 10, 200, 10, 200]);
    }
  } catch(err) {
    console.error('Haptics error', err);
  }
}

function showRealFireEffect() {
  const inputArea = document.querySelector('.chat-input-area');
  if (!inputArea) return;

  const rect = inputArea.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = rect.width;
  canvas.height = 350; // Increased height for longer, more elegant flames
  canvas.style.position = 'fixed';
  canvas.style.left = rect.left + 'px';
  canvas.style.top = (rect.top - canvas.height + 40) + 'px';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '9999';
  canvas.style.transition = 'opacity 1s ease-in, opacity 1s ease-out';
  canvas.style.mixBlendMode = 'screen'; 
  // Hardware-accelerated optical fluid filter (blurs edges and boosts contrast to merge shapes like liquid)
  canvas.style.filter = 'blur(2px) contrast(1.2) brightness(1.2)';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  
  let flames = [];
  // 80 primary flame licks rooted at the bottom for denser core
  for (let i = 0; i < 80; i++) {
    flames.push({
      x: Math.random() * canvas.width,
      y: canvas.height + 20, 
      baseWidth: Math.random() * 50 + 20,
      maxHeight: Math.random() * 200 + 100,
      swayAmount: Math.random() * 60 + 20,
      life: Math.random() * Math.PI * 2, 
      speed: Math.random() * 0.015 + 0.005 // Even slower for ultra cinematic feel
    });
  }

  let wisps = [];
  // 50 detaching smoke/fire wisps floating upwards
  for (let i = 0; i < 50; i++) {
    wisps.push({
      x: Math.random() * canvas.width,
      y: canvas.height + Math.random() * 100,
      width: Math.random() * 30 + 10,
      height: Math.random() * 80 + 30,
      swayAmount: Math.random() * 40 + 15,
      life: Math.random() * Math.PI * 2,
      speedY: Math.random() * 1.2 + 0.4, 
      speedX: (Math.random() - 0.5) * 0.3
    });
  }

  let animationFrame;

  function drawFlameShape(x, y, width, height, sway, gradientOpacity) {
    // Hyper-realistic heat gradient
    const grad = ctx.createLinearGradient(0, y, 0, y - height);
    grad.addColorStop(0, `rgba(255, 255, 255, ${1.0 * gradientOpacity})`); // Blinding white core
    grad.addColorStop(0.1, `rgba(255, 230, 100, ${0.9 * gradientOpacity})`); // Bright yellow
    grad.addColorStop(0.4, `rgba(255, 100, 0, ${0.6 * gradientOpacity})`); // Intense Orange
    grad.addColorStop(0.8, `rgba(150, 10, 0, ${0.2 * gradientOpacity})`); // Dark Red Edge
    grad.addColorStop(1, `rgba(0, 0, 0, 0)`); // Dissipates

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x - width / 2, y);
    // Draw dynamic curving flame tongue with a slight pinch at the base for realism
    ctx.quadraticCurveTo(x - width / 4 + sway / 2, y - height / 2, x + sway, y - height);
    ctx.quadraticCurveTo(x + width / 4 + sway / 2, y - height / 2, x + width / 2, y);
    ctx.closePath();
    ctx.fill();
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    ctx.globalCompositeOperation = 'lighter';

    // 1. Draw distinct rooted flame licks
    for (let f of flames) {
      f.life += f.speed;
      
      // Pulse height organically
      let currentHeight = f.maxHeight * (0.7 + 0.3 * Math.sin(f.life * 1.2));
      
      // Complex pseudo-noise for organic, chaotic turbulence (Perlin noise approximation)
      let time = f.life * 2.5;
      let sway = (Math.sin(time) * 0.5 + Math.cos(time * 1.7) * 0.3 + Math.sin(time * 0.6) * 0.2) * f.swayAmount;
      
      drawFlameShape(f.x, f.y, f.baseWidth, currentHeight, sway, 1.0);
    }

    // 2. Draw detached floating wisps (to match the video's breaking flames)
    for (let w of wisps) {
      w.life += 0.015;
      
      // Complex pseudo-noise for wisps
      let time = w.life * 2.5;
      let sway = (Math.sin(time) * 0.5 + Math.cos(time * 1.7) * 0.3 + Math.sin(time * 0.6) * 0.2) * w.swayAmount;
      
      // Fade out as they rise
      let progress = 1.0 - (w.y / canvas.height);
      let opacity = Math.max(0, 1.0 - (progress * 1.5)); 
      
      if (opacity > 0) {
        drawFlameShape(w.x, w.y, w.width, w.height, sway, opacity);
      }

      // Physics
      w.y -= w.speedY;
      w.x += w.speedX;
      w.height *= 0.985; // Shrink vertically slightly slower
      w.width *= 0.985;

      // Respawn
      if (w.y < 0 || opacity <= 0) {
        w.y = canvas.height + 20;
        w.x = Math.random() * canvas.width;
        w.height = Math.random() * 80 + 30;
        w.width = Math.random() * 30 + 10;
        w.speedY = Math.random() * 1.2 + 0.4;
      }
    }

    animationFrame = requestAnimationFrame(animate);
  }

  animate();

  canvas.style.opacity = '0';
  setTimeout(() => {
    canvas.style.opacity = '1';
  }, 50);

  setTimeout(() => {
    canvas.style.opacity = '0';
    setTimeout(() => {
      cancelAnimationFrame(animationFrame);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }, 1000);
  }, 2500);
}

window.checkBirthdayMessage = function(msg) {
  if (msg.text && /(happy birthday|happy new year)/i.test(msg.text)) {
    if (typeof window.startConfetti === "function") {
      window.startConfetti();
    }
  }
};

// Love-message hook — the ❤️ twin of the 🔥 effect. When a message contains
// love words/emoji, auto-play the heart burst on that bubble (both sides see
// it: the sender's own echo and the receiver's live arrival).
window.checkLoveMessage = function(msg) {
  if (!msg || !msg.text) return;
  if (!/(\blove\b|❤|💖|💕|💗|💘|😍|😘)/i.test(String(msg.text))) return;
  if (typeof showHeartBurst !== 'function') return;
  const findEl = () => chatMessages
    ? chatMessages.querySelector(`[data-msg-id="${msg.id}"]`)
    : null;
  // The hook fires before renderMessage() appends the bubble, so find the
  // element now, and if it's not there yet retry on the next tick right
  // after the pending synchronous render.
  // Dedupe: the hook can fire twice for the same self-sent message (new_message
  // echo + message_sent), which would stack two bursts on one bubble.
  const burstOnce = (target) => {
    if (target && !target.querySelector('.heart-burst-container')) {
      showHeartBurst(target);
    }
  };
  const el = findEl();
  if (el) { burstOnce(el); return; }
  setTimeout(() => burstOnce(findEl()), 0);
};