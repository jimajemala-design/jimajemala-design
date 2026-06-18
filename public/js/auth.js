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
  clearSession() { localStorage.removeItem('nb_token'); localStorage.removeItem('nb_user'); },
  logout() { Auth.clearSession(); location.href = '/'; },
  // Decode a JWT payload (no verification — just to read `exp` client-side)
  _decode(token) {
    try {
      const part = token.split('.')[1];
      return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return null; }
  },
  isAuthed() {
    const t = localStorage.getItem('nb_token');
    if (!t) return false;
    const payload = Auth._decode(t);
    // A token we can't decode, or one with no/elapsed expiry, is NOT trusted.
    // (Previously a malformed token fell through to `true`, so a stale token
    // from an old JWT secret was trusted client-side and the very next API call
    // 401'd — surfacing as "session expired" right after login.)
    if (!payload || !payload.exp || Date.now() >= payload.exp * 1000) {
      Auth.clearSession();
      return false;
    }
    return true;
  },
  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = Auth.token();
    if (t) headers.Authorization = 'Bearer ' + t;

    // Retry transient failures (network drop, 502/503/504) up to 3 attempts
    // with exponential backoff. Auth/validation errors (4xx) are NOT retried.
    const MAX = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        const res = await fetch(path, { ...opts, headers });
        if (res.status === 401) {
          // If we SENT a token and it was rejected, the session is genuinely
          // dead (expired or signed with an old secret): clear it and recover
          // to the login page once. If we had NO token, this is an ordinary
          // auth failure (e.g. wrong password) — let the caller show it.
          if (t) {
            Auth.clearSession();
            if (!/\/login\.html$/.test(location.pathname)) {
              location.href = '/login.html?expired=1';
            }
            throw new Error('Your session expired. Please log in again.');
          }
          const data401 = await res.json().catch(() => null);
          throw new Error((data401 && data401.error) || 'Invalid email or password');
        }
        if ([502, 503, 504].includes(res.status) && attempt < MAX) {
          await Auth._backoff(attempt); continue;
        }
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) || 'Request failed');
        return data;
      } catch (err) {
        // Only network/fetch failures are retryable; thrown app errors are not.
        const retryable = err instanceof TypeError || /Failed to fetch|NetworkError|load failed/i.test(err.message || '');
        if (retryable && attempt < MAX) { lastErr = err; await Auth._backoff(attempt); continue; }
        throw retryable ? new Error('Network error — please check your connection and try again.') : err;
      }
    }
    throw lastErr || new Error('Request failed');
  },
  _backoff(attempt) { return new Promise(r => setTimeout(r, attempt * 400)); },
};

// ── Unified toast system (stacked, typed, top-right) ─────────────────────
const Toast = {
  ICONS: { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' },
  _wrap() {
    let w = document.getElementById('nfToasts');
    if (!w) {
      w = document.createElement('div');
      w.id = 'nfToasts';
      w.className = 'nf-toasts';
      w.setAttribute('aria-live', 'polite');
      w.setAttribute('aria-atomic', 'false');
      document.body.appendChild(w);
    }
    return w;
  },
  show(message, type = 'success', ms = 4000) {
    const t = ['success', 'error', 'info', 'warning'].includes(type) ? type : 'success';
    const el = document.createElement('div');
    el.className = `nf-toast ${t}`;
    el.setAttribute('role', t === 'error' ? 'alert' : 'status');
    el.innerHTML =
      `<span class="nf-toast-ico" aria-hidden="true">${Toast.ICONS[t]}</span>` +
      `<span class="nf-toast-msg"></span>` +
      `<button class="nf-toast-x" aria-label="Dismiss">✕</button>`;
    el.querySelector('.nf-toast-msg').textContent = message;
    const dismiss = () => {
      if (el._gone) return; el._gone = true;
      clearTimeout(el._t);
      el.classList.remove('in');
      el.classList.add('out');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400); // safety net
    };
    el.querySelector('.nf-toast-x').addEventListener('click', dismiss);
    Toast._wrap().appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    if (ms > 0) el._t = setTimeout(dismiss, ms);
    return { dismiss };
  },
};
// Back-compat helper used across the app; errors linger a little longer.
function toast(message, type = 'success', ms) {
  if (ms == null) ms = type === 'error' ? 5000 : 4000;
  return Toast.show(message, type, ms);
}
window.Toast = Toast;

