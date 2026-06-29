/* meal-builder.js — NutriFell Meal Builder.
   Search the 74-food DB, combine foods with gram weights, see live cumulative
   macros, then analyze for aggregated benefits/drawbacks + an AI verdict.
   Free users: max 2 foods, no AI verdict / share. Premium: unlimited + both.
   Uses the shared Auth / Toast helpers from auth.js (bare `Auth`, not window). */
'use strict';

(() => {
  const FREE_FOOD_LIMIT = 2;
  const GRAM_STEP = 25;
  const MIN_GRAMS = 5;

  let allFoods = [];                 // from /api/foods
  const selected = [];               // [{ food, grams }]
  let lastResult = null;             // last analyze response (for log/share)

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const $ = (id) => document.getElementById(id);

  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  function isPremium() {
    const u = (typeof Auth !== 'undefined' && Auth.user()) || {};
    const plan = String(u.plan || '').toLowerCase();
    const role = u.role || (u.isAdmin ? 'admin' : 'user');
    return ['premium', 'pro', 'elite'].includes(plan) || role === 'admin';
  }

  // Derive a simple category chip from the dominant macro (foods have no
  // category field in the DB). Calories from each macro decide the label.
  function categoryOf(food) {
    const n = food.nutrition || {};
    const p = (n.protein || 0) * 4, c = (n.carbs || 0) * 4, f = (n.fat || 0) * 9;
    if (p >= c && p >= f && p > 0) return 'Protein';
    if (f >= c && f >= p && f > 0) return 'Fats';
    if (c > 0) return 'Carbs';
    return 'Light';
  }

  // ── per-food contribution at a gram weight ──────────────────────────────
  function contrib(food, grams) {
    const factor = grams / 100;
    const n = food.nutrition || {};
    return {
      calories: Math.round((food.calories || 0) * factor),
      protein: round1((n.protein || 0) * factor),
      carbs: round1((n.carbs || 0) * factor),
      fat: round1((n.fat || 0) * factor),
      fiber: round1((n.fiber || 0) * factor),
    };
  }
  const round1 = (x) => Math.round(x * 10) / 10;

  // ── search ───────────────────────────────────────────────────────────────
  function renderSearch(term) {
    const box = $('searchResults');
    const q = term.trim().toLowerCase();
    if (!q) { box.classList.remove('open'); box.innerHTML = ''; return; }
    const matches = allFoods.filter(f =>
      f.name.toLowerCase().includes(q) || (f.nameKa && f.nameKa.includes(term))
    ).slice(0, 8);
    if (!matches.length) {
      box.innerHTML = '<div class="mb-no-results">No foods match that search.</div>';
      box.classList.add('open');
      return;
    }
    const added = new Set(selected.map(s => s.food.id));
    box.innerHTML = matches.map(f => `
      <button class="mb-result ${added.has(f.id) ? 'added' : ''}" data-id="${esc(f.id)}" role="option">
        <span class="em">${esc(f.emoji || '🍽️')}</span>
        <span>
          <span class="mb-result-name">${esc(f.name)}</span><br>
          <span class="mb-result-meta">${f.calories} kcal / 100g</span>
        </span>
        <span class="mb-cat-chip">${esc(categoryOf(f))}</span>
      </button>`).join('');
    box.classList.add('open');
    box.querySelectorAll('.mb-result').forEach(btn =>
      btn.addEventListener('click', () => addFood(btn.dataset.id)));
  }

  // ── add / remove / adjust ──────────────────────────────────────────────
  function addFood(id) {
    if (selected.some(s => s.food.id === id)) return;
    if (!isPremium() && selected.length >= FREE_FOOD_LIMIT) {
      toast('Free plan is limited to 2 foods. Upgrade for unlimited meals + an AI verdict.', 'warning', 4000);
      return;
    }
    const food = allFoods.find(f => f.id === id);
    if (!food) return;
    selected.push({ food, grams: 100 });
    $('foodSearch').value = '';
    $('searchResults').classList.remove('open');
    renderSelected();
  }
  function removeFood(id) {
    const i = selected.findIndex(s => s.food.id === id);
    if (i !== -1) { selected.splice(i, 1); renderSelected(); }
  }
  function setGrams(id, grams) {
    const s = selected.find(x => x.food.id === id);
    if (!s) return;
    s.grams = Math.max(MIN_GRAMS, Math.min(5000, Math.round(grams) || MIN_GRAMS));
    renderSelected();
  }

  // ── render selected list + totals ──────────────────────────────────────
  function renderSelected() {
    const list = $('selectedList');
    $('mbEmpty').style.display = selected.length ? 'none' : 'block';
    list.innerHTML = selected.map(({ food, grams }) => {
      const c = contrib(food, grams);
      return `<div class="mb-card" data-id="${esc(food.id)}">
        <div class="mb-card-top">
          <span class="mb-card-em">${esc(food.emoji || '🍽️')}</span>
          <span class="mb-card-name">${esc(food.name)}</span>
          <button class="mb-card-rm" data-act="rm" aria-label="Remove ${esc(food.name)}">✕</button>
        </div>
        <div class="mb-stepper">
          <button class="mb-step-btn" data-act="dec" aria-label="Decrease">−</button>
          <input class="mb-grams" type="number" inputmode="numeric" value="${grams}" data-act="grams" aria-label="Grams" />
          <span class="mb-grams-unit">grams</span>
        </div>
        <div class="mb-contrib">
          <div class="mb-mini cal"><b>${c.calories}</b><span>kcal</span></div>
          <div class="mb-mini p"><b>${c.protein}g</b><span>Protein</span></div>
          <div class="mb-mini c"><b>${c.carbs}g</b><span>Carbs</span></div>
          <div class="mb-mini f"><b>${c.fat}g</b><span>Fat</span></div>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.mb-card').forEach(card => {
      const id = card.dataset.id;
      card.querySelector('[data-act="rm"]').addEventListener('click', () => removeFood(id));
      card.querySelector('[data-act="dec"]').addEventListener('click', () => {
        const s = selected.find(x => x.food.id === id); if (s) setGrams(id, s.grams - GRAM_STEP);
      });
      const input = card.querySelector('[data-act="grams"]');
      input.addEventListener('change', () => setGrams(id, Number(input.value)));
    });
    renderTotals();
  }

  function totals() {
    return selected.reduce((t, { food, grams }) => {
      const c = contrib(food, grams);
      t.calories += c.calories; t.protein += c.protein; t.carbs += c.carbs; t.fat += c.fat; t.fiber += c.fiber;
      return t;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  }
  function renderTotals() {
    const t = totals();
    $('tCal').textContent = Math.round(t.calories);
    $('tP').textContent = round1(t.protein);
    $('tC').textContent = round1(t.carbs);
    $('tF').textContent = round1(t.fat);
    $('tFb').textContent = round1(t.fiber);
    $('analyzeBtn').disabled = selected.length === 0;
  }

  // ── analyze ────────────────────────────────────────────────────────────
  function openModal() { $('resultOverlay').classList.add('open'); $('resultModal').classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeModal() { $('resultOverlay').classList.remove('open'); $('resultModal').classList.remove('open'); document.body.style.overflow = ''; }

  async function analyze() {
    if (!authed()) { toast('Log in to analyze meals.', 'info', 3000); return; }
    if (!selected.length) return;
    openModal();
    $('resultBody').innerHTML = '<div class="mb-spinner"></div>';
    try {
      const res = await fetch('/api/meal-builder/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Auth.token() },
        body: JSON.stringify({ foods: selected.map(s => ({ foodId: s.food.id, grams: s.grams })) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'Could not analyze this meal.');
      lastResult = data;
      renderResult(data);
    } catch (err) {
      $('resultBody').innerHTML = `<div class="mb-locked"><span class="em">😕</span>${esc(err.message)}</div>`;
    }
  }

  function renderResult(d) {
    const maxCal = Math.max(...d.foods.map(f => f.contribution.calories), 1);
    const bars = d.foods.map(f => `
      <div class="mb-bar-row">
        <span class="mb-bar-label">${esc(f.emoji)} ${esc(f.name)}</span>
        <span class="mb-bar-track"><span class="mb-bar-fill" style="width:${Math.round(f.contribution.calories / maxCal * 100)}%;background:${esc(f.color || '#46D98A')}"></span></span>
        <span class="mb-bar-val">${f.contribution.calories} kcal</span>
      </div>`).join('');

    const benefits = (d.aggregatedBenefits || []).map(b => `<li class="mb-pro"><span class="mb-ic">✓</span>${esc(b)}</li>`).join('');
    const drawbacks = (d.aggregatedDrawbacks || []).map(x => `<li class="mb-con"><span class="mb-ic">⚠</span>${esc(x)}</li>`).join('');

    let verdictHTML;
    if (d.geminiVerdict) {
      verdictHTML = `<div class="mb-verdict"><div class="mb-verdict-head">✨ AI Nutritionist Verdict</div>${esc(d.geminiVerdict)}</div>`;
    } else if (d.premium && d.verdictError) {
      verdictHTML = `<div class="mb-verdict"><div class="mb-verdict-head">✨ AI Nutritionist Verdict</div>The AI verdict is unavailable right now — your macros above are still accurate.</div>`;
    } else {
      verdictHTML = `<div class="mb-locked"><span class="em">✨</span>AI verdict + share to feed are premium features.<br><a href="/pricing.html">See plans →</a></div>`;
    }

    const shareBtn = d.premium
      ? `<button class="mb-btn mb-btn-ghost" id="mbShare">↗ Share to feed</button>` : '';

    $('resultBody').innerHTML = `
      <div class="mb-result-totals">
        <div class="mb-mini cal"><b>${d.totalCalories}</b><span>kcal</span></div>
        <div class="mb-mini p"><b>${d.totalProtein}g</b><span>Protein</span></div>
        <div class="mb-mini c"><b>${d.totalCarbs}g</b><span>Carbs</span></div>
        <div class="mb-mini f"><b>${d.totalFat}g</b><span>Fat</span></div>
      </div>

      <div class="mb-section">
        <h4>Calorie contribution</h4>
        <div class="mb-bars">${bars}</div>
      </div>

      ${benefits ? `<div class="mb-section"><h4>Benefits</h4><ul class="mb-list">${benefits}</ul></div>` : ''}
      ${drawbacks ? `<div class="mb-section"><h4>Watch out for</h4><ul class="mb-list">${drawbacks}</ul></div>` : ''}

      ${verdictHTML}

      <div class="mb-note">⚕️ Estimates from a public food database — not medical advice.</div>

      <div class="mb-actions">
        <button class="mb-btn mb-btn-primary" id="mbLog">＋ Log this meal</button>
        ${shareBtn}
      </div>`;

    $('mbLog').addEventListener('click', logMeal);
    const sb = $('mbShare');
    if (sb) sb.addEventListener('click', shareMeal);
  }

  function mealName() {
    const names = selected.map(s => s.food.name);
    if (names.length <= 2) return names.join(' + ');
    return `${names[0]} + ${names[1]} +${names.length - 2}`;
  }

  async function logMeal() {
    if (!lastResult) return;
    const btn = $('mbLog'); const label = btn.textContent; btn.disabled = true; btn.textContent = 'Logging…';
    try {
      await Auth.api('/api/logs', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Meal: ' + mealName(),
          calories: lastResult.totalCalories,
          protein: lastResult.totalProtein,
          carbs: lastResult.totalCarbs,
          fat: lastResult.totalFat,
        }),
      });
      toast(`Logged ${lastResult.totalCalories} kcal to today 🎉`, 'success');
      btn.textContent = '✓ Logged';
    } catch (err) {
      toast(err.message || 'Could not log this meal.', 'error');
      btn.disabled = false; btn.textContent = label;
    }
  }

  async function shareMeal() {
    if (!lastResult) return;
    const btn = $('mbShare'); const label = btn.textContent; btn.disabled = true; btn.textContent = 'Sharing…';
    const d = lastResult;
    const caption = `🍽️ Meal Builder: ${mealName()}\n`
      + `🔥 ${d.totalCalories} kcal · P ${d.totalProtein}g · C ${d.totalCarbs}g · F ${d.totalFat}g · Fiber ${d.totalFiber}g`
      + (d.geminiVerdict ? `\n\n${d.geminiVerdict}` : '')
      + `\n#MealBuilder #NutriFell`;
    try {
      const fd = new FormData();
      fd.append('type', 'text');
      fd.append('caption', caption);
      const res = await fetch('/api/posts', {
        method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token() }, body: fd,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'Could not share to the feed.');
      toast('Shared to the feed! 🎉', 'success');
      btn.textContent = '✓ Shared';
    } catch (err) {
      toast(err.message || 'Could not share to the feed.', 'error');
      btn.disabled = false; btn.textContent = label;
    }
  }

  // ── init ─────────────────────────────────────────────────────────────────
  async function init() {
    // Plan badge
    const badge = $('mbPlanBadge');
    if (isPremium()) { badge.textContent = 'Premium'; badge.classList.remove('free'); }
    else { badge.textContent = 'Free · 2 foods'; }

    $('mbBack').addEventListener('click', () => {
      if (history.length > 1) history.back(); else location.href = '/feed.html';
    });
    $('foodSearch').addEventListener('input', (e) => renderSearch(e.target.value));
    $('foodSearch').addEventListener('focus', (e) => { if (e.target.value) renderSearch(e.target.value); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.mb-search')) $('searchResults').classList.remove('open');
    });
    $('analyzeBtn').addEventListener('click', analyze);
    $('resultClose').addEventListener('click', closeModal);
    $('resultOverlay').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    try {
      allFoods = await Auth.api('/api/foods');
    } catch {
      try { allFoods = await (await fetch('/api/foods')).json(); } catch { allFoods = []; }
    }
    renderSelected();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
