/* quit-smoking.js — Quit Smoking tracker */
'use strict';

const $ = id => document.getElementById(id);
const HR_CIRC = 2 * Math.PI * 40; // health ring r=40 → 251.3
let stats = null, tickTimer = null, prevBadges = {};

function buyWith(amount, cur) {
  if (amount >= 1000) return `🏝️ A holiday`;
  if (amount >= 500)  return `📱 A new phone`;
  if (amount >= 100)  return `✈️ A weekend trip`;
  if (amount >= 50)   return `👕 A new shirt`;
  if (amount >= 20)   return `🍽️ A restaurant meal`;
  if (amount >= 5)    return `☕ A coffee`;
  return `💧 Almost a coffee — keep going!`;
}

function renderCountdown() {
  if (!stats) return;
  const elapsed = Math.max(0, Date.now() - new Date(stats.quitDate).getTime());
  let s = Math.floor(elapsed / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);    s -= m * 60;
  const unit = (v, l) => `<div class="cu"><b>${v}</b><span>${l}</span></div>`;
  $('countdown').innerHTML = unit(d, 'Days') + unit(h, 'Hrs') + unit(m, 'Min') + unit(s, 'Sec');
}

function renderDashboard(st) {
  stats = st;
  $('setupView').style.display = 'none';
  $('dashView').style.display = '';

  $('quitSince').textContent = new Date(st.quitDate).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('moneyVal').textContent = st.currency + st.moneySaved.toLocaleString();
  $('moneyBuy').innerHTML = 'You could buy: <b>' + buyWith(st.moneySaved, st.currency) + '</b>';
  $('cigsVal').textContent = st.cigsNotSmoked.toLocaleString();
  $('lifeVal').textContent = st.lifeHours + ' hours';

  const hp = Math.min(100, st.healthScore);
  $('healthFill').style.strokeDashoffset = HR_CIRC * (1 - hp / 100);
  $('healthPct').textContent = hp + '%';

  // timeline
  $('timeline').innerHTML = st.milestones.map(m => {
    const cls = m.reached ? 'done' : (m.current ? 'current' : '');
    const date = new Date(m.reachedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const dateLabel = m.reached ? `Reached ${date}` : `Expected ${date}`;
    return `<div class="tl-item ${cls}">
      <div class="tl-dot">${m.reached ? '✓' : (m.current ? '◷' : '🔒')}</div>
      <div class="tl-title">${m.title}</div>
      <div class="tl-desc">${m.desc}</div>
      <div class="tl-date">${dateLabel}</div>
    </div>`;
  }).join('');

  // badges
  $('badges').innerHTML = st.badges.map(b => {
    const justUnlocked = b.unlocked && prevBadges[b.key] === false;
    return `<div class="badge ${b.unlocked ? 'unlocked' : 'locked'} ${justUnlocked ? 'just-unlocked' : ''}">
      <div class="ico">${b.icon}</div>
      <div class="bt">${b.title}</div>
      <div class="bd">${b.unlocked ? b.desc : new Date(b.unlockAt).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</div>
    </div>`;
  }).join('');
  st.badges.forEach(b => { prevBadges[b.key] = b.unlocked; });

  $('cravingCount').textContent = st.cravingsSurvived ? `${st.cravingsSurvived} craving${st.cravingsSurvived === 1 ? '' : 's'} beaten 💪` : '';

  if (st.motivation) { $('motiveCard').style.display = ''; $('motiveText').textContent = '"' + st.motivation + '"'; }

  renderCountdown();
  clearInterval(tickTimer);
  tickTimer = setInterval(renderCountdown, 1000);
}

function showSetup(st) {
  $('dashView').style.display = 'none';
  $('setupView').style.display = '';
  // prefill defaults
  if (st) {
    $('suQuit').value = new Date(st.quitDate).toISOString().slice(0, 16);
    $('suPerDay').value = st.cigsPerDay; $('suPerPack').value = st.cigsPerPack;
    $('suPrice').value = st.pricePerPack; $('suCurrency').value = st.currency; $('suBrand').value = st.brand || '';
    $('suMotive').value = st.motivation || '';
  } else {
    $('suQuit').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
}

// ── Craving overlay ──
let cravingTimer = null, breathTimer = null;
function openCraving() {
  $('cravingOverlay').classList.add('open');
  let left = 300;
  const tEl = $('cravingTimer');
  const render = () => { tEl.textContent = `${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`; };
  render();
  clearInterval(cravingTimer);
  cravingTimer = setInterval(() => { left--; render(); if (left <= 0) { clearInterval(cravingTimer); tEl.textContent = "You made it! ✨"; } }, 1000);

  const phases = ['Breathe in…', 'Hold…', 'Breathe out…', 'Hold…'];
  let p = 0; const bEl = $('breath');
  bEl.textContent = phases[0];
  clearInterval(breathTimer);
  breathTimer = setInterval(() => { p = (p + 1) % phases.length; bEl.textContent = phases[p]; }, 2000);
}
function closeCraving() {
  $('cravingOverlay').classList.remove('open');
  clearInterval(cravingTimer); clearInterval(breathTimer);
}

// ── Generic AI chat widget ──
function initChat({ endpoint, icon, greeting, storeKey }) {
  let history = [], busy = false;
  try { history = JSON.parse(localStorage.getItem(storeKey)) || []; } catch {}
  const fab = $('chatFab'), panel = $('chatPanel');
  const now = () => new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  const fmt = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/_(.+?)_/g,'<i>$1</i>').replace(/\n/g,'<br>');
  function render() {
    $('chatBody').innerHTML = history.map(m => `
      <div class="chat-msg ${m.role === 'user' ? 'user' : 'ai'}">
        ${m.role === 'user' ? '' : `<div class="chat-avatar">${icon}</div>`}
        <div><div class="chat-bubble">${fmt(m.content)}</div><div class="chat-time">${m.time || ''}</div></div>
      </div>`).join('');
    $('chatBody').scrollTop = $('chatBody').scrollHeight;
  }
  async function send() {
    if (busy) return;
    const inp = $('chatInput'); const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    history.push({ role: 'user', content: text, time: now() }); render();
    const typing = document.createElement('div');
    typing.className = 'chat-msg ai';
    typing.innerHTML = `<div class="chat-avatar">${icon}</div><div class="chat-typing"><span></span><span></span><span></span></div>`;
    $('chatBody').appendChild(typing); $('chatBody').scrollTop = $('chatBody').scrollHeight;
    busy = true; $('chatSend').disabled = true;
    try {
      const hist = history.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const data = await Auth.api(endpoint, { method: 'POST', body: JSON.stringify({ message: text, history: hist }) });
      history.push({ role: 'assistant', content: data.reply, time: now() });
    } catch {
      history.push({ role: 'assistant', content: 'Sorry, I had trouble responding. Please try again.', time: now() });
    } finally {
      typing.remove(); busy = false; $('chatSend').disabled = false;
      localStorage.setItem(storeKey, JSON.stringify(history.slice(-30))); render();
    }
  }
  fab.addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) $('chatInput').focus(); });
  $('chatClose').addEventListener('click', () => panel.classList.remove('open'));
  $('chatClear').addEventListener('click', () => { history = []; localStorage.removeItem(storeKey); seed(); render(); });
  $('chatSend').addEventListener('click', send);
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('chatSuggest').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('chatInput').value = b.textContent; send(); }));
  function seed() { if (!history.length) history.push({ role: 'assistant', content: greeting, time: now() }); }
  seed(); render();
}

