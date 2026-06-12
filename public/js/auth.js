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

// ── Client-side calorie calculator (mirrors server Mifflin-St Jeor) ──────
function clientCalc({ weight, height, age, gender, goal }) {
  if (!weight || !height || !age) return null;
  const bmr = 10 * weight + 6.25 * height - 5 * age + (gender === 'female' ? -161 : 5);
  const tdee = bmr * 1.55;
  const factor = goal === 'lose_weight' ? 0.8 : goal === 'gain_muscle' ? 1.2 : 1.0;
  const target = Math.round(tdee * factor);
  return {
    target,
    protein: Math.round((target * 0.30) / 4),
    carbs: Math.round((target * 0.40) / 4),
    fats: Math.round((target * 0.30) / 9),
  };
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
  if (Auth.isAuthed() && user) {
    const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
    host.innerHTML = `
      <a class="nav-link" href="/fridge.html">My Fridge</a>
      <div class="nav-user">
        <button class="nav-user-btn" id="navUserBtn" aria-haspopup="true">
          <span class="nav-avatar">${initial}</span>
          <span>${user.name ? user.name.split(' ')[0] : 'Account'}</span>
        </button>
        <div class="nav-dropdown" id="navDropdown">
          <a href="/profile.html">👤 My Profile</a>
          <a href="/fridge.html">🧊 My Fridge</a>
          <div class="divider"></div>
          <a href="#" class="danger" id="navLogout">⏻ Logout</a>
        </div>
      </div>`;
    const btn = document.getElementById('navUserBtn');
    const dd = document.getElementById('navDropdown');
    btn.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('show'); });
    document.addEventListener('click', () => dd.classList.remove('show'));
    document.getElementById('navLogout').addEventListener('click', e => { e.preventDefault(); Auth.logout(); });
  } else {
    host.innerHTML = `
      <a class="nav-link" href="/fridge.html">My Fridge</a>
      <a class="nav-cta" href="/login.html">Login</a>`;
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

  const fields = {
    name: form.querySelector('[name=name]'),
    age: form.querySelector('[name=age]'),
    weight: form.querySelector('[name=weight]'),
    height: form.querySelector('[name=height]'),
    gender: form.querySelector('[name=gender]'),
    goal: form.querySelector('[name=goal]'),
  };
  const box = document.getElementById('calorieResult');

  // Prefill from session + server
  const cached = Auth.user();
  if (cached) {
    if (cached.name) fields.name.value = cached.name;
    if (cached.age) fields.age.value = cached.age;
    if (cached.weight) fields.weight.value = cached.weight;
    if (cached.height) fields.height.value = cached.height;
    if (cached.gender) fields.gender.value = cached.gender;
    if (cached.goal) fields.goal.value = cached.goal;
  }
  Auth.api('/api/profile').then(({ user }) => {
    Auth.updateUser(user);
    if (user.name) fields.name.value = user.name;
    if (user.age) fields.age.value = user.age;
    if (user.weight) fields.weight.value = user.weight;
    if (user.height) fields.height.value = user.height;
    if (user.gender) fields.gender.value = user.gender;
    if (user.goal) fields.goal.value = user.goal;
    updateCalc();
  }).catch(() => {});

  function updateCalc() {
    const c = clientCalc({
      weight: Number(fields.weight.value), height: Number(fields.height.value),
      age: Number(fields.age.value), gender: fields.gender.value, goal: fields.goal.value,
    });
    if (!c) { box.classList.remove('show'); return; }
    box.querySelector('#calNum').firstChild.textContent = c.target;
    box.querySelector('#calP').textContent = c.protein + 'g';
    box.querySelector('#calC').textContent = c.carbs + 'g';
    box.querySelector('#calF').textContent = c.fats + 'g';
    box.classList.add('show');
  }
  ['age', 'weight', 'height', 'gender', 'goal'].forEach(k => {
    fields[k].addEventListener('input', updateCalc);
    fields[k].addEventListener('change', updateCalc);
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    let ok = true;
    const age = Number(fields.age.value), weight = Number(fields.weight.value), height = Number(fields.height.value);
    if (!fields.name.value.trim()) { setError(fields.name, 'Name is required'); ok = false; } else markValid(fields.name);
    if (!age || age < 13 || age > 100) { setError(fields.age, 'Age must be between 13 and 100'); ok = false; } else markValid(fields.age);
    if (!weight || weight < 25 || weight > 400) { setError(fields.weight, 'Enter a valid weight in kg'); ok = false; } else markValid(fields.weight);
    if (!height || height < 90 || height > 250) { setError(fields.height, 'Enter a valid height in cm'); ok = false; } else markValid(fields.height);
    if (!ok) return;

    const btn = form.querySelector('button[type=submit]');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      const data = await Auth.api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name: fields.name.value.trim(), age, weight, height,
          gender: fields.gender.value, goal: fields.goal.value,
        }),
      });
      Auth.updateUser(data.user);
      toast('Profile saved! Your daily target: ' + data.calories.target + ' kcal', 'success');
      setTimeout(() => location.href = '/fridge.html', 900);
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
