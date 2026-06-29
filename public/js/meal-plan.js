/* meal-plan.js — NutriFell AI Weekly Meal Plan (premium).
   Setup form → loading → 7-day results with day tabs, meal cards, daily
   totals, weekly notes, regenerate, and Export PDF (window.print).
   Pre-fills calorie/protein targets from the user's profile.
   Uses the shared Auth / Toast helpers (bare `Auth`, not window.Auth). */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const state = { goal: 'maintain', allergies: new Set(), plan: null, activeDay: 0, lastReq: null };

  const authed = () => typeof Auth !== 'undefined' && Auth.isAuthed();
  function isPremium() {
    const u = (typeof Auth !== 'undefined' && Auth.user()) || {};
    const plan = String(u.plan || '').toLowerCase();
    const role = u.role || (u.isAdmin ? 'admin' : 'user');
    return ['premium', 'pro', 'elite'].includes(plan) || role === 'admin';
  }
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };

  // ── setup interactions ─────────────────────────────────────────────────
  function wireSetup() {
    $('mpGoals').querySelectorAll('.mp-goal').forEach(b => b.addEventListener('click', () => {
      state.goal = b.dataset.goal;
      $('mpGoals').querySelectorAll('.mp-goal').forEach(x => x.classList.toggle('active', x === b));
    }));
    $('mpAllergies').querySelectorAll('.mp-chip').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.allergy;
      if (state.allergies.has(a)) { state.allergies.delete(a); b.classList.remove('active'); }
      else { state.allergies.add(a); b.classList.add('active'); }
    }));
    $('mpGenerate').addEventListener('click', generate);
  }

  // Pre-fill calorie/protein from the user's profile (already in the DB).
  async function preloadProfile() {
    const cached = (typeof Auth !== 'undefined' && Auth.user()) || {};
    if (cached.goal && ['gain_muscle', 'lose_weight', 'maintain'].includes(cached.goal)) {
      state.goal = cached.goal;
      $('mpGoals').querySelectorAll('.mp-goal').forEach(x => x.classList.toggle('active', x.dataset.goal === cached.goal));
    }
    try {
      const { calories } = await Auth.api('/api/profile');
      if (calories && calories.target) $('mpCalories').value = calories.target;
      if (calories && calories.protein) $('mpProtein').value = calories.protein;
    } catch { /* keep defaults */ }
  }

  // ── generate ───────────────────────────────────────────────────────────
  function readForm() {
    return {
      calories: Math.round(Number($('mpCalories').value) || 2000),
      protein: Math.round(Number($('mpProtein').value) || 140),
      goal: state.goal,
      allergies: [...state.allergies],
      preferences: $('mpPrefs').value.split(',').map(s => s.trim()).filter(Boolean),
      daysCount: 7,
    };
  }
  async function generate() {
    if (!authed()) { toast('Log in to generate a meal plan.', 'info', 3000); return; }
    const req = readForm();
    state.lastReq = req;
    show('mpSetup', false); show('mpResults', false); show('mpLocked', false);
    show('mpLoading', true);
    try {
      const data = await Auth.api('/api/meal-plan/generate', { method: 'POST', body: JSON.stringify(req) });
      state.plan = data; state.activeDay = 0;
      show('mpLoading', false);
      renderResults();
    } catch (err) {
      show('mpLoading', false);
      if (/premium/i.test(err.message || '')) { showLocked(); }
      else { show('mpSetup', true); toast(err.message || 'Could not generate your plan.', 'error', 5000); }
    }
  }

  // ── results ────────────────────────────────────────────────────────────
  function renderResults() {
    const plan = state.plan;
    if (!plan || !plan.days || !plan.days.length) { show('mpSetup', true); return; }
    show('mpResults', true);

    $('mpDayTabs').innerHTML = plan.days.map((d, i) =>
      `<button class="mp-day-tab ${i === state.activeDay ? 'active' : ''}" data-i="${i}">${esc(d.day)}</button>`).join('');
    $('mpDayTabs').querySelectorAll('.mp-day-tab').forEach(b => b.addEventListener('click', () => {
      state.activeDay = Number(b.dataset.i);
      $('mpDayTabs').querySelectorAll('.mp-day-tab').forEach(x => x.classList.toggle('active', x === b));
      renderDay();
    }));

    const notes = $('mpNotes');
    if (plan.weeklyNotes) { notes.innerHTML = `<h4>Weekly notes</h4>${esc(plan.weeklyNotes)}`; notes.hidden = false; }
    else notes.hidden = true;

    renderDay();
  }
  function renderDay() {
    const d = state.plan.days[state.activeDay];
    if (!d) return;
    const meals = (d.meals || []).map(m => {
      const foods = (m.foods || []).map(f => `${esc(f.name)}${f.grams ? ` (${f.grams}g)` : ''}`).join(' · ');
      return `<div class="mp-meal">
        <div class="mp-meal-head">
          <span class="mp-meal-type">${esc(m.type)}</span>
          <span class="mp-meal-name">${esc(m.name)}</span>
          ${m.prepTime ? `<span class="mp-meal-prep">⏱ ${esc(m.prepTime)}</span>` : ''}
        </div>
        ${foods ? `<div class="mp-meal-foods">${foods}</div>` : ''}
        <div class="mp-meal-macros">
          <span class="mp-macro cal">${m.calories} kcal</span>
          <span class="mp-macro p">P ${m.protein}g</span>
          <span class="mp-macro c">C ${m.carbs}g</span>
          <span class="mp-macro f">F ${m.fat}g</span>
        </div>
      </div>`;
    }).join('');
    $('mpDayContent').innerHTML = `
      <div class="mp-day mp-meals">${meals}</div>
      <div class="mp-day-total">
        <span><span class="lbl">Day total</span><br><b>${d.totalCalories} kcal</b></span>
        <span style="text-align:right"><span class="lbl">Protein</span><br><b>${d.totalProtein}g</b></span>
      </div>`;
  }

  function showLocked() {
    show('mpSetup', false); show('mpLoading', false); show('mpResults', false);
    show('mpLocked', true);
  }

  // ── init ─────────────────────────────────────────────────────────────────
  function init() {
    if (!$('mpSetup')) return;
    const badge = $('mpBadge');
    $('mpBack')?.addEventListener('click', () => { if (history.length > 1) history.back(); else location.href = '/feed.html'; });

    if (!authed()) {
      toast('Log in to use the meal planner.', 'info', 3000);
      setTimeout(() => location.href = '/login.html', 900);
      return;
    }
    if (isPremium()) { if (badge) { badge.textContent = 'Premium'; badge.classList.remove('free'); } }
    else { if (badge) badge.textContent = 'Free'; showLocked(); }

    wireSetup();
    $('mpRegenerate')?.addEventListener('click', generate);
    $('mpExport')?.addEventListener('click', () => window.print());

    if (isPremium()) preloadProfile();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
