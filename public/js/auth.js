/* auth.js — shared session, navbar state, and auth/profile forms */
'use strict';

const Auth = {
  token: () => localStorage.getItem('nb_token'),
  user: () => { try { return JSON.parse(localStorage.getItem('nb_user')); } catch { return null; } },
  setSession(token, user) {
    localStorage.setItem('nb_token', token);
    localStorage.setItem('nb_user', JSON.stringify(user));
  },
  updateUser(user) { localStorage.setItem('nb_user', JSON.stringify(user)); },
  logout() { localStorage.removeItem('nb_token'); localStorage.removeItem('nb_user'); location.href = '/'; },
  isAuthed: () => !!localStorage.getItem('nb_token'),
  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = Auth.token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) { Auth.logout(); throw new Error('Session expired — please log in again'); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Request failed');
    return data;
  },
};

// ── Toast ───────────────────────────────────────────────────────────────
function toast(message, type = 'success', ms = 3200) {
  let el = document.getElementById('nbToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nbToast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast ${type} show`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = `toast ${type}`; }, ms);
}

// ── Client-side calorie calculator (mirrors server advanced engine) ──────
const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, extreme: 1.9 };
function clientCalc({ weight, height, age, gender, activityLevel, targetWeight, timeline }) {
  if (!weight || !height || !age) return null;
  const g = gender === 'female' ? 'female' : 'male';
  const bmr = 10 * weight + 6.25 * height - 5 * age + (g === 'female' ? -161 : 5);
  const mult = ACTIVITY[activityLevel] || 1.55;
  const tdee = bmr * mult;

  const current = Number(weight);
  const targetW = (targetWeight != null && targetWeight !== '') ? Number(targetWeight) : current;
  const weeks = Number(timeline) || 12;
  const diff = +(targetW - current).toFixed(2);
  const direction = diff < -0.05 ? 'lose' : diff > 0.05 ? 'gain' : 'maintain';
  const totalCals = diff * 7700;
  const requestedDaily = weeks > 0 ? totalCals / (weeks * 7) : 0;

  let dailyAdjust = requestedDaily, warning = null, suggestedWeeks = null;
  if (requestedDaily < -1000) {
    dailyAdjust = -1000;
    suggestedWeeks = Math.ceil(Math.abs(totalCals) / (1000 * 7));
    warning = `This pace is too aggressive. Losing more than 1kg/week can cause muscle loss and nutrient deficiencies. We recommend ${suggestedWeeks} weeks instead for healthy results.`;
  } else if (requestedDaily > 500) {
    dailyAdjust = 500;
    suggestedWeeks = Math.ceil(totalCals / (500 * 7));
    warning = `This pace is too aggressive. Gaining more than 0.5kg/week tends to add fat rather than muscle. We recommend ${suggestedWeeks} weeks instead for lean results.`;
  }
  let target = Math.round(tdee + dailyAdjust);
  const minCal = g === 'female' ? 1200 : 1500;
  let minClamped = false;
  if (target < minCal) { target = minCal; dailyAdjust = Math.round(target - tdee); minClamped = true; }

  const weeklyChange = +((dailyAdjust * 7) / 7700).toFixed(3);
  let effWeeks = weeks;
  if (direction === 'maintain') effWeeks = 0;
  else if (Math.abs(weeklyChange) > 0.0001) effWeeks = Math.abs(diff / weeklyChange);
  effWeeks = Math.round(effWeeks * 10) / 10;
  const completionDate = direction === 'maintain' ? null
    : new Date(Date.now() + effWeeks * 7 * 86400000).toISOString().slice(0, 10);

  const prediction = [];
  const totalWeeks = Math.min(Math.max(Math.ceil(effWeeks), 1), 52);
  for (let w = 0; w <= totalWeeks; w++) {
    let val = current + weeklyChange * w;
    if (direction === 'lose') val = Math.max(val, targetW);
    if (direction === 'gain') val = Math.min(val, targetW);
    prediction.push({ week: w, weight: +val.toFixed(1) });
  }
  return {
    bmr: Math.round(bmr), tdee: Math.round(tdee), target,
    dailyAdjust: Math.round(dailyAdjust), weeklyChange, direction,
    goalKg: +Math.abs(diff).toFixed(1), currentWeight: current, targetWeight: targetW,
    weeks, effWeeks, completionDate, minClamped, warning, suggestedWeeks,
    protein: Math.round((target * 0.30) / 4),
    carbs: Math.round((target * 0.40) / 4),
    fats: Math.round((target * 0.30) / 9),
    prediction,
  };
}

