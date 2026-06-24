/* water.js — Water Tracker page */
'use strict';

const RING_CIRC = 2 * Math.PI * 104; // r=104 → 653.45

function tipFor(pct) {
  if (pct < 25)  return { cls: 'danger', emoji: '⚠️', text: "You're dehydrated! Drink some water now." };
  if (pct < 50)  return { cls: 'low',    emoji: '💧', text: "Keep going! You're a quarter of the way there." };
  if (pct < 75)  return { cls: 'mid',    emoji: '🌊', text: 'Great progress! You\'re half way done.' };
  if (pct < 100) return { cls: 'mid',    emoji: '🎯', text: 'Almost there! Just one more glass.' };
  return { cls: 'high', emoji: '🏆', text: 'Goal achieved! Stay hydrated. 🎉' };
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderSummary(s) {
  const pct = Math.min(100, s.percent);
  document.getElementById('ringFill').style.strokeDashoffset = RING_CIRC * (1 - pct / 100);
  document.getElementById('ringNow').innerHTML = `${s.consumedMl}<span style="font-size:18px;color:var(--text-3)">ml</span>`;
  document.getElementById('ringGoal').textContent = `/ ${s.goalMl} ml · ${s.goalGlasses} glasses`;
  document.getElementById('ringPct').textContent = s.percent + '%';

  const rem = s.glassesRemaining;
  document.getElementById('remaining').innerHTML = s.percent >= 100
    ? `<b>Goal reached</b> — ${s.consumedL} L today`
    : `<b>${rem}</b> glass${rem === 1 ? '' : 'es'} remaining (${(s.goalL - s.consumedL).toFixed(2)} L to go)`;

  const tip = tipFor(s.percent);
  const tipEl = document.getElementById('tip');
  tipEl.className = 'water-tip ' + tip.cls;
  tipEl.querySelector('.emoji').textContent = tip.emoji;
  document.getElementById('tipText').textContent = tip.text;

  if (!document.activeElement || document.activeElement.id !== 'goalInput') {
    document.getElementById('goalInput').value = s.goalMl;
  }
  document.getElementById('goalAuto').style.display = s.autoGoal ? 'none' : '';

  // today's log
  const log = document.getElementById('todayLog');
  if (!s.entries.length) {
    log.innerHTML = '<div class="feat-empty">No water logged yet today.</div>';
  } else {
    log.innerHTML = s.entries.slice().reverse().map(e => `
      <div class="water-log-item">
        <span class="ico">${e.ml >= 1000 ? '🪣' : '💧'}</span>
        <span class="amt">${e.ml} ml</span>
        <span class="time">${fmtTime(e.at)}</span>
        <button class="del" data-id="${e.id}" title="Remove">✕</button>
      </div>`).join('');
    log.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => removeEntry(b.dataset.id)));
  }
}

async function loadWeek() {
  const { days } = await Auth.api('/api/water/history');
  const max = Math.max(...days.map(d => Math.max(d.totalMl, d.goalMl)), 1);
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const todayStr = new Date().toISOString().slice(0, 10);
  document.getElementById('weekStrip').innerHTML = days.map(d => {
    const h = Math.round((d.totalMl / max) * 100);
    const dn = names[new Date(d.date + 'T00:00').getDay()];
    return `<div class="water-day ${d.date === todayStr ? 'today' : ''}">
      <div class="bar-track"><div class="bar-fill ${d.onTrack ? 'ok' : 'under'}" style="height:${h}%"></div></div>
      <span class="val">${(d.totalMl/1000).toFixed(1)}L</span>
      <span class="lbl">${dn}</span>
    </div>`;
  }).join('');
}

function splash() {
  const w = document.getElementById('ringWrap');
  w.classList.remove('splash'); void w.offsetWidth; w.classList.add('splash');
}

async function addWater(ml) {
  try {
    const { summary } = await Auth.api('/api/water/add', { method: 'POST', body: JSON.stringify({ ml }) });
    splash();
    renderSummary(summary);
    loadWeek();
    if (summary.percent >= 100) toast('🏆 Daily goal reached — great job!', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function removeEntry(id) {
  try {
    const { summary } = await Auth.api('/api/water/' + id, { method: 'DELETE' });
    renderSummary(summary); loadWeek();
  } catch (err) { toast(err.message, 'error'); }
}

document.addEventListener('DOMContentLoaded', async () => {
  renderNav();
  if (!requireAuth()) return;

  document.querySelectorAll('.water-add-btn').forEach(b =>
    b.addEventListener('click', () => addWater(Number(b.dataset.ml))));

  const custom = document.getElementById('customMl');
  const doCustom = () => {
    const ml = Number(custom.value);
    if (ml > 0) { addWater(ml); custom.value = ''; }
  };
  document.getElementById('customAdd').addEventListener('click', doCustom);
  custom.addEventListener('keydown', e => { if (e.key === 'Enter') doCustom(); });

  document.getElementById('goalSave').addEventListener('click', async () => {
    const btn = document.getElementById('goalSave');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    const goalMl = Number(document.getElementById('goalInput').value);
    try { renderSummary(await Auth.api('/api/water/goal', { method: 'POST', body: JSON.stringify({ goalMl }) })); toast('Goal updated', 'success', 1800); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });
  document.getElementById('goalAuto').addEventListener('click', async () => {
    const btn = document.getElementById('goalAuto');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try { renderSummary(await Auth.api('/api/water/goal', { method: 'POST', body: JSON.stringify({ goalMl: null }) })); toast('Using auto goal from your weight', 'success', 1800); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });

  try {
    renderSummary(await Auth.api('/api/water/today'));
    await loadWeek();
  } catch (err) { toast(err.message, 'error'); }
});
