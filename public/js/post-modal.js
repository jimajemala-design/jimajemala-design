/* post-modal.js — NutriFell Phase 3: shared fullscreen post viewer.
   Reused by hashtag.html and search.html (profile-social.html keeps its own).
   PostModal.open(posts, index) shows media + caption + comments with like/react/
   comment and prev/next navigation. Renders author from each post's own
   authorName/authorUsername/authorAvatar fields. Styles come from profile.css
   (.post-modal / .pm-*). Requires auth.js. */
'use strict';

const PostModal = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const nFmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0);
  const notify = (m, t, ms) => { if (window.toast) toast(m, t, ms); };
  const REACTIONS = ['❤️', '🔥', '😋', '👏', '🤩', '💪'];

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
    const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function avatarHTML(url, name, cls) {
    return url ? `<div class="${cls}" style="background-image:url('${esc(url)}')"></div>` : `<div class="${cls}">${esc(initial(name))}</div>`;
  }
  function renderCaption(text) {
    return esc(text)
      .replace(/#([\p{L}0-9_]+)/gu, '<a class="hashtag" href="/hashtag.html?tag=$1">#$1</a>')
      .replace(/@([a-z0-9_]{2,30})/gi, '<a class="mention" href="/search.html?type=people&q=$1">@$1</a>');
  }

  let modal = null;
  const state = { list: [], index: 0 };

  function build() {
    modal = document.createElement('div');
    modal.className = 'post-modal';
    modal.innerHTML =
      '<button class="pm-close" id="pmCloseS" aria-label="Close">✕</button>' +
      '<button class="pm-nav pm-prev" id="pmPrevS" aria-label="Previous">‹</button>' +
      '<button class="pm-nav pm-next" id="pmNextS" aria-label="Next">›</button>' +
      '<div class="pm-shell" id="pmShellS"></div>';
    document.body.appendChild(modal);
    modal.querySelector('#pmCloseS').addEventListener('click', close);
    modal.querySelector('#pmPrevS').addEventListener('click', () => nav(-1));
    modal.querySelector('#pmNextS').addEventListener('click', () => nav(1));
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => {
      if (!modal.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') nav(-1);
      else if (e.key === 'ArrowRight') nav(1);
    });
  }

  function mediaHTML(p) {
    if ((p.photos || []).length) return `<img src="${esc(p.photos[0])}" alt="">`;
    if (p.video) return `<video src="${esc(p.video)}" controls autoplay playsinline></video>`;
    if (p.recipe && p.recipe.cover) return `<img src="${esc(p.recipe.cover)}" alt="">`;
    return `<div class="pm-text">${renderCaption(p.caption || '')}</div>`;
  }

  function render() {
    const p = state.list[state.index];
    const reacted = p.myReaction || null;
    modal.querySelector('#pmShellS').innerHTML =
      `<div class="pm-media">${mediaHTML(p)}</div>` +
      '<div class="pm-side">' +
        '<div class="pm-head">' +
          `<a href="/profile-social.html?id=${esc(p.userId)}">${avatarHTML(p.authorAvatar, p.authorName, 'post-avatar')}</a>` +
          `<div class="pm-head-id"><b>${esc(p.authorName || 'NutriFell User')}</b><span>${esc(p.authorUsername || '')} · ${timeAgo(p.createdAt)}</span></div>` +
        '</div>' +
        ((p.caption || (p.recipe && p.recipe.name)) ?
          `<div class="pm-caption">${p.recipe ? `<div style="font-weight:600;margin-bottom:6px">🍽️ ${esc(p.recipe.name)}</div>` : ''}<div class="cap-text">${renderCaption(p.caption || '')}</div></div>` : '') +
        '<div class="pm-comments" id="pmCommentsS"><div class="feed-empty" style="padding:24px"><span class="spinner"></span></div></div>' +
        '<div class="pm-actions">' +
          `<button class="act ${reacted ? 'liked' : ''}" id="pmLikeS">${reacted ? `<span style="font-size:20px">${reacted}</span>` : heart()} <span>${nFmt(p.totalReactions)}</span></button>` +
          REACTIONS.map(em => `<button class="act pm-react-opt" data-em="${em}" style="font-size:18px;padding:0 8px">${em}</button>`).join('') +
          `<button class="act ${p.saved ? 'saved' : ''}" id="pmSaveS" style="margin-left:auto">${bookmark()}</button>` +
          `<button class="act" id="pmShareS">${share()}</button>` +
        '</div>' +
        '<div class="pm-compose"><input id="pmInputS" placeholder="Add a comment…" aria-label="Add a comment" /><button id="pmSendS" disabled>Post</button></div>' +
      '</div>';

    modal.querySelector('#pmPrevS').disabled = state.index === 0;
    modal.querySelector('#pmNextS').disabled = state.index === state.list.length - 1;

    modal.querySelector('#pmLikeS').addEventListener('click', () => reactTo('❤️'));
    modal.querySelectorAll('.pm-react-opt').forEach(b => b.addEventListener('click', () => reactTo(b.dataset.em)));
    modal.querySelector('#pmSaveS').addEventListener('click', toggleSave);
    modal.querySelector('#pmShareS').addEventListener('click', sharePost);
    const inp = modal.querySelector('#pmInputS'), send = modal.querySelector('#pmSendS');
    inp.addEventListener('input', () => { send.disabled = !inp.value.trim(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendComment(); } });
    send.addEventListener('click', sendComment);
    loadComments(p.id);
  }

  async function reactTo(emoji) {
    if (!authed()) { location.href = '/login.html'; return; }
    const p = state.list[state.index];
    try {
      const out = await Auth.api(`/api/posts/${p.id}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
      p.myReaction = out.mine; p.totalReactions = out.total;
      const like = modal.querySelector('#pmLikeS');
      like.classList.toggle('liked', !!out.mine);
      like.innerHTML = (out.mine ? `<span style="font-size:20px">${out.mine}</span>` : heart()) + ` <span>${nFmt(out.total)}</span>`;
    } catch (e) { notify(e.message, 'error'); }
  }
  async function toggleSave() {
    if (!authed()) { location.href = '/login.html'; return; }
    const p = state.list[state.index];
    try { const out = await Auth.api(`/api/posts/${p.id}/save`, { method: 'POST' }); p.saved = out.saved; modal.querySelector('#pmSaveS').classList.toggle('saved', out.saved); notify(out.saved ? 'Saved' : 'Removed', 'success', 1500); }
    catch (e) { notify(e.message, 'error'); }
  }
  async function sharePost() {
    const p = state.list[state.index];
    const url = location.origin + '/feed.html?post=' + p.id;
    try { if (navigator.share) await navigator.share({ title: 'NutriFell', url }); else { await navigator.clipboard.writeText(url); notify('Link copied', 'success', 1600); } } catch { /* cancelled */ }
  }
  async function loadComments(id) {
    const host = modal.querySelector('#pmCommentsS');
    try {
      const comments = await Auth.api('/api/posts/' + id + '/comments');
      if (!comments.length) { host.innerHTML = '<div class="feed-empty" style="padding:24px"><span class="em">💬</span><h3>No comments yet</h3></div>'; return; }
      host.innerHTML = comments.map(commentHTML).join('');
    } catch { host.innerHTML = '<div class="feed-empty" style="padding:24px"><h3>Could not load comments</h3></div>'; }
  }
  function commentHTML(c) {
    const replies = (c.replies || []).map(r =>
      `<div class="comment">${avatarHTML(r.authorAvatar, r.authorName, 'post-avatar')}<div class="comment-main"><div class="comment-bubble"><b>${esc(r.authorName)}</b><p>${renderCaption(r.text)}</p></div><div class="comment-actions"><span>${timeAgo(r.at)}</span></div></div></div>`).join('');
    return `<div class="comment">${avatarHTML(c.authorAvatar, c.authorName, 'post-avatar')}<div class="comment-main"><div class="comment-bubble"><b>${esc(c.authorName)}</b><p>${renderCaption(c.text)}</p></div><div class="comment-actions"><span>${timeAgo(c.at)}</span></div>${replies ? `<div class="comment-replies">${replies}</div>` : ''}</div></div>`;
  }
  async function sendComment() {
    if (!authed()) { location.href = '/login.html'; return; }
    const p = state.list[state.index];
    const inp = modal.querySelector('#pmInputS'); const text = inp.value.trim();
    if (!text) return;
    modal.querySelector('#pmSendS').disabled = true;
    try { await Auth.api(`/api/posts/${p.id}/comments`, { method: 'POST', body: JSON.stringify({ text }) }); inp.value = ''; p.commentCount = (p.commentCount || 0) + 1; await loadComments(p.id); }
    catch (e) { notify(e.message, 'error'); }
  }

  function open(list, index) {
    if (!modal) build();
    state.list = list; state.index = index;
    modal.classList.add('open'); document.body.style.overflow = 'hidden';
    render();
  }
  function close() { if (modal) modal.classList.remove('open'); document.body.style.overflow = ''; }
  function nav(d) { const n = state.index + d; if (n < 0 || n >= state.list.length) return; state.index = n; render(); }

  function heart() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>'; }
  function bookmark() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'; }
  function share() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>'; }

  return { open, close };
})();
