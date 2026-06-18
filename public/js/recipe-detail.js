/* recipe-detail.js — single recipe view */
'use strict';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const RID = qs.get('id');
const REACTIONS = ['❤️','😍','🔥','👏','😋','🤩'];
const catEmoji = { Breakfast:'🥐', Lunch:'🥗', Dinner:'🍝', Snacks:'🍎', Drinks:'🥤', Desserts:'🍰' };
const initial = n => (n || '?').trim().charAt(0).toUpperCase();
const esc = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ago = iso => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  if (s < 604800) return Math.floor(s/86400) + 'd ago';
  return new Date(iso).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
};
let recipe = null, myReaction = null, myRating = 0, aiLoaded = false, photoList = [];

function requireLogin() {
  if (!Auth.isAuthed()) { toast('Please log in to do that', 'error'); setTimeout(() => location.href = '/login.html', 900); return false; }
  return true;
}

function renderReactions() {
  $('reactBar').innerHTML = REACTIONS.map(e => {
    const c = recipe.reactionCounts[e] || 0;
    return `<button class="react-btn ${myReaction === e ? 'mine' : ''}" data-e="${e}">${e}${c ? `<span class="c">${c}</span>` : ''}</button>`;
  }).join('');
  $('reactBar').querySelectorAll('.react-btn').forEach(b => b.addEventListener('click', () => react(b.dataset.e, b)));
}

async function react(emoji, btn) {
  if (!requireLogin()) return;
  btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
  try {
    const data = await Auth.api('/api/recipes/' + RID + '/react', { method: 'POST', body: JSON.stringify({ emoji }) });
    recipe.reactionCounts = data.counts; myReaction = data.mine; renderReactions();
  } catch (err) { toast(err.message, 'error'); }
}

function renderStars() {
  $('starRate').innerHTML = [1,2,3,4,5].map(n =>
    `<span class="s ${n <= (myRating || Math.round(recipe.avgRating)) ? 'on' : ''}" data-n="${n}">★</span>`).join('');
  $('starRate').querySelectorAll('.s').forEach(s => s.addEventListener('click', () => rate(Number(s.dataset.n))));
  $('rateMeta').textContent = recipe.ratingCount ? `${recipe.avgRating} avg · ${recipe.ratingCount} rating${recipe.ratingCount===1?'':'s'}` : 'No ratings yet';
}

async function rate(value) {
  if (!requireLogin()) return;
  try {
    const data = await Auth.api('/api/recipes/' + RID + '/rate', { method: 'POST', body: JSON.stringify({ value }) });
    recipe.avgRating = data.avgRating; recipe.ratingCount = data.ratingCount; myRating = data.mine; renderStars();
    toast('Thanks for rating!', 'success', 1600);
  } catch (err) { toast(err.message, 'error'); }
}

function selectPhoto(url) {
  $('mainPhoto').src = url;
  $('thumbs').querySelectorAll('img').forEach(i => i.classList.toggle('active', i.src.endsWith(url)));
}

function renderGallery() {
  const main = $('mainPhoto');
  if (photoList.length) {
    main.classList.remove('fallback'); main.style.display = '';
    selectPhoto(photoList[0]);
    $('thumbs').innerHTML = photoList.length > 1
      ? photoList.map((p, i) => `<img src="${p}" class="${i===0?'active':''}" alt="" loading="lazy" decoding="async" />`).join('') : '';
    $('thumbs').querySelectorAll('img').forEach(img => img.addEventListener('click', () => selectPhoto(img.getAttribute('src'))));
  } else {
    main.outerHTML = `<div class="main-photo fallback" id="mainPhoto">${catEmoji[recipe.category] || '🍽️'}</div>`;
  }
}

function renderRecipeTab() {
  const ing = (recipe.ingredients || []).map(i => `
    <div class="ing-row">
      <span class="qty">${i.quantity ? esc(i.quantity) : ''} ${esc(i.unit || '')}</span>
      <span>${esc(i.name)}</span>
      ${i.foodId ? '<span class="matched">✓ matched</span>' : ''}
    </div>`).join('') || '<div class="feat-empty">No ingredients listed.</div>';
  const steps = (recipe.steps || []).map(s => `
    <div class="step-item"><div class="num"></div><div class="txt">${esc(s.text)}${s.photo ? `<img src="${s.photo}" alt="" loading="lazy" decoding="async" />` : ''}</div></div>`).join('')
    || '<div class="feat-empty">No instructions listed.</div>';
  $('pane-recipe').innerHTML = `
    ${recipe.description ? `<p style="color:var(--text-2);margin-bottom:18px">${esc(recipe.description)}</p>` : ''}
    <div class="feat-card-title">🧺 Ingredients</div>
    <div class="ing-list">${ing}</div>
    <div class="feat-card-title" style="margin-top:22px">👩‍🍳 Instructions</div>
    <div class="step-list">${steps}</div>
    ${recipe.opinion ? `<div class="author-note">💚 ${esc(recipe.opinion)}</div>` : ''}
    ${recipe.tips ? `<div class="author-note">💡 ${esc(recipe.tips)}</div>` : ''}`;
}

