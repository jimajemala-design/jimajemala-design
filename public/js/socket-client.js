/* socket-client.js — NutriFell Phase 5: real-time client hub.
   Connects to socket.io (served at /socket.io/socket.io.js), authenticates with
   the stored JWT, and routes live events into the existing UI primitives
   (Notif badge, DM badge, Toast) plus optional per-page hooks
   (window.Messages, window.Feed). Exposes window.socket + window.Live.
   Gracefully no-ops if socket.io isn't loaded or the user is logged out. */
'use strict';

window.Live = (() => {
  const online = new Set();              // userIds currently online
  let socket = null;

  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const emit = (ev, payload) => { if (socket && socket.connected) socket.emit(ev, payload); };

  function announcePresence() {
    // let any page update avatars/dots
    document.dispatchEvent(new CustomEvent('presence:change', { detail: { online: Array.from(online) } }));
  }

  function init() {
    if (!authed() || typeof io === 'undefined') return null;
    socket = io({
      auth: { token: Auth.token() },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => { /* connected to NutriFell live */ });
    socket.on('connect_error', (e) => { if (/Unauthorized|Invalid token/.test(e.message)) socket.close(); });

    // ── Presence ──────────────────────────────────────────────────────
    socket.on('presence:list', (ids) => { online.clear(); (ids || []).forEach(id => online.add(id)); announcePresence(); });
    socket.on('user:online', (id) => { online.add(id); announcePresence(); });
    socket.on('user:offline', (id) => { online.delete(id); announcePresence(); });

    // ── Notifications ─────────────────────────────────────────────────
    socket.on('notification:new', (notif) => {
      if (window.Notif && Notif.refreshCount) Notif.refreshCount();
      if (window.Notif && Notif.prependLive) Notif.prependLive(notif);
      if (window.toast && notif && notif.text) {
        const who = notif.actor ? notif.actor.name : 'Someone';
        toast(`${who} ${notif.text}`, 'info', 3500);
      }
    });

    // ── Direct messages ───────────────────────────────────────────────
    socket.on('dm:receive', (dm) => {
      if (window.Messages && Messages.addIncoming) { Messages.addIncoming(dm); }
      else {
        if (window.Notif && Notif.refreshDMCount) Notif.refreshDMCount();
        if (window.toast) toast('💬 New message', 'info', 3000);
      }
    });
    socket.on('dm:read', (info) => { if (window.Messages && Messages.markReadByPeer) Messages.markReadByPeer(info); });
    socket.on('dm:typing', (t) => { if (window.Messages && Messages.setTyping) Messages.setTyping(t.fromUserId, true); });
    socket.on('dm:stop_typing', (t) => { if (window.Messages && Messages.setTyping) Messages.setTyping(t.fromUserId, false); });
    socket.on('dm:sent', (info) => { if (window.Messages && Messages.confirmSent) Messages.confirmSent(info); });

    // ── Live feed ─────────────────────────────────────────────────────
    socket.on('feed:new_post', (data) => { if (window.Feed && Feed.onNewPost) Feed.onNewPost(data); });
    socket.on('post:reaction', (data) => { if (window.Feed && Feed.onReaction) Feed.onReaction(data); });
    // post:comment is a global count bump; comment:new carries the full comment
    // and only reaches subscribers of that post's room (the open comment sheet).
    socket.on('post:comment', (data) => { if (window.Feed && Feed.onCommentCount) Feed.onCommentCount(data); });
    socket.on('comment:new', (data) => { if (window.Feed && Feed.onComment) Feed.onComment(data); });

    // ── Live stories ──────────────────────────────────────────────────
    socket.on('story:viewed', (data) => { if (window.Stories && Stories.onViewed) Stories.onViewed(data); });

    window.socket = socket;
    return socket;
  }

  return {
    init,
    socket: () => socket,
    isOnline: (id) => online.has(id),
    onlineIds: () => Array.from(online),
    emit,
    // typing + post-room helpers for pages
    typing: (toUserId, on) => emit(on ? 'dm:typing' : 'dm:stop_typing', { toUserId }),
    subscribePost: (postId) => emit('post:subscribe', postId),
    unsubscribePost: (postId) => emit('post:unsubscribe', postId),
  };
})();

if (document.readyState !== 'loading') window.Live.init();
else document.addEventListener('DOMContentLoaded', () => window.Live.init());
