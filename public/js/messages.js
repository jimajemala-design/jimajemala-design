/* messages.js — NutriFell Phase 4A: Direct Messages.
   Two-pane inbox (conversation list + thread). 1:1, open to everyone.
   Realtime via polling: the open thread polls every 5s while the tab is
   focused; the conversation list refreshes every 20s. Requires auth.js. */
'use strict';

(function () {
  if (typeof Auth === 'undefined' || !Auth.isAuthed()) { location.href = '/login.html'; return; }
  const ME = Auth.user() || {};

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const $ = (id) => document.getElementById(id);

  const els = {
    shell: $('dmShell'), convos: $('dmConvos'),
    empty: $('dmEmpty'), active: $('dmActive'),
    peer: $('dmPeer'), peerAv: $('dmPeerAv'), peerInitial: $('dmPeerInitial'),
    peerName: $('dmPeerName'), peerStatus: $('dmPeerStatus'), peerDot: $('dmPeerDot'),
    messages: $('dmMessages'), compose: $('dmCompose'), input: $('dmInput'), send: $('dmSend'),
    back: $('dmBack'), typingRow: $('dmTypingRow'), typingName: $('dmTypingName'),
  };

  let currentId = null;       // open conversation id
  let currentPeer = null;     // { id, name, ... } of the open thread's other user
  let convoCache = [];        // last conversations payload
  let threadTimer = null;     // poll fallback (sockets are primary)
  let lastStamp = null;       // newest message timestamp rendered (for cheap diffing)
  let typingDebounce = null;  // stop-typing timer (sender side)
  let peerTypingHide = null;  // auto-hide timer (receiver side)

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
    const d = h / 24; if (d < 7) return `${Math.floor(d)}d`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function clockTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function avatarHTML(url, name, cls) {
    return url
      ? `<span class="${cls}" style="background-image:url('${esc(url)}')"></span>`
      : `<span class="${cls}">${esc(initial(name))}</span>`;
  }

  // ── Conversation list ───────────────────────────────────────────────
  function convoRowHTML(c) {
    const u = c.user || {};
    const preview = c.lastMessage
      ? (c.lastMessage.fromUserId === ME.id ? 'You: ' : '') + (c.lastMessage.text || '')
      : 'Say hello 👋';
    const unread = c.unreadCount > 0;
    return `<button class="dm-convo ${currentId === c.id ? 'active' : ''} ${unread ? 'unread' : ''}" data-id="${esc(c.id)}" data-uid="${esc(u.id)}">
      ${avatarHTML(u.avatar, u.name, 'dm-convo-av')}
      <span class="dm-convo-main">
        <span class="dm-convo-top"><b>${esc(u.name)}</b><time>${c.lastMessageAt ? timeAgo(c.lastMessageAt) : ''}</time></span>
        <span class="dm-convo-prev">${esc(preview)}</span>
      </span>
      ${unread ? `<span class="dm-convo-dot" aria-label="${c.unreadCount} unread">${c.unreadCount > 9 ? '9+' : c.unreadCount}</span>` : ''}
    </button>`;
  }

  async function loadConvos() {
    try {
      const d = await Auth.api('/api/conversations');
      convoCache = d.conversations || [];
      if (!convoCache.length) {
        els.convos.innerHTML = `<div class="dm-list-empty"><span class="em" aria-hidden="true">💬</span><p>No conversations yet.<br>Start one from any profile.</p></div>`;
        return;
      }
      els.convos.innerHTML = convoCache.map(convoRowHTML).join('');
      els.convos.querySelectorAll('.dm-convo').forEach(btn =>
        btn.addEventListener('click', () => openConversation(btn.dataset.id)));
      refreshConvoPresence();
    } catch (e) {
      els.convos.innerHTML = `<div class="dm-list-empty"><p>Could not load messages.</p></div>`;
    }
  }

  // ── Thread ──────────────────────────────────────────────────────────
  function attachmentHTML(att) {
    if (!att || !att.preview) return '';
    const p = att.preview;
    const thumb = p.thumb
      ? `<span class="dm-att-thumb" style="background-image:url('${esc(p.thumb)}')"></span>`
      : `<span class="dm-att-thumb glyph">${p.type === 'video' ? '🎬' : (p.type === 'recipe' ? '🍽️' : '💬')}</span>`;
    return `<a class="dm-att" href="/feed.html?post=${esc(p.id)}">
      ${thumb}
      <span class="dm-att-meta"><b>${esc(p.authorName || 'Post')}</b><small>${esc(p.caption || 'View post')}</small></span>
    </a>`;
  }

  function bubbleHTML(m) {
    const mine = m.fromUserId === ME.id;
    const body = m.text ? `<span class="dm-bubble-text">${linkify(esc(m.text))}</span>` : '';
    // Read receipts on my own messages: ✓ sent, ✓✓ read (blue).
    const ticks = mine ? `<span class="dm-ticks ${m.read ? 'read' : ''}" aria-hidden="true">${m.read ? '✓✓' : '✓'}</span>` : '';
    return `<div class="dm-row ${mine ? 'mine' : 'theirs'}" data-mid="${esc(m.id)}">
      <div class="dm-bubble">${attachmentHTML(m.attachment)}${body}<span class="dm-meta"><time>${clockTime(m.at)}</time>${ticks}</span></div>
    </div>`;
  }

  // Minimal linkifier: @mentions → profile search, #tags → hashtag page.
  function linkify(safe) {
    return safe
      .replace(/(^|\s)@([a-z0-9_]{2,30})/gi, (mm, sp, h) => `${sp}<a class="mention" href="/search.html?q=%40${h}">@${h}</a>`)
      .replace(/(^|\s)#([a-z0-9_]{2,40})/gi, (mm, sp, t) => `${sp}<a class="mention" href="/hashtag.html?tag=${t}">#${t}</a>`);
  }

  function renderThread(payload, { keepScroll } = {}) {
    const msgs = payload.messages || [];
    const newest = msgs.length ? msgs[msgs.length - 1].at : null;
    if (keepScroll && newest === lastStamp) return; // nothing new
    lastStamp = newest;
    const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
    els.messages.innerHTML = msgs.length
      ? msgs.map(bubbleHTML).join('')
      : `<div class="dm-thread-empty"><p>No messages yet. Say something nice.</p></div>`;
    if (!keepScroll || atBottom) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function setPeer(u) {
    currentPeer = u;
    els.peerName.textContent = u.name || 'NutriFell User';
    els.peer.href = '/profile-social.html?id=' + (u.id || '');
    if (u.avatar) { els.peerAv.style.backgroundImage = `url('${u.avatar}')`; els.peerInitial.textContent = ''; els.peerAv.classList.add('has-img'); }
    else { els.peerAv.style.backgroundImage = ''; els.peerInitial.textContent = initial(u.name); els.peerAv.classList.remove('has-img'); }
    updatePeerPresence();
  }

  // Reflect the peer's online state in the header (live via window.Live).
  function updatePeerPresence() {
    if (!currentPeer) return;
    const live = window.Live;
    const isOnline = live && live.isOnline(currentPeer.id);
    els.peerDot.hidden = !isOnline;
    if (els.typingRow && !els.typingRow.hidden) return; // don't clobber "typing…"
    els.peerStatus.textContent = isOnline ? 'Active now' : (currentPeer.username || '');
    els.peerStatus.classList.toggle('online', !!isOnline);
  }
  document.addEventListener('presence:change', () => { updatePeerPresence(); refreshConvoPresence(); });

  // Online dots on the conversation-list rows.
  function refreshConvoPresence() {
    const live = window.Live; if (!live) return;
    els.convos.querySelectorAll('.dm-convo[data-uid]').forEach(row => {
      row.classList.toggle('is-online', live.isOnline(row.dataset.uid));
    });
  }

  async function openConversation(id) {
    currentId = id;
    els.empty.hidden = true;
    els.active.hidden = false;
    els.shell.classList.add('show-thread');
    if (els.typingRow) els.typingRow.hidden = true;
    els.messages.innerHTML = `<div class="dm-thread-empty"><span class="spinner"></span></div>`;
    lastStamp = null;
    // highlight in list
    els.convos.querySelectorAll('.dm-convo').forEach(b => b.classList.toggle('active', b.dataset.id === id));
    try {
      const d = await Auth.api(`/api/conversations/${id}/messages`);
      setPeer(d.user || {});
      renderThread(d);
      els.input.focus();
      await markRead(id);
    } catch (e) {
      els.messages.innerHTML = `<div class="dm-thread-empty"><p>Could not load this conversation.</p></div>`;
    }
    startThreadPoll();
  }

  async function markRead(id) {
    try {
      await Auth.api(`/api/conversations/${id}/read`, { method: 'PUT' });
      // optimistically clear this row's unread state + refresh nav badge
      const row = els.convos.querySelector(`.dm-convo[data-id="${id}"]`);
      if (row) { row.classList.remove('unread'); const dot = row.querySelector('.dm-convo-dot'); if (dot) dot.remove(); }
      if (window.Notif && Notif.refreshDMCount) Notif.refreshDMCount();
    } catch { /* ignore */ }
  }

  function startThreadPoll() {
    stopThreadPoll();
    threadTimer = setInterval(async () => {
      if (document.hidden || !currentId) return;
      try {
        const d = await Auth.api(`/api/conversations/${currentId}/messages`);
        renderThread(d, { keepScroll: true });
        if ((d.messages || []).some(m => m.fromUserId !== ME.id && !m.read)) markRead(currentId);
      } catch { /* offline; next tick */ }
    }, 5000);
  }
  function stopThreadPoll() { if (threadTimer) { clearInterval(threadTimer); threadTimer = null; } }

  // ── Composer ────────────────────────────────────────────────────────
  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
  }
  function syncSendState() { els.send.disabled = !els.input.value.trim(); }

  async function sendMessage() {
    const text = els.input.value.trim();
    if (!text || !currentId) return;
    els.input.value = ''; autosize(); syncSendState();
    clearTimeout(typingDebounce);
    if (window.Live && currentPeer) window.Live.typing(currentPeer.id, false);
    // optimistic append
    const temp = { id: 'temp', fromUserId: ME.id, text, attachment: null, at: new Date().toISOString() };
    els.messages.insertAdjacentHTML('beforeend', bubbleHTML(temp));
    els.messages.scrollTop = els.messages.scrollHeight;
    try {
      await Auth.api(`/api/conversations/${currentId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      const d = await Auth.api(`/api/conversations/${currentId}/messages`);
      renderThread(d);
      loadConvos();
    } catch (e) {
      if (window.toast) toast(e.message || 'Could not send.', 'error');
      els.input.value = text; autosize(); syncSendState();
    }
  }

  function closeThread() {
    currentId = null;
    currentPeer = null;
    if (els.typingRow) els.typingRow.hidden = true;
    stopThreadPoll();
    els.shell.classList.remove('show-thread');
    els.active.hidden = true;
    els.empty.hidden = false;
    els.convos.querySelectorAll('.dm-convo.active').forEach(b => b.classList.remove('active'));
  }

  // ── Deep links: ?c=<conversationId> or ?to=<userId> ──────────────────
  async function handleDeepLink() {
    const params = new URLSearchParams(location.search);
    const c = params.get('c');
    const to = params.get('to');
    if (c) { openConversation(c); return; }
    if (to) {
      try {
        const convo = await Auth.api('/api/conversations', { method: 'POST', body: JSON.stringify({ userId: to }) });
        await loadConvos();
        openConversation(convo.id);
      } catch (e) { if (window.toast) toast(e.message || 'Could not start conversation.', 'error'); }
    }
  }

  // ── Wire-up ─────────────────────────────────────────────────────────
  els.input.addEventListener('input', () => { autosize(); syncSendState(); emitTyping(); });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Sender-side typing signal (throttled stop after 2.5s idle).
  function emitTyping() {
    if (!currentPeer || !window.Live) return;
    window.Live.typing(currentPeer.id, true);
    clearTimeout(typingDebounce);
    typingDebounce = setTimeout(() => window.Live.typing(currentPeer.id, false), 2500);
  }
  els.compose.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  els.back.addEventListener('click', closeThread);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && currentId) markRead(currentId); });

  // ── Real-time API (called by socket-client.js) ───────────────────────
  function hideTyping() { if (els.typingRow) els.typingRow.hidden = true; updatePeerPresence(); }
  window.Messages = {
    // A message arrived live.
    addIncoming(dm) {
      if (dm.conversationId === currentId) {
        hideTyping();
        // avoid duplicating a message we already rendered via poll
        if (!els.messages.querySelector(`.dm-row[data-mid="${dm.message.id}"]`)) {
          const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
          els.messages.insertAdjacentHTML('beforeend', bubbleHTML(dm.message));
          lastStamp = dm.message.at;
          if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
        }
        markRead(currentId);
      } else if (window.toast) {
        toast('💬 New message', 'info', 2600);
      }
      if (window.Notif && Notif.refreshDMCount) Notif.refreshDMCount();
      loadConvos();
    },
    // The peer is typing (or stopped).
    setTyping(fromUserId, on) {
      if (!currentPeer || fromUserId !== currentPeer.id) return;
      clearTimeout(peerTypingHide);
      els.typingRow.hidden = !on;
      els.typingName.textContent = (currentPeer.name || 'They').split(' ')[0] + ' is typing…';
      if (on) peerTypingHide = setTimeout(() => { els.typingRow.hidden = true; updatePeerPresence(); }, 4000);
      else updatePeerPresence();
    },
    // The peer read my messages — flip ticks to blue.
    markReadByPeer(info) {
      if (info.conversationId !== currentId) return;
      els.messages.querySelectorAll('.dm-row.mine .dm-ticks').forEach(t => { t.classList.add('read'); t.textContent = '✓✓'; });
    },
    confirmSent() { /* REST path is authoritative; no-op */ },
  };

  (async function init() {
    await loadConvos();
    await handleDeepLink();
    setInterval(() => { if (!document.hidden) loadConvos(); }, 20000);
  })();
})();