// ── Offline / online detection ───────────────────────────────────────────
const NetStatus = {
  _banner() {
    let b = document.getElementById('nfOffline');
    if (!b) {
      b = document.createElement('div');
      b.id = 'nfOffline';
      b.className = 'nf-offline';
      b.setAttribute('role', 'status');
      b.innerHTML = '<span class="nf-offline-dot" aria-hidden="true"></span> You are offline — changes may not save until you reconnect.';
      document.body.appendChild(b);
    }
    return b;
  },
  update(online) {
    const b = NetStatus._banner();
    b.classList.toggle('show', !online);
    if (online && NetStatus._wasOffline) {
      Toast.show('Back online', 'success', 2200);
    }
    NetStatus._wasOffline = !online;
  },
  init() {
    window.addEventListener('online', () => NetStatus.update(true));
    window.addEventListener('offline', () => NetStatus.update(false));
    if (!navigator.onLine) NetStatus.update(false);
  },
};

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
// ── Daily streak (consecutive days the app is opened) ────────────────────
const Streak = {
  KEY: 'nf_streak_v1',
  MILES: [3, 7, 30, 100],
  _today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  _daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); },
  get() {
    try { return JSON.parse(localStorage.getItem(Streak.KEY)) || { count: 0, best: 0, last: null, seen: [] }; }
    catch { return { count: 0, best: 0, last: null, seen: [] }; }
  },
  // Record today's visit; returns the state + any newly-hit milestone.
  tick() {
    const s = Streak.get();
    const today = Streak._today();
    let milestone = null;
    if (s.last === today) {
      // already counted today — no change
    } else if (s.last && Streak._daysBetween(s.last, today) === 1) {
      s.count += 1;            // consecutive day
    } else {
      s.count = 1;             // first visit or a missed day resets
    }
    s.last = today;
    s.best = Math.max(s.best || 0, s.count);
    s.seen = s.seen || [];
    if (Streak.MILES.includes(s.count) && !s.seen.includes(s.count)) {
      s.seen.push(s.count);
      milestone = s.count;
    }
    try { localStorage.setItem(Streak.KEY, JSON.stringify(s)); } catch {}
    return { s, milestone };
  },
  // Badge tier for a given day count.
  badge(count) {
    if (count >= 100) return { icon: '👑', name: 'Legend', days: 100 };
    if (count >= 30)  return { icon: '💪', name: 'Monthly Master', days: 30 };
    if (count >= 7)   return { icon: '⚡', name: 'Week Warrior', days: 7 };
    if (count >= 3)   return { icon: '🔥', name: 'On Fire', days: 3 };
    return { icon: '🔥', name: '', days: 0 };
  },
};
window.Streak = Streak;

function renderStreakChip(s) {
  const el = document.getElementById('nbStreak');
  if (!el) return;
  if (!s || s.count < 1) { el.hidden = true; return; }
  const b = Streak.badge(s.count);
  el.innerHTML =
    `<span class="nb-streak-ico">${b.icon}</span>` +
    `<span class="nb-streak-n">${s.count} day streak</span>` +
    (b.name ? `<span class="nb-streak-name">${b.name}</span>` : '');
  el.hidden = false;
}