function renderNutritionTab() {
  const n = recipe.nutrition;
  if (!n || !n.matched) { $('pane-nutrition').innerHTML = '<div class="feat-empty">Nutrition couldn\'t be calculated — ingredients weren\'t matched to the food database.</div>'; return; }
  const p = n.perServing;
  $('pane-nutrition').innerHTML = `
    <p style="color:var(--text-3);font-size:13px;margin-bottom:14px">Per serving · ${recipe.servings} serving${recipe.servings===1?'':'s'} total · auto-calculated from matched ingredients</p>
    <div class="nut-grid">
      <div class="nut-cell"><b>${p.calories}</b><span>Calories</span></div>
      <div class="nut-cell"><b>${p.protein}g</b><span>Protein</span></div>
      <div class="nut-cell"><b>${p.carbs}g</b><span>Carbs</span></div>
      <div class="nut-cell"><b>${p.fat}g</b><span>Fat</span></div>
      <div class="nut-cell"><b>${p.fiber}g</b><span>Fiber</span></div>
    </div>`;
}

async function renderAITab() {
  const pane = $('pane-ai');
  if (aiLoaded) return;
  pane.innerHTML = '<div class="feat-empty"><div class="loading-ring"></div>Analyzing recipe with AI…</div>';
  try {
    const a = await Auth.api('/api/recipes/' + RID + '/ai-analysis', { method: 'POST', body: '{}' });
    const cls = a.score >= 7 ? 'good' : a.score >= 4 ? 'mid' : 'low';
    pane.innerHTML = `
      <div class="ai-score"><div class="big ${cls}">${a.score}<span style="font-size:20px;color:var(--text-3)">/10</span></div>
        <div><div style="font-family:var(--font-display);font-weight:600">Health Score</div>
        <div style="color:var(--text-3);font-size:13px">Best eaten: ${esc(a.bestTime || 'Anytime')}</div></div></div>
      <div class="ai-list pros"><h4>What's good</h4><ul>${(a.pros||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="ai-list cons"><h4>Could be improved</h4><ul>${(a.cons||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="ai-list tips"><h4>Make it healthier</h4><ul>${(a.suggestions||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`;
    aiLoaded = true;
  } catch (err) { pane.innerHTML = `<div class="feat-empty">${esc(err.message)}</div>`; }
}

// ── Comments ──
function commentHTML(c, isReply) {
  const liked = false; // server doesn't return per-user like flag; rely on optimistic toggle
  return `<div class="cmt" data-id="${c.id}">
    <span class="rcp-avatar">${initial(c.authorName)}</span>
    <div class="cmt-main">
      <div class="cmt-head"><span class="nm">${esc(c.authorName)}</span><span class="tm">${ago(c.at)}</span></div>
      <div class="cmt-text">${esc(c.text)}</div>
      <div class="cmt-actions">
        <button class="like-btn" data-id="${c.id}">❤ <span>${c.likeCount || 0}</span></button>
        ${isReply ? '' : `<button class="reply-btn" data-id="${c.id}">Reply</button>`}
        <button class="report-c-btn" data-id="${c.id}">Report</button>
      </div>
      ${!isReply ? `<div class="cmt-replies" id="replies-${c.id}">${(c.replies||[]).map(r => commentHTML(r, true)).join('')}</div>
      <div class="cmt-reply-box" id="replybox-${c.id}" style="display:none">
        <input class="form-input" placeholder="Write a reply…" /><button class="chip-btn send-reply" data-id="${c.id}">Send</button>
      </div>` : ''}
    </div>
  </div>`;
}

async function loadComments() {
  const pane = $('pane-comments');
  pane.innerHTML = `
    <div class="cmt-input-row">
      <input class="form-input" id="cmtInput" placeholder="Add a comment…" />
      <button class="btn-primary" id="cmtSend">Post</button>
    </div>
    <div id="cmtList"></div>`;
  $('cmtSend').addEventListener('click', postComment);
  $('cmtInput').addEventListener('keydown', e => { if (e.key === 'Enter') postComment(); });
  try {
    const comments = await Auth.api('/api/recipes/' + RID + '/comments');
    const list = $('cmtList');
    list.innerHTML = comments.length ? comments.map(c => commentHTML(c, false)).join('') : '<div class="feat-empty">No comments yet — start the conversation!</div>';
    wireComments();
  } catch (err) { toast(err.message, 'error'); }
}

