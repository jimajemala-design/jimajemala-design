/* fridge.js — Fridge, Meal Planner, Calorie Tracker, Smart Suggestions, NutriAI */
'use strict';

(function () {
  if (!Auth.isAuthed()) { location.href = '/login.html'; return; }

  let foods = [];
  let fridge = [];
  let logs = [];
  let targets = null;
  let currentPlan = null;
  const $ = id => document.getElementById(id);
  const today = () => new Date().toISOString().slice(0, 10);

  const QUICK_ADD = [
    { name: 'Chicken Breast', category: 'protein' }, { name: 'White Rice', category: 'carb' },
    { name: 'Broccoli', category: 'vegetable' }, { name: 'Banana', category: 'fruit' },
    { name: 'Eggs', category: 'protein' }, { name: 'Oats', category: 'carb' },
    { name: 'Greek Yogurt', category: 'protein' }, { name: 'Almond', category: 'fat' },
    { name: 'Sweet Potato', category: 'carb' }, { name: 'Salmon', category: 'protein' },
  ];
  const PREP = { protein: '15 min', carb: '12 min', fat: '2 min', vegetable: '10 min', fruit: '1 min' };

  function guessCategory(food) {
    const n = food.nutrition || {};
    if (food.calories < 60 && (n.protein || 0) < 3 && (n.fat || 0) < 2) return (n.carbs || 0) > 5 ? 'fruit' : 'vegetable';
    if ((n.fat || 0) >= 15) return 'fat';
    if ((n.protein || 0) >= 12) return 'protein';
    if ((n.carbs || 0) >= 20) return 'carb';
    return 'protein';
  }
  const findFood = (item) => foods.find(f => f.id === item.foodId) || foods.find(f => f.name.toLowerCase() === String(item.name).toLowerCase());
  const emojiFor = (item) => { const f = findFood(item); return f ? f.emoji : '🍽️'; };

  // ── Init ────────────────────────────────────────────────────────────────
  async function init() {
    try {
      foods = await fetch('/api/foods').then(r => r.json());
      const prof = await Auth.api('/api/profile');
      targets = prof.calories;
      renderTargets();
      fridge = await Auth.api('/api/fridge');
      logs = await Auth.api('/api/logs');
      renderFridge();
      renderTracker();
      renderWeekly();
      renderSuggestions();
      const existing = await Auth.api('/api/mealplan');
      if (existing) { currentPlan = existing; renderPlan(existing); }
    } catch (err) { toast(err.message, 'error'); }
    wireSearch(); renderQuickAdd(); wireTracker(); wireChat();
    $('generateBtn').addEventListener('click', generatePlan);
  }

  // ── Targets ───────────────────────────────────────────────────────────────
  function renderTargets() {
    const host = $('planTargets');
    if (!targets) {
      host.innerHTML = `<div class="plan-target cal"><b>—</b><span>Set profile</span></div>
        <div class="plan-target"><b>—</b><span>Protein</span></div><div class="plan-target"><b>—</b><span>Carbs</span></div><div class="plan-target"><b>—</b><span>Fats</span></div>`;
      return;
    }
    host.innerHTML = `
      <div class="plan-target cal"><b>${targets.target}</b><span>Kcal / day</span></div>
      <div class="plan-target"><b>${targets.protein}g</b><span>Protein</span></div>
      <div class="plan-target"><b>${targets.carbs}g</b><span>Carbs</span></div>
      <div class="plan-target"><b>${targets.fats}g</b><span>Fats</span></div>`;
  }

  // ── Calorie tracker (today) ───────────────────────────────────────────────
  function todayTotals() {
    const t = logs.filter(l => l.date === today());
    return t.reduce((a, l) => ({
      calories: a.calories + l.calories, protein: a.protein + l.protein, carbs: a.carbs + l.carbs, fat: a.fat + l.fat,
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  }
  function renderTracker() {
    const tot = todayTotals();
    const tgt = targets || { target: 0, protein: 1, carbs: 1, fats: 1 };
    const pct = (v, t) => Math.min(100, Math.round((v / (t || 1)) * 100));
    const over = tgt.target && tot.calories > tgt.target;
    $('tkCalsNum').firstChild.textContent = tot.calories + ' ';
    $('tkCalsTarget').textContent = `/ ${tgt.target || '—'} kcal`;
    const bar = $('tkBar');
    bar.style.width = pct(tot.calories, tgt.target) + '%';
    bar.classList.toggle('over', !!over);
    $('tkPv').textContent = Math.round(tot.protein) + 'g'; $('tkP').style.width = pct(tot.protein, tgt.protein) + '%';
    $('tkCv').textContent = Math.round(tot.carbs) + 'g'; $('tkC').style.width = pct(tot.carbs, tgt.carbs) + '%';
    $('tkFv').textContent = Math.round(tot.fat) + 'g'; $('tkF').style.width = pct(tot.fat, tgt.fats) + '%';

    const list = logs.filter(l => l.date === today());
    const host = $('loggedMeals');
    if (!list.length) { host.innerHTML = `<div class="logged-empty">Nothing logged yet today. Log a meal or pick a suggestion below.</div>`; return; }
    host.innerHTML = list.map(l => `
      <div class="logged-meal" data-id="${l.id}">
        <span class="lm-name">${l.name}</span>
        <span class="lm-macros">P${Math.round(l.protein)} C${Math.round(l.carbs)} F${Math.round(l.fat)}</span>
        <span class="lm-cal">${l.calories} kcal</span>
        <button class="lm-del" aria-label="Remove">✕</button>
      </div>`).join('');
    host.querySelectorAll('.logged-meal').forEach(row => {
      row.querySelector('.lm-del').addEventListener('click', () => deleteLog(row.dataset.id));
    });
  }

  // ── Weekly overview ───────────────────────────────────────────────────────
  function renderWeekly() {
    const host = $('weeklyStrip');
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const cals = logs.filter(l => l.date === key).reduce((a, l) => a + l.calories, 0);
      const tgt = targets ? targets.target : 0;
      let state = 'none';
      if (cals > 0) state = (tgt && cals > tgt * 1.05) ? 'over' : 'ontrack';
      days.push({ key, label: d.toLocaleDateString('en', { weekday: 'short' }), cals, state, isToday: key === today() });
    }
    host.innerHTML = days.map(d => `
      <div class="week-day ${d.state}${d.isToday ? ' today' : ''}">
        <div class="wd-label">${d.label}</div>
        <div class="wd-cal">${d.cals || '–'}</div>
        <div class="wd-dot"></div>
      </div>`).join('');
  }

  // ── Smart suggestions ─────────────────────────────────────────────────────
  function renderSuggestions() {
    const sec = $('suggestSection');
    if (!targets || !fridge.length) { sec.style.display = 'none'; return; }
    const tot = todayTotals();
    const remaining = Math.max(0, targets.target - tot.calories);
    if (remaining < 120) {
      sec.style.display = 'block';
      $('suggestSub').textContent = "— you're at your target for today 🎉";
      $('suggestGrid').innerHTML = `<div class="suggest-card"><div class="sg-name">Nicely done!</div><div class="sg-meta">You've hit your calorie goal. Rest & hydrate.</div></div>`;
      return;
    }
    const resolved = fridge.map(findFood).filter(Boolean);
    if (!resolved.length) { sec.style.display = 'none'; return; }
    const per = remaining / 3;
    const picks = [];
    for (let i = 0; i < 3; i++) {
      const food = resolved[i % resolved.length];
      const grams = Math.min(350, Math.max(50, Math.round((per / (food.calories || 1)) * 100)));
      const f = grams / 100;
      picks.push({
        food, grams,
        calories: Math.round(food.calories * f),
        protein: +(food.nutrition.protein * f).toFixed(1),
        carbs: +(food.nutrition.carbs * f).toFixed(1),
        fat: +(food.nutrition.fat * f).toFixed(1),
        prep: PREP[guessCategory(food)] || '10 min',
      });
    }
    sec.style.display = 'block';
    $('suggestSub').textContent = `— ${remaining} kcal left today`;
    $('suggestGrid').innerHTML = picks.map((p, i) => `
      <div class="suggest-card" data-i="${i}">
        <div class="sg-emoji">${p.food.emoji}</div>
        <div class="sg-name">${p.food.name} · ${p.grams}g</div>
        <div class="sg-meta"><span class="cal">${p.calories} kcal</span><span>P${p.protein} C${p.carbs} F${p.fat}</span><span>⏱ ${p.prep}</span></div>
        <button class="sg-add">+ Log this</button>
      </div>`).join('');
    $('suggestGrid').querySelectorAll('.suggest-card').forEach(card => {
      const p = picks[+card.dataset.i];
      const btn = card.querySelector('.sg-add');
      if (btn) btn.addEventListener('click', () => logMeal({
        name: `${p.food.name} (${p.grams}g)`, calories: p.calories, protein: p.protein, carbs: p.carbs, fat: p.fat,
      }));
    });
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  function wireTracker() {
    $('logToggle').addEventListener('click', () => $('logForm').classList.toggle('show'));
    $('logAdd').addEventListener('click', () => {
      const name = $('logName').value.trim();
      const cals = Number($('logCals').value);
      if (!name || !cals) { toast('Enter a meal name and calories', 'error'); return; }
      logMeal({ name, calories: cals, protein: 0, carbs: 0, fat: 0 });
      $('logName').value = ''; $('logCals').value = ''; $('logForm').classList.remove('show');
    });
  }
  async function logMeal(entry) {
    try {
      const before = todayTotals().calories;
      const saved = await Auth.api('/api/logs', { method: 'POST', body: JSON.stringify(entry) });
      logs.push(saved);
      renderTracker(); renderWeekly(); renderSuggestions();
      toast(entry.name + ' logged', 'success', 1600);
      maybeCelebrate(before, todayTotals().calories);
    } catch (err) { toast(err.message, 'error'); }
  }
  async function deleteLog(id) {
    try {
      await Auth.api('/api/logs/' + id, { method: 'DELETE' });
      logs = logs.filter(l => l.id !== id);
      renderTracker(); renderWeekly(); renderSuggestions();
    } catch (err) { toast(err.message, 'error'); }
  }

  // ── Fridge list ───────────────────────────────────────────────────────────
  function renderFridge() {
    const host = $('fridgeList');
    $('fridgeCount').textContent = fridge.length + ' item' + (fridge.length === 1 ? '' : 's');
    if (!fridge.length) { host.innerHTML = `<div class="fridge-empty">Your fridge is empty.<br>Search or quick-add below to stock it.</div>`; return; }
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
      qty.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => updateQty(id, qty.value), 600); });
    });
  }
  function renderQuickAdd() {
    $('quickAdd').innerHTML = QUICK_ADD.map(q => `<button class="quick-chip" data-name="${q.name}" data-cat="${q.category}">+ ${q.name}</button>`).join('');
    $('quickAdd').querySelectorAll('.quick-chip').forEach(chip => chip.addEventListener('click', () => addItem(chip.dataset.name, '100g', chip.dataset.cat)));
  }
  function wireSearch() {
    const input = $('searchInput'), results = $('searchResults');
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.classList.remove('show'); return; }
      const matches = foods.filter(f => f.name.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) { results.classList.remove('show'); return; }
      results.innerHTML = matches.map(f => `<div class="search-item" data-id="${f.id}"><span class="emoji">${f.emoji}</span><span>${f.name}</span><span class="cal">${f.calories} kcal</span></div>`).join('');
      results.classList.add('show');
      results.querySelectorAll('.search-item').forEach(el => el.addEventListener('click', () => {
        const food = foods.find(f => f.id === el.dataset.id);
        addItem(food.name, '100g', guessCategory(food), food.id);
        input.value = ''; results.classList.remove('show');
      }));
    });
    document.addEventListener('click', e => { if (!e.target.closest('.fridge-search')) results.classList.remove('show'); });
    $('searchAddBtn').addEventListener('click', () => {
      const v = input.value.trim(); if (!v) return;
      const food = foods.find(f => f.name.toLowerCase() === v.toLowerCase()) || foods.find(f => f.name.toLowerCase().includes(v.toLowerCase()));
      addItem(food ? food.name : v, '100g', food ? guessCategory(food) : 'protein', food ? food.id : null);
      input.value = ''; results.classList.remove('show');
    });
  }
  async function addItem(name, quantity, category, foodId) {
    try {
      const item = await Auth.api('/api/fridge', { method: 'POST', body: JSON.stringify({ name, quantity, category, foodId }) });
      fridge.push(item); renderFridge(); renderSuggestions();
      toast(name + ' added', 'success', 1400);
    } catch (err) { toast(err.message, 'error'); }
  }
  async function removeItem(id) {
    try { await Auth.api('/api/fridge/' + id, { method: 'DELETE' }); fridge = fridge.filter(i => i.id !== id); renderFridge(); renderSuggestions(); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function updateQty(id, quantity) {
    try { await Auth.api('/api/fridge/' + id, { method: 'PUT', body: JSON.stringify({ quantity }) }); const it = fridge.find(i => i.id === id); if (it) it.quantity = quantity; }
    catch (err) { toast(err.message, 'error'); }
  }

  // ── Meal plan ─────────────────────────────────────────────────────────────
  async function generatePlan() {
    const btn = $('generateBtn'), label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…';
    try { currentPlan = await Auth.api('/api/mealplan/generate', { method: 'POST' }); renderPlan(currentPlan); toast('Fresh meal plan generated!', 'success'); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  }
  async function savePlan() {
    if (!currentPlan) return;
    try { await Auth.api('/api/mealplan/save', { method: 'POST', body: JSON.stringify({ plan: currentPlan }) }); toast('Meal plan saved', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  }
  function renderPlan(plan) {
    const host = $('mealPlan');
    if (!plan || !plan.meals) { host.innerHTML = `<div class="plan-empty"><div class="big">🍳</div>No meal plan yet.<br>Stock your fridge and hit <b>Generate Meal Plan</b>.</div>`; return; }
    const icons = { Breakfast: '🌅', Lunch: '🥗', Dinner: '🍽️', Snacks: '🍎' };
    const meals = plan.meals.map((m, mi) => `
      <div class="meal-card">
        <div class="meal-card-head">
          <div class="meal-card-name">${icons[m.name] || '🍴'} ${m.name}</div>
          <span class="meal-card-time">${m.time}</span>
        </div>
        <div class="meal-items">
          ${m.items.length ? m.items.map(it => `<div class="meal-item"><span class="mi-emoji">${it.emoji || '🍽️'}</span><span>${it.name}</span><span class="mi-qty">${it.quantity} · ${it.calories} kcal</span></div>`).join('') : '<div class="meal-item">No items</div>'}
        </div>
        <div class="meal-instr">${m.instructions}</div>
        <div class="meal-macros">
          <span class="mm-cal">${m.calories} kcal</span><span>P <b>${m.protein}g</b></span><span>C <b>${m.carbs}g</b></span><span>F <b>${m.fat}g</b></span>
          <button class="btn-ghost" data-log="${mi}" style="margin-left:auto;padding:4px 12px;font-size:10px;">+ Log</button>
        </div>
      </div>`).join('');
    const tgt = plan.target || targets || { protein: 1, carbs: 1, fats: 1, target: 1 };
    const tot = plan.totals;
    const pct = (v, t) => Math.min(100, Math.round((v / (t || 1)) * 100));
    const macroBar = (label, cls, val, target) => `
      <div class="macro-progress">
        <div class="macro-progress-head"><span class="label">${label}</span><span class="val">${Math.round(val)}g / ${target}g</span></div>
        <div class="macro-progress-track"><div class="macro-progress-fill ${cls}" data-pct="${pct(val, target)}"></div></div>
      </div>`;
    host.innerHTML = meals + `
      <div class="daily-totals">
        <h3>// Daily Totals — ${tot.calories} / ${tgt.target} kcal</h3>
        ${macroBar('Protein', 'protein', tot.protein, tgt.protein)}
        ${macroBar('Carbs', 'carbs', tot.carbs, tgt.carbs)}
        ${macroBar('Fats', 'fats', tot.fat, tgt.fats)}
      </div>
      <div class="plan-actions"><button class="btn-ghost" id="regenBtn">↻ Regenerate</button><button class="btn-primary" id="saveBtn">Save Plan</button></div>`;
    requestAnimationFrame(() => host.querySelectorAll('.macro-progress-fill').forEach(el => { el.style.width = el.dataset.pct + '%'; }));
    $('regenBtn').addEventListener('click', generatePlan);
    $('saveBtn').addEventListener('click', savePlan);
    host.querySelectorAll('[data-log]').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = plan.meals[+btn.dataset.log];
        logMeal({ name: m.name + ' (meal plan)', calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat });
      });
    });
  }

  // ── Celebrations ──────────────────────────────────────────────────────────
  function maybeCelebrate(before, after) {
    if (!targets || !targets.target) return;
    const key = 'nb_celebrated_' + today();
    if (before < targets.target && after >= targets.target && !localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      celebrate('🎯', 'Daily Goal Reached!', `You hit your ${targets.target} kcal target for today. Keep the streak going!`);
    }
  }
  function celebrate(badge, title, msg) {
    const colors = ['#22c55e', '#4ade80', '#f59e0b', '#38bdf8', '#a78bfa', '#f87171'];
    const host = $('confetti');
    for (let i = 0; i < 80; i++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[(Math.random() * colors.length) | 0];
      p.style.animationDuration = (1.8 + Math.random() * 1.6) + 's';
      p.style.animationDelay = (Math.random() * 0.4) + 's';
      if (Math.random() > 0.5) p.style.borderRadius = '50%';
      host.appendChild(p);
      setTimeout(() => p.remove(), 3800);
    }
    const ach = document.createElement('div');
    ach.className = 'achievement';
    ach.innerHTML = `<div class="badge">${badge}</div><h2>${title}</h2><p>${msg}</p>`;
    document.body.appendChild(ach);
    requestAnimationFrame(() => ach.classList.add('show'));
    setTimeout(() => { ach.classList.remove('show'); setTimeout(() => ach.remove(), 500); }, 3200);
  }

  // ── NutriAI chat ──────────────────────────────────────────────────────────
  let chatHistory = [];
  try { chatHistory = JSON.parse(localStorage.getItem('nb_chat') || '[]'); } catch { chatHistory = []; }
  let chatBusy = false;

  function wireChat() {
    const fab = $('chatFab'), panel = $('chatPanel');
    fab.addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) $('chatInput').focus(); });
    $('chatClose').addEventListener('click', () => panel.classList.remove('open'));
    $('chatClear').addEventListener('click', () => { chatHistory = []; localStorage.removeItem('nb_chat'); renderChat(); });
    $('chatSend').addEventListener('click', sendChat);
    $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
    $('chatSuggest').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('chatInput').value = b.textContent; sendChat(); }));
    if (!chatHistory.length) {
      const name = (Auth.user() && Auth.user().name) ? Auth.user().name.split(' ')[0] : 'there';
      chatHistory.push({ role: 'assistant', content: `Hi ${name}! 🌿 I'm NutriAI. Ask me for a meal plan, nutrition advice, or what to cook with your fridge.`, time: now() });
    }
    renderChat();
  }
  function now() { return new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }); }
  function fmt(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
      .replace(/\n/g, '<br>');
  }
  function renderChat() {
    const body = $('chatBody');
    body.innerHTML = chatHistory.map(m => `
      <div class="chat-msg ${m.role === 'user' ? 'user' : 'ai'}">
        ${m.role === 'user' ? '' : '<div class="chat-avatar">🌿</div>'}
        <div>
          <div class="chat-bubble">${fmt(m.content)}</div>
          <div class="chat-time">${m.time || ''}</div>
        </div>
      </div>`).join('');
    body.scrollTop = body.scrollHeight;
  }
  async function sendChat() {
    if (chatBusy) return;
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    chatHistory.push({ role: 'user', content: text, time: now() });
    renderChat();

    const body = $('chatBody');
    const typing = document.createElement('div');
    typing.className = 'chat-msg ai';
    typing.innerHTML = `<div class="chat-avatar">🌿</div><div class="chat-typing"><span></span><span></span><span></span></div>`;
    body.appendChild(typing); body.scrollTop = body.scrollHeight;
    chatBusy = true; $('chatSend').disabled = true;

    try {
      const hist = chatHistory.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const data = await Auth.api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ message: text, history: hist }) });
      chatHistory.push({ role: 'assistant', content: data.reply, time: now() });
    } catch (err) {
      chatHistory.push({ role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.', time: now() });
    } finally {
      typing.remove();
      chatBusy = false; $('chatSend').disabled = false;
      localStorage.setItem('nb_chat', JSON.stringify(chatHistory.slice(-30)));
      renderChat();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
