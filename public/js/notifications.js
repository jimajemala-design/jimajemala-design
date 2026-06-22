/* notifications.js — NutriFell Phase 3: navbar notifications dropdown + shared
   rendering used by notifications.html. Polls the unread count every 30s for a
   real-time feel, marks read (single + all), and links each notification to the
   relevant post or profile. Exposed as window.Notif. Requires auth.js. */
'use strict';

const Notif = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();

  const TYPE_ICON = {
    like: '❤️', reaction: '❤️', comment: '💬', reply: '🔁',
    follow: '👤', save: '📌', mention: '🏷️',
  };

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60; if (m < 60) return `${Math.floor(m)} min ago`;
    const h = m / 60; if (h < 24) return `${Math.floor(h)} hour${h < 2 ? '' : 's'} ago`;
    const d = h / 24; if (d < 7) return `${Math.floor(d)} day${d < 2 ? '' : 's'} ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function avatarHTML(url, name) {
    return url
      ? `<div class="post-avatar" style="background-image:url('${esc(url)}')"></div>`
      : `<div class="post-avatar">${esc(initial(name))}</div>`;
  }

  // Single notification row (shared by dropdown + full page).
  function rowHTML(n) {
    const thumb = n.postThumb
      ? `<img class="notif-thumb" src="${esc(n.postThumb)}" alt="" loading="lazy">`
      : (n.postType === 'video' ? '<div class="notif-thumb glyph">🎬</div>'
        : (n.postType === 'text' ? '<div class="notif-thumb glyph">💬</div>' : ''));
    return `<div class="notif-row ${n.read ? '' : 'unread'}" data-id="${esc(n.id)}" data-link="${esc(n.link)}" role="button" tabindex="0">
      <div class="notif-av">${avatarHTML(n.fromAvatar, n.fromName)}<span class="notif-badge-ic">${TYPE_ICON[n.type] || '🔔'}</span></div>
      <div class="notif-main"><p><b>${esc(n.fromName)}</b> ${esc(n.text)}</p><span class="notif-time">${timeAgo(n.at)}</span></div>
      ${thumb}
    </div>`;
  }

  async function fetchPage(page = 1, type = '') {
    const qs = `?page=${page}` + (type ? `&type=${encodeURIComponent(type)}` : '');
    return Auth.api('/api/notifications' + qs);
  }
  async function markAll() { return Auth.api('/api/notifications/read', { method: 'PUT' }); }
  async function markOne(id) { try { await Auth.api(`/api/notifications/${id}/read`, { method: 'PUT' }); } catch { /* ignore */ } }

  // Wire a row container: clicking a row marks it read and navigates.
  function wireRows(container) {
    container.querySelectorAll('.notif-row').forEach(row => {
      const go = async () => {
        await markOne(row.dataset.id);
        const link = row.dataset.link;
        if (link && link !== '#') location.href = link;
      };
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }

  // ── Badges (poll every 30s) ──────────────────────────────────────────
  function setBadges(count) {
    document.querySelectorAll('[data-notif-badge]').forEach(b => {
      if (count > 0) { b.textContent = count > 99 ? '99+' : count; b.hidden = false; }
      else { b.hidden = true; }
    });
  }
  async function refreshCount() {
    if (!authed()) return;
    try { const d = await Auth.api('/api/notifications/count'); setBadges(d.count || 0); } catch { /* offline */ }
  }

  // ── DM unread badge (Phase 4A) — separate poll so messages never crowd the
  //    notifications feed. Updates any [data-dm-badge]; [data-dm-bell] routes
  //    to the inbox. ─────────────────────────────────────────────────────────
  function setDMBadges(count) {
    document.querySelectorAll('[data-dm-badge]').forEach(b => {
      if (count > 0) { b.textContent = count > 99 ? '99+' : count; b.hidden = false; }
      else { b.hidden = true; }
    });
  }
  async function refreshDMCount() {
    if (!authed()) return;
    try { const d = await Auth.api('/api/messages/unread-count'); setDMBadges(d.count || 0); } catch { /* offline */ }
  }

  // ── Dropdown ─────────────────────────────────────────────────────────
  let panel = null, open = false;
  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'notif-panel';
    panel.innerHTML =
      '<div class="notif-head"><h3>Notifications</h3><button id="notifMarkAll">Mark all read</button></div>' +
      '<div class="notif-list" id="notifList"></div>' +
      '<div class="notif-foot"><a href="/notifications.html">See all notifications</a></div>';
    document.body.appendChild(panel);
    panel.querySelector('#notifMarkAll').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await markAll(); setBadges(0); await loadDropdown(); } catch { /* ignore */ }
    });
    panel.addEventListener('click', e => e.stopPropagation());
  }
  async function loadDropdown() {
    const list = panel.querySelector('#notifList');
    list.innerHTML = '<div class="feed-empty" style="padding:30px"><span class="spinner"></span></div>';
    try {
      const d = await fetchPage(1);
      if (!d.notifications.length) {
        list.innerHTML = '<div class="feed-empty" style="padding:40px 20px"><span class="em">🔔</span><h3>No notifications yet</h3><p style="color:var(--text-3)">Likes, comments and follows show up here.</p></div>';
        return;
      }
      list.innerHTML = d.notifications.map(rowHTML).join('');
      wireRows(list);
    } catch { list.innerHTML = '<div class="feed-empty" style="padding:30px"><h3>Could not load</h3></div>'; }
  }
  function openPanel() {
    if (!authed()) { location.href = '/login.html'; return; }
    if (!panel) buildPanel();
    panel.classList.add('open'); open = true;
    loadDropdown();
  }
  function closePanel() { if (panel) panel.classList.remove('open'); open = false; }
  function toggle() { open ? closePanel() : openPanel(); }

  function init() {
    document.querySelectorAll('[data-notif-bell]').forEach(b =>
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); }));
    document.querySelectorAll('[data-dm-bell]').forEach(b =>
      b.addEventListener('click', (e) => { e.preventDefault(); location.href = '/messages.html'; }));
    document.addEventListener('click', () => { if (open) closePanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) closePanel(); });
    refreshCount();
    refreshDMCount();
    setInterval(() => { refreshCount(); refreshDMCount(); }, 30000);
  }

  return { init, rowHTML, wireRows, fetchPage, markAll, markOne, refreshCount, refreshDMCount, timeAgo, TYPE_ICON };
})();

if (document.readyState !== 'loading') Notif.init();
else document.addEventListener('DOMContentLoaded', Notif.init);
