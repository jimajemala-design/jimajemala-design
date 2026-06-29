/* meal-builder.js — NutriFell Meal Builder.
   Search the 74-food DB OR type ANY food (estimated per-100g by Gemini),
   combine with gram weights, see live cumulative macros, then analyze for
   aggregated benefits/drawbacks + an AI verdict.
   Free users: max 2 foods, no AI verdict / share. Premium: unlimited + both.

   Works both standalone (meal-builder.html) and embedded (fridge.html). Uses
   mb-prefixed element IDs to avoid clashing with the fridge page, and exposes
   window.MealBuilder for the "Build Meal from Fridge" integration.
   Relies on the shared Auth / Toast helpers (bare `Auth`, not window.Auth). */
'use strict';

window.MealBuilder = (() => {
  const FREE_FOOD_LIMIT = 2;
  const GRAM_STEP = 25;
  const MIN_GRAMS = 5;

  let allFoods = [];                 // from /api/foods (the 74-food DB)
  const selected = [];               // [{ food, grams, source }]  food = {id|null,name,emoji,color,calories,nutrition}
  let lastResult = null;
  let booted = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const $ = (id) => document.getElementById(id);
  const round1 = (x) => Math.round(x * 10) / 10;

  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  function isPremium() {
    const u = (typeof Auth !== 'undefined' && Auth.user()) || {};
    const plan = String(u.plan || '').toLowerCase();
    const role = u.role || (u.isAdmin ? 'admin' : 'user');
    return ['premium', 'pro', 'elite'].includes(plan) || role === 'admin';
  }
  // Stable key for dedupe (DB id, or normalized name for AI foods).
  const keyOf = (food) => food.id || ('ai:' + String(food.name).toLowerCase().trim());

  function categoryOf(food) {
    const n = food.nutrition || {};
    const p = (n.protein || 0) * 4, c = (n.carbs || 0) * 4, f = (n.fat || 0) * 9;
    if (p >= c && p >= f && p > 0) return 'Protein';
    if (f >= c && f >= p && f > 0) return 'Fats';
    if (c > 0) return 'Carbs';
    return 'Light';
  }
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
  // Pull a gram number out of a fridge quantity string like "150g" / "2 cups".
  function parseGrams(q) {
    const m = String(q || '').match(/(\d+(\.\d+)?)/);
    const g = m ? Math.round(Number(m[1])) : 100;
    return Math.max(MIN_GRAMS, Math.min(5000, g || 100));
  }

  // ── search (DB matches + an AI-estimate option for free text) ──────────
  function renderSearch(term) {
    const box = $('mbSearchResults');
    if (!box) return;
    const q = term.trim();
    if (!q) { box.classList.remove('open'); box.innerHTML = ''; return; }
    const ql = q.toLowerCase();
    const matches = allFoods.filter(f =>
      f.name.toLowerCase().includes(ql) || (f.nameKa && f.nameKa.includes(q))
    ).slice(0, 6);
    const added = new Set(selected.map(s => keyOf(s.food)));
    const exact = allFoods.some(f => f.name.toLowerCase() === ql);

    let html = matches.map(f => `
      <button class="mb-result ${added.has(f.id) ? 'added' : ''}" data-id="${esc(f.id)}" role="option">
        <span class="em">${esc(f.emoji || '🍽️')}</span>
        <span><span class="mb-result-name">${esc(f.name)}</span><br><span class="mb-result-meta">${f.calories} kcal / 100g</span></span>
        <span class="mb-cat-chip">${esc(categoryOf(f))}</span>
      </button>`).join('');

    // Offer an AI estimate for anything not already an exact DB hit.
    if (!exact && q.length >= 2) {
      html += `<button class="mb-result mb-result-ai" data-ai="${esc(q)}" role="option">
        <span class="em">✨</span>
        <span><span class="mb-result-name">Add “${esc(q)}”</span><br><span class="mb-result-meta">AI nutrition estimate</span></span>
        <span class="mb-cat-chip">AI</span>
      </button>`;
    }
    box.innerHTML = html || '<div class="mb-no-results">No matches — keep typing for an AI estimate.</div>';
    box.classList.add('open');
    box.querySelectorAll('.mb-result[data-id]').forEach(b => b.addEventListener('click', () => addByFoodId(b.dataset.id)));
    box.querySelectorAll('.mb-result[data-ai]').forEach(b => b.addEventListener('click', () => addByName(b.dataset.ai)));
  }

  // ── add / remove / adjust ──────────────────────────────────────────────
  function atFreeLimit() {
    if (!isPremium() && selected.length >= FREE_FOOD_LIMIT) {
      // Trigger 3 — AI Tease: don't hit the server. Show an inline upsell card
      // right below the food list instead of silently blocking the add.
      showAiTease();
      return true;
    }
    return false;
  }
  // Inline premium upsell shown when a free user tries to add a 3rd food.
  function showAiTease() {
    const list = $('mbSelectedList');
    if (!list) return;
    let card = $('mbUpsell');
    if (!card) {
      card = document.createElement('div');
      card.id = 'mbUpsell';
      card.className = 'mb-upsell';
      card.setAttribute('data-trigger', 'ai_tease'); // analytics hook
      list.parentNode.insertBefore(card, list.nextSibling);
      card.innerHTML = `
        <div class="mb-upsell-lead">🔒 Add unlimited foods with Premium</div>
        <div class="mb-upsell-card">
          <p class="mb-upsell-compare"><b>Free plan:</b> 2 foods max.<br><b>Premium:</b> unlimited foods + AI verdict + share to feed</p>
          <a class="mb-upsell-btn" href="/pricing.html?trigger=ai_tease">Upgrade Now</a>
          <p class="mb-upsell-hint">Remove a food to continue free</p>
        </div>`;
    }
    card.classList.add('show');
  }
  function hideAiTease() {
    const card = $('mbUpsell');
    if (card) card.classList.remove('show');
  }
  function pushFood(food, grams, source) {
    if (selected.some(s => keyOf(s.food) === keyOf(food))) return false;
    selected.push({ food, grams: grams || 100, source: source || (food.id ? 'db' : 'ai') });
    return true;
  }
  function addByFoodId(id) {
    const food = allFoods.find(f => f.id === id);
    if (!food) return;
    if (selected.some(s => keyOf(s.food) === id)) return;
    if (atFreeLimit()) return;
    pushFood(food, 100, 'db');
    clearSearch();
    renderSelected();
  }
  // Free-text food: DB fuzzy match first, else Gemini estimate via /lookup.
  async function addByName(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    if (atFreeLimit()) return;
    // local DB fuzzy match first (no network)
    const local = allFoods.find(f => f.name.toLowerCase() === clean.toLowerCase())
      || allFoods.find(f => f.name.toLowerCase().includes(clean.toLowerCase()));
    if (local) { addByFoodId(local.id); return; }
    clearSearch();
    const toastRef = toast(`Estimating “${clean}”…`, 'info', 8000);
    try {
      const data = await Auth.api('/api/meal-builder/lookup', { method: 'POST', body: JSON.stringify({ name: clean }) });
      if (toastRef && toastRef.dismiss) toastRef.dismiss();
      const f = data.food;
      if (pushFood(f, 100, data.source)) renderSelected();
    } catch (err) {
      if (toastRef && toastRef.dismiss) toastRef.dismiss();
      toast(err.message || 'Could not look up that food.', 'error');
    }
  }
  function removeFood(key) {
    const i = selected.findIndex(s => keyOf(s.food) === key);
    if (i !== -1) { selected.splice(i, 1); renderSelected(); }
  }
  function setGrams(key, grams) {
    const s = selected.find(x => keyOf(x.food) === key);
    if (!s) return;
    s.grams = Math.max(MIN_GRAMS, Math.min(5000, Math.round(grams) || MIN_GRAMS));
    renderSelected();
  }
  function clearSearch() {
    const inp = $('mbFoodSearch'); if (inp) inp.value = '';
    const box = $('mbSearchResults'); if (box) box.classList.remove('open');
  }

  // ── render selected + totals ───────────────────────────────────────────
  function renderSelected() {
    const list = $('mbSelectedList');
    if (!list) return;
    const empty = $('mbEmpty');
    if (empty) empty.style.display = selected.length ? 'none' : 'block';
    // Removing a food back under the free cap clears the inline AI-tease upsell.
    if (selected.length < FREE_FOOD_LIMIT) hideAiTease();
    list.innerHTML = selected.map(({ food, grams, source }) => {
      const c = contrib(food, grams);
      const key = keyOf(food);
      return `<div class="mb-card" data-key="${esc(key)}">
        <div class="mb-card-top">
          <span class="mb-card-em">${esc(food.emoji || '🍽️')}</span>
          <span class="mb-card-name">${esc(food.name)}${source === 'ai' ? ' <span class="mb-ai-tag">AI</span>' : ''}</span>
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
      const key = card.dataset.key;
      card.querySelector('[data-act="rm"]').addEventListener('click', () => removeFood(key));
      card.querySelector('[data-act="dec"]').addEventListener('click', () => {
        const s = selected.find(x => keyOf(x.food) === key); if (s) setGrams(key, s.grams - GRAM_STEP);
      });
      const input = card.querySelector('[data-act="grams"]');
      input.addEventListener('change', () => setGrams(key, Number(input.value)));
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
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('mbTCal', Math.round(t.calories));
    set('mbTP', round1(t.protein)); set('mbTC', round1(t.carbs));
    set('mbTF', round1(t.fat)); set('mbTFb', round1(t.fiber));
    const btn = $('mbAnalyzeBtn'); if (btn) btn.disabled = selected.length === 0;
  }

  // ── analyze ────────────────────────────────────────────────────────────
  function openModal() { $('mbResultOverlay')?.classList.add('open'); $('mbResultModal')?.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeModal() { $('mbResultOverlay')?.classList.remove('open'); $('mbResultModal')?.classList.remove('open'); document.body.style.overflow = ''; }

  async function analyze() {
    if (!authed()) { toast('Log in to analyze meals.', 'info', 3000); return; }
    if (!selected.length) return;
    openModal();
    $('mbResultBody').innerHTML = '<div class="mb-spinner"></div>';
    try {
      const payload = selected.map(s => s.food.id
        ? { foodId: s.food.id, grams: s.grams }
        : { foodName: s.food.name, grams: s.grams });
      const res = await fetch('/api/meal-builder/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Auth.token() },
        body: JSON.stringify({ foods: payload }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'Could not analyze this meal.');
      lastResult = data;
      renderResult(data);
    } catch (err) {
      $('mbResultBody').innerHTML = `<div class="mb-locked"><span class="em">😕</span>${esc(err.message)}</div>`;
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
    const shareBtn = d.premium ? `<button class="mb-btn mb-btn-ghost" id="mbShare">↗ Share to feed</button>` : '';

    $('mbResultBody').innerHTML = `
      <div class="mb-result-totals">
        <div class="mb-mini cal"><b>${d.totalCalories}</b><span>kcal</span></div>
        <div class="mb-mini p"><b>${d.totalProtein}g</b><span>Protein</span></div>
        <div class="mb-mini c"><b>${d.totalCarbs}g</b><span>Carbs</span></div>
        <div class="mb-mini f"><b>${d.totalFat}g</b><span>Fat</span></div>
      </div>
      <div class="mb-section"><h4>Calorie contribution</h4><div class="mb-bars">${bars}</div></div>
      ${benefits ? `<div class="mb-section"><h4>Benefits</h4><ul class="mb-list">${benefits}</ul></div>` : ''}
      ${drawbacks ? `<div class="mb-section"><h4>Watch out for</h4><ul class="mb-list">${drawbacks}</ul></div>` : ''}
      ${verdictHTML}
      <div class="mb-note">⚕️ Estimates only — not medical advice. AI-estimated foods are approximate.</div>
      <div class="mb-actions">
        <button class="mb-btn mb-btn-primary" id="mbLog">＋ Log this meal</button>
        ${shareBtn}
      </div>`;
    $('mbLog').addEventListener('click', logMeal);
    $('mbShare')?.addEventListener('click', shareMeal);
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
        body: JSON.stringify({ name: 'Meal: ' + mealName(), calories: lastResult.totalCalories, protein: lastResult.totalProtein, carbs: lastResult.totalCarbs, fat: lastResult.totalFat }),
      });
      toast(`Logged ${lastResult.totalCalories} kcal to today 🎉`, 'success');
      btn.textContent = '✓ Logged';
    } catch (err) {
      if (err.code === 'PROGRESS_WALL') {
        UpgradeWall.progress(err.body && err.body.logsCount);
        btn.disabled = false; btn.textContent = label;
        return;
      }
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
      + (d.geminiVerdict ? `\n\n${d.geminiVerdict}` : '') + `\n#MealBuilder #NutriFell`;
    try {
      const fd = new FormData();
      fd.append('type', 'text'); fd.append('caption', caption);
      const res = await fetch('/api/posts', { method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token() }, body: fd });
      const data = await res.json().catch(() => null);
      if (res.status === 403 && data && data.code === 'SOCIAL_LOCK') {
        UpgradeWall.social();
        btn.disabled = false; btn.textContent = label;
        return;
      }
      if (!res.ok) throw new Error((data && data.error) || 'Could not share to the feed.');
      toast('Shared to the feed! 🎉', 'success');
      btn.textContent = '✓ Shared';
    } catch (err) {
      toast(err.message || 'Could not share to the feed.', 'error');
      btn.disabled = false; btn.textContent = label;
    }
  }

  // ── public API (used by the fridge integration) ────────────────────────
  async function prefillFromFridge(fridgeItems) {
    if (!Array.isArray(fridgeItems) || !fridgeItems.length) {
      toast('Your fridge is empty — add ingredients first.', 'info', 3000);
      return;
    }
    selected.length = 0; lastResult = null;
    const premium = isPremium();
    const cap = premium ? 50 : FREE_FOOD_LIMIT;
    const slice = fridgeItems.slice(0, cap);
    renderSelected();
    for (const it of slice) {
      const grams = parseGrams(it.quantity);
      const dbFood = (it.foodId && allFoods.find(f => f.id === it.foodId))
        || allFoods.find(f => f.name.toLowerCase() === String(it.name).toLowerCase());
      if (dbFood) { pushFood(dbFood, grams, 'db'); renderSelected(); }
      else { await addByNameWithGrams(it.name, grams); }
    }
    if (!premium && fridgeItems.length > FREE_FOOD_LIMIT) {
      toast(`Added the first ${FREE_FOOD_LIMIT} items — upgrade for unlimited.`, 'warning', 4000);
    }
    renderSelected();
  }
  // Like addByName but applies a specific gram weight (for fridge quantities).
  async function addByNameWithGrams(name, grams) {
    const clean = String(name || '').trim(); if (!clean) return;
    const local = allFoods.find(f => f.name.toLowerCase() === clean.toLowerCase())
      || allFoods.find(f => f.name.toLowerCase().includes(clean.toLowerCase()));
    if (local) { if (pushFood(local, grams, 'db')) renderSelected(); return; }
    try {
      const data = await Auth.api('/api/meal-builder/lookup', { method: 'POST', body: JSON.stringify({ name: clean }) });
      if (pushFood(data.food, grams, data.source)) renderSelected();
    } catch (err) { toast(`Skipped “${clean}”: ${err.message}`, 'warning', 3000); }
  }

  // ── init ─────────────────────────────────────────────────────────────────
  async function init() {
    if (booted) return;
    if (!$('mbSelectedList')) return;     // markup not on this page
    booted = true;

    const badge = $('mbPlanBadge');
    if (badge) {
      if (isPremium()) { badge.textContent = 'Premium'; badge.classList.remove('free'); }
      else { badge.textContent = 'Free · 2 foods'; }
    }
    $('mbBack')?.addEventListener('click', () => { if (history.length > 1) history.back(); else location.href = '/feed.html'; });

    const search = $('mbFoodSearch');
    if (search) {
      search.addEventListener('input', (e) => renderSearch(e.target.value));
      search.addEventListener('focus', (e) => { if (e.target.value) renderSearch(e.target.value); });
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const v = search.value.trim(); if (v) addByName(v); }
      });
    }
    document.addEventListener('click', (e) => { if (!e.target.closest('.mb-search')) $('mbSearchResults')?.classList.remove('open'); });
    $('mbAnalyzeBtn')?.addEventListener('click', analyze);
    $('mbResultClose')?.addEventListener('click', closeModal);
    $('mbResultOverlay')?.addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    try { allFoods = await Auth.api('/api/foods'); }
    catch { try { allFoods = await (await fetch('/api/foods')).json(); } catch { allFoods = []; } }
    renderSelected();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { init, addByFoodId, addByName, prefillFromFridge, isPremium,
    clear: () => { selected.length = 0; lastResult = null; renderSelected(); } };
})();
