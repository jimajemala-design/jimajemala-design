/* post-detail.js — immersive single-post view.
   URL: /post-detail.html?id={postId}
   Fetches GET /api/posts/:id + /comments, renders a full-bleed media (or
   large-text) hero, content, a fixed action dock, threaded comments, and a
   keyboard-aware composer. Reuses the shared Auth / Toast helpers. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const me = () => (typeof Auth !== 'undefined' && Auth.user()) || {};
  const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();
  const nFmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0);

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
    const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function fullDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); }
    catch { return ''; }
  }

  // Linkify #hashtags → /feed.html?hashtag=tag and @mentions → people search.
  function renderCaption(text) {
    return esc(text)
      .replace(/#([\p{L}0-9_]+)/gu, '<a class="pd-hashtag" href="/feed.html?hashtag=$1">#$1</a>')
      .replace(/@([a-z0-9_]{2,30})/gi, '<a class="pd-mention" href="/search.html?type=people&q=$1">@$1</a>');
  }
  function avatarStyle(url) { return url ? ` style="background-image:url('${esc(url)}')"` : ''; }

  const I = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    heartFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21 4.2 13.4l-1-1a5.5 5.5 0 0 1 7.8-7.8l1 1.1 1-1.1a5.5 5.5 0 0 1 7.8 7.8l-1 1z"/></svg>',
    comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.6A8.4 8.4 0 1 1 21 11.5z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    bookmarkFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/></svg>',
  };

  const state = { id: null, post: null, comments: [], shown: 10, replyTo: null };

  // ── media helpers ──────────────────────────────────────────────────────
  function hasMedia(p) {
    if (p.type === 'video') return !!p.video;
    if (p.type === 'recipe') return true;
    return (p.photos || []).length > 0;
  }
  function heroMediaInner(p) {
    if (p.type === 'video' && p.video) {
      return `<video src="${esc(p.video)}" ${p.videoThumb ? `poster="${esc(p.videoThumb)}"` : ''} autoplay muted loop playsinline></video>`;
    }
    const src = p.type === 'recipe'
      ? ((p.recipe && p.recipe.cover) || (p.photos || [])[0] || '')
      : (p.photos || [])[0] || '';
    if (!src) return `<div class="pd-hero-ph">${p.type === 'recipe' ? '🍽️' : '📷'}</div>`;
    return `<img src="${esc(src)}" alt="${esc(p.caption || '').slice(0, 80)}" />`;
  }
  function pillLabel(p) {
    const type = ({ recipe: 'RECIPE', video: 'REEL', photo: 'PHOTO' })[p.type] || '';
    let detail = '';
    if (p.type === 'recipe' && p.recipe) {
      detail = p.recipe.calories != null ? `${p.recipe.calories} KCAL`
             : (p.recipe.category ? String(p.recipe.category).toUpperCase() : '');
    } else if (p.type === 'video' && p.views) {
      detail = `${nFmt(p.views)} VIEWS`;
    }
    return detail ? `${type} · ${detail}` : type;
  }

  // ── render ──────────────────────────────────────────────────────────────
  function authorRow(p) {
    const followBtn = (authed() && !p.isOwn && p.userId)
      ? `<button class="pd-follow${p.isFollowingAuthor ? ' following' : ''}" id="pdFollow">${p.isFollowingAuthor ? 'Following' : 'Follow'}</button>`
      : '';
    const handle = p.authorUsername ? `@${esc(p.authorUsername)}` : '';
    return `<div class="pd-author">
      <a class="pd-avatar" href="/profile-social.html?id=${esc(p.userId)}"${avatarStyle(p.authorAvatar)}>${p.authorAvatar ? '' : esc(initial(p.authorName))}</a>
      <a class="pd-author-meta" href="/profile-social.html?id=${esc(p.userId)}">
        <span class="pd-name">${esc(p.authorName || 'NutriFell User')}</span>
        ${handle ? `<span class="pd-handle">${handle}</span>` : ''}
      </a>
      ${followBtn}
    </div>`;
  }

  function renderPost(p) {
    state.post = p;
    const media = hasMedia(p);
    const recipeName = (p.type === 'recipe' && p.recipe) ? p.recipe.name : '';
    const captionHTML = p.caption ? renderCaption(p.caption) : '';

    let html = '';
    if (media) {
      html += `<div class="pd-hero">
        ${heroMediaInner(p)}
        <button class="pd-overlay-btn back" id="pdBack" aria-label="Back">${I.back}</button>
        <button class="pd-overlay-btn more" id="pdMore" aria-label="More options">${I.more}</button>
        ${pillLabel(p) ? `<span class="pd-pill">${esc(pillLabel(p))}</span>` : ''}
      </div>`;
      html += `<div class="pd-content">
        ${authorRow(p)}
        ${recipeName ? `<div class="pd-caption" style="font-weight:700;color:var(--text)">${esc(recipeName)}</div>` : ''}
        ${captionHTML ? `<div class="pd-caption">${captionHTML}</div>` : ''}
        ${p.location ? `<div class="pd-recipe-meta">📍 ${esc(p.location)}</div>` : ''}
        <div class="pd-timestamp">${fullDate(p.createdAt)} · ${timeAgo(p.createdAt)}${p.views ? ` · ${nFmt(p.views)} views` : ''}</div>
      </div>`;
    } else {
      // TEXT POST — top bar + large-text hero, author row below.
      html += `<div class="pd-topbar">
        <button class="pd-bar-btn" id="pdBack" aria-label="Back">${I.back}</button>
        <button class="pd-bar-btn" id="pdMore" aria-label="More options">${I.more}</button>
      </div>`;
      html += `<div class="pd-text-hero">${captionHTML || '<span style="color:var(--text-4)">(no text)</span>'}</div>`;
      html += `<div class="pd-content">
        ${authorRow(p)}
        <div class="pd-timestamp">${fullDate(p.createdAt)} · ${timeAgo(p.createdAt)}</div>
      </div>`;
    }

    html += `<div class="pd-comments" id="pdComments">
      <div class="pd-comments-head">Comments</div>
      <div id="pdCommentList"><div class="pd-comments-empty">Loading comments…</div></div>
    </div>`;

    $('pdScroll').innerHTML = html;
    renderDock(p);
    renderComposer();
    wirePost();
  }

  function renderDock(p) {
    const liked = p.myReaction === '❤️';
    $('pdDock').innerHTML = `<div class="pd-dock-inner">
      <button class="pd-act like${liked ? ' liked' : ''}" id="pdLike" aria-label="Like">
        ${liked ? I.heartFill : I.heart}<span id="pdLikeCount">${p.totalReactions ? nFmt(p.totalReactions) : ''}</span>
      </button>
      <button class="pd-act comment" id="pdToComment" aria-label="Comments">
        ${I.comment}<span id="pdCommentCount">${p.commentCount ? nFmt(p.commentCount) : ''}</span>
      </button>
      <span class="pd-dock-spacer"></span>
      <button class="pd-act share" id="pdShare" aria-label="Share">${I.share}</button>
      <button class="pd-act save${p.saved ? ' saved' : ''}" id="pdSave" aria-label="Save">${p.saved ? I.bookmarkFill : I.bookmark}</button>
    </div>`;
  }

  function renderComposer() {
    const u = me();
    $('pdComposer').innerHTML = `<div class="pd-composer-inner">
      <div class="pd-composer-av"${avatarStyle(u.avatar)}>${u.avatar ? '' : esc(initial(u.name))}</div>
      <div class="pd-composer-field">
        <input id="pdInput" type="text" maxlength="2000" placeholder="Add a comment..." autocomplete="off" />
      </div>
      <button class="pd-send" id="pdSend" aria-label="Send comment" disabled>${I.send}</button>
    </div>`;
  }

  // ── comments ─────────────────────────────────────────────────────────────
  function commentCardHTML(c, isReply) {
    const myId = me().id || '';
    const liked = (c.likes || []).includes(myId);
    const likeCount = c.likeCount != null ? c.likeCount : (c.likes || []).length;
    const replies = !isReply && (c.replies || []).length
      ? `<div class="pd-replies">${c.replies.map(r => commentCardHTML(r, true)).join('')}</div>` : '';
    return `<div class="pd-comment" data-cid="${esc(c.id)}">
      <a class="pd-comment-av" href="/profile-social.html?id=${esc(c.userId)}"${avatarStyle(c.authorAvatar)}>${c.authorAvatar ? '' : esc(initial(c.authorName))}</a>
      <div class="pd-comment-body">
        <div class="pd-comment-top">
          <a class="pd-comment-user" href="/profile-social.html?id=${esc(c.userId)}">${esc(c.authorName || 'User')}</a>
          <span class="pd-comment-time">${timeAgo(c.at)}</span>
        </div>
        <div class="pd-comment-text">${renderCaption(c.text)}</div>
        <div class="pd-comment-actions">
          ${isReply ? '' : `<button class="pd-comment-reply" data-reply="${esc(c.id)}" data-name="${esc(c.authorName || '')}">Reply</button>`}
          <button class="pd-comment-like${liked ? ' liked' : ''}" data-clike="${esc(c.id)}" aria-label="Like comment">
            ${liked ? I.heartFill : I.heart}<span>${likeCount || ''}</span>
          </button>
        </div>
        ${replies}
      </div>
    </div>`;
  }

  function renderComments() {
    const host = $('pdCommentList');
    if (!host) return;
    if (!state.comments.length) {
      host.innerHTML = `<div class="pd-comments-empty">No comments yet — be the first to share a thought.</div>`;
      return;
    }
    const slice = state.comments.slice(0, state.shown);
    let html = slice.map(c => commentCardHTML(c, false)).join('');
    if (state.comments.length > state.shown) {
      html += `<button class="pd-loadmore" id="pdLoadMore">Load more comments (${state.comments.length - state.shown})</button>`;
    }
    host.innerHTML = html;
    const more = $('pdLoadMore');
    if (more) more.addEventListener('click', () => { state.shown += 10; renderComments(); });
  }

  async function loadComments() {
    try {
      state.comments = await Auth.api(`/api/posts/${state.id}/comments`) || [];
    } catch { state.comments = []; }
    renderComments();
    const cc = $('pdCommentCount');
    if (cc) cc.textContent = state.comments.length ? nFmt(state.comments.length) : '';
  }

  // ── interactions ─────────────────────────────────────────────────────────
  function goBack() {
    if (history.length > 1) history.back();
    else location.href = '/feed.html';
  }
  function requireLogin() {
    if (!authed()) { toast('Log in to do that.', 'info', 2500); setTimeout(() => location.href = '/login.html', 700); return false; }
    return true;
  }

  async function toggleLike() {
    if (!requireLogin()) return;
    const btn = $('pdLike');
    try {
      const out = await Auth.api(`/api/posts/${state.id}/like`, { method: 'POST' });
      const liked = !!out.liked;
      state.post.myReaction = liked ? '❤️' : null;
      state.post.totalReactions = out.total != null ? out.total : state.post.totalReactions;
      btn.classList.toggle('liked', liked);
      btn.querySelector('svg').outerHTML = liked ? I.heartFill : I.heart;
      $('pdLikeCount').textContent = state.post.totalReactions ? nFmt(state.post.totalReactions) : '';
    } catch (err) { toast(err.message, 'error'); }
  }

  async function toggleSave() {
    if (!requireLogin()) return;
    const btn = $('pdSave');
    try {
      const out = await Auth.api(`/api/posts/${state.id}/save`, { method: 'POST' });
      state.post.saved = !!out.saved;
      btn.classList.toggle('saved', out.saved);
      btn.innerHTML = out.saved ? I.bookmarkFill : I.bookmark;
      toast(out.saved ? 'Saved to your collection' : 'Removed from saved', 'success', 1600);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function toggleFollow() {
    if (!requireLogin()) return;
    const btn = $('pdFollow');
    if (!btn) return;
    btn.disabled = true;
    try {
      const out = await Auth.api(`/api/users/${state.post.userId}/follow`, { method: 'POST' });
      state.post.isFollowingAuthor = !!out.following;
      btn.classList.toggle('following', out.following);
      btn.textContent = out.following ? 'Following' : 'Follow';
      toast(out.following ? 'Following' : 'Unfollowed', 'success', 1500);
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  }

  async function share() {
    const url = location.origin + '/post-detail.html?id=' + state.id;
    if (navigator.share) {
      try { await navigator.share({ title: 'NutriFell', url }); return; } catch { /* cancelled */ }
    }
    try { await navigator.clipboard.writeText(url); toast('Link copied to clipboard', 'success', 1800); }
    catch { window.open('https://wa.me/?text=' + encodeURIComponent(url), '_blank'); }
  }

  function openMore() {
    const isOwn = !!state.post.isOwn;
    const items = ['<button data-m="copy">🔗 Copy link</button>'];
    items.push(isOwn ? '<button data-m="delete">🗑️ Delete post</button>' : '<button data-m="report">🚩 Report post</button>');
    const sheet = document.createElement('div');
    sheet.className = 'pd-sheet-overlay';
    sheet.innerHTML = `<div class="pd-sheet">${items.join('')}</div>`;
    Object.assign(sheet.style, { position: 'fixed', inset: '0', zIndex: '300', background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center' });
    const card = sheet.querySelector('.pd-sheet');
    Object.assign(card.style, { width: '100%', maxWidth: '460px', background: '#121614', borderRadius: '24px 24px 0 0',
      border: '1px solid rgba(255,255,255,0.06)', padding: '10px', marginBottom: '0', display: 'flex', flexDirection: 'column' });
    card.querySelectorAll('button').forEach(b => Object.assign(b.style, { padding: '15px', border: 'none',
      background: 'none', color: '#F2F4F2', fontSize: '15px', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }));
    document.body.appendChild(sheet);
    sheet.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) { if (e.target === sheet) sheet.remove(); return; }
      const m = b.dataset.m;
      sheet.remove();
      if (m === 'copy') share();
      else if (m === 'report') {
        if (!requireLogin()) return;
        const reason = prompt('Why are you reporting this post? (optional)') ?? '';
        try { const r = await Auth.api(`/api/posts/${state.id}/report`, { method: 'POST', body: JSON.stringify({ reason }) });
          toast(r.message || 'Reported. Thank you.', 'success'); } catch (err) { toast(err.message, 'error'); }
      } else if (m === 'delete') {
        if (!confirm('Delete this post? This cannot be undone.')) return;
        try { await Auth.api(`/api/posts/${state.id}`, { method: 'DELETE' }); toast('Post deleted', 'success'); setTimeout(goBack, 600); }
        catch (err) { toast(err.message, 'error'); }
      }
    });
  }

  function setReplyTo(cid, name) {
    state.replyTo = cid ? { cid, name } : null;
    const ctx = $('pdReplyCtx');
    if (state.replyTo) {
      ctx.innerHTML = `<span>Replying to <b>${esc(name)}</b></span><button id="pdReplyCancel" aria-label="Cancel reply">✕</button>`;
      ctx.classList.add('show');
      $('pdReplyCancel').addEventListener('click', () => setReplyTo(null));
      const inp = $('pdInput'); if (inp) inp.focus();
    } else {
      ctx.classList.remove('show'); ctx.innerHTML = '';
    }
  }

  async function sendComment() {
    if (!requireLogin()) return;
    const inp = $('pdInput');
    const text = (inp.value || '').trim();
    if (!text) return;
    const btn = $('pdSend');
    btn.disabled = true; inp.disabled = true;
    try {
      if (state.replyTo) {
        await Auth.api(`/api/posts/${state.id}/comments/${state.replyTo.cid}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
      } else {
        await Auth.api(`/api/posts/${state.id}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
      }
      inp.value = '';
      setReplyTo(null);
      state.shown = Math.max(state.shown, 10);
      await loadComments();
      toast('Comment posted', 'success', 1400);
    } catch (err) {
      toast(err.message || 'Could not post comment.', 'error');
    } finally {
      btn.disabled = false; inp.disabled = false; inp.focus();
    }
  }

  async function likeComment(cid, btn) {
    if (!requireLogin()) return;
    try {
      const out = await Auth.api(`/api/posts/${state.id}/comments/${cid}/like`, { method: 'POST' });
      btn.classList.toggle('liked', !!out.liked);
      btn.querySelector('svg').outerHTML = out.liked ? I.heartFill : I.heart;
      btn.querySelector('span').textContent = out.likeCount || '';
    } catch (err) { toast(err.message, 'error'); }
  }

  // Wire elements that live inside #pdScroll (re-bound after every renderPost).
  function wirePost() {
    $('pdBack')?.addEventListener('click', goBack);
    $('pdMore')?.addEventListener('click', openMore);
    $('pdFollow')?.addEventListener('click', toggleFollow);
    $('pdLike')?.addEventListener('click', toggleLike);
    $('pdSave')?.addEventListener('click', toggleSave);
    $('pdShare')?.addEventListener('click', share);
    $('pdToComment')?.addEventListener('click', () => { $('pdInput')?.focus(); });

    const send = $('pdSend'), inp = $('pdInput');
    if (inp && send) {
      inp.addEventListener('input', () => { send.disabled = !inp.value.trim(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendComment(); } });
      send.addEventListener('click', sendComment);
      // Keyboard-aware: drop the dock/composer to the very bottom while typing.
      inp.addEventListener('focus', () => document.body.classList.add('pd-kbd'));
      inp.addEventListener('blur', () => setTimeout(() => document.body.classList.remove('pd-kbd'), 120));
    }

    // Delegated handlers for the comment list (reply / like).
    $('pdComments')?.addEventListener('click', (e) => {
      const reply = e.target.closest('[data-reply]');
      const clike = e.target.closest('[data-clike]');
      if (reply) { e.preventDefault(); setReplyTo(reply.dataset.reply, reply.dataset.name); }
      else if (clike) { e.preventDefault(); likeComment(clike.dataset.clike, clike); }
    });
  }

  // ── follow state (single-post endpoint omits it) ─────────────────────────
  async function hydrateFollowState(userId) {
    try {
      const u = await Auth.api('/api/users/' + userId);
      if (u && state.post) {
        state.post.isFollowingAuthor = !!u.isFollowing;
        const btn = $('pdFollow');
        if (btn) { btn.classList.toggle('following', !!u.isFollowing); btn.textContent = u.isFollowing ? 'Following' : 'Follow'; }
      }
    } catch { /* leave default Follow */ }
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  async function init() {
    state.id = new URLSearchParams(location.search).get('id');
    if (!state.id) { renderError("This post couldn't be found."); return; }
    try {
      const post = await Auth.api('/api/posts/' + state.id);
      renderPost(post);
      loadComments();
      if (authed() && !post.isOwn && post.userId) hydrateFollowState(post.userId);
    } catch (err) {
      renderError(err && /not found/i.test(err.message || '') ? 'This post is no longer available.' : 'Could not load this post.');
    }
  }
  function renderError(msg) {
    $('pdScroll').innerHTML = `<div class="pd-error">
      <div style="font-size:42px">🍃</div>
      <p>${esc(msg)}</p>
      <a href="/feed.html">← Back to feed</a>
    </div>`;
    $('pdDock').innerHTML = ''; $('pdComposer').innerHTML = ''; $('pdReplyCtx').classList.remove('show');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