// Build the prediction SVG sparkline (current → target over the weeks)
function predictionSVG(pred, direction) {
  if (!pred || pred.length < 2) return '';
  const W = 100, H = 36, pad = 3;
  const weights = pred.map(p => p.weight);
  const min = Math.min(...weights), max = Math.max(...weights);
  const range = (max - min) || 1;
  const pts = pred.map((p, i) => {
    const x = pad + (i / (pred.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (p.weight - min) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="pred-svg">
    <defs><linearGradient id="predg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(34,197,94,0.35)"/><stop offset="100%" stop-color="rgba(34,197,94,0)"/>
    </linearGradient></defs>
    <polygon points="${pad},${H - pad} ${pts.join(' ')} ${W - pad},${H - pad}" fill="url(#predg)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#22c55e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="#22c55e"/>
  </svg>`;
}

// Render the full results stats card into #calorieResult and warning into #goalWarning
function renderProfileResults(c) {
  const box = document.getElementById('calorieResult');
  const warn = document.getElementById('goalWarning');
  if (!c) { if (box) box.innerHTML = ''; if (warn) warn.className = 'goal-warning'; return; }

  if (warn) {
    if (c.warning) { warn.innerHTML = `⚠️ ${c.warning}`; warn.className = 'goal-warning show'; }
    else { warn.innerHTML = ''; warn.className = 'goal-warning'; }
  }

  const adj = c.dailyAdjust;
  const goalLine = c.direction === 'maintain'
    ? 'Maintain your weight'
    : `${c.direction === 'lose' ? 'Lose' : 'Gain'} ${c.goalKg}kg in ${c.effWeeks} weeks`;
  const deltaLabel = c.direction === 'lose' ? 'Daily Deficit' : c.direction === 'gain' ? 'Daily Surplus' : 'Daily Balance';
  const deltaVal = adj === 0 ? '0' : (adj > 0 ? '+' : '−') + Math.abs(adj);

  box.innerHTML = `
    <div class="stats-card">
      <div class="stats-grid">
        <div class="stat"><span>TDEE</span><b>${c.tdee}<i>kcal</i></b></div>
        <div class="stat hero"><span>Daily Calories</span><b>${c.target}<i>kcal</i></b></div>
        <div class="stat"><span>${deltaLabel}</span><b class="${c.direction}">${deltaVal}<i>cal</i></b></div>
        <div class="stat"><span>Goal</span><b class="sm">${goalLine}</b></div>
        <div class="stat"><span>Weekly Change</span><b class="sm">${c.weeklyChange === 0 ? '—' : (c.weeklyChange > 0 ? '+' : '') + c.weeklyChange + ' kg/wk'}</b></div>
        <div class="stat"><span>Est. Completion</span><b class="sm">${c.completionDate || '—'}</b></div>
      </div>

      <div class="macro-split">
        <div class="ms protein"><b>${c.protein}g</b><span>Protein · 30%</span></div>
        <div class="ms carbs"><b>${c.carbs}g</b><span>Carbs · 40%</span></div>
        <div class="ms fats"><b>${c.fats}g</b><span>Fats · 30%</span></div>
      </div>

      ${c.direction !== 'maintain' ? `
      <div class="pred-chart">
        <div class="pred-head">
          <span>Weight prediction</span>
          <span>${c.currentWeight}kg → ${c.targetWeight}kg</span>
        </div>
        ${predictionSVG(c.prediction, c.direction)}
        <div class="pred-axis"><span>Now</span><span>Week ${c.prediction.length - 1}</span></div>
      </div>` : ''}
      ${c.minClamped ? `<p class="stat-note">Adjusted up to the safe minimum of ${c.target} kcal/day.</p>` : ''}
    </div>`;
  box.classList.add('show-results');
}

// ── Field helpers ─────────────────────────────────────────────────────────
function setError(input, msg) {
  input.classList.add('error');
  input.classList.remove('valid');
  const err = input.closest('.form-group')?.querySelector('.form-error');
  if (err) { err.textContent = msg; err.classList.add('show'); }
}
function clearError(input) {
  input.classList.remove('error');
  const err = input.closest('.form-group')?.querySelector('.form-error');
  if (err) err.classList.remove('show');
}
function markValid(input) { input.classList.add('valid'); clearError(input); }
const validEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

// ── Navbar auth state ─────────────────────────────────────────────────────
function renderNav() {
  const host = document.getElementById('navAuth');
  if (!host) return;
  const user = Auth.user();

  let desktopHTML, mobileLinksHTML;

  if (Auth.isAuthed() && user) {
    const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
    const firstName = user.name ? user.name.split(' ')[0] : 'Account';
    desktopHTML = `
      <a class="nav-link" href="/fridge.html">My Fridge</a>
      <div class="nav-user">
        <button class="nav-user-btn" id="navUserBtn" aria-haspopup="true">
          <span class="nav-avatar">${initial}</span>
          <span>${firstName}</span>
        </button>
        <div class="nav-dropdown" id="navDropdown">
          <a href="/profile.html">👤 My Profile</a>
          <a href="/fridge.html">🧊 My Fridge</a>
          <div class="divider"></div>
          <a href="#" class="danger" id="navLogout">⏻ Logout</a>
        </div>
      </div>`;
    mobileLinksHTML = `
      <a class="mobile-nav-item" href="/">🏠 Home</a>
      <a class="mobile-nav-item" href="/#gallery">🌿 Food Explorer</a>
      <a class="mobile-nav-item" href="/fridge.html">🧊 My Fridge</a>
      <a class="mobile-nav-item" href="/profile.html">👤 Profile</a>
      <div class="mobile-nav-divider"></div>
      <a class="mobile-nav-item danger" href="#" id="mobileLogout">⏻ Logout</a>`;
  } else {
    desktopHTML = `
      <a class="nav-link" href="/fridge.html">My Fridge</a>
      <a class="nav-cta" href="/login.html">Login</a>`;
    mobileLinksHTML = `
      <a class="mobile-nav-item" href="/">🏠 Home</a>
      <a class="mobile-nav-item" href="/#gallery">🌿 Food Explorer</a>
      <a class="mobile-nav-item" href="/fridge.html">🧊 My Fridge</a>
      <div class="mobile-nav-divider"></div>
      <a class="mobile-nav-item" href="/login.html">Login</a>
      <a class="mobile-nav-item highlight" href="/register.html">Create Account</a>`;
  }

  host.innerHTML = `
    <div class="desktop-nav">${desktopHTML}</div>
    <button class="hamburger" id="hamburger" aria-label="Open menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>`;

  // Wire desktop dropdown
  if (Auth.isAuthed() && user) {
    const btn = document.getElementById('navUserBtn');
    const dd  = document.getElementById('navDropdown');
    if (btn && dd) {
      btn.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('show'); });
      document.addEventListener('click', () => dd.classList.remove('show'));
    }
    const logoutBtn = document.getElementById('navLogout');
    if (logoutBtn) logoutBtn.addEventListener('click', e => { e.preventDefault(); Auth.logout(); });
  }

  _setupMobileNav(mobileLinksHTML);
}

function _openMobileNav() {
  const overlay = document.getElementById('mobileNavOverlay');
  const burger  = document.getElementById('hamburger');
  if (!overlay) return;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (burger) { burger.classList.add('active'); burger.setAttribute('aria-expanded', 'true'); }
}

function _closeMobileNav() {
  const overlay = document.getElementById('mobileNavOverlay');
  const burger  = document.getElementById('hamburger');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  if (burger) { burger.classList.remove('active'); burger.setAttribute('aria-expanded', 'false'); }
}

function _setupMobileNav(linksHTML) {
  // Create overlay once
  if (!document.getElementById('mobileNavOverlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'mobileNavOverlay';
    overlay.className = 'mobile-nav-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Navigation menu');
    overlay.innerHTML = `
      <div class="mobile-nav-sheet">
        <div class="mobile-nav-handle"></div>
        <div class="mobile-nav-head">
          <div class="mobile-nav-brand">
            <div class="logo-mark" style="width:28px;height:28px;border-radius:8px;flex-shrink:0">
              <svg width="13" height="15" viewBox="0 0 16 18" fill="none" aria-hidden="true">
                <path d="M8 1C8 1 1.5 4.5 1.5 10.5C1.5 13.8 4.5 16.5 8 16.5C11.5 16.5 14.5 13.8 14.5 10.5C14.5 4.5 8 1 8 1Z" fill="white" fill-opacity="0.9"/>
                <path d="M8 7V13.5" stroke="#080c14" stroke-width="1.5" stroke-linecap="round"/>
                <path d="M5.5 9.5L8 7L10.5 9.5" stroke="#080c14" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <span>NutriBase</span>
          </div>
          <button class="mobile-nav-close" id="mobileNavClose" aria-label="Close menu">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 2L14 14M14 2L2 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <nav class="mobile-nav-links" id="mobileNavLinks"></nav>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) _closeMobileNav(); });
    document.getElementById('mobileNavClose').addEventListener('click', _closeMobileNav);

    // Close on Escape
    document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeMobileNav(); });
  }

  // Refresh links (handles auth state changes without recreating overlay)
  document.getElementById('mobileNavLinks').innerHTML = linksHTML;

  // Wire nav item clicks
  document.querySelectorAll('#mobileNavLinks .mobile-nav-item').forEach(link => {
    link.addEventListener('click', () => {
      if (link.id !== 'mobileLogout') _closeMobileNav();
    });
  });

  // Wire overlay logout
  const mobileLogout = document.getElementById('mobileLogout');
  if (mobileLogout) {
    mobileLogout.addEventListener('click', e => {
      e.preventDefault();
      _closeMobileNav();
      Auth.logout();
    });
  }

  // Wire hamburger (re-attach each render)
  const burger = document.getElementById('hamburger');
  if (burger) {
    burger.addEventListener('click', _openMobileNav);
  }
}

// ── Page guards ───────────────────────────────────────────────────────────
function requireAuth() {
  if (!Auth.isAuthed()) { location.href = '/login.html'; return false; }
  return true;
}

// ── Register form ─────────────────────────────────────────────────────────
function initRegister() {
  const form = document.getElementById('registerForm');
  if (!form) return;
  if (Auth.isAuthed()) { location.href = '/fridge.html'; return; }

  const f = {
    name: form.querySelector('[name=name]'),
    email: form.querySelector('[name=email]'),
    password: form.querySelector('[name=password]'),
    confirm: form.querySelector('[name=confirm]'),
  };
  Object.values(f).forEach(i => i.addEventListener('input', () => clearError(i)));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    let ok = true;
    if (!f.name.value.trim()) { setError(f.name, 'Please enter your name'); ok = false; } else markValid(f.name);
    if (!validEmail(f.email.value.trim())) { setError(f.email, 'Enter a valid email address'); ok = false; } else markValid(f.email);
    if (f.password.value.length < 6) { setError(f.password, 'Password must be at least 6 characters'); ok = false; } else markValid(f.password);
    if (f.confirm.value !== f.password.value) { setError(f.confirm, 'Passwords do not match'); ok = false; } else markValid(f.confirm);
    if (!ok) return;

    const btn = form.querySelector('button[type=submit]');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating account…';
    try {
      const data = await Auth.api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          name: f.name.value.trim(), email: f.email.value.trim(), password: f.password.value,
        }),
      });
      Auth.setSession(data.token, data.user);
      toast('Account created! Setting up your profile…', 'success');
      setTimeout(() => location.href = '/profile.html', 700);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.innerHTML = label;
    }
  });
}

// ── Login form ────────────────────────────────────────────────────────────
function initLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;
  if (Auth.isAuthed()) { location.href = '/fridge.html'; return; }

  const email = form.querySelector('[name=email]');
  const password = form.querySelector('[name=password]');
  [email, password].forEach(i => i.addEventListener('input', () => clearError(i)));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    let ok = true;
    if (!validEmail(email.value.trim())) { setError(email, 'Enter a valid email address'); ok = false; }
    if (!password.value) { setError(password, 'Enter your password'); ok = false; }
    if (!ok) return;

    const btn = form.querySelector('button[type=submit]');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Logging in…';
    try {
      const data = await Auth.api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.value.trim(), password: password.value }),
      });
      Auth.setSession(data.token, data.user);
      toast('Welcome back, ' + (data.user.name ? data.user.name.split(' ')[0] : 'friend') + '!', 'success');
      const ready = data.user.weight && data.user.height && data.user.age;
      setTimeout(() => location.href = ready ? '/fridge.html' : '/profile.html', 700);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.innerHTML = label;
    }
  });
}

// ── Profile setup form ────────────────────────────────────────────────────
function initProfile() {
  const form = document.getElementById('profileForm');
  if (!form) return;
  if (!requireAuth()) return;

  const F = {
    name: form.querySelector('[name=name]'),
    age: form.querySelector('[name=age]'),
    gender: form.querySelector('[name=gender]'),
    currentWeight: form.querySelector('[name=currentWeight]'),
    targetWeight: form.querySelector('[name=targetWeight]'),
    height: form.querySelector('[name=height]'),
    timeline: form.querySelector('[name=timeline]'),
    activityLevel: form.querySelector('[name=activityLevel]'),
  };

  function fill(u) {
    if (u.name) F.name.value = u.name;
    if (u.age) F.age.value = u.age;
    if (u.gender) F.gender.value = u.gender;
    if (u.weight) F.currentWeight.value = u.weight;
    if (u.targetWeight != null) F.targetWeight.value = u.targetWeight;
    if (u.height) F.height.value = u.height;
    if (u.timeline) F.timeline.value = u.timeline;
    if (u.activityLevel) F.activityLevel.value = u.activityLevel;
  }
  const cached = Auth.user();
  if (cached) fill(cached);
  Auth.api('/api/profile').then(({ user }) => { Auth.updateUser(user); fill(user); updateCalc(); }).catch(() => {});

  function updateCalc() {
    const c = clientCalc({
      weight: Number(F.currentWeight.value), height: Number(F.height.value), age: Number(F.age.value),
      gender: F.gender.value, activityLevel: F.activityLevel.value,
      targetWeight: F.targetWeight.value, timeline: F.timeline.value,
    });
    renderProfileResults(c);
  }
  Object.values(F).forEach(el => {
    el.addEventListener('input', () => { clearError(el); updateCalc(); });
    el.addEventListener('change', updateCalc);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    let ok = true;
    const age = Number(F.age.value), weight = Number(F.currentWeight.value),
      target = Number(F.targetWeight.value), height = Number(F.height.value);
    if (!F.name.value.trim()) { setError(F.name, 'Name is required'); ok = false; } else markValid(F.name);
    if (!age || age < 13 || age > 100) { setError(F.age, 'Age must be between 13 and 100'); ok = false; } else markValid(F.age);
    if (!weight || weight < 25 || weight > 400) { setError(F.currentWeight, 'Enter a valid current weight'); ok = false; } else markValid(F.currentWeight);
    if (!target || target < 25 || target > 400) { setError(F.targetWeight, 'Enter a valid target weight'); ok = false; } else markValid(F.targetWeight);
    if (!height || height < 90 || height > 250) { setError(F.height, 'Enter a valid height in cm'); ok = false; } else markValid(F.height);
    if (!ok) return;

    const btn = form.querySelector('button[type=submit]');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      const data = await Auth.api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name: F.name.value.trim(), age, currentWeight: weight, targetWeight: target, height,
          gender: F.gender.value, timeline: Number(F.timeline.value), activityLevel: F.activityLevel.value,
        }),
      });
      Auth.updateUser(data.user);
      toast('Profile saved! Daily target: ' + data.calories.target + ' kcal', 'success');
      setTimeout(() => location.href = '/fridge.html', 1000);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.innerHTML = label;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderNav();
  initRegister();
  initLogin();
  initProfile();
});
