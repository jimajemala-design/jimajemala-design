/* search.js — NutriFell Phase 3 search + explore (/search.html).
   Debounced search-as-you-type across People / Posts / Recipes / Hashtags /
   Foods, recent-searches (localStorage), and an Explore view (trending hashtags,
   suggested users, popular foods) shown when the query is empty.
   Requires auth.js, post-modal.js. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const notify = (m, t, ms) => { if (window.toast) toast(m, t, ms); };
  const nFmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0);
  const TYPE_EMOJI = { photo: '📸', video: '🎬', recipe: '🍽️', text: '💬' };

  const input = $('searchInput'), results = $('searchResults'), clearBtn = $('searchClear');
  const RECENT_KEY = 'nf_recent_searches';
  let type = 'all';
  let recipesCache = null;
  let lastPosts = [];
  let debounceTimer = null;

  if (authed()) { const u = Auth.user(); if (u) $('bnProfile').href = '/profile-social.html?id=' + u.id; }

  function avatarHTML(url, name, cls) {
    return url ? `<div class="${cls}" style="background-image:url('${esc(url)}')"></div>` : `<div class="${cls}">${esc(initial(name))}</div>`;
  }

  // ── recent searches ──────────────────────────────────────────────────
  const getRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
  const setRecent = (a) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(a.slice(0, 10))); } catch {} };
  function pushRecent(q) {
    q = q.trim(); if (!q) return;
    const a = getRecent().filter(x => x.toLowerCase() !== q.toLowerCase());
    a.unshift(q); setRecent(a);
  }
  function removeRecent(q) { setRecent(getRecent().filter(x => x !== q)); }

  // ── result renderers ─────────────────────────────────────────────────
  function userRow(u) {
    return `<div class="user-result" data-uid="${esc(u.id)}">` +
      avatarHTML(u.avatar, u.name, 'post-avatar') +
      `<div class="ur-info"><b>${esc(u.name)}</b><span>${esc(u.username)} · ${nFmt(u.followers)} followers</span></div>` +
      (u.isOwn ? '' : `<button class="ur-btn ${u.isFollowing ? 'following' : ''}" data-follow="${esc(u.id)}">${u.isFollowing ? 'Following' : 'Follow'}</button>`) +
      '</div>';
  }
  function hashRow(h) {
    return `<a class="hash-result" href="/hashtag.html?tag=${encodeURIComponent(h.tag)}"><div class="hr-ic">#</div>` +
      `<div class="ur-info"><b>#${esc(h.tag)}</b><span>${nFmt(h.count)} ${h.count === 1 ? 'post' : 'posts'}</span></div></a>`;
  }
  function foodRow(f) {
    return `<a class="food-result" href="/index.html?food=${encodeURIComponent(f.id)}"><div class="fr-ic">${esc(f.emoji || '🍽️')}</div>` +
      `<div class="ur-info"><b>${esc(f.name)}</b><span class="fr-cal">${f.calories} kcal / 100g</span></div></a>`;
  }
  function recipeRow(r) {
    const cal = r.nutrition && r.nutrition.perServing ? Math.round(r.nutrition.perServing.calories) : null;
    const cover = (r.photos || [])[0];
    return `<a class="food-result" href="/recipe-detail.html?id=${encodeURIComponent(r.id)}">` +
      (cover ? `<img class="fr-ic" style="object-fit:cover" src="${esc(cover)}" alt="">` : '<div class="fr-ic">🍽️</div>') +
      `<div class="ur-info"><b>${esc(r.name)}</b><span>${esc(r.category || 'Recipe')}${cal ? ` · <span class="fr-cal">${cal} kcal</span>` : ''}</span></div></a>`;
  }
  function postsGrid(arr) {
    if (!arr.length) return '';
    return '<div class="post-grid">' + arr.map((p, i) => {
      const media = (p.photos || []).length ? `<img src="${esc(p.photos[0])}" alt="" loading="lazy">`
        : p.video ? `<video src="${esc(p.video)}" muted preload="metadata"></video>`
        : (p.recipe && p.recipe.cover) ? `<img src="${esc(p.recipe.cover)}" alt="" loading="lazy">`
        : p.type === 'text' ? `<div class="tile-text">${esc((p.caption || '').slice(0, 140))}</div>` : (TYPE_EMOJI[p.type] || '📝');
      return `<button class="pg-tile" data-i="${i}">${media}<span class="pg-badge">${TYPE_EMOJI[p.type] || ''}</span>` +
        `<span class="pg-stats">❤️ ${nFmt(p.totalReactions)} &nbsp; 💬 ${nFmt(p.commentCount)}</span></button>`;
    }).join('') + '</div>';
  }
  function wirePostTiles(scope) {
    scope.querySelectorAll('.pg-tile').forEach(el => el.addEventListener('click', () => PostModal.open(lastPosts, parseInt(el.dataset.i, 10))));
  }
  function wireUserFollows(scope) {
    scope.querySelectorAll('[data-follow]').forEach(b => b.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!authed()) { location.href = '/login.html'; return; }
      b.disabled = true;
      try { const out = await Auth.api(`/api/users/${b.dataset.follow}/follow`, { method: 'POST' });
        b.classList.toggle('following', out.following); b.textContent = out.following ? 'Following' : 'Follow';
      } catch (err) { notify(err.message, 'error'); } finally { b.disabled = false; }
    }));
  }
  const sectionLabel = (t) => `<div class="section-label">${t}</div>`;
  const noResults = (q) => `<div class="feed-empty" style="padding:50px 20px"><span class="em">🔍</span><h3>No results for “${esc(q)}”</h3><p style="color:var(--text-3)">Try a different word or check the spelling.</p></div>`;

  // ── searches ─────────────────────────────────────────────────────────
  async function runSearch(q) {
    results.innerHTML = '<div class="feed-empty" style="padding:40px"><span class="spinner"></span></div>';
    try {
      if (type === 'all') return renderAll(q, await Auth.api('/api/search?q=' + encodeURIComponent(q)));
      if (type === 'people') return renderPeople(q, await Auth.api('/api/search/users?q=' + encodeURIComponent(q)));
      if (type === 'hashtags') return renderHashtags(q, await Auth.api('/api/search/hashtags?q=' + encodeURIComponent(q)));
      if (type === 'foods') return renderFoods(q, await Auth.api('/api/search/foods?q=' + encodeURIComponent(q)));
      if (type === 'posts') { const arr = await Auth.api('/api/search/posts?q=' + encodeURIComponent(q)); return renderPosts(q, arr); }
      if (type === 'recipes') return renderRecipes(q);
    } catch (e) { results.innerHTML = '<div class="feed-empty"><h3>Search failed. Try again.</h3></div>'; }
  }

  function renderAll(q, d) {
    let html = '';
    if (d.users.length) { html += sectionLabel('People') + d.users.map(userRow).join(''); }
    if (d.hashtags.length) { html += sectionLabel('Hashtags') + d.hashtags.map(hashRow).join(''); }
    if (d.foods.length) { html += sectionLabel('Foods') + d.foods.map(foodRow).join(''); }
    if (d.posts.length) { lastPosts = d.posts; html += sectionLabel('Posts') + postsGrid(d.posts); }
    results.innerHTML = html || noResults(q);
    wireUserFollows(results); wirePostTiles(results);
  }
  function renderPeople(q, arr) { results.innerHTML = arr.length ? arr.map(userRow).join('') : noResults(q); wireUserFollows(results); }
  function renderHashtags(q, arr) { results.innerHTML = arr.length ? arr.map(hashRow).join('') : noResults(q); }
  function renderFoods(q, arr) { results.innerHTML = arr.length ? arr.map(foodRow).join('') : noResults(q); }
  function renderPosts(q, arr) { lastPosts = arr; results.innerHTML = arr.length ? postsGrid(arr) : noResults(q); wirePostTiles(results); }
  async function renderRecipes(q) {
    if (recipesCache === null) { try { recipesCache = await Auth.api('/api/recipes'); } catch { recipesCache = []; } }
    const ql = q.toLowerCase();
    const arr = recipesCache.filter(r => (r.name || '').toLowerCase().includes(ql) || (r.category || '').toLowerCase().includes(ql)).slice(0, 30);
    results.innerHTML = arr.length ? arr.map(recipeRow).join('') : noResults(q);
  }

  // ── explore (empty query) ────────────────────────────────────────────
  async function renderExplore() {
    const recent = getRecent();
    let html = '';
    if (recent.length) {
      html += '<div class="recent-box"><div class="recent-head"><b>Recent searches</b><button id="clearRecent">Clear all</button></div>' +
        recent.map(q => `<div class="recent-item" data-q="${esc(q)}"><span class="ri-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span><span>${esc(q)}</span><button class="ri-x" data-rm="${esc(q)}" aria-label="Remove">✕</button></div>`).join('') +
        '</div>';
    }
    html += '<div id="exploreBlocks"><div class="section-label">🔥 Trending hashtags</div><div class="trend-chips" id="trendChips"><span class="spinner"></span></div>' +
      '<div class="section-label">✨ Suggested for you</div><div class="explore-users" id="suggestUsers"></div>' +
      '<div class="section-label">🥗 Popular foods</div><div id="popularFoods"></div></div>';
    results.innerHTML = html;

    // wire recent
    results.querySelectorAll('.recent-item').forEach(el => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-rm]')) return;
      input.value = el.dataset.q; onInput(true);
    }));
    results.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); removeRecent(b.dataset.rm); renderExplore(); }));
    const cr = $('clearRecent'); if (cr) cr.addEventListener('click', () => { setRecent([]); renderExplore(); });

    // load explore data
    loadExploreData();
  }
  async function loadExploreData() {
    try {
      const tags = await Auth.api('/api/hashtags/trending');
      const tc = $('trendChips');
      if (tc) tc.innerHTML = tags.length
        ? tags.map(t => `<a class="trend-chip" href="/hashtag.html?tag=${encodeURIComponent(t.tag)}">#${esc(t.tag)}<span>${nFmt(t.count)}</span></a>`).join('')
        : '<span style="color:var(--text-3);font-size:13px">No trends yet — be the first to post with a #hashtag.</span>';
    } catch { const tc = $('trendChips'); if (tc) tc.innerHTML = ''; }
    try {
      const users = await Auth.api('/api/users/suggested');
      const su = $('suggestUsers');
      if (su) {
        su.innerHTML = users.length ? users.map(u =>
          `<div class="explore-user"><a href="/profile-social.html?id=${esc(u.id)}">${avatarHTML(u.avatar, u.name, 'post-avatar')}</a>` +
          `<b>${esc(u.name)}</b><span>${esc(u.username)}</span>` +
          `<button class="ur-btn" data-follow="${esc(u.id)}">Follow</button></div>`).join('')
          : '<span style="color:var(--text-3);font-size:13px">No suggestions yet.</span>';
        wireUserFollows(su);
      }
    } catch { const su = $('suggestUsers'); if (su) su.innerHTML = ''; }
    try {
      const foods = await Auth.api('/api/search/foods?q=a'); // simple popular sample
      const pf = $('popularFoods');
      if (pf) pf.innerHTML = foods.slice(0, 6).map(foodRow).join('');
    } catch { /* ignore */ }
  }

  // ── input handling (debounced 300ms) ─────────────────────────────────
  function onInput(immediate) {
    const q = input.value.trim();
    clearBtn.style.display = q ? 'block' : 'none';
    clearTimeout(debounceTimer);
    if (!q) { renderExplore(); return; }
    const go = () => { runSearch(q); };
    if (immediate) go(); else debounceTimer = setTimeout(go, 300);
  }
  input.addEventListener('input', () => onInput(false));
  input.addEventListener('change', () => { if (input.value.trim()) pushRecent(input.value.trim()); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (input.value.trim()) pushRecent(input.value.trim()); onInput(true); } });
  clearBtn.addEventListener('click', () => { input.value = ''; input.focus(); onInput(true); });

  document.querySelectorAll('.filter-tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); type = t.dataset.type;
    onInput(true);
  }));

  // ── boot: honour ?q= and ?type= ──────────────────────────────────────
  (function boot() {
    const params = new URLSearchParams(location.search);
    const pt = params.get('type'); const pq = params.get('q');
    if (pt) { const tab = document.querySelector(`.filter-tab[data-type="${pt}"]`); if (tab) { document.querySelectorAll('.filter-tab').forEach(x => x.classList.remove('active')); tab.classList.add('active'); type = pt; } }
    if (pq) { input.value = pq; clearBtn.style.display = 'block'; pushRecent(pq); runSearch(pq.trim()); }
    else { renderExplore(); input.focus(); }
  })();
})();
