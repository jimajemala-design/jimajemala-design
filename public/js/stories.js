/* stories.js — NutriFell Phase 4B: 24h Stories.
   Renders the avatar-ring tray at the top of the feed, a fullscreen viewer
   with auto-advancing progress bars, and an upload composer. Visible to
   followers + self (enforced server-side). Requires auth.js. Exposed as
   window.Stories so feed.js can mount the tray. */
'use strict';

const Stories = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const IMG_MS = 5000;

  let groups = [];        // story groups from the API
  let trayEl = null;      // tray container

  // ── Tray ─────────────────────────────────────────────────────────────
  function ringHTML(g, idx) {
    const u = g.user || {};
    const av = u.avatar
      ? `<span class="story-ring-img" style="background-image:url('${esc(u.avatar)}')"></span>`
      : `<span class="story-ring-img">${esc(initial(u.name))}</span>`;
    const label = g.isOwn ? 'Your story' : (u.name || '').split(' ')[0];
    return `<button class="story-ring ${g.hasUnseen ? 'unseen' : 'seen'}" data-idx="${idx}" aria-label="View ${esc(label)}'s story">
      <span class="story-ring-frame">${av}</span>
      <span class="story-ring-name">${esc(label)}</span>
    </button>`;
  }

  function render() {
    if (!trayEl) return;
    const own = groups.find(g => g.isOwn);
    const addBtn = `<button class="story-ring story-add" data-add aria-label="Add to your story">
      <span class="story-ring-frame"><span class="story-add-plus">+</span></span>
      <span class="story-ring-name">Add story</span>
    </button>`;
    const rings = groups.map((g, i) => ringHTML(g, i)).join('');
    // Show the add button first only when you have no active story of your own;
    // otherwise your own ring leads and the add button is folded into it.
    trayEl.innerHTML = (own ? '' : addBtn) + rings;
    trayEl.hidden = groups.length === 0 && !authed();
    trayEl.querySelectorAll('.story-ring[data-idx]').forEach(b =>
      b.addEventListener('click', () => openViewer(parseInt(b.dataset.idx, 10), 0)));
    const add = trayEl.querySelector('[data-add]');
    if (add) add.addEventListener('click', pickStory);
    // tapping your own ring offers "add more" via long-press is overkill; the
    // viewer itself exposes a + when viewing your own story.
  }

  async function load(container) {
    if (container) trayEl = container;
    if (!authed() || !trayEl) return;
    try {
      const d = await Auth.api('/api/stories');
      groups = d.groups || [];
      render();
    } catch { /* offline — leave tray as-is */ }
  }

  // ── Upload composer ──────────────────────────────────────────────────
  let fileInput = null;
  function pickStory() {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*,video/*';
      fileInput.hidden = true;
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (f) openComposer(f);
        fileInput.value = '';
      });
    }
    fileInput.click();
  }

  function openComposer(file) {
    const isVideo = /^video\//.test(file.type);
    const url = URL.createObjectURL(file);
    const ov = document.createElement('div');
    ov.className = 'story-composer';
    ov.innerHTML = `
      <div class="story-composer-card">
        <button class="story-close" data-x aria-label="Cancel">✕</button>
        <div class="story-composer-preview">
          ${isVideo ? `<video src="${url}" autoplay muted loop playsinline></video>` : `<img src="${url}" alt="Story preview">`}
        </div>
        <div class="story-composer-foot">
          <input type="text" maxlength="200" placeholder="Add a caption…" aria-label="Story caption" data-cap>
          <button class="btn-post" data-share>Share to your story</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    document.body.classList.add('story-open');
    const close = () => { URL.revokeObjectURL(url); ov.remove(); document.body.classList.remove('story-open'); };
    ov.querySelector('[data-x]').addEventListener('click', close);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('[data-share]').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Sharing…';
      const fd = new FormData();
      fd.append('media', file);
      fd.append('caption', ov.querySelector('[data-cap]').value.trim());
      try {
        // Auth.api forces JSON content-type, so post FormData with fetch directly.
        const res = await fetch('/api/stories', { method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token() }, body: fd });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) || 'Upload failed');
        if (window.toast) toast('Story shared — it disappears in 24h.', 'success');
        close();
        load();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Share to your story';
        if (window.toast) toast(err.message || 'Could not share your story.', 'error');
      }
    });
  }

  // ── Fullscreen viewer ──────────────────────────────────────────────────
  let viewer = null, gi = 0, si = 0, timer = null, startT = 0, remaining = 0, paused = false;

  function buildViewer() {
    viewer = document.createElement('div');
    viewer.className = 'story-viewer';
    viewer.innerHTML = `
      <div class="story-stage" data-stage>
        <div class="story-bars" data-bars></div>
        <header class="story-vhead">
          <div class="story-vuser" data-vuser></div>
          <div class="story-vactions">
            <button class="story-icon" data-del hidden aria-label="Delete story">🗑</button>
            <button class="story-icon" data-close aria-label="Close">✕</button>
          </div>
        </header>
        <div class="story-media" data-media></div>
        <div class="story-caption" data-caption hidden></div>
        <div class="story-nav left" data-prev aria-label="Previous"></div>
        <div class="story-nav right" data-next aria-label="Next"></div>
        <footer class="story-vfoot" data-foot></footer>
      </div>`;
    document.body.appendChild(viewer);
    viewer.querySelector('[data-close]').addEventListener('click', closeViewer);
    viewer.querySelector('[data-prev]').addEventListener('click', () => step(-1));
    viewer.querySelector('[data-next]').addEventListener('click', () => step(1));
    viewer.querySelector('[data-del]').addEventListener('click', deleteCurrent);
    // hold-to-pause on the media area
    const media = viewer.querySelector('[data-media]');
    media.addEventListener('pointerdown', pause);
    media.addEventListener('pointerup', resume);
    media.addEventListener('pointerleave', resume);
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (!viewer || !viewer.classList.contains('open')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  }

  function openViewer(groupIdx, storyIdx) {
    if (!viewer) buildViewer();
    gi = groupIdx; si = storyIdx || 0;
    viewer.classList.add('open');
    document.body.classList.add('story-open');
    showStory();
  }
  function closeViewer() {
    clearTimeout(timer); timer = null;
    if (viewer) viewer.classList.remove('open');
    document.body.classList.remove('story-open');
    const m = viewer && viewer.querySelector('[data-media]'); if (m) m.innerHTML = '';
    load(); // refresh seen-state rings
  }

  function currentGroup() { return groups[gi]; }
  function currentStory() { const g = currentGroup(); return g && g.stories[si]; }

  function renderBars() {
    const g = currentGroup(); if (!g) return;
    const bars = viewer.querySelector('[data-bars]');
    bars.innerHTML = g.stories.map((s, i) =>
      `<span class="story-bar ${i < si ? 'done' : ''} ${i === si ? 'active' : ''}"><i></i></span>`).join('');
  }

  function showStory() {
    const g = currentGroup(); const s = currentStory();
    if (!g || !s) { closeViewer(); return; }
    clearTimeout(timer);
    renderBars();
    const u = g.user || {};
    viewer.querySelector('[data-vuser]').innerHTML =
      `${u.avatar ? `<span class="story-vav" style="background-image:url('${esc(u.avatar)}')"></span>` : `<span class="story-vav">${esc(initial(u.name))}</span>`}
       <a href="/profile-social.html?id=${esc(u.id)}"><b>${esc(u.name)}</b></a>
       <time>${timeAgo(s.createdAt)}</time>`;
    viewer.querySelector('[data-del]').hidden = !g.isOwn;

    const media = viewer.querySelector('[data-media]');
    if (s.type === 'video') {
      media.innerHTML = `<video src="${esc(s.media)}" autoplay playsinline></video>`;
      const v = media.querySelector('video');
      v.addEventListener('loadedmetadata', () => startProgress((v.duration || 8) * 1000));
      v.addEventListener('ended', () => step(1));
    } else {
      media.innerHTML = `<img src="${esc(s.media)}" alt="${esc(s.caption || 'Story')}">`;
      startProgress(IMG_MS);
    }

    const cap = viewer.querySelector('[data-caption]');
    if (s.caption) { cap.textContent = s.caption; cap.hidden = false; } else { cap.hidden = true; }

    renderFoot(g, s);
    markViewed(s.id);
  }

  function renderFoot(g, s) {
    const foot = viewer.querySelector('[data-foot]');
    if (g.isOwn) {
      foot.innerHTML = `<button class="story-viewers" data-viewers>👁 Viewers</button>`;
      foot.querySelector('[data-viewers]').addEventListener('click', () => showViewers(s.id));
    } else {
      foot.innerHTML = `<form class="story-reply" data-reply>
        <input type="text" placeholder="Reply to ${esc((g.user.name || '').split(' ')[0])}…" aria-label="Reply" maxlength="2000">
        <button type="submit" aria-label="Send reply">➤</button>
      </form>`;
      foot.querySelector('[data-reply]').addEventListener('submit', (e) => { e.preventDefault(); sendReply(g.user, e.target.querySelector('input')); });
      const input = foot.querySelector('input');
      input.addEventListener('focus', pause);
      input.addEventListener('blur', resume);
    }
  }

  // Progress + auto-advance
  function startProgress(ms) {
    const bar = viewer.querySelector('.story-bar.active i');
    if (bar) {
      bar.style.transition = 'none'; bar.style.width = '0%';
      // force reflow then animate
      void bar.offsetWidth;
      bar.style.transition = `width ${ms}ms linear`;
      bar.style.width = '100%';
    }
    remaining = ms; startT = Date.now(); paused = false;
    timer = setTimeout(() => step(1), ms);
  }
  function pause() {
    if (paused || !timer) return;
    paused = true; clearTimeout(timer);
    remaining -= (Date.now() - startT);
    const bar = viewer.querySelector('.story-bar.active i');
    if (bar) { const w = getComputedStyle(bar).width; bar.style.transition = 'none'; bar.style.width = w; }
    const v = viewer.querySelector('[data-media] video'); if (v) v.pause();
  }
  function resume() {
    if (!paused) return;
    paused = false;
    const bar = viewer.querySelector('.story-bar.active i');
    if (bar && remaining > 0) { void bar.offsetWidth; bar.style.transition = `width ${remaining}ms linear`; bar.style.width = '100%'; }
    startT = Date.now();
    timer = setTimeout(() => step(1), Math.max(0, remaining));
    const v = viewer.querySelector('[data-media] video'); if (v) v.play().catch(() => {});
  }

  function step(dir) {
    clearTimeout(timer);
    const g = currentGroup(); if (!g) return closeViewer();
    si += dir;
    if (si >= g.stories.length) { gi++; si = 0; if (gi >= groups.length) return closeViewer(); }
    else if (si < 0) { gi--; if (gi < 0) { gi = 0; si = 0; } else si = groups[gi].stories.length - 1; }
    showStory();
  }

  async function markViewed(id) {
    const s = currentStory();
    if (s) s.viewed = true;
    try { await Auth.api(`/api/stories/${id}/view`, { method: 'POST' }); } catch { /* ignore */ }
  }

  async function showViewers(id) {
    pause();
    try {
      const d = await Auth.api(`/api/stories/${id}/viewers`);
      const sheet = document.createElement('div');
      sheet.className = 'story-viewers-sheet';
      sheet.innerHTML = `<div class="svs-card">
        <div class="svs-head"><b>${d.count} view${d.count === 1 ? '' : 's'}</b><button data-x aria-label="Close">✕</button></div>
        <div class="svs-list">${d.viewers.length ? d.viewers.map(v =>
          `<a class="svs-row" href="/profile-social.html?id=${esc(v.id)}">
            ${v.avatar ? `<span class="svs-av" style="background-image:url('${esc(v.avatar)}')"></span>` : `<span class="svs-av">${esc(initial(v.name))}</span>`}
            <span><b>${esc(v.name)}</b><small>${esc(v.username)}</small></span>
          </a>`).join('') : '<p class="svs-empty">No views yet.</p>'}</div>
      </div>`;
      viewer.querySelector('[data-stage]').appendChild(sheet);
      const close = () => { sheet.remove(); resume(); };
      sheet.querySelector('[data-x]').addEventListener('click', close);
      sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
    } catch { resume(); }
  }

  async function deleteCurrent() {
    const s = currentStory(); if (!s) return;
    if (!confirm('Delete this story?')) return;
    pause();
    try {
      await Auth.api(`/api/stories/${s.id}`, { method: 'DELETE' });
      const g = currentGroup();
      g.stories.splice(si, 1);
      if (!g.stories.length) { groups.splice(gi, 1); if (gi >= groups.length) return closeViewer(); si = 0; }
      else if (si >= g.stories.length) si = g.stories.length - 1;
      if (window.toast) toast('Story deleted.', 'success', 1800);
      if (!groups.length) return closeViewer();
      showStory();
    } catch (e) { if (window.toast) toast('Could not delete story.', 'error'); resume(); }
  }

  async function sendReply(user, input) {
    const text = input.value.trim(); if (!text) return;
    input.value = '';
    try {
      const convo = await Auth.api('/api/conversations', { method: 'POST', body: JSON.stringify({ userId: user.id }) });
      await Auth.api(`/api/conversations/${convo.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      if (window.toast) toast('Reply sent.', 'success', 1800);
    } catch (e) { if (window.toast) toast(e.message || 'Could not send reply.', 'error'); }
    resume();
  }

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
    const h = m / 60; return `${Math.floor(h)}h`;
  }

  return { load };
})();

if (typeof window !== 'undefined') window.Stories = Stories;