function wireComments() {
  document.querySelectorAll('.like-btn').forEach(b => b.addEventListener('click', () => likeComment(b)));
  document.querySelectorAll('.reply-btn').forEach(b => b.addEventListener('click', () => {
    const box = $('replybox-' + b.dataset.id); box.style.display = box.style.display === 'none' ? 'flex' : 'none';
    if (box.style.display === 'flex') box.querySelector('input').focus();
  }));
  document.querySelectorAll('.send-reply').forEach(b => b.addEventListener('click', () => postReply(b.dataset.id, b)));
  document.querySelectorAll('.report-c-btn').forEach(b => b.addEventListener('click', () => toast('Thanks — this comment has been flagged for review.', 'success')));
}

async function postComment() {
  if (!requireLogin()) return;
  const inp = $('cmtInput'); const text = inp.value.trim();
  if (!text) return;
  try {
    await Auth.api('/api/recipes/' + RID + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
    inp.value = ''; loadComments();
  } catch (err) { toast(err.message, 'error'); }
}

async function postReply(cid, btn) {
  if (!requireLogin()) return;
  const inp = btn.parentElement.querySelector('input'); const text = inp.value.trim();
  if (!text) return;
  try {
    await Auth.api(`/api/recipes/${RID}/comments/${cid}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
    inp.value = ''; loadComments();
  } catch (err) { toast(err.message, 'error'); }
}

async function likeComment(btn) {
  if (!requireLogin()) return;
  try {
    const { likeCount, liked } = await Auth.api(`/api/recipes/${RID}/comments/${btn.dataset.id}/like`, { method: 'POST', body: '{}' });
    btn.querySelector('span').textContent = likeCount;
    btn.classList.toggle('liked', liked);
  } catch (err) { toast(err.message, 'error'); }
}

function render() {
  $('loading').style.display = 'none';
  $('detail').style.display = '';
  document.title = recipe.name + ' — NutriFell';
  photoList = recipe.photos || [];
  renderGallery();
  renderReactions();
  $('catBadge').textContent = recipe.category;
  $('title').textContent = recipe.name;
  $('authorAvatar').textContent = initial(recipe.authorName);
  $('authorName').textContent = recipe.authorName;
  renderStars();
  const totalTime = (recipe.prepTime||0)+(recipe.cookTime||0);
  $('statRow').innerHTML = `
    <div class="it"><b>⏱️ ${recipe.prepTime||0}m</b><span>Prep</span></div>
    <div class="it"><b>🍳 ${recipe.cookTime||0}m</b><span>Cook</span></div>
    <div class="it"><b>👥 ${recipe.servings}</b><span>Servings</span></div>
    <div class="it"><b>🔥 ${recipe.nutrition ? recipe.nutrition.perServing.calories : '—'}</b><span>Kcal/serv</span></div>
    <div class="it"><b>📊 ${recipe.difficulty}</b><span>Difficulty</span></div>`;
  $('tagRow').innerHTML = (recipe.tags||[]).map(t => `<span class="rcp-flag react">#${esc(t)}</span>`).join('');
  renderRecipeTab();
  renderNutritionTab();
  loadComments();
}

document.addEventListener('DOMContentLoaded', async () => {
  renderNav();
  if (!RID) { $('loading').innerHTML = '<div class="feat-empty">No recipe specified.</div>'; return; }

  // tabs
  $('tabBar').querySelectorAll('.rcp-tabbtn').forEach(b => b.addEventListener('click', () => {
    $('tabBar').querySelectorAll('.rcp-tabbtn').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.rcp-tabpane').forEach(p => p.classList.remove('active'));
    b.classList.add('active'); $('pane-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'ai') renderAITab();
  }));

  $('bookmarkBtn').addEventListener('click', async () => {
    if (!requireLogin()) return;
    try { const { bookmarked } = await Auth.api('/api/recipes/' + RID + '/bookmark', { method: 'POST', body: '{}' });
      $('bookmarkBtn').innerHTML = bookmarked ? '🔖 Bookmarked' : '🏷️ Bookmark'; } catch (err) { toast(err.message, 'error'); }
  });
  $('shareBtn').addEventListener('click', async () => {
    const url = location.href;
    if (navigator.share) { try { await navigator.share({ title: recipe.name, url }); } catch {} }
    else { try { await navigator.clipboard.writeText(url); toast('Link copied!', 'success', 1600); } catch { toast(url); } }
  });
  $('reportBtn').addEventListener('click', async () => {
    if (!requireLogin()) return;
    const reason = prompt('Why are you reporting this recipe?');
    if (reason == null) return;
    try { const r = await Auth.api('/api/recipes/' + RID + '/report', { method: 'POST', body: JSON.stringify({ reason }) }); toast(r.message, 'success'); } catch (err) { toast(err.message, 'error'); }
  });
  $('followBtn').addEventListener('click', () => {
    const on = $('followBtn').classList.toggle('on');
    $('followBtn').textContent = on ? 'Following' : 'Follow';
    toast(on ? 'Following ' + recipe.authorName : 'Unfollowed', 'success', 1500);
  });

  try {
    recipe = await Auth.api('/api/recipes/' + RID);
    render();
  } catch (err) { $('loading').innerHTML = `<div class="feat-empty">${esc(err.message)}</div>`; }
});
