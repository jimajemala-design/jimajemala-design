/* fridge.js — My Fridge + AI Meal Planner page */
'use strict';

(function () {
  if (!Auth.isAuthed()) { location.href = '/login.html'; return; }

  let foods = [];
  let fridge = [];
  let targets = null;       // { target, protein, carbs, fats }
  let currentPlan = null;

  const $ = id => document.getElementById(id);

  const QUICK_ADD = [
    { name: 'Chicken Breast', category: 'protein' },
    { name: 'White Rice', category: 'carb' },
    { name: 'Broccoli', category: 'vegetable' },
    { name: 'Banana', category: 'fruit' },
    { name: 'Eggs', category: 'protein' },
    { name: 'Oats', category: 'carb' },
    { name: 'Greek Yogurt', category: 'protein' },
    { name: 'Almond', category: 'fat' },
    { name: 'Sweet Potato', category: 'carb' },
    { name: 'Salmon', category: 'protein' },
  ];

  function guessCategory(food) {
    const n = food.nutrition || {};
    if (food.calories < 60 && (n.protein || 0) < 3 && (n.fat || 0) < 2) return (n.carbs || 0) > 5 ? 'fruit' : 'vegetable';
    if ((n.fat || 0) >= 15) return 'fat';
    if ((n.protein || 0) >= 12) return 'protein';
    if ((n.carbs || 0) >= 20) return 'carb';
    return 'protein';
  }
  const findFood = (item) =>
    foods.find(f => f.id === item.foodId) ||
    foods.find(f => f.name.toLowerCase() === String(item.name).toLowerCase());
  const emojiFor = (item) => { const f = findFood(item); return f ? f.emoji : '🍽️'; };

  // ── Init ────────────────────────────────────────────────────────────────
  async function init() {
    try {
      foods = await fetch('/api/foods').then(r => r.json());
      const prof = await Auth.api('/api/profile');
      targets = prof.calories;
      renderTargets();
      if (!targets) {
        toast('Complete your profile to unlock meal plans', 'error');
      }
      fridge = await Auth.api('/api/fridge');
      renderFridge();
      const existing = await Auth.api('/api/mealplan');
      if (existing) { currentPlan = existing; renderPlan(existing); }
    } catch (err) {
      toast(err.message, 'error');
    }
    wireSearch();
    renderQuickAdd();
    $('generateBtn').addEventListener('click', generatePlan);
  }

  // ── Targets panel ─────────────────────────────────────────────────────────
  function renderTargets() {
    const host = $('planTargets');
    if (!targets) {
      host.innerHTML = `<div class="plan-target cal"><b>—</b><span>Set profile</span></div>
        <div class="plan-target"><b>—</b><span>Protein</span></div>
        <div class="plan-target"><b>—</b><span>Carbs</span></div>
        <div class="plan-target"><b>—</b><span>Fats</span></div>`;
      return;
    }
    host.innerHTML = `
      <div class="plan-target cal"><b>${targets.target}</b><span>Kcal / day</span></div>
      <div class="plan-target"><b>${targets.protein}g</b><span>Protein</span></div>
      <div class="plan-target"><b>${targets.carbs}g</b><span>Carbs</span></div>
      <div class="plan-target"><b>${targets.fats}g</b><span>Fats</span></div>`;
  }

  // ── Fridge list ─────────────────────────────────────────────────────────
  function renderFridge() {
    const host = $('fridgeList');
    $('fridgeCount').textContent = fridge.length + ' item' + (fridge.length === 1 ? '' : 's');
    if (!fridge.length) {
      host.innerHTML = `<div class="fridge-empty">Your fridge is empty.<br>Search or use a quick-add below to stock it.</div>`;
      return;
    }
    host.innerHTML = fridge.map(i => `
      <div class="fridge-item" data-id="${i.id}">
        <span class="fi-emoji">${emojiFor(i)}</span>
        <div class="fi-main"><div class="fi-name">${i.name}</div></div>
        <input class="fi-qty" value="${i.quantity}" aria-label="Quantity for ${i.name}" />
        <span class="fi-cat ${i.category}">${i.category}</span>
        <button class="fi-del" aria-label="Remove ${i.name}">✕</button>
      </div>`).join('');

    host.querySelectorAll('.fridge-item').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('.fi-del').addEventListener('click', () => removeItem(id));
      const qty = row.querySelector('.fi-qty');
      let t;
      qty.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => updateQty(id, qty.value), 600);
      });
    });
  }

  function renderQuickAdd() {
    $('quickAdd').innerHTML = QUICK_ADD.map(q =>
      `<button class="quick-chip" data-name="${q.name}" data-cat="${q.category}">+ ${q.name}</button>`).join('');
    $('quickAdd').querySelectorAll('.quick-chip').forEach(chip => {
      chip.addEventListener('click', () => addItem(chip.dataset.name, '100g', chip.dataset.cat));
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────
  function wireSearch() {
    const input = $('searchInput');
    const results = $('searchResults');
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.classList.remove('show'); return; }
      const matches = foods.filter(f => f.name.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) { results.classList.remove('show'); return; }
      results.innerHTML = matches.map(f =>
        `<div class="search-item" data-id="${f.id}">
          <span class="emoji">${f.emoji}</span><span>${f.name}</span><span class="cal">${f.calories} kcal</span>
        </div>`).join('');
      results.classList.add('show');
      results.querySelectorAll('.search-item').forEach(el => {
        el.addEventListener('click', () => {
          const food = foods.find(f => f.id === el.dataset.id);
          addItem(food.name, '100g', guessCategory(food), food.id);
          input.value = ''; results.classList.remove('show');
        });
      });
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.fridge-search')) results.classList.remove('show');
    });
    $('searchAddBtn').addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) return;
      const food = foods.find(f => f.name.toLowerCase() === v.toLowerCase()) ||
                   foods.find(f => f.name.toLowerCase().includes(v.toLowerCase()));
      addItem(food ? food.name : v, '100g', food ? guessCategory(food) : 'protein', food ? food.id : null);
      input.value = ''; results.classList.remove('show');
    });
  }

  // ── Fridge CRUD ───────────────────────────────────────────────────────────
  async function addItem(name, quantity, category, foodId) {
    try {
      const item = await Auth.api('/api/fridge', {
        method: 'POST', body: JSON.stringify({ name, quantity, category, foodId }),
      });
      fridge.push(item);
      renderFridge();
      toast(name + ' added to fridge', 'success', 1600);
    } catch (err) { toast(err.message, 'error'); }
  }
  async function removeItem(id) {
    try {
      await Auth.api('/api/fridge/' + id, { method: 'DELETE' });
      fridge = fridge.filter(i => i.id !== id);
      renderFridge();
    } catch (err) { toast(err.message, 'error'); }
  }
  async function updateQty(id, quantity) {
    try {
      await Auth.api('/api/fridge/' + id, { method: 'PUT', body: JSON.stringify({ quantity }) });
      const it = fridge.find(i => i.id === id); if (it) it.quantity = quantity;
    } catch (err) { toast(err.message, 'error'); }
  }

  // ── Meal plan ─────────────────────────────────────────────────────────────
  async function generatePlan() {
    const btn = $('generateBtn');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…';
    try {
      currentPlan = await Auth.api('/api/mealplan/generate', { method: 'POST' });
      renderPlan(currentPlan);
      toast('Fresh meal plan generated!', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  }

  async function savePlan() {
    if (!currentPlan) return;
    try {
      await Auth.api('/api/mealplan/save', { method: 'POST', body: JSON.stringify({ plan: currentPlan }) });
      toast('Meal plan saved to your account', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderPlan(plan) {
    const host = $('mealPlan');
    if (!plan || !plan.meals) {
      host.innerHTML = `<div class="plan-empty"><div class="big">🍳</div>No meal plan yet.<br>Stock your fridge and hit <b>Generate Meal Plan</b>.</div>`;
      return;
    }
    const icons = { Breakfast: '🌅', Lunch: '🥗', Dinner: '🍽️', Snacks: '🍎' };
    const meals = plan.meals.map(m => `
      <div class="meal-card">
        <div class="meal-card-head">
          <div class="meal-card-name">${icons[m.name] || '🍴'} ${m.name}</div>
          <span class="meal-card-time">${m.time}</span>
        </div>
        <div class="meal-items">
          ${m.items.length ? m.items.map(it => `
            <div class="meal-item">
              <span class="mi-emoji">${it.emoji || '🍽️'}</span>
              <span>${it.name}</span>
              <span class="mi-qty">${it.quantity} · ${it.calories} kcal</span>
            </div>`).join('') : '<div class="meal-item">No items</div>'}
        </div>
        <div class="meal-instr">${m.instructions}</div>
        <div class="meal-macros">
          <span class="mm-cal">${m.calories} kcal</span>
          <span>P <b>${m.protein}g</b></span>
          <span>C <b>${m.carbs}g</b></span>
          <span>F <b>${m.fat}g</b></span>
        </div>
      </div>`).join('');

    const tgt = plan.target || targets || { protein: 1, carbs: 1, fats: 1, target: 1 };
    const tot = plan.totals;
    const pct = (v, t) => Math.min(100, Math.round((v / (t || 1)) * 100));
    const totals = `
      <div class="daily-totals">
        <h3>// Daily Totals — ${tot.calories} / ${tgt.target} kcal</h3>
        ${macroBar('Protein', 'protein', tot.protein, tgt.protein)}
        ${macroBar('Carbs', 'carbs', tot.carbs, tgt.carbs)}
        ${macroBar('Fats', 'fats', tot.fat, tgt.fats)}
      </div>
      <div class="plan-actions">
        <button class="btn-ghost" id="regenBtn">↻ Regenerate</button>
        <button class="btn-primary" id="saveBtn">Save Plan</button>
      </div>`;

    host.innerHTML = meals + totals;
    requestAnimationFrame(() => {
      host.querySelectorAll('.macro-progress-fill').forEach(el => { el.style.width = el.dataset.pct + '%'; });
    });
    $('regenBtn').addEventListener('click', generatePlan);
    $('saveBtn').addEventListener('click', savePlan);

    function macroBar(label, cls, val, target) {
      return `
        <div class="macro-progress">
          <div class="macro-progress-head">
            <span class="label">${label}</span>
            <span class="val">${Math.round(val)}g / ${target}g</span>
          </div>
          <div class="macro-progress-track">
            <div class="macro-progress-fill ${cls}" data-pct="${pct(val, target)}"></div>
          </div>
        </div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
