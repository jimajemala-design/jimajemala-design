/* feed.js — NutriFell Social Feed (Phase 1)
   Infinite-scroll feed, video autoplay-on-scroll, photo carousel, reactions,
   comments, save/report/share, follow, and the create-post modal. Integrates
   with the shared Auth/Toast helpers from auth.js. */
'use strict';

const Feed = (() => {
  // Lucide-style stroke icons (SVG, themeable via currentColor).
  const I = {
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    heartFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21 4.2 13.4l-1-1a5.5 5.5 0 0 1 7.8-7.8l1 1.1 1-1.1a5.5 5.5 0 0 1 7.8 7.8l-1 1z"/></svg>',
    comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.6A8.4 8.4 0 1 1 21 11.5z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    bookmarkFill: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>',
    message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.6A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  };

  const REACTIONS = ['❤️', '🔥', '😋', '👏', '🤩', '💪'];
  const TYPE_BADGE = { photo: '📸 Photo', video: '🎬 Reel', recipe: '🍽️ Recipe', text: '💬 Tip' };

  const state = { page: 1, hasMore: true, loading: false, filter: '', ranking: 'foryou', seen: new Set(), viewed: new Set(), pendingNew: new Set() };
  let io = null, videoIO = null, sentinelIO = null;

  // ── helpers ──────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const authed = () => Auth.isAuthed();
  const me = () => Auth.user() || {};
  const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
    const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const nFmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);

  // Linkify #hashtags and @mentions in captions (everything else escaped first).
  function renderCaption(text) {
    return esc(text)
      .replace(/#([\p{L}0-9_]+)/gu, '<a class="hashtag" href="/hashtag.html?tag=$1">#$1</a>')
      .replace(/@([a-z0-9_]{2,30})/gi, '<a class="mention" href="/search.html?type=people&q=$1">@$1</a>');
  }

  function avatarHTML(url, name, cls) {
    if (url) return `<div class="${cls}" style="background-image:url('${esc(url)}')"></div>`;
    return `<div class="${cls}">${esc(initial(name))}</div>`;
  }

  // ── media renderers ──────────────────────────────────────────────────
  // A post is a MEDIA card when it has an image/video/recipe header, otherwise
  // a TEXT card. Recipes always use the media layout (cover or placeholder).
  function hasMedia(p) {
    if (p.type === 'video') return !!p.video;
    if (p.type === 'recipe') return true;
    return (p.photos || []).length > 0;
  }

  // Inner media element placed inside the 210px .nf-media header. Keeps the
  // data-media / data-carousel / .reel / .carousel-dot / .heart-burst hooks the
  // rest of feed.js binds to (double-tap like, carousel, video autoplay).
  function mediaInner(p) {
    if (p.type === 'video' && p.video) {
      return `<div class="reel" data-media>
        <video src="${esc(p.video)}" muted loop playsinline preload="metadata"></video>
        <button class="reel-mute" aria-label="Unmute video">${I.mute}</button>
        <div class="reel-views">${I.eye}<span>${nFmt(p.views || 0)}</span></div>
        <div class="reel-progress"><div class="reel-progress-bar"></div></div>
        <div class="heart-burst">❤️</div>
      </div>`;
    }
    if (p.type === 'recipe') {
      const cover = (p.recipe && p.recipe.cover) || (p.photos || [])[0] || '';
      return cover
        ? `<div class="nf-media-inner" data-media><img class="post-photo" src="${esc(cover)}" alt="${esc((p.recipe && p.recipe.name) || '')}" loading="lazy"><div class="heart-burst">❤️</div></div>`
        : `<div class="nf-media-inner nf-media-ph" data-media><span>🍽️</span><div class="heart-burst">❤️</div></div>`;
    }
    const photos = p.photos || [];
    if (photos.length <= 1) {
      return `<div class="nf-media-inner" data-media><img class="post-photo" src="${esc(photos[0] || '')}" alt="${esc(p.caption).slice(0, 80)}" loading="lazy"><div class="heart-burst">❤️</div></div>`;
    }
    const slides = photos.map(u => `<div class="carousel-slide"><img src="${esc(u)}" alt="" loading="lazy"></div>`).join('');
    const dots = photos.map((_, i) => `<span class="carousel-dot${i === 0 ? ' active' : ''}"></span>`).join('');
    return `<div class="carousel" data-media data-carousel>
      <div class="carousel-track">${slides}</div>
      <div class="carousel-count">1/${photos.length}</div>
      <div class="carousel-dots">${dots}</div>
      <div class="heart-burst">❤️</div></div>`;
  }

  // Overlay pill text, e.g. "RECIPE · 320 KCAL" / "REEL · 1.2k VIEWS" / "PHOTO".
  // (Cook time isn't in the post payload, so we show the strongest detail we have.)
  function overlayPill(p) {
    const type = ({ recipe: 'RECIPE', video: 'REEL', photo: 'PHOTO' })[p.type] || '';
    let detail = '';
    if (p.type === 'recipe' && p.recipe) {
      detail = p.recipe.calories != null ? `${p.recipe.calories} KCAL`
             : (p.recipe.category ? String(p.recipe.category).toUpperCase() : '');
    } else if (p.type === 'video' && p.views) {
      detail = `${nFmt(p.views)} VIEWS`;
    }
    const label = detail ? `${type} · ${detail}` : type;
    return label ? `<span class="nf-pill">${esc(label)}</span>` : '';
  }

  // ── post card ────────────────────────────────────────────────────────
  function postHTML(p) {
    const showFollow = authed() && !p.isOwn && p.userId;
    const reactEmoji = p.myReaction || '🤍';
    const likedCls = p.myReaction ? ' liked' : '';
    const idAttrs = `data-id="${esc(p.id)}" data-type="${esc(p.type)}" data-user="${esc(p.userId)}"`;
    const avatar = avatarHTML(p.authorAvatar, p.authorName, 'nf-av');
    const authorMeta = `<a class="nf-author" href="/profile-social.html?id=${esc(p.userId)}">${avatar}<span class="nf-author-meta"><span class="nf-name">${esc(p.authorName)}</span><span class="nf-time">${timeAgo(p.createdAt)}</span></span></a>`;
    const followPill = showFollow
      ? `<button class="nf-follow${p.isFollowingAuthor ? ' following' : ''}" data-act="follow">${p.isFollowingAuthor ? 'Following' : 'Follow'}</button>` : '';
    const menuBtn = `<button class="post-menu-btn" data-act="menu" aria-label="Post options">${I.more}</button>`;
    // Action row — keeps the .act-react / data-react-count / data-comment-count
    // hooks that updateReactionUI() and the socket handlers read & write.
    const reactBtn = `<button class="act act-react${likedCls}" data-act="react" aria-label="Like"><span class="react-emoji">${reactEmoji}</span><span class="nf-count" data-react-count>${p.totalReactions ? nFmt(p.totalReactions) : ''}</span></button>`;
    const commentBtn = `<button class="act" data-act="comment" aria-label="Comments">${I.comment}<span class="nf-count" data-comment-count>${p.commentCount ? nFmt(p.commentCount) : ''}</span></button>`;
    const shareBtn = `<button class="act" data-act="share" aria-label="Share">${I.share}</button>`;
    const saveInline = `<button class="act act-save${p.saved ? ' saved' : ''}" data-act="save" aria-label="Save">${p.saved ? I.bookmarkFill : I.bookmark}</button>`;

    if (!hasMedia(p)) {
      // ── TEXT CARD — wraps content tightly, height:auto (see feed.css) ──
      return `<article class="post text-only nf-card nf-text-card" ${idAttrs}>
        <div class="nf-author-row">${authorMeta}<span class="nf-spacer"></span>${followPill}${menuBtn}</div>
        <div class="nf-text-body">${renderCaption(p.caption)}</div>
        <div class="post-actions nf-actions">${reactBtn}${commentBtn}<span class="nf-spacer"></span>${shareBtn}${saveInline}</div>
      </article>`;
    }

    // ── MEDIA CARD — 210px header + overlays, then body ──
    const title = p.type === 'recipe' && p.recipe ? esc(p.recipe.name) : (p.caption ? renderCaption(p.caption) : '');
    const sub = p.type === 'recipe' ? (p.caption ? renderCaption(p.caption) : '') : esc(p.location || '');
    return `<article class="post nf-card nf-media-card" ${idAttrs}>
      <div class="nf-media">
        ${mediaInner(p)}
        ${overlayPill(p)}
        <button class="nf-bookmark${p.saved ? ' saved' : ''}" data-act="save" aria-label="Save">${p.saved ? I.bookmarkFill : I.bookmark}</button>
      </div>
      <div class="nf-body">
        <div class="nf-author-row">${authorMeta}<span class="nf-spacer"></span>${followPill}${menuBtn}</div>
        ${title ? `<div class="nf-title">${title}</div>` : ''}
        ${sub ? `<div class="nf-sub">${sub}</div>` : ''}
        <div class="post-actions nf-actions">${reactBtn}${commentBtn}<span class="nf-spacer"></span>${shareBtn}</div>
      </div>
    </article>`;
  }

  function topReactEmojis(p) {
    const entries = Object.entries(p.reactionCounts || {}).filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
    return entries.length ? entries.join('') : '❤️';
  }

  // ── data ─────────────────────────────────────────────────────────────
  async function fetchPage() {
    const qs = new URLSearchParams({ page: String(state.page) });
    if (state.filter) qs.set('type', state.filter);
    if (state.ranking) qs.set('ranking', state.ranking);
    const tag = new URLSearchParams(location.search).get('tag');
    if (tag) qs.set('tag', tag);
    return Auth.api('/api/feed?' + qs.toString());
  }

  async function loadMore() {
    if (state.loading || !state.hasMore) return;
    state.loading = true;
    showSkeletons();
    try {
      const data = await fetchPage();
      removeSkeletons();
      const fresh = (data.posts || []).filter(p => !state.seen.has(p.id));
      fresh.forEach(p => state.seen.add(p.id));
      const list = document.getElementById('feedList');
      fresh.forEach(p => list.insertAdjacentHTML('beforeend', postHTML(p)));
      bindNewPosts();
      state.hasMore = data.hasMore;
      state.page += 1;
      if (!fresh.length && !list.querySelector('.post')) showEmpty();
      else if (!state.hasMore) showEnd();
    } catch (err) {
      removeSkeletons();
      toast(err.message || 'Could not load the feed.', 'error');
    } finally {
      state.loading = false;
    }
  }

  function resetFeed() {
    state.page = 1; state.hasMore = true; state.seen = new Set();
    state.pendingNew.clear();
    document.getElementById('feedNewBanner')?.classList.remove('show');
    const list = document.getElementById('feedList');
    list.innerHTML = '';
    document.getElementById('feedEnd')?.remove();
    document.getElementById('feedEmpty')?.remove();
    loadMore();
  }

  // ── skeletons / states ───────────────────────────────────────────────
  function showSkeletons() {
    if (document.getElementById('feedSkel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'feedSkel';
    wrap.style.display = 'contents';
    let html = '';
    for (let i = 0; i < 3; i++) html += `<div class="skel-card">
      <div class="skel-head"><div class="skel skel-avatar"></div><div style="flex:1">
        <div class="skel skel-line" style="width:40%"></div><div class="skel skel-line" style="width:24%;margin-top:8px"></div></div></div>
      <div class="skel skel-media"></div>
      <div style="padding:14px"><div class="skel skel-line" style="width:80%"></div></div></div>`;
    wrap.innerHTML = html;
    document.getElementById('feedList').appendChild(wrap);
  }
  function removeSkeletons() { document.getElementById('feedSkel')?.remove(); }
  function showEmpty() {
    const list = document.getElementById('feedList');
    list.insertAdjacentHTML('beforeend', `<div class="feed-empty" id="feedEmpty">
      <span class="em">🌱</span><h3>The feed is just getting started</h3>
      <p>Be the first to share a meal, a reel, or a tip with the community.</p>
      <p style="margin-top:14px"><button class="btn-post" style="padding:11px 24px" onclick="Feed.openCreate()">Create the first post</button></p></div>`);
  }
  function showEnd() {
    if (document.getElementById('feedEnd')) return;
    document.getElementById('feedList').insertAdjacentHTML('beforeend',
      `<div class="feed-end" id="feedEnd">
        ✨ You're all caught up
        <p>Check back later for new posts</p>
        <a class="btn-explore" href="/search.html">Explore trending</a>
      </div>`);
  }

  // ── per-post interaction binding ─────────────────────────────────────
  function bindNewPosts() {
    document.querySelectorAll('.post:not([data-bound])').forEach(el => {
      el.setAttribute('data-bound', '1');
      const id = el.dataset.id;

      el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'react') { e.preventDefault(); openReactPicker(el, btn); }
        else if (act === 'comment') { e.preventDefault(); openComments(id); }
        else if (act === 'share') { e.preventDefault(); sharePost(id); }
        else if (act === 'save') { e.preventDefault(); toggleSave(el, btn); }
        else if (act === 'follow') { e.preventDefault(); toggleFollow(el, btn); }
        else if (act === 'menu') { e.preventDefault(); openMenu(el, btn); }
        else if (act === 'readmore') {
          e.preventDefault();
          const cap = el.querySelector('.post-caption');
          if (cap) cap.classList.remove('clamped');
          btn.hidden = true;
        }
      });

      // show/hide "Read more" based on whether the clamp actually truncates
      const cap = el.querySelector('.post-caption.clamped');
      const readMoreBtn = el.querySelector('.post-read-more');
      if (cap && readMoreBtn) {
        if (cap.scrollHeight > cap.clientHeight + 2) {
          readMoreBtn.hidden = false;
        }
      }

      // card press animation (touch-only)
      el.addEventListener('touchstart', () => el.classList.add('pressing'), { passive: true });
      el.addEventListener('touchend', () => el.classList.remove('pressing'), { passive: true });
      el.addEventListener('touchcancel', () => el.classList.remove('pressing'), { passive: true });

      // swipe left = save, swipe right = share (skip on carousels to avoid conflict)
      const hasCarousel = !!el.querySelector('[data-carousel]');
      if (!hasCarousel) {
        let swipeX = 0, swipeY = 0;
        el.addEventListener('touchstart', (ev) => {
          swipeX = ev.touches[0].clientX;
          swipeY = ev.touches[0].clientY;
        }, { passive: true });
        el.addEventListener('touchend', (ev) => {
          const dx = ev.changedTouches[0].clientX - swipeX;
          const dy = ev.changedTouches[0].clientY - swipeY;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) {
            if (dx < 0) {
              const saveBtn = el.querySelector('[data-act="save"]');
              if (saveBtn) toggleSave(el, saveBtn);
            } else {
              sharePost(id);
            }
          }
        }, { passive: true });
      }

      // double-tap / double-click media → quick ❤️ like
      const media = el.querySelector('[data-media]');
      if (media) {
        let lastTap = 0;
        const quick = () => doubleTapLike(el);
        media.addEventListener('dblclick', quick);
        media.addEventListener('touchend', (ev) => {
          const now = Date.now();
          if (now - lastTap < 300) { ev.preventDefault(); quick(); }
          lastTap = now;
        });
      }
      const carousel = el.querySelector('[data-carousel]');
      if (carousel) bindCarousel(carousel);
      const reel = el.querySelector('.reel');
      if (reel) bindReel(el, reel);

      // count a view once when the card first becomes visible
      if (videoIO) videoIO.observe(el);
    });
  }

  // ── reactions ────────────────────────────────────────────────────────
  let openPop = null;
  function closePop() { if (openPop) { openPop.remove(); openPop = null; } }
  function openReactPicker(postEl, btn) {
    if (!requireLogin()) return;
    closePop();
    const pop = document.createElement('div');
    pop.className = 'react-pop';
    pop.innerHTML = REACTIONS.map(em => `<button data-em="${em}">${em}</button>`).join('');
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    // Clamp within the viewport on both edges so it can't cause horizontal scroll.
    const popW = pop.offsetWidth || 240;
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8)) + 'px';
    pop.style.top = (r.top + window.scrollY - 54) + 'px';
    requestAnimationFrame(() => pop.classList.add('show'));
    openPop = pop;
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-em]'); if (!b) return;
      react(postEl, b.dataset.em); closePop();
    });
    setTimeout(() => document.addEventListener('click', onDocClosePop, { once: true }), 0);
  }
  function onDocClosePop(e) { if (openPop && !openPop.contains(e.target)) closePop(); }

  function pulseReactBtn(postEl) {
    const btn = postEl.querySelector('.act-react');
    if (!btn) return;
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 450);
  }

  async function react(postEl, emoji) {
    if (!requireLogin()) return;
    const id = postEl.dataset.id;
    pulseReactBtn(postEl);
    try {
      const out = await Auth.api(`/api/posts/${id}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
      updateReactionUI(postEl, out);
    } catch (err) { toast(err.message, 'error'); }
  }
  async function doubleTapLike(postEl) {
    if (!requireLogin()) return;
    const burst = postEl.querySelector('.heart-burst');
    if (burst) { burst.classList.remove('go'); void burst.offsetWidth; burst.classList.add('go'); }
    pulseReactBtn(postEl);
    const id = postEl.dataset.id;
    try {
      const out = await Auth.api(`/api/posts/${id}/like`, { method: 'POST' });
      updateReactionUI(postEl, out);
    } catch (err) { toast(err.message, 'error'); }
  }
  function updateReactionUI(postEl, out) {
    const btn = postEl.querySelector('.act-react');
    const emojiEl = btn.querySelector('.react-emoji');
    const countEl = btn.querySelector('[data-react-count]');
    emojiEl.textContent = out.mine || '🤍';
    btn.classList.toggle('liked', !!out.mine);
    countEl.textContent = out.total ? nFmt(out.total) : '';
    // summary line
    let summary = postEl.querySelector('.react-summary');
    if (out.total > 0) {
      const top = Object.entries(out.counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e).join('');
      if (!summary) {
        summary = document.createElement('div'); summary.className = 'react-summary';
        postEl.querySelector('.post-actions').before(summary);
      }
      summary.innerHTML = `<span class="em">${top}</span><span>${nFmt(out.total)}</span>`;
    } else if (summary) summary.remove();
  }

  // ── save / share / report / follow ───────────────────────────────────
  async function toggleSave(postEl, btn) {
    if (!requireLogin()) return;
    try {
      const out = await Auth.api(`/api/posts/${postEl.dataset.id}/save`, { method: 'POST' });
      btn.classList.toggle('saved', out.saved);
      btn.innerHTML = (out.saved ? I.bookmarkFill : I.bookmark);
      toast(out.saved ? 'Saved to your collection' : 'Removed from saved', 'success', 1800);
    } catch (err) { toast(err.message, 'error'); }
  }
  async function sharePost(id) {
    const url = location.origin + '/feed.html?post=' + id;
    if (navigator.share) {
      try { await navigator.share({ title: 'NutriFell', url }); return; } catch { /* cancelled */ }
    }
    try { await navigator.clipboard.writeText(url); toast('Link copied to clipboard', 'success', 2000); }
    catch { window.open('https://wa.me/?text=' + encodeURIComponent(url), '_blank'); }
  }
  function openMenu(postEl, btn) {
    const id = postEl.dataset.id;
    const isOwn = postEl.dataset.user === (me().id || '');
    const items = [];
    items.push(`<button data-m="copy">🔗 Copy link</button>`);
    if (isOwn) items.push(`<button data-m="delete">🗑️ Delete post</button>`);
    else items.push(`<button data-m="report">🚩 Report post</button>`);
    const pop = document.createElement('div');
    pop.className = 'react-pop'; pop.style.flexDirection = 'column'; pop.style.padding = '6px';
    pop.innerHTML = items.map(b => b.replace('<button', '<button style="font-size:14px;padding:8px 12px;white-space:nowrap;color:var(--text)"')).join('');
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    // Clamp within the viewport on both edges (measure real width, not a guess).
    const popW = pop.offsetWidth || 180;
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8)) + 'px';
    pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
    requestAnimationFrame(() => pop.classList.add('show'));
    closePop(); openPop = pop;
    pop.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      closePop();
      if (b.dataset.m === 'copy') sharePost(id);
      else if (b.dataset.m === 'report') reportPost(id);
      else if (b.dataset.m === 'delete') deletePost(postEl, id);
    });
    setTimeout(() => document.addEventListener('click', onDocClosePop, { once: true }), 0);
  }
  async function reportPost(id) {
    if (!requireLogin()) return;
    const reason = prompt('Why are you reporting this post? (optional)') ?? '';
    try { const r = await Auth.api(`/api/posts/${id}/report`, { method: 'POST', body: JSON.stringify({ reason }) });
      toast(r.message || 'Reported. Thank you.', 'success'); } catch (err) { toast(err.message, 'error'); }
  }
  async function deletePost(postEl, id) {
    if (!confirm('Delete this post? This cannot be undone.')) return;
    try { await Auth.api(`/api/posts/${id}`, { method: 'DELETE' }); postEl.remove(); toast('Post deleted', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function toggleFollow(postEl, btn) {
    if (!requireLogin()) return;
    const userId = postEl.dataset.user;
    btn.disabled = true;
    try {
      const out = await Auth.api(`/api/users/${userId}/follow`, { method: 'POST' });
      // reflect on every visible card by the same author
      document.querySelectorAll(`.post[data-user="${userId}"] [data-act="follow"]`).forEach(b => {
        b.classList.toggle('following', out.following);
        b.textContent = out.following ? 'Following' : 'Follow';
      });
      toast(out.following ? 'Following' : 'Unfollowed', 'success', 1600);
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  }

  // ── carousel ─────────────────────────────────────────────────────────
  function bindCarousel(el) {
    const track = el.querySelector('.carousel-track');
    const dots = [...el.querySelectorAll('.carousel-dot')];
    const count = el.querySelector('.carousel-count');
    const n = dots.length; let idx = 0, startX = 0, dx = 0, dragging = false;
    const go = (i) => {
      idx = Math.max(0, Math.min(n - 1, i));
      track.style.transform = `translateX(${-idx * 100}%)`;
      dots.forEach((d, k) => d.classList.toggle('active', k === idx));
      if (count) count.textContent = `${idx + 1}/${n}`;
    };
    el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; dragging = true; track.classList.add('dragging'); }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!dragging) return; dx = e.touches[0].clientX - startX;
      track.style.transform = `translateX(calc(${-idx * 100}% + ${dx}px))`;
    }, { passive: true });
    el.addEventListener('touchend', () => {
      dragging = false; track.classList.remove('dragging');
      if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1)); else go(idx);
      dx = 0;
    });
  }

  // ── video reel ───────────────────────────────────────────────────────
  function bindReel(postEl, reel) {
    const video = reel.querySelector('video');
    const muteBtn = reel.querySelector('.reel-mute');
    const bar = reel.querySelector('.reel-progress-bar');
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      muteBtn.innerHTML = video.muted ? I.mute : I.volume;
      if (!video.muted) video.play().catch(() => {});
    });
    video.addEventListener('timeupdate', () => {
      if (video.duration) bar.style.width = (video.currentTime / video.duration * 100) + '%';
    });
  }

  // Autoplay videos in view, pause out of view; also counts a view per post.
  function setupVideoObserver() {
    videoIO = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        const el = en.target;
        const video = el.querySelector('.reel video');
        if (en.isIntersecting) {
          if (video) video.play().catch(() => {});
          countView(el.dataset.id);
        } else if (video) {
          video.pause();
        }
      });
    }, { threshold: 0.6 });
  }
  async function countView(id) {
    if (!id || state.viewed.has(id)) return;
    state.viewed.add(id);
    try { await fetch(`/api/posts/${id}/view`, { method: 'POST' }); } catch { /* non-critical */ }
  }

  // ── comments sheet ───────────────────────────────────────────────────
  let sheetPostId = null;
  function openComments(id) {
    sheetPostId = id;
    if (window.Live && Live.subscribePost) Live.subscribePost(id); // live comment:new
    document.getElementById('sheetOverlay').classList.add('open');
    document.getElementById('commentSheet').classList.add('open');
    document.body.style.overflow = 'hidden';
    const body = document.getElementById('sheetBody');
    body.innerHTML = '<div class="feed-end">Loading comments…</div>';
    Auth.api(`/api/posts/${id}/comments`).then(renderComments).catch(() => {
      body.innerHTML = '<div class="feed-end">Could not load comments.</div>';
    });
    const input = document.getElementById('commentInput');
    input.value = ''; document.getElementById('commentSend').disabled = true;
  }
  function closeSheet() {
    document.getElementById('sheetOverlay').classList.remove('open');
    document.getElementById('commentSheet').classList.remove('open');
    document.body.style.overflow = '';
    if (sheetPostId && window.Live && Live.unsubscribePost) Live.unsubscribePost(sheetPostId);
    sheetPostId = null;
  }
  function commentHTML(c) {
    const replies = (c.replies || []).map(r => `<div class="comment">
      ${avatarHTML(r.authorAvatar, r.authorName, 'post-avatar')}
      <div class="comment-main"><div class="comment-bubble"><b>${esc(r.authorName)}</b><p>${esc(r.text)}</p></div>
      <div class="comment-actions"><span>${timeAgo(r.at)}</span><button data-clike="${esc(r.id)}" class="${(r.likes||[]).includes(me().id)?'liked':''}">♥ ${r.likeCount || ''}</button></div></div></div>`).join('');
    return `<div class="comment" data-cid="${esc(c.id)}">
      ${avatarHTML(c.authorAvatar, c.authorName, 'post-avatar')}
      <div class="comment-main">
        <div class="comment-bubble"><b>${esc(c.authorName)}</b><p>${esc(c.text)}</p></div>
        <div class="comment-actions"><span>${timeAgo(c.at)}</span>
          <button data-clike="${esc(c.id)}" class="${(c.likes||[]).includes(me().id)?'liked':''}">♥ ${c.likeCount || ''}</button>
          <button data-creply="${esc(c.id)}">Reply</button></div>
        ${replies ? `<div class="comment-replies">${replies}</div>` : ''}
      </div></div>`;
  }
  function renderComments(list) {
    const body = document.getElementById('sheetBody');
    document.getElementById('sheetCount').textContent = list.reduce((n, c) => n + 1 + (c.replies || []).length, 0) + ' comments';
    body.innerHTML = list.length ? list.map(commentHTML).join('')
      : '<div class="feed-end">No comments yet. Start the conversation.</div>';
  }
  let replyTo = null;
  async function sendComment() {
    if (!requireLogin()) return;
    const input = document.getElementById('commentInput');
    const text = input.value.trim(); if (!text || !sheetPostId) return;
    const path = replyTo
      ? `/api/posts/${sheetPostId}/comments/${replyTo}/reply`
      : `/api/posts/${sheetPostId}/comments`;
    try {
      await Auth.api(path, { method: 'POST', body: JSON.stringify({ text }) });
      input.value = ''; replyTo = null; input.placeholder = 'Add a comment…';
      const fresh = await Auth.api(`/api/posts/${sheetPostId}/comments`);
      renderComments(fresh);
      bumpCommentCount(sheetPostId, fresh.reduce((n, c) => n + 1 + (c.replies || []).length, 0));
      document.getElementById('sheetBody').scrollTop = 0;
    } catch (err) { toast(err.message, 'error'); }
  }
  function bumpCommentCount(id, n) {
    const el = document.querySelector(`.post[data-id="${id}"] [data-comment-count]`);
    if (el) el.textContent = n ? nFmt(n) : '';
  }

  // ══ Live feed handlers (Phase 5) ═════════════════════════════════════
  // Driven by socket-client.js → window.Live events. All are defensive: they
  // no-op when the target post/sheet isn't on screen.

  // 1) feed:new_post — accumulate a "N new posts" banner; load on tap.
  function ensureNewBanner() {
    let b = document.getElementById('feedNewBanner');
    if (!b) {
      b = document.createElement('button');
      b.id = 'feedNewBanner';
      b.type = 'button';
      b.className = 'feed-new-banner';
      b.addEventListener('click', loadPendingNew);
      const list = document.getElementById('feedList');
      if (list && list.parentNode) list.parentNode.insertBefore(b, list);
    }
    return b;
  }
  function renderNewBanner() {
    const n = state.pendingNew.size;
    if (!n) { document.getElementById('feedNewBanner')?.classList.remove('show'); return; }
    const b = ensureNewBanner();
    b.textContent = `🔥 ${n} new post${n > 1 ? 's' : ''} · tap to load`;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); // replay slide-in
  }
  function onNewPost(data) {
    if (!data || !data.postId) return;
    if (data.author && data.author.id === (me().id || '')) return;       // my own post
    if (state.seen.has(data.postId) || state.pendingNew.has(data.postId)) return;
    state.pendingNew.add(data.postId);
    renderNewBanner();
  }
  async function loadPendingNew() {
    const ids = Array.from(state.pendingNew);
    if (!ids.length) return;
    state.pendingNew.clear();
    document.getElementById('feedNewBanner')?.classList.remove('show');
    const list = document.getElementById('feedList');
    if (!list) return;
    // Fetch each new post (decorated for this viewer), then prepend oldest-first
    // so the very newest lands on top.
    const fetched = [];
    for (const id of ids) {
      try { const p = await Auth.api('/api/posts/' + id); if (p && p.id && !state.seen.has(p.id)) fetched.push(p); }
      catch { /* gone/forbidden — skip */ }
    }
    fetched.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    document.getElementById('feedEmpty')?.remove();
    fetched.forEach(p => {
      state.seen.add(p.id);
      list.insertAdjacentHTML('afterbegin', postHTML(p));
      const el = list.firstElementChild;
      el.classList.add('post-enter');
      requestAnimationFrame(() => el.classList.add('post-enter-active'));
      setTimeout(() => el.classList.remove('post-enter', 'post-enter-active'), 650);
    });
    bindNewPosts();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 2) post:reaction — refresh a card's reaction count/summary live (does NOT
  //    touch my own reaction state, which is per-viewer).
  function onReaction(data) {
    if (!data || !data.postId) return;
    const card = document.querySelector(`.post[data-id="${data.postId}"]`);
    if (!card) return;
    const countEl = card.querySelector('.act-react [data-react-count]');
    if (countEl) {
      const next = data.total ? nFmt(data.total) : '';
      if (countEl.textContent !== next) {
        countEl.textContent = next;
        countEl.classList.remove('count-pop'); void countEl.offsetWidth; countEl.classList.add('count-pop');
      }
    }
    let summary = card.querySelector('.react-summary');
    if (data.total > 0) {
      const top = Object.entries(data.counts || {}).filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e).join('') || '❤️';
      if (!summary) { summary = document.createElement('div'); summary.className = 'react-summary'; card.querySelector('.post-actions').before(summary); }
      summary.innerHTML = `<span class="em">${top}</span><span>${nFmt(data.total)}</span>`;
    } else if (summary) summary.remove();
    const topEmoji = (Object.entries(data.counts || {}).sort((a, b) => b[1] - a[1])[0] || ['❤️'])[0];
    reactionBurst(card, topEmoji);
  }
  function reactionBurst(card, emoji) {
    const btn = card.querySelector('.act-react');
    if (!btn) return;
    const fly = document.createElement('span');
    fly.className = 'react-fly'; fly.textContent = emoji || '❤️';
    btn.appendChild(fly);
    setTimeout(() => fly.remove(), 850);
  }

  // 3a) comment:new — full comment to a post we're subscribed to; live-prepend
  //     into the open sheet (and bump the card count).
  function onComment(data) {
    if (!data || !data.postId || !data.comment) return;
    if (sheetPostId === data.postId) {
      const body = document.getElementById('sheetBody');
      body.querySelector('.feed-end')?.remove(); // clear "loading"/"no comments"
      if (!body.querySelector(`.comment[data-cid="${data.comment.id}"]`)) {
        body.insertAdjacentHTML('afterbegin', commentHTML(data.comment));
        const el = body.firstElementChild;
        el.classList.add('comment-enter');
        requestAnimationFrame(() => el.classList.add('comment-enter-active'));
        setTimeout(() => el.classList.remove('comment-enter', 'comment-enter-active'), 500);
        const cEl = document.getElementById('sheetCount');
        const cur = parseInt(cEl.textContent, 10) || 0;
        cEl.textContent = (cur + 1) + ' comments';
        body.scrollTop = 0;
      }
    }
  }
  // 3b) post:comment — global count bump for any visible card (covers posts
  //     whose room we're not subscribed to).
  function onCommentCount(data) {
    if (!data || !data.postId) return;
    bumpCommentCount(data.postId, data.total);
  }

  function requireLogin() {
    if (authed()) return true;
    toast('Log in to join the conversation.', 'info', 2500);
    setTimeout(() => location.href = '/login.html', 700);
    return false;
  }

  // ── create-post modal ────────────────────────────────────────────────
  // Reels carry extra state: an async transcode job runs while the user fills in
  // the caption. videoUrl/videoThumb hold the transcoded result once ready.
  const create = { type: 'photo', files: [], videoUrl: null, videoThumb: null, jobId: null, uploading: false };
  function resetCreateMedia() {
    create.files = []; create.videoUrl = null; create.videoThumb = null;
    create.jobId = null; create.uploading = false;
  }
  function openCreate() {
    if (!requireLogin()) return;
    document.getElementById('createModal').classList.add('open');
    document.body.style.overflow = 'hidden';
    setType('photo');
    document.getElementById('captionInput').value = '';
    updateCharCount();
  }
  function closeCreate() {
    document.getElementById('createModal').classList.remove('open');
    document.body.style.overflow = '';
    resetCreateMedia();
    syncSubmitState();
  }
  function setType(t) {
    create.type = t;
    // The "Photo / Video" tab is data-type="photo" but also represents the video flow.
    document.querySelectorAll('.type-opt').forEach(o =>
      o.classList.toggle('active', o.dataset.type === t || (t === 'video' && o.dataset.type === 'photo')));
    const isMedia = t === 'photo' || t === 'video';
    document.getElementById('dropWrap').style.display = isMedia ? 'block' : 'none';
    document.getElementById('recipePickWrap').style.display = t === 'recipe' ? 'block' : 'none';
    document.getElementById('dropHint').textContent =
      'Drop photos (up to 10) or a video (MP4/WebM/MOV, up to 3 min, 180MB)';
    resetCreateMedia(); renderPreviews(); syncSubmitState();
  }
  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    // The shared media tab accepts either; detect from the first file.
    if (create.type === 'photo' || create.type === 'video') {
      create.type = /^video\//.test(files[0].type) ? 'video' : 'photo';
    }
    if (create.type === 'video') {
      const f = files[0];
      if (!/^video\//.test(f.type)) { toast('That is not a video file.', 'error'); return; }
      if (f.size > 180 * 1024 * 1024) { toast('Video must be under 180MB.', 'error'); return; }
      const dur = await videoDuration(f).catch(() => 0);
      if (dur > 181) { toast('Video must be 3 minutes or less.', 'error'); return; }
      resetCreateMedia();
      create.type = 'video';
      create.files = [f];
      renderPreviews();
      uploadVideo(f);            // kick off the async transcode + progress
      return;
    }
    for (const f of files) {
      if (!/^image\//.test(f.type)) { toast('Only image files for photo posts.', 'error'); continue; }
      if (create.files.length >= 10) { toast('Up to 10 photos per post.', 'warning'); break; }
      create.files.push(f);
    }
    renderPreviews();
  }
  function videoDuration(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); resolve(v.duration); };
      v.onerror = reject;
      v.src = URL.createObjectURL(file);
    });
  }

  // ── async video transcode (upload → poll → preview) ────────────────────
  async function uploadVideo(file) {
    create.uploading = true; create.videoUrl = null; create.videoThumb = null;
    syncSubmitState(); setVideoProgress(2, 'Uploading');
    try {
      const fd = new FormData();
      fd.append('video', file);
      const res = await fetch('/api/upload/video', { method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token() }, body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'Video upload failed.');
      create.jobId = data.jobId;
      setVideoProgress(5, 'Transcoding');
      pollVideoJob(data.jobId);
    } catch (err) {
      create.uploading = false; syncSubmitState();
      setVideoProgress(0, '', err.message);
      toast(err.message || 'Video upload failed.', 'error');
    }
  }
  function pollVideoJob(jobId) {
    const tick = async () => {
      if (create.jobId !== jobId) return;     // superseded (replaced/removed/closed)
      try {
        const s = await Auth.api(`/api/upload/video/${jobId}/status`);
        if (create.jobId !== jobId) return;
        if (s.status === 'complete') {
          create.uploading = false;
          create.videoUrl = s.videoUrl;
          create.videoThumb = s.thumbnailUrl || null;
          setVideoProgress(100, 'Ready');
          renderPreviews();                   // swap to the transcoded preview
          syncSubmitState();
          return;
        }
        if (s.status === 'failed') {
          create.uploading = false; syncSubmitState();
          setVideoProgress(0, '', s.error || 'Transcoding failed.');
          toast(s.error || 'Transcoding failed.', 'error');
          return;
        }
        setVideoProgress(Math.max(5, s.progress || 0), 'Transcoding');
        setTimeout(tick, 2000);
      } catch (err) {
        if (create.jobId !== jobId) return;
        setTimeout(tick, 2000);               // transient — keep polling
      }
    };
    setTimeout(tick, 2000);
  }
  function setVideoProgress(pct, label, error) {
    const wrap = document.getElementById('vidProgress');
    const fill = document.getElementById('vidProgressFill');
    const lab = document.getElementById('vidProgressLabel');
    if (wrap) { wrap.hidden = false; wrap.classList.toggle('error', !!error); }
    if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
    if (lab) lab.textContent = error || (pct >= 100 ? 'Ready' : `${label || 'Working'}… ${Math.round(pct)}%`);
  }
  function syncSubmitState() {
    const btn = document.getElementById('submitPostBtn');
    if (!btn) return;
    btn.disabled = !!create.uploading;
    btn.textContent = create.uploading ? 'Processing video…' : 'Post';
  }
  function renderPreviews() {
    const grid = document.getElementById('previewGrid');
    if (create.type === 'video') {
      if (!create.files.length && !create.videoUrl) { grid.innerHTML = ''; return; }
      const src = create.videoUrl ? esc(create.videoUrl)
        : (create.files[0] ? URL.createObjectURL(create.files[0]) : '');
      grid.innerHTML = `
        <div class="preview-thumb preview-video">
          <video src="${src}" muted playsinline ${create.videoUrl ? 'controls loop' : ''}></video>
          <button data-rm="0" aria-label="Remove">✕</button>
          <div class="vid-progress" id="vidProgress" ${create.videoUrl ? 'hidden' : ''}>
            <div class="vid-progress-bar"><span id="vidProgressFill"></span></div>
            <small id="vidProgressLabel">Transcoding…</small>
          </div>
        </div>`;
      grid.querySelector('[data-rm]').addEventListener('click', () => {
        resetCreateMedia(); create.type = 'photo'; renderPreviews(); syncSubmitState();
      });
      return;
    }
    grid.innerHTML = create.files.map((f, i) => {
      const url = URL.createObjectURL(f);
      return `<div class="preview-thumb"><img src="${url}" alt=""><button data-rm="${i}" aria-label="Remove">✕</button></div>`;
    }).join('');
    grid.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      create.files.splice(Number(b.dataset.rm), 1); renderPreviews();
    }));
  }
  function updateCharCount() {
    const v = document.getElementById('captionInput').value.length;
    document.getElementById('charCount').textContent = `${v}/500`;
  }
  async function submitPost() {
    if (!requireLogin()) return;
    const caption = document.getElementById('captionInput').value.trim();
    const location_ = document.getElementById('locationInput').value.trim();
    const btn = document.getElementById('submitPostBtn');
    if (create.type === 'photo' && !create.files.length) return toast('Add at least one photo.', 'error');
    if (create.type === 'video') {
      if (create.uploading) return toast('Hang on — your video is still processing.', 'info');
      if (!create.videoUrl) return toast('Add a video to post a reel.', 'error');
    }
    if (create.type === 'text' && !caption) return toast('Write something to share.', 'error');
    let recipeId = '';
    if (create.type === 'recipe') {
      recipeId = document.getElementById('recipeSelect').value;
      if (!recipeId) return toast('Pick one of your recipes to share.', 'error');
    }
    const fd = new FormData();
    fd.append('type', create.type);
    fd.append('caption', caption);
    fd.append('location', location_);
    if (recipeId) fd.append('recipeId', recipeId);
    if (create.type === 'video') {
      // Reels post the pre-transcoded path, not the raw file.
      fd.append('videoUrl', create.videoUrl);
      if (create.videoThumb) fd.append('videoThumb', create.videoThumb);
    } else {
      create.files.forEach(f => fd.append('media', f));
    }

    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Posting…';
    try {
      const res = await fetch('/api/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token() }, body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'Could not publish your post.');
      toast('Posted! 🎉', 'success');
      closeCreate();
      resetFeed();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  }

  // Load the current user's recipes into the recipe-share picker.
  async function loadMyRecipes() {
    try {
      const all = await Auth.api('/api/recipes');
      const mine = all.filter(r => r.userId === (me().id || ''));
      const sel = document.getElementById('recipeSelect');
      sel.innerHTML = mine.length
        ? '<option value="">Choose a recipe…</option>' + mine.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')
        : '<option value="">You have no recipes yet</option>';
    } catch { /* ignore */ }
  }

  // ── suggested users (desktop rail) ───────────────────────────────────
  async function loadSuggested() {
    const host = document.getElementById('suggestList');
    if (!host) return;
    try {
      const users = await Auth.api('/api/users/suggested');
      if (!users.length) { host.closest('.rail-card').style.display = 'none'; return; }
      host.innerHTML = users.map(u => `<div class="suggest-user" data-uid="${esc(u.id)}">
        <a href="/profile-social.html?id=${esc(u.id)}">${avatarHTML(u.avatar, u.name, 'post-avatar')}</a>
        <div class="suggest-info"><b>${esc(u.name)}</b><span>${esc(u.username)} · ${u.followers} followers</span></div>
        <button class="suggest-follow" data-follow="${esc(u.id)}">Follow</button></div>`).join('');
      host.querySelectorAll('[data-follow]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        try { const out = await Auth.api(`/api/users/${b.dataset.follow}/follow`, { method: 'POST' });
          b.textContent = out.following ? 'Following' : 'Follow';
          b.style.background = out.following ? 'var(--glass-2)' : ''; b.style.color = out.following ? 'var(--text-2)' : '';
          // After following someone, surface fresh suggestions (the just-followed
          // user drops out, new people rotate in).
          if (out.following) setTimeout(loadSuggested, 900);
        } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
      }));
    } catch { host.closest('.rail-card').style.display = 'none'; }
  }

  // ── caption autocomplete (# hashtags + @ mentions) ───────────────────
  function initCaptionAutocomplete(ta) {
    const field = ta.parentElement;
    field.style.position = 'relative';
    const pop = document.createElement('div');
    pop.className = 'ac-pop';
    field.appendChild(pop);
    let acTimer = null, items = [], active = -1, tokenStart = -1, trigger = '';

    const hide = () => { pop.classList.remove('open'); active = -1; };
    function place() { pop.style.top = (ta.offsetTop + ta.offsetHeight + 4) + 'px'; pop.style.left = ta.offsetLeft + 'px'; }

    function pick(i) {
      const it = items[i]; if (!it) return;
      const insert = (trigger === '#' ? '#' + it.tag : '@' + it.username) + ' ';
      const before = ta.value.slice(0, tokenStart);
      const after = ta.value.slice(ta.selectionStart);
      ta.value = before + insert + after;
      const caret = (before + insert).length;
      ta.setSelectionRange(caret, caret);
      hide(); ta.focus(); updateCharCount();
    }
    function render() {
      if (!items.length) { hide(); return; }
      pop.innerHTML = items.map((it, i) => trigger === '#'
        ? `<div class="ac-item ${i === active ? 'active' : ''}" data-i="${i}"><span class="ac-tag">#${esc(it.tag)}</span><span class="ac-sub">${it.count}</span></div>`
        : `<div class="ac-item ${i === active ? 'active' : ''}" data-i="${i}">${avatarHTML(it.avatar, it.name, 'post-avatar')}<span>${esc(it.name)}</span><span class="ac-sub">${esc(it.username)}</span></div>`).join('');
      pop.querySelectorAll('.ac-item').forEach(el => el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(parseInt(el.dataset.i, 10)); }));
      place(); pop.classList.add('open');
    }
    async function query(term) {
      try {
        if (trigger === '#') { items = (await Auth.api('/api/search/hashtags?q=' + encodeURIComponent(term))).slice(0, 6); }
        else { items = (await Auth.api('/api/search/users?q=' + encodeURIComponent(term))).slice(0, 6); }
        active = -1; render();
      } catch { hide(); }
    }
    ta.addEventListener('input', () => {
      const left = ta.value.slice(0, ta.selectionStart);
      const m = left.match(/([#@])([\p{L}0-9_]*)$/u);
      clearTimeout(acTimer);
      if (!m) { hide(); return; }
      trigger = m[1]; tokenStart = ta.selectionStart - m[0].length;
      const term = m[2];
      if (trigger === '#' && term.length < 1) { hide(); return; } // wait for a char on #
      acTimer = setTimeout(() => query(term), 180);
    });
    ta.addEventListener('keydown', (e) => {
      if (!pop.classList.contains('open')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') hide();
    });
    ta.addEventListener('blur', () => setTimeout(hide, 120));
  }

  // ── pull-to-refresh ──────────────────────────────────────────────────
  function initPullToRefresh() {
    const main = document.querySelector('.feed-main');
    if (!main) return;
    // inject PTR indicator above the story tray
    const ptr = document.createElement('div');
    ptr.className = 'ptr-spinner';
    ptr.innerHTML = '<div class="ptr-icon"></div><span>Refreshing…</span>';
    main.insertAdjacentElement('afterbegin', ptr);

    let startY = 0, pulling = false, triggered = false;
    document.addEventListener('touchstart', (e) => {
      if (window.scrollY < 5) { startY = e.touches[0].clientY; pulling = true; triggered = false; }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 60 && !triggered) { ptr.classList.add('visible'); }
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!pulling) return;
      pulling = false;
      const dy = e.changedTouches[0].clientY - startY;
      if (dy > 70 && !triggered && window.scrollY < 5) {
        triggered = true;
        resetFeed();
        setTimeout(() => ptr.classList.remove('visible'), 600);
      } else {
        ptr.classList.remove('visible');
      }
    }, { passive: true });
  }

  // ── init ─────────────────────────────────────────────────────────────
  function init() {
    setupVideoObserver();
    initPullToRefresh();
    // sentinel for infinite scroll
    const sentinel = document.getElementById('feedSentinel');
    sentinelIO = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '600px' });
    sentinelIO.observe(sentinel);

    // ranking tabs (For You / Following / Latest)
    document.querySelectorAll('.feed-ranking .rank-tab').forEach(t => t.addEventListener('click', () => {
      if (t.classList.contains('active')) return;
      document.querySelectorAll('.feed-ranking .rank-tab').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
      t.classList.add('active'); t.setAttribute('aria-selected', 'true');
      state.ranking = t.dataset.rank || 'foryou';
      resetFeed();
    }));

    // pill tabs — All / Recipes / Reels / Tips all filter the feed in place.
    document.querySelectorAll('.feed-filters .chip').forEach(c => c.addEventListener('click', () => {
      document.querySelectorAll('.feed-filters .chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      state.filter = c.dataset.filter || '';
      resetFeed();
    }));

    // create modal wiring
    document.querySelectorAll('[data-open-create]').forEach(b => b.addEventListener('click', openCreate));
    document.getElementById('createClose').addEventListener('click', closeCreate);
    document.querySelectorAll('.type-opt').forEach(o => o.addEventListener('click', () => {
      setType(o.dataset.type); if (o.dataset.type === 'recipe') loadMyRecipes();
    }));
    document.getElementById('submitPostBtn').addEventListener('click', submitPost);
    const fileInput = document.getElementById('fileInput');
    document.getElementById('dropzone').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => addFiles(fileInput.files));
    const dz = document.getElementById('dropzone');
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
    const cap = document.getElementById('captionInput');
    cap.addEventListener('input', updateCharCount);
    initCaptionAutocomplete(cap);

    // comment sheet wiring
    document.getElementById('sheetOverlay').addEventListener('click', closeSheet);
    document.getElementById('sheetClose').addEventListener('click', closeSheet);
    const ci = document.getElementById('commentInput');
    ci.addEventListener('input', () => { document.getElementById('commentSend').disabled = !ci.value.trim(); });
    ci.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendComment(); } });
    document.getElementById('commentSend').addEventListener('click', sendComment);
    document.getElementById('sheetBody').addEventListener('click', (e) => {
      const like = e.target.closest('[data-clike]');
      const reply = e.target.closest('[data-creply]');
      if (like) likeComment(like);
      if (reply) { replyTo = reply.dataset.creply; ci.placeholder = 'Replying…'; ci.focus(); }
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeCreate(); closePop(); } });
    window.addEventListener('scroll', closePop, { passive: true });

    // ── Collapsible header on scroll ────────────────────────────────────
    const feedHeaderEl = document.getElementById('feedHeader');
    const feedTabsEl = document.querySelector('.feed-main-head');

    // Keep --feed-header-h in sync so tabs always stick just below the header
    if (feedHeaderEl) {
      const updateHeaderH = () => {
        document.documentElement.style.setProperty('--feed-header-h', feedHeaderEl.offsetHeight + 'px');
      };
      updateHeaderH();
      if ('ResizeObserver' in window) new ResizeObserver(updateHeaderH).observe(feedHeaderEl);
    }

    let lastScrollY = 0;
    window.addEventListener('scroll', () => {
      const current = window.scrollY;
      const goingDown = current > lastScrollY && current > 100;
      feedHeaderEl?.classList.toggle('header-hidden', goingDown);
      feedTabsEl?.classList.toggle('tabs-raised', goingDown);
      lastScrollY = current;
    }, { passive: true });

    loadSuggested();
    loadMore();
  }
  async function likeComment(btn) {
    if (!requireLogin()) return;
    try { const out = await Auth.api(`/api/posts/${sheetPostId}/comments/${btn.dataset.clike}/like`, { method: 'POST' });
      btn.classList.toggle('liked', out.liked); btn.textContent = '♥ ' + (out.likeCount || ''); }
    catch (err) { toast(err.message, 'error'); }
  }

  return { init, openCreate, ICONS: I, onNewPost, onReaction, onComment, onCommentCount };
})();

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('feedList')) Feed.init();
});
