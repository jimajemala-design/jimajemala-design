/* recipes.js — Community Recipes grid */
'use strict';

const CATEGORIES = ['All', 'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Drinks', 'Desserts'];
let activeCat = 'All', activeSort = 'reacted', searchQ = '', bookmarks = new Set();
let searchTimer = null;

const initial = name => (name || '?').trim().charAt(0).toUpperCase();
const catEmoji = { Breakfast:'🥐', Lunch:'🥗', Dinner:'🍝', Snacks:'🍎', Drinks:'🥤', Desserts:'🍰' };

function card(r) {
  const cover = r.cover
    ? `<img class="rcp-cover" src="${r.cover}" alt="${r.name}" loading="lazy" />`
    : `<div class="rcp-cover rcp-cover-fallback">${catEmoji[r.category] || '🍽️'}</div>`;
  const stars = r.avgRating ? `<span class="rcp-flag star">★ ${r.avgRating} (${r.ratingCount})</span>` : '';
  const react = r.totalReactions ? `<span class="rcp-flag react">${r.topReactions.map(t=>t.emoji).join('')} ${r.totalReactions}</span>` : '';
  const flags = [
    r.badges.quick ? '<span class="rcp-flag quick">⚡ Quick</span>' : '',
    r.badges.healthy ? '<span class="rcp-flag healthy">🌿 Healthy</span>' : '',
    stars, react,
  ].filter(Boolean).join('');
  const bm = bookmarks.has(r.id);
  return `<article class="rcp-card" data-id="${r.id}">
    <div class="rcp-cat-badge">${r.category}</div>
    <button class="rcp-bookmark ${bm ? 'on' : ''}" data-id="${r.id}" title="Bookmark">${bm ? '🔖' : '🏷️'}</button>
    ${cover}
    <div class="rcp-body">
      <div class="rcp-name">${r.name}</div>
      <div class="rcp-author"><span class="rcp-avatar">${initial(r.authorName)}</span> ${r.authorName}</div>
      <div class="rcp-meta">
        <span>⏱️ ${(r.prepTime||0)+(r.cookTime||0)} min</span>
        <span>👥 ${r.servings}</span>
        ${r.calories != null ? `<span>🔥 ${r.calories} kcal</span>` : ''}
        <span>💬 ${r.commentCount}</span>
      </div>
      ${flags ? `<div class="rcp-tagrow">${flags}</div>` : ''}
    </div>
  </article>`;
}

async function load() {
  const params = new URLSearchParams();
  if (activeCat !== 'All') params.set('category', activeCat);
  if (searchQ) params.set('q', searchQ);
  params.set('sort', activeSort);
  try {
    const list = await Auth.api('/api/recipes?' + params.toString());
    const grid = document.getElementById('grid');
    document.getElementById('emptyState').style.display = list.length ? 'none' : '';
    grid.innerHTML = list.map(card).join('');
    grid.querySelectorAll('.rcp-card').forEach(c =>
      c.addEventListener('click', () => location.href = '/recipe-detail.html?id=' + c.dataset.id));
    grid.querySelectorAll('.rcp-bookmark').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); toggleBookmark(b.dataset.id, b); }));
  } catch (err) { toast(err.message, 'error'); }
}

async function toggleBookmark(id, btn) {
  if (!Auth.isAuthed()) { toast('Log in to bookmark recipes', 'error'); return; }
  try {
    const { bookmarked } = await Auth.api('/api/recipes/' + id + '/bookmark', { method: 'POST', body: '{}' });
    if (bookmarked) { bookmarks.add(id); btn.classList.add('on'); btn.textContent = '🔖'; }
    else { bookmarks.delete(id); btn.classList.remove('on'); btn.textContent = '🏷️'; }
  } catch (err) { toast(err.message, 'error'); }
}

document.addEventListener('DOMContentLoaded', async () => {
  renderNav();

  document.getElementById('catTabs').innerHTML = CATEGORIES.map(c =>
    `<button class="chip-btn ${c === 'All' ? 'active' : ''}" data-cat="${c}">${c === 'All' ? 'All' : (catEmoji[c] + ' ' + c)}</button>`).join('');
  document.querySelectorAll('#catTabs .chip-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#catTabs .chip-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); activeCat = b.dataset.cat; load();
  }));

  document.getElementById('sortSelect').addEventListener('change', e => { activeSort = e.target.value; load(); });
  document.getElementById('searchInput').addEventListener('input', e => {
    clearTimeout(searchTimer); searchQ = e.target.value.trim();
    searchTimer = setTimeout(load, 280);
  });

  if (Auth.isAuthed()) {
    try { bookmarks = new Set(await Auth.api('/api/bookmarks')); } catch {}
  }
  load();
});
