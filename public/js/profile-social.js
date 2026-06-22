/* profile-social.js — NutriFell Phase 2: full user profiles.
   Renders the profile header, tabbed grids (Posts / Reels / Recipes / Liked /
   About), the edit-profile modal (avatar + cover upload, name/username/bio/
   location/website), the followers/following list modal with search, and the
   fullscreen post modal (media + comments + like/react/comment + prev/next).
   Talks to the Phase-2 endpoints; reuses the shared Auth/Toast from auth.js. */
'use strict';

(() => {
  // ── helpers ──────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const me = () => (authed() && Auth.user()) || {};
  const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();
  const notify = (m, t, ms) => { if (window.toast) toast(m, t, ms); };

  const TYPE_EMOJI = { photo: '📸', video: '🎬', recipe: '🍽️', text: '💬' };
  const REACTIONS = ['❤️', '🔥', '😋', '👏', '🤩', '💪'];

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
    const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const nFmt = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0);
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  function renderCaption(text) {
    return esc(text)
      .replace(/#([\p{L}0-9_]+)/gu, '<a class="hashtag" href="/hashtag.html?tag=$1">#$1</a>')
      .replace(/@([a-z0-9_]{2,30})/gi, '<a class="mention" href="/search.html?type=people&q=$1">@$1</a>');
  }
  function avatarHTML(url, name, cls) {
    return url
      ? `<div class="${cls}" style="background-image:url('${esc(url)}')"></div>`
      : `<div class="${cls}">${esc(initial(name))}</div>`;
  }
  // FormData upload with auth + graceful error surfacing (Auth.api is JSON-only).
  async function uploadImage(kind, file) {
    const fd = new FormData();
    fd.append('image', file);
    const res = await fetch('/api/upload/' + kind, {
      method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token() }, body: fd,
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) { Auth.clearSession(); location.href = '/login.html?expired=1'; throw new Error('Session expired'); }
    if (!res.ok) throw new Error((data && data.error) || 'Upload failed');
    return data;
  }

  // ── state ────────────────────────────────────────────────────────────
  const PROFILE_ID = new URLSearchParams(location.search).get('id');
  const state = {
    profile: null,
    tab: 'posts',
    posts: null,   // all posts by this user (decorated)
    liked: null,   // liked posts (lazy)
    modalList: [], // current post-modal navigation array
    modalIndex: 0,
  };

  const wrap = $('profWrap');

  // ── top-bar personalisation ──────────────────────────────────────────
  (function topbar() {
    const u = authed() ? Auth.user() : null;
    const av = $('topAvatar');
    if (u) {
      if (u.avatar) { av.textContent = ''; av.style.backgroundImage = `url('${u.avatar}')`; av.style.backgroundSize = 'cover'; }
      else av.textContent = initial(u.name || u.email);
      $('bnProfile').href = '/profile-social.html?id=' + u.id;
    }
  })();

  // ── load profile ─────────────────────────────────────────────────────
  if (!PROFILE_ID) {
    wrap.innerHTML = '<div class="feed-empty"><span class="em">🤔</span><h3>No profile selected</h3><p><a href="/feed.html" style="color:var(--green)">Back to the feed</a></p></div>';
    return;
  }

  async function load() {
    try {
      const [profile, posts] = await Promise.all([
        Auth.api('/api/users/' + PROFILE_ID),
        Auth.api('/api/users/' + PROFILE_ID + '/posts'),
      ]);
      state.profile = profile;
      state.posts = posts || [];
      renderHeader();
      selectTab(state.tab);
    } catch (e) {
      wrap.innerHTML = '<div class="feed-empty"><span class="em">😕</span><h3>Profile not found</h3><p><a href="/feed.html" style="color:var(--green)">Back to the feed</a></p></div>';
    }
  }

  function renderHeader() {
    const u = state.profile;
    const s = u.stats || { posts: 0, followers: 0, following: 0 };
    const meta = [];
    if (u.location) meta.push('📍 ' + esc(u.location));
    if (u.website) meta.push(`🔗 <a href="${esc(u.website)}" target="_blank" rel="noopener">${esc(hostOf(u.website))}</a>`);

    const actionBtn = u.isOwn
      ? '<button class="prof-btn edit" id="openEdit">Edit Profile</button>'
      : `<button class="prof-btn ${u.isFollowing ? 'following' : 'follow'}" id="followBtn">${u.isFollowing ? 'Following' : 'Follow'}</button>` +
        `<a class="prof-btn message" id="messageBtn" href="/messages.html?to=${esc(u.id)}">Message</a>`;

    const tabs = [
      ['posts', '📸 Posts'],
      ['reels', '🎬 Reels'],
      ['recipes', '🍽️ Recipes'],
    ];
    if (u.isOwn) tabs.push(['liked', '❤️ Liked']);
    tabs.push(['about', 'ℹ️ About']);

    wrap.innerHTML =
      `<div class="prof-cover" id="profCover"${u.cover ? ` style="background-image:url('${esc(u.cover)}')"` : ''}>` +
        (u.isOwn ? '<button class="cover-edit" id="coverEditBtn" type="button">📷 Edit cover</button>' : '') +
      '</div>' +
      '<div class="prof-head">' +
        '<div class="prof-top">' +
          `<div class="prof-avatar${u.isOwn ? ' editable' : ''}" id="profAvatar"${u.avatar ? ` style="background-image:url('${esc(u.avatar)}')"` : ''}>` +
            (u.avatar ? '' : esc(initial(u.name))) +
            (u.isOwn ? '<span class="avatar-edit" id="avatarEditBtn">📷</span>' : '') +
          '</div>' +
          `<div class="prof-actions">${actionBtn}</div>` +
        '</div>' +
        `<div class="prof-name">${esc(u.name)}</div>` +
        `<div class="prof-handle">${esc(u.username)}</div>` +
        (u.bio ? `<div class="prof-bio">${esc(u.bio)}</div>` : '') +
        (meta.length ? `<div class="prof-meta">${meta.join('')}</div>` : '') +
        '<div class="prof-stats">' +
          `<button class="prof-stat" data-list="posts"><b>${nFmt(s.posts)}</b><span>Posts</span></button>` +
          `<button class="prof-stat" data-list="followers"><b id="followerCount">${nFmt(s.followers)}</b><span>Followers</span></button>` +
          `<button class="prof-stat" data-list="following"><b>${nFmt(s.following)}</b><span>Following</span></button>` +
        '</div>' +
      '</div>' +
      `<div class="prof-tabs" role="tablist">${tabs.map(([k, label]) =>
        `<button class="prof-tab${k === state.tab ? ' active' : ''}" data-tab="${k}" role="tab">${label}</button>`).join('')}</div>` +
      '<div class="prof-tabpanel" id="tabPanel"></div>';

    // wire header actions
    const fb = $('followBtn');
    if (fb) fb.addEventListener('click', toggleFollow);
    const oe = $('openEdit');
    if (oe) oe.addEventListener('click', openEdit);
    if (u.isOwn) {
      $('coverEditBtn').addEventListener('click', () => $('coverFile').click());
      $('avatarEditBtn').addEventListener('click', (e) => { e.stopPropagation(); $('avatarFile').click(); });
      $('profAvatar').addEventListener('click', () => $('avatarFile').click());
    }
    wrap.querySelectorAll('.prof-tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));
    wrap.querySelectorAll('.prof-stat[data-list]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.list;
      if (k === 'posts') { selectTab('posts'); document.querySelector('.prof-tabs').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else openListModal(k);
    }));
  }

  async function toggleFollow() {
    if (!authed()) { location.href = '/login.html'; return; }
    const fb = $('followBtn');
    fb.disabled = true;
    try {
      const out = await Auth.api(`/api/users/${PROFILE_ID}/follow`, { method: 'POST' });
      state.profile.isFollowing = out.following;
      state.profile.stats.followers = out.followers;
      fb.className = 'prof-btn ' + (out.following ? 'following' : 'follow');
      fb.textContent = out.following ? 'Following' : 'Follow';
      $('followerCount').textContent = nFmt(out.followers);
      if (out.following) notify('Following ' + state.profile.name, 'success', 2200);
    } catch (e) { notify(e.message, 'error'); }
    finally { fb.disabled = false; }
  }

  // ── tabs ─────────────────────────────────────────────────────────────
  async function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.prof-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const panel = $('tabPanel');
    if (tab === 'about') { panel.innerHTML = renderAbout(); return; }
    if (tab === 'recipes') { panel.innerHTML = renderRecipeCards(); wireTiles(panel, recipePosts()); return; }
    if (tab === 'liked') {
      if (state.liked === null) {
        panel.innerHTML = skeletonGrid();
        try { state.liked = await Auth.api('/api/users/' + PROFILE_ID + '/liked'); }
        catch { state.liked = []; }
      }
      panel.innerHTML = grid(state.liked, '❤️', 'No liked posts yet');
      wireTiles(panel, state.liked);
      return;
    }
    // posts / reels
    const arr = tab === 'reels' ? reelPosts() : feedPosts();
    panel.innerHTML = grid(arr, tab === 'reels' ? '🎬' : '🌱',
      tab === 'reels' ? 'No reels yet' : 'No posts yet');
    wireTiles(panel, arr);
  }

  const feedPosts = () => (state.posts || []).filter(p => p.type === 'photo' || p.type === 'text');
  const reelPosts = () => (state.posts || []).filter(p => p.type === 'video');
  const recipePosts = () => (state.posts || []).filter(p => p.type === 'recipe');

  function tileMedia(p) {
    if ((p.photos || []).length) return `<img src="${esc(p.photos[0])}" alt="" loading="lazy">`;
    if (p.video) return `<video src="${esc(p.video)}" muted preload="metadata"></video>`;
    if (p.recipe && p.recipe.cover) return `<img src="${esc(p.recipe.cover)}" alt="" loading="lazy">`;
    if (p.type === 'text') return `<div class="tile-text">${esc((p.caption || '').slice(0, 140))}</div>`;
    return TYPE_EMOJI[p.type] || '📝';
  }
  function grid(arr, emptyEmoji, emptyMsg) {
    if (!arr || !arr.length) return `<div class="feed-empty"><span class="em">${emptyEmoji}</span><h3>${emptyMsg}</h3></div>`;
    return '<div class="prof-grid">' + arr.map((p, i) =>
      `<button class="grid-tile" data-i="${i}">${tileMedia(p)}` +
      `<span class="grid-badge">${TYPE_EMOJI[p.type] || ''}</span>` +
      `<span class="grid-stats">❤️ ${nFmt(p.totalReactions)} &nbsp; 💬 ${nFmt(p.commentCount)}</span></button>`
    ).join('') + '</div>';
  }
  function renderRecipeCards() {
    const arr = recipePosts();
    if (!arr.length) return '<div class="feed-empty"><span class="em">🍽️</span><h3>No recipes shared yet</h3></div>';
    return '<div class="recipe-cards">' + arr.map((p, i) => {
      const r = p.recipe || {};
      return `<div class="recipe-card" data-i="${i}">` +
        (r.cover ? `<img class="recipe-card-cover" src="${esc(r.cover)}" alt="" loading="lazy">` : '<div class="recipe-card-cover">🍽️</div>') +
        '<div class="recipe-card-body">' +
          `<h4>${esc(r.name || 'Recipe')}</h4>` +
          '<div class="recipe-card-meta">' +
            (r.calories ? `<span class="kcal">${Math.round(r.calories)} kcal</span>` : '') +
            `<span>❤️ ${nFmt(p.totalReactions)}</span><span>💬 ${nFmt(p.commentCount)}</span>` +
          '</div>' +
        '</div></div>';
    }).join('') + '</div>';
  }
  function renderAbout() {
    const u = state.profile;
    const rows = [];
    rows.push(`<div class="about-row"><span class="k">Username</span><span>${esc(u.username)}</span></div>`);
    if (u.bio) rows.push(`<div class="about-row"><span class="k">Bio</span><span>${esc(u.bio)}</span></div>`);
    if (u.location) rows.push(`<div class="about-row"><span class="k">Location</span><span>${esc(u.location)}</span></div>`);
    if (u.website) rows.push(`<div class="about-row"><span class="k">Website</span><a href="${esc(u.website)}" target="_blank" rel="noopener">${esc(hostOf(u.website))}</a></div>`);
    rows.push(`<div class="about-row"><span class="k">Activity</span><span>${u.stats.posts} posts · ${u.stats.followers} followers · ${u.stats.following} following</span></div>`);
    const link = u.isOwn
      ? '<a class="about-link" href="/profile-view.html">📊 View my nutrition dashboard</a>'
      : '';
    return `<div class="about-card"><h3>About</h3>${rows.join('')}${link}</div>`;
  }
  function skeletonGrid() {
    return '<div class="prof-grid">' + Array.from({ length: 6 }).map(() =>
      '<div class="grid-tile skel" style="aspect-ratio:1"></div>').join('') + '</div>';
  }
  function wireTiles(panel, arr) {
    panel.querySelectorAll('[data-i]').forEach(el => el.addEventListener('click', () => {
      openPostModal(arr, parseInt(el.dataset.i, 10));
    }));
  }

  // ── Edit-profile modal ───────────────────────────────────────────────
  const editModal = $('editModal');
  function openEdit() {
    const u = state.profile;
    $('editName').value = u.name || '';
    $('editUsername').value = (u.username || '').replace(/^@/, '');
    $('editBio').value = u.bio || '';
    $('editLocation').value = u.location || '';
    $('editWebsite').value = u.website || '';
    $('errName').textContent = ''; $('errUsername').textContent = '';
    $('bioCount').textContent = (u.bio || '').length + '/150';
    const cov = $('editCover');
    cov.style.backgroundImage = u.cover ? `url('${u.cover}')` : '';
    const av = $('editAvatar');
    if (u.avatar) { av.style.backgroundImage = `url('${u.avatar}')`; av.firstChild.textContent = ''; }
    else { av.style.backgroundImage = ''; av.childNodes[0].nodeValue = initial(u.name); }
    editModal.classList.add('open');
  }
  function closeEdit() { editModal.classList.remove('open'); }

  $('editClose').addEventListener('click', closeEdit);
  $('editCancel').addEventListener('click', closeEdit);
  editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEdit(); });
  $('editBio').addEventListener('input', (e) => { $('bioCount').textContent = e.target.value.length + '/150'; });
  $('editCoverBtn').addEventListener('click', () => $('coverFile').click());
  $('editAvatar').addEventListener('click', () => $('avatarFile').click());

  // file inputs (shared by header buttons + edit modal)
  $('avatarFile').addEventListener('change', (e) => handleUpload('avatar', e.target));
  $('coverFile').addEventListener('change', (e) => handleUpload('cover', e.target));

  async function handleUpload(kind, input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { notify('Image must be under 12 MB.', 'error'); return; }
    const editTarget = kind === 'avatar' ? $('editAvatar') : $('editCover');
    if (editModal.classList.contains('open') && editTarget) editTarget.classList.add('uploading');
    try {
      const out = await uploadImage(kind, file);
      const url = out[kind];
      state.profile[kind] = url;
      // live-update header
      if (kind === 'avatar') {
        const pa = $('profAvatar');
        if (pa) { pa.style.backgroundImage = `url('${url}')`; pa.childNodes[0].nodeValue = ''; }
      } else {
        const pc = $('profCover');
        if (pc) pc.style.backgroundImage = `url('${url}')`;
      }
      // live-update edit modal preview
      if (kind === 'avatar' && editTarget) { editTarget.style.backgroundImage = `url('${url}')`; editTarget.childNodes[0].nodeValue = ''; }
      if (kind === 'cover' && editTarget) editTarget.style.backgroundImage = `url('${url}')`;
      // keep session avatar fresh (used by top bars across the app)
      if (kind === 'avatar') { const su = Auth.user() || {}; su.avatar = url; Auth.updateUser(su); }
      notify((kind === 'avatar' ? 'Avatar' : 'Cover') + ' updated', 'success', 2000);
    } catch (e) { notify(e.message, 'error'); }
    finally { if (editTarget) editTarget.classList.remove('uploading'); }
  }

  $('editSave').addEventListener('click', async () => {
    const btn = $('editSave');
    $('errName').textContent = ''; $('errUsername').textContent = '';
    const body = {
      name: $('editName').value.trim(),
      username: $('editUsername').value.trim().replace(/^@/, ''),
      bio: $('editBio').value,
      location: $('editLocation').value.trim(),
      website: $('editWebsite').value.trim(),
    };
    if (!body.name) { $('errName').textContent = 'Display name is required.'; return; }
    if (body.username && !/^[a-z0-9_]{3,20}$/.test(body.username.toLowerCase())) {
      $('errUsername').textContent = '3–20 characters: letters, numbers or underscore.'; return;
    }
    const label = btn.textContent;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      const updated = await Auth.api('/api/users/profile', { method: 'PUT', body: JSON.stringify(body) });
      // preserve isOwn/isFollowing & merge fresh fields
      state.profile = { ...state.profile, ...updated, isOwn: true };
      const su = Auth.user() || {}; su.name = updated.name; Auth.updateUser(su);
      renderHeader(); selectTab(state.tab);
      notify('Profile saved', 'success', 2000);
      closeEdit();
    } catch (e) {
      if (/username/i.test(e.message)) $('errUsername').textContent = e.message;
      else notify(e.message, 'error');
    } finally { btn.disabled = false; btn.textContent = label; }
  });

  // ── Followers / following modal ──────────────────────────────────────
  const listModal = $('listModal');
  let listAll = [];
  async function openListModal(kind) {
    $('listTitle').textContent = kind === 'following' ? 'Following' : 'Followers';
    $('listSearch').value = '';
    $('listBody').innerHTML = '<div class="feed-empty" style="padding:30px"><span class="spinner"></span></div>';
    listModal.classList.add('open');
    try {
      listAll = await Auth.api(`/api/users/${PROFILE_ID}/${kind}`) || [];
      renderList(listAll);
    } catch (e) {
      $('listBody').innerHTML = `<div class="feed-empty"><span class="em">😕</span><h3>${esc(e.message)}</h3></div>`;
    }
  }
  function closeList() { listModal.classList.remove('open'); }
  function renderList(arr) {
    const body = $('listBody');
    if (!arr.length) { body.innerHTML = '<div class="feed-empty"><span class="em">🌱</span><h3>No one here yet</h3></div>'; return; }
    body.innerHTML = arr.map(u =>
      `<div class="user-row" data-uid="${esc(u.id)}">` +
        `<a href="/profile-social.html?id=${esc(u.id)}">${avatarHTML(u.avatar, u.name, 'post-avatar')}</a>` +
        `<a class="user-row-info" href="/profile-social.html?id=${esc(u.id)}"><b>${esc(u.name)}</b><span>${esc(u.username)}</span></a>` +
        (u.isOwn ? '' : `<button class="user-row-btn ${u.isFollowing ? 'following' : ''}" data-follow="${esc(u.id)}">${u.isFollowing ? 'Following' : 'Follow'}</button>`) +
      '</div>'
    ).join('');
    body.querySelectorAll('[data-follow]').forEach(b => b.addEventListener('click', async () => {
      if (!authed()) { location.href = '/login.html'; return; }
      b.disabled = true;
      try {
        const out = await Auth.api(`/api/users/${b.dataset.follow}/follow`, { method: 'POST' });
        b.classList.toggle('following', out.following);
        b.textContent = out.following ? 'Following' : 'Follow';
        const item = listAll.find(x => x.id === b.dataset.follow); if (item) item.isFollowing = out.following;
      } catch (e) { notify(e.message, 'error'); }
      finally { b.disabled = false; }
    }));
  }
  $('listClose').addEventListener('click', closeList);
  listModal.addEventListener('click', (e) => { if (e.target === listModal) closeList(); });
  $('listSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    renderList(!q ? listAll : listAll.filter(u =>
      (u.name || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q)));
  });

  // ── Fullscreen post modal ────────────────────────────────────────────
  const postModal = $('postModal');
  function openPostModal(arr, index) {
    state.modalList = arr; state.modalIndex = index;
    postModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    renderPostModal();
  }
  function closePostModal() { postModal.classList.remove('open'); document.body.style.overflow = ''; $('pmShell').innerHTML = ''; }
  function navPost(delta) {
    const n = state.modalIndex + delta;
    if (n < 0 || n >= state.modalList.length) return;
    state.modalIndex = n; renderPostModal();
  }

  function mediaHTML(p) {
    if ((p.photos || []).length) {
      return `<img src="${esc(p.photos[0])}" alt="">`;
    }
    if (p.video) return `<video src="${esc(p.video)}" controls autoplay playsinline></video>`;
    if (p.recipe && p.recipe.cover) return `<img src="${esc(p.recipe.cover)}" alt="">`;
    return `<div class="pm-text">${renderCaption(p.caption || '')}</div>`;
  }

  function renderPostModal() {
    const p = state.modalList[state.modalIndex];
    const u = state.profile;
    const reacted = p.myReaction || null;
    $('pmShell').innerHTML =
      `<div class="pm-media">${mediaHTML(p)}</div>` +
      '<div class="pm-side">' +
        '<div class="pm-head">' +
          `<a href="/profile-social.html?id=${esc(p.userId)}">${avatarHTML(u.avatar, u.name, 'post-avatar')}</a>` +
          `<div class="pm-head-id"><b>${esc(u.name)}</b><span>${esc(u.username)} · ${timeAgo(p.createdAt)}</span></div>` +
        '</div>' +
        ((p.caption || (p.recipe && p.recipe.name)) ?
          `<div class="pm-caption">${p.recipe ? `<div style="font-weight:600;margin-bottom:6px">🍽️ ${esc(p.recipe.name)}</div>` : ''}<div class="cap-text">${renderCaption(p.caption || '')}</div></div>` : '') +
        '<div class="pm-comments" id="pmComments"><div class="feed-empty" style="padding:24px"><span class="spinner"></span></div></div>' +
        '<div class="pm-actions" id="pmActions">' +
          `<button class="act ${reacted ? 'liked' : ''}" id="pmLike">${reacted ? `<span style="font-size:20px">${reacted}</span>` : heartSvg()} <span id="pmReactCount">${nFmt(p.totalReactions)}</span></button>` +
          REACTIONS.map(em => `<button class="act pm-react-opt" data-em="${em}" title="React ${em}" style="font-size:18px;padding:0 8px">${em}</button>`).join('') +
          `<button class="act ${p.saved ? 'saved' : ''}" id="pmSave" style="margin-left:auto">${bookmarkSvg()}</button>` +
          `<button class="act" id="pmShare">${shareSvg()}</button>` +
        '</div>' +
        '<div class="pm-compose">' +
          '<input id="pmInput" placeholder="Add a comment…" aria-label="Add a comment" />' +
          '<button id="pmSend" disabled>Post</button>' +
        '</div>' +
      '</div>';

    $('pmPrev').disabled = state.modalIndex === 0;
    $('pmNext').disabled = state.modalIndex === state.modalList.length - 1;

    // actions
    $('pmLike').addEventListener('click', () => reactTo('❤️'));
    document.querySelectorAll('.pm-react-opt').forEach(b => b.addEventListener('click', () => reactTo(b.dataset.em)));
    $('pmSave').addEventListener('click', toggleSave);
    $('pmShare').addEventListener('click', sharePost);
    const inp = $('pmInput'), send = $('pmSend');
    inp.addEventListener('input', () => { send.disabled = !inp.value.trim(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendComment(); } });
    send.addEventListener('click', sendComment);

    loadComments(p.id);
  }

  async function reactTo(emoji) {
    if (!authed()) { location.href = '/login.html'; return; }
    const p = state.modalList[state.modalIndex];
    try {
      const out = await Auth.api(`/api/posts/${p.id}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
      p.myReaction = out.mine; p.totalReactions = out.total;
      const like = $('pmLike');
      like.classList.toggle('liked', !!out.mine);
      like.innerHTML = (out.mine ? `<span style="font-size:20px">${out.mine}</span>` : heartSvg()) + ` <span id="pmReactCount">${nFmt(out.total)}</span>`;
    } catch (e) { notify(e.message, 'error'); }
  }
  async function toggleSave() {
    if (!authed()) { location.href = '/login.html'; return; }
    const p = state.modalList[state.modalIndex];
    try {
      const out = await Auth.api(`/api/posts/${p.id}/save`, { method: 'POST' });
      p.saved = out.saved;
      $('pmSave').classList.toggle('saved', out.saved);
      notify(out.saved ? 'Saved' : 'Removed from saved', 'success', 1600);
    } catch (e) { notify(e.message, 'error'); }
  }
  async function sharePost() {
    const p = state.modalList[state.modalIndex];
    const url = location.origin + '/feed.html?post=' + p.id;
    try {
      if (navigator.share) await navigator.share({ title: 'NutriFell', url });
      else { await navigator.clipboard.writeText(url); notify('Link copied', 'success', 1800); }
    } catch { /* user cancelled */ }
  }

  async function loadComments(postId) {
    const host = $('pmComments');
    try {
      const comments = await Auth.api('/api/posts/' + postId + '/comments');
      if (!comments.length) { host.innerHTML = '<div class="feed-empty" style="padding:24px"><span class="em">💬</span><h3>No comments yet</h3><p style="color:var(--text-3)">Be the first to comment.</p></div>'; return; }
      host.innerHTML = comments.map(commentHTML).join('');
      host.querySelectorAll('[data-clike]').forEach(b => b.addEventListener('click', () => likeComment(b, postId)));
    } catch { host.innerHTML = '<div class="feed-empty" style="padding:24px"><h3>Could not load comments</h3></div>'; }
  }
  function commentHTML(c) {
    const replies = (c.replies || []).map(r =>
      `<div class="comment">${avatarHTML(r.authorAvatar, r.authorName, 'post-avatar')}` +
        `<div class="comment-main"><div class="comment-bubble"><b>${esc(r.authorName)}</b><p>${esc(r.text)}</p></div>` +
        `<div class="comment-actions"><span>${timeAgo(r.at)}</span></div></div></div>`).join('');
    return `<div class="comment">${avatarHTML(c.authorAvatar, c.authorName, 'post-avatar')}` +
      `<div class="comment-main"><div class="comment-bubble"><b>${esc(c.authorName)}</b><p>${esc(c.text)}</p></div>` +
      `<div class="comment-actions"><span>${timeAgo(c.at)}</span>` +
        `<button data-clike="${esc(c.id)}">♥ ${c.likeCount || ''}</button></div>` +
      (replies ? `<div class="comment-replies">${replies}</div>` : '') +
      '</div></div>';
  }
  async function likeComment(btn, postId) {
    if (!authed()) { location.href = '/login.html'; return; }
    try {
      const out = await Auth.api(`/api/posts/${postId}/comments/${btn.dataset.clike}/like`, { method: 'POST' });
      btn.classList.toggle('liked', out.liked); btn.textContent = '♥ ' + (out.likeCount || '');
    } catch (e) { notify(e.message, 'error'); }
  }
  async function sendComment() {
    if (!authed()) { location.href = '/login.html'; return; }
    const p = state.modalList[state.modalIndex];
    const inp = $('pmInput'); const text = inp.value.trim();
    if (!text) return;
    $('pmSend').disabled = true;
    try {
      await Auth.api(`/api/posts/${p.id}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
      inp.value = '';
      p.commentCount = (p.commentCount || 0) + 1;
      await loadComments(p.id);
    } catch (e) { notify(e.message, 'error'); }
    finally { $('pmSend').disabled = !inp.value.trim(); }
  }

  $('pmClose').addEventListener('click', closePostModal);
  $('pmPrev').addEventListener('click', () => navPost(-1));
  $('pmNext').addEventListener('click', () => navPost(1));
  postModal.addEventListener('click', (e) => { if (e.target === postModal) closePostModal(); });
  document.addEventListener('keydown', (e) => {
    if (!postModal.classList.contains('open')) {
      if (e.key === 'Escape') { closeEdit(); closeList(); }
      return;
    }
    if (e.key === 'Escape') closePostModal();
    else if (e.key === 'ArrowLeft') navPost(-1);
    else if (e.key === 'ArrowRight') navPost(1);
  });

  // ── inline icons ─────────────────────────────────────────────────────
  function heartSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>'; }
  function bookmarkSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21 12 16 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'; }
  function shareSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>'; }

  load();
})();
