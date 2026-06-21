/* hashtag.js — NutriFell Phase 3 hashtag page (/hashtag.html?tag=...).
   Header with post count, follow + share, related tags, and Top/Recent post
   grids that open the shared PostModal. Requires auth.js, post-modal.js. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const notify = (m, t, ms) => { if (window.toast) toast(m, t, ms); };
  const nFmt = (n) => n >= 1000 ? n.toLocaleString() : String(n || 0);
  const TYPE_EMOJI = { photo: '📸', video: '🎬', recipe: '🍽️', text: '💬' };

  const TAG = (new URLSearchParams(location.search).get('tag') || '').toLowerCase().replace(/^#/, '');
  const wrap = $('hashWrap');
  let topPosts = [], recentPosts = [];

  if (authed()) { const u = Auth.user(); if (u) $('bnProfile').href = '/profile-social.html?id=' + u.id; }

  if (!TAG) {
    wrap.innerHTML = '<div class="feed-empty"><span class="em">🏷️</span><h3>No hashtag specified</h3><p><a href="/search.html" style="color:var(--green)">Search instead</a></p></div>';
    return;
  }
  document.title = '#' + TAG + ' · NutriFell';

  function tileMedia(p) {
    if ((p.photos || []).length) return `<img src="${esc(p.photos[0])}" alt="" loading="lazy">`;
    if (p.video) return `<video src="${esc(p.video)}" muted preload="metadata"></video>`;
    if (p.recipe && p.recipe.cover) return `<img src="${esc(p.recipe.cover)}" alt="" loading="lazy">`;
    if (p.type === 'text') return `<div class="tile-text">${esc((p.caption || '').slice(0, 140))}</div>`;
    return TYPE_EMOJI[p.type] || '📝';
  }
  function gridHTML(arr, which) {
    if (!arr.length) return '<div class="feed-empty" style="padding:30px"><span class="em">🌱</span><h3>No posts yet</h3></div>';
    return '<div class="post-grid">' + arr.map((p, i) =>
      `<button class="pg-tile" data-which="${which}" data-i="${i}">${tileMedia(p)}` +
      `<span class="pg-badge">${TYPE_EMOJI[p.type] || ''}</span>` +
      `<span class="pg-stats">❤️ ${nFmt(p.totalReactions)} &nbsp; 💬 ${nFmt(p.commentCount)}</span></button>`
    ).join('') + '</div>';
  }
  function wireTiles() {
    wrap.querySelectorAll('.pg-tile').forEach(el => el.addEventListener('click', () => {
      const arr = el.dataset.which === 'top' ? topPosts : recentPosts;
      PostModal.open(arr, parseInt(el.dataset.i, 10));
    }));
  }

  async function load() {
    wrap.innerHTML = '<div class="hash-hero"><div class="hash-icon">#</div><div class="skel skel-line" style="width:120px;height:20px;margin:0 auto"></div></div><div class="sk-grid">' +
      Array.from({ length: 9 }).map(() => '<div class="sk-tile skel"></div>').join('') + '</div>';
    try {
      const [info, top, recent] = await Promise.all([
        Auth.api('/api/hashtags/' + encodeURIComponent(TAG)),
        Auth.api(`/api/hashtags/${encodeURIComponent(TAG)}/posts?sort=top`),
        Auth.api(`/api/hashtags/${encodeURIComponent(TAG)}/posts?sort=recent`),
      ]);
      topPosts = top.posts || [];
      recentPosts = recent.posts || [];
      render(info);
    } catch (e) {
      wrap.innerHTML = '<div class="feed-empty"><span class="em">😕</span><h3>Could not load this hashtag</h3></div>';
    }
  }

  function render(info) {
    const count = info.postCount || 0;
    const related = (info.related || []).map(r =>
      `<a class="related-tag" href="/hashtag.html?tag=${encodeURIComponent(r.tag)}">#${esc(r.tag)}</a>`).join('');
    wrap.innerHTML =
      '<div class="hash-hero">' +
        '<div class="hash-icon">#</div>' +
        `<h1 class="hash-title">#${esc(TAG)}</h1>` +
        `<div class="hash-count">${nFmt(count)} ${count === 1 ? 'post' : 'posts'}${info.recentCount ? ` · ${nFmt(info.recentCount)} this week` : ''}</div>` +
        '<div class="hash-actions">' +
          `<button class="hash-btn ${info.isFollowing ? 'following' : 'follow'}" id="followTag">${info.isFollowing ? 'Following' : 'Follow'}</button>` +
          '<button class="hash-btn ghost" id="shareTag">Share</button>' +
        '</div>' +
      '</div>' +
      (related ? `<div class="section-label" style="text-align:center">Related</div><div class="related-tags">${related}</div>` : '') +
      (topPosts.length ? '<div class="section-label">🔥 Top posts</div>' + gridHTML(topPosts, 'top') : '') +
      '<div class="section-label">🆕 Recent</div>' + gridHTML(recentPosts, 'recent');

    $('followTag').addEventListener('click', toggleFollow);
    $('shareTag').addEventListener('click', shareTag);
    wireTiles();
  }

  async function toggleFollow() {
    if (!authed()) { location.href = '/login.html'; return; }
    const b = $('followTag');
    b.disabled = true;
    try {
      const out = await Auth.api(`/api/hashtags/${encodeURIComponent(TAG)}/follow`, { method: 'POST' });
      b.className = 'hash-btn ' + (out.following ? 'following' : 'follow');
      b.textContent = out.following ? 'Following' : 'Follow';
      if (out.following) notify('Following #' + TAG, 'success', 1800);
    } catch (e) { notify(e.message, 'error'); }
    finally { b.disabled = false; }
  }
  async function shareTag() {
    const url = location.origin + '/hashtag.html?tag=' + encodeURIComponent(TAG);
    try { if (navigator.share) await navigator.share({ title: '#' + TAG, url }); else { await navigator.clipboard.writeText(url); notify('Link copied', 'success', 1600); } } catch { /* cancelled */ }
  }

  load();
})();
