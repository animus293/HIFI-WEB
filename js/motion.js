/* ============================================================
   HiFi — MOTION LAYER  (motion.dev — Framer Motion's engine, no React)
   ------------------------------------------------------------
   This module is 100% additive. It observes the DOM that app.js
   already builds and layers real spring physics on top:

     1. Messages     → spring fade + scale-up from the bottom
     2. Sidebar list → staggered entrance (stagger())
     3. Micro-interactions → whileHover {scale:1.02, x:5} + whileTap {scale:0.98}
     4. Typing dots  → custom looped spring-like sequence

   app.js is never modified. If this module fails to load (e.g.
   offline CDN), the app keeps working — CSS fallbacks cover it.

   Motion API notes (verified against motion.dev docs):
     • Independent transforms are TOP-LEVEL keys: x, y, scale, rotate.
     • Physics spring: { type:'spring', stiffness, damping, mass }.
     • Tween easing option is `ease` (NOT `easing`); accepts a
       cubic-bezier array.
     • Springs support only two keyframes; multi-keyframe loops use tween.
============================================================ */

import { animate, stagger } from 'https://cdn.jsdelivr.net/npm/motion@11/+esm';

// Signal to CSS that JS-driven motion is available.
document.documentElement.classList.add('motion-ready');

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A crisp, premium spring used across the app.
const SPRING = { type: 'spring', stiffness: 520, damping: 30, mass: 0.9 };
const SPRING_SOFT = { type: 'spring', stiffness: 360, damping: 26 };
const EASE_OUT = [0.22, 1, 0.36, 1];
// WhatsApp-style message pop: snappy with a tiny overshoot bounce.
const SPRING_POP = { type: 'spring', stiffness: 700, damping: 26, mass: 0.7 };

/* ------------------------------------------------------------------
   1 + 2. MESSAGE + CONVERSATION ENTRANCE
   A MutationObserver watches the two live containers app.js renders
   into. Nodes get a spring reveal the moment they're added.
------------------------------------------------------------------ */
function revealMessage(el) {
  if (reduceMotion) return;
  // Classic look: a calm, quick fade + tiny rise. No spring, no scale pop.
  animate(el, { opacity: [0, 1], y: [6, 0] }, { duration: 0.2, ease: 'ease-out' });
}

function revealTyping(el) {
  if (reduceMotion) return;
  animate(el, { opacity: [0, 1], y: [6, 0] }, { duration: 0.2, ease: 'ease-out' });
}

const messageObserver = new MutationObserver((mutations) => {
  // Gather all message nodes added in this batch.
  const added = [];
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1 && node.classList.contains('message')) added.push(node);
    }
  }
  if (!added.length) return;

  // Opening/switching a chat re-renders the whole history in one batch.
  // Animating every bubble at once causes jitter — so only animate when a
  // small number of nodes arrive (a genuine new/sent message).
  const bulk = added.length > 2;

  for (const node of added) {
    const isTyping = node.id === 'typingIndicator' || node.querySelector('.typing-indicator');
    if (isTyping) {
      revealTyping(node);
    } else if (!bulk) {
      revealMessage(node);
    }
    // bulk history render → show instantly, no animation (prevents jitter)
  }
});

function attachMessageObserver() {
  const chatMessages = document.getElementById('chatMessages');
  if (chatMessages && !chatMessages.__motionBound) {
    chatMessages.__motionBound = true;
    messageObserver.observe(chatMessages, { childList: true });
  }
}

/* ------------------------------------------------------------------
   Staggered sidebar entrance — runs whenever the conversation list
   is (re)rendered. Uses Motion's stagger() for sequenced reveals.
------------------------------------------------------------------ */
let staggerScheduled = false;
let listAnimatedOnce = false;
function staggerConversations() {
  if (reduceMotion || listAnimatedOnce) return;
  const list = document.getElementById('conversationsList');
  if (!list) return;
  const items = list.querySelectorAll('.conv-item');
  if (!items.length) return;
  // Animate the sidebar ONCE on first load. Switching chats re-renders the
  // list, but we don't re-animate it (that was the source of the jitter).
  listAnimatedOnce = true;
  animate(
    items,
    { opacity: [0, 1], y: [6, 0] },
    { delay: stagger(0.02), duration: 0.22, ease: 'ease-out' }
  );
}

const listObserver = new MutationObserver(() => {
  // Coalesce bursty re-renders into one stagger pass per frame.
  if (staggerScheduled) return;
  staggerScheduled = true;
  requestAnimationFrame(() => {
    staggerScheduled = false;
    staggerConversations();
  });
});

function attachListObserver() {
  const list = document.getElementById('conversationsList');
  if (list && !list.__motionBound) {
    list.__motionBound = true;
    listObserver.observe(list, { childList: true });
    staggerConversations(); // animate whatever's already there
  }
}

/* ------------------------------------------------------------------
   3. MICRO-INTERACTIONS — intentionally DISABLED for the classic look.
   No spring hover/tap transforms; the stylesheet's :hover backgrounds
   provide calm, classic feedback instead.
------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   4. TYPING DOTS — classic look uses the calm CSS keyframe bounce only.
   (No custom Motion loop.)
------------------------------------------------------------------ */
function animateTypingDots() { /* intentionally no-op for classic theme */ }

/* ------------------------------------------------------------------
   BOOTSTRAP — the chat UI is created after login, so poll briefly
   until the live containers exist, then bind observers.
------------------------------------------------------------------ */
function boot() {
  attachMessageObserver();
  attachListObserver();
}

const bootPoll = setInterval(() => {
  if (document.getElementById('conversationsList') && document.getElementById('chatMessages')) {
    boot();
  }
}, 400);

// Stop polling once both containers are bound (they persist for the session).
const stopWhenBound = setInterval(() => {
  const cm = document.getElementById('chatMessages');
  const cl = document.getElementById('conversationsList');
  if (cm && cm.__motionBound && cl && cl.__motionBound) {
    clearInterval(bootPoll);
    clearInterval(stopWhenBound);
  }
}, 600);

// Also try immediately (covers auto-login where chat mounts fast).
document.addEventListener('DOMContentLoaded', boot);
boot();