async function load() {
  try {
    const data = await Auth.api('/api/smoking/stats');
    if (data.setup) renderDashboard(data); else showSetup(null);
  } catch (err) { toast(err.message, 'error'); }
}

document.addEventListener('DOMContentLoaded', () => {
  renderNav();
  if (!requireAuth()) return;

  $('suSave').addEventListener('click', async () => {
    const btn = $('suSave');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    const body = {
      quitDate: $('suQuit').value, cigsPerDay: $('suPerDay').value,
      cigsPerPack: $('suPerPack').value, pricePerPack: $('suPrice').value,
      currency: $('suCurrency').value, brand: $('suBrand').value, motivation: $('suMotive').value,
    };
    try {
      const data = await Auth.api('/api/smoking/setup', { method: 'POST', body: JSON.stringify(body) });
      prevBadges = {};
      renderDashboard(data);
      toast("Your quit journey starts now. You've got this! 💪", 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });

  $('editSetup').addEventListener('click', () => showSetup(stats));
  $('panicBtn').addEventListener('click', openCraving);
  $('cravingClose').addEventListener('click', closeCraving);
  $('survivedBtn').addEventListener('click', async () => {
    const btn = $('survivedBtn');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const { cravingsSurvived } = await Auth.api('/api/smoking/craving', { method: 'POST', body: JSON.stringify({}) });
      closeCraving();
      toast(`🏆 ${cravingsSurvived} craving${cravingsSurvived === 1 ? '' : 's'} beaten! That urge is gone and you won.`, 'success');
      load();
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });

  initChat({
    endpoint: '/api/smoking/chat', icon: '🫁', storeKey: 'nb_quit_chat',
    greeting: "Hi, I'm your Quit Coach. 🫁 Whatever you're feeling — a craving, a wobble, or a win — I'm here. How are you doing right now?",
  });

  load();
});