function renderNav() {
  const navRight = document.getElementById('navRight');
  if (!navRight) return;
  const user = Auth.user();

  if (Auth.isAuthed() && user) {
    const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
    navRight.innerHTML = `<button class="nb-avatar-btn" id="nbAvatarBtn" title="My Profile">${initial}</button>`;
    document.getElementById('nbAvatarBtn').addEventListener('click', () => {
      location.href = '/profile-view.html';
    });
  } else {
    navRight.innerHTML = `<a class="nb-login-link" href="/login.html">Login</a>`;
  }

  _buildSidebar(user);
}

function _buildSidebar(user) {
  let overlay = document.getElementById('nbSidebarOverlay');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'nbSidebarOverlay';
    overlay.className = 'nb-sidebar-overlay';
    overlay.innerHTML = `
      <aside class="nb-sidebar" id="nbSidebar" role="dialog" aria-modal="true" aria-label="Navigation">
        <div class="nb-sidebar-head" id="nbSidebarHead"></div>
        <div class="nb-streak" id="nbStreak" hidden aria-live="polite"></div>
        <nav class="nb-sidebar-nav">
          <a class="nb-nav-item" href="/">🏠 Home</a>
          <a class="nb-nav-item" href="/#gallery">🥗 Food Database</a>
          <a class="nb-nav-item" href="/fridge.html">🧊 My Fridge</a>
          <a class="nb-nav-item" href="/water.html">💧 Water Tracker</a>
          <a class="nb-nav-item" href="/quit-smoking.html">🚭 Quit Smoking</a>
          <a class="nb-nav-item" href="/recipes.html">👨‍🍳 Recipes</a>
          <a class="nb-nav-item" href="/profile-view.html">👤 My Profile</a>
          <a class="nb-nav-item" href="/pricing.html">💎 Pricing</a>
          <div class="nb-nav-item nb-nav-disabled">⚙️ Settings <span class="nb-soon">Soon</span></div>
        </nav>
        <div class="nb-sidebar-foot" id="nbSidebarFoot"></div>
      </aside>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) _closeSidebar(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeSidebar(); });
    overlay.querySelectorAll('.nb-nav-item:not(.nb-nav-disabled)').forEach(item => {
      item.addEventListener('click', _closeSidebar);
    });

    const path = location.pathname;
    overlay.querySelectorAll('.nb-nav-item[href]').forEach(item => {
      const href = item.getAttribute('href').split('#')[0];
      if ((href === '/' && path === '/') || (href !== '/' && path === href)) {
        item.classList.add('active');
      }
    });
  }

  const burger = document.getElementById('nbHamburger');
  if (burger) {
    const fresh = burger.cloneNode(true);
    burger.replaceWith(fresh);
    fresh.addEventListener('click', _openSidebar);
  }

  const head = document.getElementById('nbSidebarHead');
  const foot = document.getElementById('nbSidebarFoot');

  if (user && Auth.isAuthed()) {
    const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
    const goalMap = { lose_weight: 'Lose Weight', gain_muscle: 'Gain Muscle', maintain: 'Maintain' };
    const goalLabel = goalMap[user.goal] || 'Healthy Living';
    head.innerHTML = `
      <div class="nb-sidebar-user">
        <div class="nb-sidebar-avatar">${initial}</div>
        <div class="nb-sidebar-name">${user.name || 'User'}</div>
        <div class="nb-sidebar-email">${user.email || ''}</div>
        <div class="nb-sidebar-goal">🎯 ${goalLabel}</div>
      </div>`;
    foot.innerHTML = `
      <button class="nb-logout-btn" id="nbLogoutBtn">⏻ Logout</button>
      <div class="nb-version">NutriFell v1.0</div>`;
    const logoutBtn = document.getElementById('nbLogoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => { _closeSidebar(); Auth.logout(); });
  } else {
    head.innerHTML = `
      <div class="nb-sidebar-welcome">
        <div class="nb-welcome-title">Welcome to NutriFell</div>
        <div class="nb-welcome-sub">Track nutrition. Reach your goals.</div>
        <a class="btn-primary nb-sidebar-cta" href="/login.html">Login</a>
        <a class="nb-register-link" href="/register.html">Create free account</a>
      </div>`;
    foot.innerHTML = `<div class="nb-version">NutriFell v1.0</div>`;
  }
}

function _openSidebar() {
  const overlay = document.getElementById('nbSidebarOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function _closeSidebar() {
  const overlay = document.getElementById('nbSidebarOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
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

  const detailsStep = document.getElementById('detailsStep');
  const verifyStep = document.getElementById('verifyStep');
  const f = {
    name: form.querySelector('[name=name]'),
    email: form.querySelector('[name=email]'),
    password: form.querySelector('[name=password]'),
    confirm: form.querySelector('[name=confirm]'),
  };
  Object.values(f).forEach(i => i.addEventListener('input', () => clearError(i)));

  const reg = { name: '', email: '', password: '' }; // kept for verify + resend
  let resendTimer = null;

  const sendCode = () => Auth.api('/api/auth/send-code', { method: 'POST', body: JSON.stringify(reg) });

  function showDevHint(data, prefix) {
    const hint = document.getElementById('devCodeHint');
    if (data && data.devCode) {
      hint.style.display = 'block';
      hint.innerHTML = `${prefix} <strong>${data.devCode}</strong>`;
    } else { hint.style.display = 'none'; }
  }

  // ── Step 1: validate details → send code ────────────────────────────────
  form.addEventListener('submit', async e => {
    e.preventDefault();
    let ok = true;
    if (!f.name.value.trim()) { setError(f.name, 'Please enter your name'); ok = false; } else markValid(f.name);
    if (!validEmail(f.email.value.trim())) { setError(f.email, 'Enter a valid email address'); ok = false; } else markValid(f.email);
    if (f.password.value.length < 6) { setError(f.password, 'Password must be at least 6 characters'); ok = false; } else markValid(f.password);
    if (f.confirm.value !== f.password.value) { setError(f.confirm, 'Passwords do not match'); ok = false; } else markValid(f.confirm);
    if (!ok) return;

    reg.name = f.name.value.trim();
    reg.email = f.email.value.trim();
    reg.password = f.password.value;

    const btn = form.querySelector('button[type=submit]');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending code…';
    try {
      const data = await sendCode();
      document.getElementById('verifyEmail').textContent = reg.email;
      detailsStep.style.display = 'none';
      verifyStep.style.display = 'block';
      const codeInput = document.getElementById('verifyCode');
      codeInput.value = ''; codeInput.focus();
      showDevHint(data, "📭 Email isn't configured yet — your code is");
      startResendCooldown();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  });

  // ── Resend (60s cooldown) ───────────────────────────────────────────────
  const resendBtn = document.getElementById('resendBtn');
  function startResendCooldown() {
    let left = 60;
    clearInterval(resendTimer);
    resendBtn.disabled = true;
    resendBtn.textContent = `Resend code (${left}s)`;
    resendTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(resendTimer); resendBtn.disabled = false; resendBtn.textContent = 'Resend code'; }
      else { resendBtn.textContent = `Resend code (${left}s)`; }
    }, 1000);
  }
  if (resendBtn) resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    try {
      const data = await sendCode();
      toast('New code sent', 'success', 2000);
      showDevHint(data, '📭 Dev code:');
      startResendCooldown();
    } catch (err) {
      toast(err.message, 'error');
      resendBtn.disabled = false;
    }
  });

  // ── Back to step 1 ──────────────────────────────────────────────────────
  const backBtn = document.getElementById('regBackBtn');
  if (backBtn) backBtn.addEventListener('click', () => {
    clearInterval(resendTimer);
    verifyStep.style.display = 'none';
    detailsStep.style.display = 'block';
  });

  // ── Step 2: verify code → create account ────────────────────────────────
  const verifyBtn = document.getElementById('verifyBtn');
  const codeInput = document.getElementById('verifyCode');
  const errEl = document.getElementById('verifyError');
  if (codeInput) codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (errEl) errEl.classList.remove('show');
  });
  if (verifyBtn) verifyBtn.addEventListener('click', async () => {
    const code = (codeInput.value || '').trim();
    if (code.length !== 6) { errEl.textContent = 'Enter the 6-digit code'; errEl.classList.add('show'); return; }
    const label = verifyBtn.innerHTML;
    verifyBtn.disabled = true; verifyBtn.innerHTML = '<span class="spinner"></span> Verifying…';
    try {
      const data = await Auth.api('/api/auth/verify-code', {
        method: 'POST', body: JSON.stringify({ email: reg.email, code }),
      });
      clearInterval(resendTimer);
      Auth.setSession(data.token, data.user);
      try { localStorage.setItem('nf_tour_pending', '1'); } catch {} // run the feature tour on first homepage visit
      toast('Email verified! Setting up your profile…', 'success');
      setTimeout(() => location.href = '/profile.html', 700);
    } catch (err) {
      errEl.textContent = err.message; errEl.classList.add('show');
      verifyBtn.disabled = false; verifyBtn.innerHTML = label;
    }
  });
}

// ── Login form ────────────────────────────────────────────────────────────
function initLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;
  if (Auth.isAuthed()) { location.href = '/fridge.html'; return; }

  // Arrived here because a stale/expired session was cleared — tell them gently.
  if (/[?&]expired=1/.test(location.search)) {
    setTimeout(() => toast('Your session expired. Please log in again.', 'info', 3500), 200);
    history.replaceState(null, '', location.pathname);
  }

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

  // ── Wizard step navigation ──────────────────────────────────────────────
  const steps = Array.from(form.querySelectorAll('.wizard-step'));
  const TOTAL = steps.length || 3;
  const STEP_NAMES = ['Basics', 'Body stats', 'Your goals'];
  const ENCOURAGE = [null, 'Great! Now the numbers behind your plan.', 'Almost there! One last step.'];
  const wizBar = document.getElementById('wizBar');
  const wizLabel = document.getElementById('wizLabel');
  const wizBack = document.getElementById('wizBack');
  const wizNext = document.getElementById('wizNext');
  const wizSave = document.getElementById('wizSave');
  let step = 1;

  function showStep(n) {
    step = Math.min(Math.max(n, 1), TOTAL);
    steps.forEach(s => { s.hidden = Number(s.dataset.step) !== step; });
    if (wizBar) wizBar.style.width = (step / TOTAL * 100) + '%';
    if (wizLabel) wizLabel.textContent = `Step ${step} of ${TOTAL} · ${STEP_NAMES[step - 1] || ''}`;
    const bar = form.closest('.auth-card')?.querySelector('.wizard-bar');
    if (bar) bar.setAttribute('aria-valuenow', String(step));
    if (wizBack) wizBack.hidden = step === 1;
    if (wizNext) wizNext.hidden = step === TOTAL;
    if (wizSave) wizSave.hidden = step !== TOTAL;
    const first = steps[step - 1] && steps[step - 1].querySelector('input, select');
    if (first) setTimeout(() => { try { first.focus(); } catch {} }, 60);
  }

  function validateStep(n) {
    let ok = true;
    if (n === 1) {
      if (!F.name.value.trim()) { setError(F.name, 'Name is required'); ok = false; } else markValid(F.name);
    } else if (n === 2) {
      const age = Number(F.age.value), weight = Number(F.currentWeight.value), height = Number(F.height.value);
      if (!age || age < 13 || age > 100) { setError(F.age, 'Age must be between 13 and 100'); ok = false; } else markValid(F.age);
      if (!weight || weight < 25 || weight > 400) { setError(F.currentWeight, 'Enter a valid current weight'); ok = false; } else markValid(F.currentWeight);
      if (!height || height < 90 || height > 250) { setError(F.height, 'Enter a valid height in cm'); ok = false; } else markValid(F.height);
    }
    return ok;
  }

  if (wizNext) wizNext.addEventListener('click', () => {
    if (!validateStep(step)) return;
    const target = step + 1;
    showStep(target);
    if (ENCOURAGE[target - 1]) toast(ENCOURAGE[target - 1], 'info', 2600);
  });
  if (wizBack) wizBack.addEventListener('click', () => showStep(step - 1));
  if (steps.length) showStep(1);

  // Enter on an early step advances instead of submitting the whole form.
  if (steps.length) form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && step < TOTAL) {
      e.preventDefault();
      if (wizNext) wizNext.click();
    }
  });

  // ── Celebration screen + confetti ───────────────────────────────────────
  function confetti() {
    const host = document.getElementById('celebrateConfetti');
    if (!host || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#22c55e', '#f59e0b', '#3b82f6', '#ef4444', '#a855f7', '#ffffff'];
    let html = '';
    for (let i = 0; i < 90; i++) {
      const c = colors[i % colors.length];
      const left = Math.random() * 100, delay = Math.random() * 0.6, dur = 2.4 + Math.random() * 1.8;
      const size = 6 + Math.random() * 8, rot = Math.random() * 360;
      html += `<span class="confetti-bit" style="left:${left}%;background:${c};width:${size}px;height:${(size * 0.6).toFixed(1)}px;animation-delay:${delay}s;animation-duration:${dur}s;transform:rotate(${rot}deg)"></span>`;
    }
    host.innerHTML = html;
  }
  function celebrate(targetCal) {
    const screen = document.getElementById('profileCelebrate');
    if (!screen) { location.href = '/fridge.html'; return; }
    screen.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => screen.classList.add('in'));
    const numEl = document.getElementById('celebrateTarget');
    if (numEl) {
      const dur = 1200, start = performance.now(), target = Number(targetCal) || 0;
      const tick = now => {
        const p = Math.min((now - start) / dur, 1);
        numEl.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    confetti();
  }

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
      celebrate(data.calories && data.calories.target);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.innerHTML = label;
    }
  });
}

// ── Tooltips (hover on desktop, tap-to-toggle on touch) ──────────────────
function initTooltips() {
  const tips = document.querySelectorAll('.nf-tip');
  if (!tips.length) return;
  tips.forEach(tip => {
    if (!tip.hasAttribute('tabindex')) tip.setAttribute('tabindex', '0');
    tip.setAttribute('role', 'button');
    const label = tip.getAttribute('data-tip') || '';
    if (label) tip.setAttribute('aria-label', label);
    const toggle = (e) => {
      e.preventDefault(); e.stopPropagation();
      document.querySelectorAll('.nf-tip.show').forEach(t => { if (t !== tip) t.classList.remove('show'); });
      tip.classList.toggle('show');
    };
    tip.addEventListener('click', toggle);
    tip.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
  });
  document.addEventListener('click', () => document.querySelectorAll('.nf-tip.show').forEach(t => t.classList.remove('show')));
}

// ── Universal scroll-reveal (works on every page that loads auth.js) ──────
// Homepage app.js has its own; a guard keeps double-observing harmless.
function initReveal() {
  const els = document.querySelectorAll('[data-reveal]:not(.is-in)');
  if (!els.length) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { els.forEach(el => el.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); obs.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach(el => io.observe(el));
}

document.addEventListener('DOMContentLoaded', () => {
  renderNav();
  NetStatus.init();
  initRegister();
  initLogin();
  initProfile();
  initReveal();
  initTooltips();

  // Streak: record today's visit, show the chip, celebrate milestones.
  const { s, milestone } = Streak.tick();
  renderStreakChip(s);
  if (milestone) {
    const b = Streak.badge(milestone);
    setTimeout(() => toast(`${b.icon} ${milestone}-day streak: ${b.name}`, 'success', 4500), 900);
  }
});
