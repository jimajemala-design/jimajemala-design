/* reels.js — NutriFell Phase 4C: full-screen TikTok-style reels viewer.
   Vertical scroll-snap feed of video posts. The reel that is >60% visible
   autoplays (muted by default for autoplay policy); others pause. Reuses the
   existing post endpoints for like/save/comment/view/follow. Requires auth.js. */
'use strict';

(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const ME = authed() ? (Auth.user() || {}) : {};
  const $ = (id) => document.getElementById(id);

  const container = $('reelsContainer');
  const loading = $('reelsLoading');
  let page = 1, hasMore = true, loadingMore = false, muted = true;
  const viewed = new Set();

  function needLogin() {
    if (window.toast) toast('Log in to interact with reels.', 'info', 2200);
    setTimeout(() => { location.href = '/login.html'; }, 900);
  }

  // Caption with linkified #tags + @mentions.
  function linkify(safe) {
    return safe
      .replace(/(^|\s)#([a-z0-9_]{2,40})/gi, (m, sp, t) => `${sp}<a href="/hashtag.html?tag=${t}">#${t}</a>`)
      .replace(/(^|\s)@([a-z0-9_]{2,30})/gi, (m, sp, h) => `${sp}<a href="/search.html?q=%40${h}">@${h}</a>`);
  }

  function reelHTML(p) {
    const liked = p.myReaction === '❤️';
    const avatar = p.authorAvatar
      ? `<span class="reel-av" style="background-image:url('${esc(p.authorAvatar)}')"></span>`
      : `<span class="reel-av">${esc(initial(p.authorName))}</span>`;
    const followBtn = (!p.isOwn && authed() && !p.isFollowingAuthor)
      ? `<button class="reel-follow" data-act="follow" aria-label="Follow ${esc(p.authorName)}">+</button>` : '';
    return `<section class="reel" data-id="${esc(p.id)}" data-uid="${esc(p.userId)}">
      <video class="reel-video" src="${esc(p.video)}" loop playsinline preload="metadata" muted></video>
      <div class="reel-tap" data-tap aria-label="Play or pause"></div>
      <div class="reel-shade"></div>

      <div class="reel-rail">
        <a class="reel-author-link" href="/profile-social.html?id=${esc(p.userId)}">${avatar}${followBtn}</a>
        <button class="reel-action ${liked ? 'liked' : ''}" data-act="like">
          <svg viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
          <b data-count="like">${p.totalReactions || 0}</b>
        </button>
        <button class="reel-action" data-act="comment">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.6A8.4 8.4 0 1 1 21 11.5z"/></svg>
          <b data-count="comment">${p.commentCount || 0}</b>
        </button>
        <button class="reel-action ${p.saved ? 'saved' : ''}" data-act="save">
          <svg viewBox="0 0 24 24" fill="${p.saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
          <b>Save</b>
        </button>
        <button class="reel-action" data-act="share">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5"/></svg>
          <b>Share</b>
        </button>
      </div>

      <div class="reel-info">
        <a class="reel-handle" href="/profile-social.html?id=${esc(p.userId)}">${esc(p.authorUsername || ('@' + (p.authorName || 'user')))}</a>
        ${p.caption ? `<p class="reel-caption">${linkify(esc(p.caption))}</p>` : ''}
      </div>
      <div class="reel-paused" data-paused hidden aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </div>
    </section>`;
  }

  // ── Video playback via IntersectionObserver ──────────────────────────
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      const v = e.target.querySelector('video');
      if (!v) return;
      if (e.intersectionRatio >= 0.6) {
        v.muted = muted;
        v.play().catch(() => {});
        markViewed(e.target.dataset.id);
        if (e.target === container.lastElementChild) maybeLoadMore();
      } else {
        v.pause();
      }
    });
  }, { threshold: [0, 0.6, 1] });

  async function markViewed(id) {
    if (viewed.has(id)) return;
    viewed.add(id);
    try { await Auth.api(`/api/posts/${id}/view`, { method: 'POST' }); } catch { /* ignore */ }
  }

  // ── Load / render ────────────────────────────────────────────────────
  async function loadPage() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const d = await Auth.api(`/api/reels?page=${page}`);
      (d.reels || []).forEach(p => {
        const wrap = document.createElement('div');
        wrap.innerHTML = reelHTML(p);
        const el = wrap.firstElementChild;
        container.appendChild(el);
        io.observe(el);
        wireReel(el, p);
      });
      hasMore = d.hasMore;
      page++;
      if (page === 2 && !(d.reels || []).length) showEmpty();
    } catch (e) {
      if (page === 1) container.innerHTML = '<div class="reels-empty"><h2>Could not load reels</h2></div>';
    } finally {
      loadingMore = false;
      if (loading) loading.remove();
    }
  }
  function maybeLoadMore() { if (hasMore && !loadingMore) loadPage(); }

  function showEmpty() {
    container.innerHTML = `<div class="reels-empty">
      <span class="em" aria-hidden="true">🎬</span>
      <h2>No reels yet</h2>
      <p>Be the first to post one. Record a quick recipe or a meal-prep clip.</p>
      <a class="btn-post" href="/feed.html">Go to feed</a>
    </div>`;
  }

  // ── Per-reel interactions ────────────────────────────────────────────
  function wireReel(el, p) {
    const video = el.querySelector('video');
    const pausedIc = el.querySelector('[data-paused]');
    el.querySelector('[data-tap]').addEventListener('click', () => {
      if (video.paused) { video.play().catch(() => {}); pausedIc.hidden = true; }
      else { video.pause(); pausedIc.hidden = false; }
    });
    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); handleAction(btn.dataset.act, el, p, btn); });
    });
  }

  async function handleAction(act, el, p, btn) {
    if (!authed() && act !== 'share') return needLogin();
    if (act === 'like') {
      try {
        const d = await Auth.api(`/api/posts/${p.id}/like`, { method: 'POST' });
        btn.classList.toggle('liked', d.liked);
        btn.querySelector('svg').setAttribute('fill', d.liked ? 'currentColor' : 'none');
        el.querySelector('[data-count="like"]').textContent = d.total;
      } catch { /* ignore */ }
    } else if (act === 'save') {
      try { const d = await Auth.api(`/api/posts/${p.id}/save`, { method: 'POST' });
        btn.classList.toggle('saved', d.saved);
        btn.querySelector('svg').setAttribute('fill', d.saved ? 'currentColor' : 'none');
        if (window.toast) toast(d.saved ? 'Saved' : 'Removed from saved', 'success', 1500);
      } catch { /* ignore */ }
    } else if (act === 'comment') {
      openComments(p, el);
    } else if (act === 'follow') {
      try { const d = await Auth.api(`/api/users/${p.userId}/follow`, { method: 'POST' });
        if (d.following) { btn.remove(); if (window.toast) toast('Following ' + p.authorName, 'success', 1800); }
      } catch { /* ignore */ }
    } else if (act === 'share') {
      const url = location.origin + '/reels.html?post=' + p.id;
      if (navigator.share) navigator.share({ title: 'NutriFell Reel', url }).catch(() => {});
      else { navigator.clipboard.writeText(url).then(() => { if (window.toast) toast('Link copied', 'success', 1500); }); }
    }
  }

  // ── Comment sheet ────────────────────────────────────────────────────
  const sheet = $('commentSheet'), overlay = $('sheetOverlay');
  const sheetBody = $('sheetBody'), commentInput = $('commentInput'), commentSend = $('commentSend');
  let activePost = null, activeEl = null;

  function openComments(p, el) {
    activePost = p; activeEl = el;
    sheet.classList.add('open'); overlay.classList.add('show');
    sheetBody.innerHTML = '<div class="feed-empty" style="padding:30px"><span class="spinner"></span></div>';
    Auth.api(`/api/posts/${p.id}/comments`).then(renderComments).catch(() => {
      sheetBody.innerHTML = '<div class="feed-empty"><p>Could not load comments.</p></div>';
    });
  }
  function closeComments() { sheet.classList.remove('open'); overlay.classList.remove('show'); activePost = null; }

  function commentHTML(c) {
    const av = c.authorAvatar
      ? `<span class="cm-av" style="background-image:url('${esc(c.authorAvatar)}')"></span>`
      : `<span class="cm-av">${esc(initial(c.authorName))}</span>`;
    return `<div class="cm-row">${av}<div><b>${esc(c.authorName)}</b><p>${esc(c.text)}</p></div></div>`;
  }
  function renderComments(list) {
    $('sheetCount').textContent = `${list.length} comment${list.length === 1 ? '' : 's'}`;
    sheetBody.innerHTML = list.length
      ? list.map(commentHTML).join('')
      : '<div class="feed-empty" style="padding:30px"><p>No comments yet. Start the conversation.</p></div>';
  }

  commentInput.addEventListener('input', () => { commentSend.disabled = !commentInput.value.trim(); });
  commentSend.addEventListener('click', async () => {
    const text = commentInput.value.trim();
    if (!text || !activePost) return;
    if (!authed()) return needLogin();
    commentInput.value = ''; commentSend.disabled = true;
    try {
      await Auth.api(`/api/posts/${activePost.id}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
      const list = await Auth.api(`/api/posts/${activePost.id}/comments`);
      renderComments(list);
      if (activeEl) activeEl.querySelector('[data-count="comment"]').textContent = list.length;
    } catch (e) { if (window.toast) toast(e.message || 'Could not comment.', 'error'); }
  });
  $('sheetClose').addEventListener('click', closeComments);
  overlay.addEventListener('click', closeComments);

  // ── Mute toggle ──────────────────────────────────────────────────────
  $('muteBtn').addEventListener('click', () => {
    muted = !muted;
    container.querySelectorAll('video').forEach(v => { v.muted = muted; });
    $('muteBtn').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    $('muteBtn').classList.toggle('on', !muted);
  });

  // ── Deep link: ?post=<id> scrolls to that reel once loaded ───────────
  async function init() {
    await loadPage();
    const target = new URLSearchParams(location.search).get('post');
    if (target) {
      // load more pages until we find it (bounded), then scroll into view
      let tries = 0;
      while (!container.querySelector(`.reel[data-id="${target}"]`) && hasMore && tries < 10) { await loadPage(); tries++; }
      const el = container.querySelector(`.reel[data-id="${target}"]`);
      if (el) el.scrollIntoView();
    }
  }
  init();
})();
