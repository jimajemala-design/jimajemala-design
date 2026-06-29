/* snap.js — NutriFell "Snap & Analyze" food-photo feature.
   Camera/photo button → Gemini Vision analysis → results sheet with macros,
   a health score, benefits/drawbacks, and "Log to Today" / "Share to Feed".
   Premium-gated (server-enforced; the client gate is just for nicer UX).
   Depends on the shared Auth / Toast helpers from auth.js. */
'use strict';

const Snap = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  // Last analysis + the captured image (data URL) for Log / Share actions.
  let current = null;
  let currentImage = null;

  // ── sheet open/close ───────────────────────────────────────────────────
  function openSheet() {
    document.getElementById('snapOverlay').classList.add('open');
    document.getElementById('snapSheet').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    document.getElementById('snapOverlay').classList.remove('open');
    document.getElementById('snapSheet').classList.remove('open');
    document.body.style.overflow = '';
  }

  // Entry point wired to every [data-open-snap] control. This NEVER navigates
  // away from the feed: it just opens the photo picker. Auth + premium are
  // enforced server-side and any gate is surfaced inside the results sheet.
  function start() {
    if (!window.Auth || !Auth.isAuthed()) {
      toast('Log in to use Snap & Analyze.', 'info', 3000);
      return;
    }
    document.getElementById('snapInput').click();
  }

  // ── downscale a picked image to a compact JPEG data URL ──────────────────
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function downscale(dataUrl, maxDim = 1024, quality = 0.85) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        try { resolve(canvas.toDataURL('image/jpeg', quality)); }
        catch { resolve(dataUrl); } // tainted/edge case — fall back to original
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function onFilePicked(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('Please choose a photo of food.', 'error'); return; }
    if (file.size > 25 * 1024 * 1024) { toast('That image is too large (max 25MB).', 'error'); return; }
    openSheet();
    renderLoading();
    try {
      const raw = await fileToDataURL(file);
      currentImage = await downscale(raw);
      const analysis = await Auth.api('/api/analyze-food', {
        method: 'POST',
        body: JSON.stringify({ image: currentImage }),
      });
      current = analysis;
      renderResult(analysis);
    } catch (err) {
      const msg = err.message || 'Could not analyze that photo.';
      // Premium gate (server 403) → in-sheet upsell, NOT a redirect.
      if (/premium/i.test(msg)) renderUpsell(msg);
      else renderError(msg);
    }
  }

  // ── render states ────────────────────────────────────────────────────────
  function renderLoading() {
    document.getElementById('snapBody').innerHTML = `
      <div class="snap-loading">
        <div class="snap-spinner"></div>
        <p>Analyzing your food…</p>
        <small>Our AI nutritionist is reading the photo</small>
      </div>`;
  }
  function renderError(msg) {
    document.getElementById('snapBody').innerHTML = `
      <div class="snap-error">
        <span class="snap-error-ico">😕</span>
        <p>${esc(msg)}</p>
        <button class="btn-post snap-retry" type="button">Try another photo</button>
      </div>`;
    document.querySelector('.snap-retry').addEventListener('click', () => {
      closeSheet(); start();
    });
  }
  // Premium-required state — a user-initiated link to plans (no auto-redirect).
  function renderUpsell(msg) {
    document.getElementById('snapBody').innerHTML = `
      <div class="snap-error">
        <span class="snap-error-ico">✨</span>
        <p>${esc(msg)}</p>
        <a class="btn-post" href="/pricing.html" style="text-decoration:none;text-align:center">See plans</a>
      </div>`;
  }

  function scoreClass(s) { return s >= 7 ? 'good' : s >= 4 ? 'mid' : 'bad'; }

  function renderResult(a) {
    const sc = scoreClass(a.healthScore);
    const benefits = (a.benefits || []).map(b =>
      `<li class="snap-pro"><span class="snap-ic">✓</span>${esc(b)}</li>`).join('');
    const drawbacks = (a.drawbacks || []).map(d =>
      `<li class="snap-con"><span class="snap-ic">⚠</span>${esc(d)}</li>`).join('');

    document.getElementById('snapBody').innerHTML = `
      <div class="snap-result">
        ${currentImage ? `<div class="snap-photo" style="background-image:url('${currentImage}')"></div>` : ''}
        <div class="snap-head">
          <div>
            <h2 class="snap-food">${esc(a.foodName)}</h2>
            <p class="snap-serving">${esc(a.serving)}</p>
          </div>
          <div class="snap-score snap-score-${sc}">
            <b>${a.healthScore}</b><span>/10</span>
            <small>Health</small>
          </div>
        </div>

        <div class="snap-macros">
          <div class="snap-pill cal"><b>${a.calories}</b><span>kcal</span></div>
          <div class="snap-pill protein"><b>${a.protein}g</b><span>Protein</span></div>
          <div class="snap-pill carbs"><b>${a.carbs}g</b><span>Carbs</span></div>
          <div class="snap-pill fat"><b>${a.fat}g</b><span>Fat</span></div>
          <div class="snap-pill fiber"><b>${a.fiber}g</b><span>Fiber</span></div>
        </div>

        ${a.verdict ? `<div class="snap-verdict">“${esc(a.verdict)}”</div>` : ''}

        ${benefits ? `<div class="snap-section"><h4>Benefits</h4><ul class="snap-list">${benefits}</ul></div>` : ''}
        ${drawbacks ? `<div class="snap-section"><h4>Watch out for</h4><ul class="snap-list">${drawbacks}</ul></div>` : ''}

        <div class="snap-note">⚕️ AI estimate — not medical or precise dietary advice.</div>

        <div class="snap-actions">
          <button class="btn-post" id="snapLog" type="button">＋ Log to Today</button>
          <button class="btn-ghost" id="snapShare" type="button">↗ Share to Feed</button>
        </div>
      </div>`;

    document.getElementById('snapLog').addEventListener('click', logToToday);
    document.getElementById('snapShare').addEventListener('click', shareToFeed);
  }

  // ── actions ────────────────────────────────────────────────────────────
  async function logToToday() {
    if (!current) return;
    const btn = document.getElementById('snapLog');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Logging…';
    try {
      await Auth.api('/api/logs', {
        method: 'POST',
        body: JSON.stringify({
          name: current.foodName,
          calories: current.calories,
          protein: current.protein,
          carbs: current.carbs,
          fat: current.fat,
        }),
      });
      toast(`Logged ${current.calories} kcal to today 🎉`, 'success');
      btn.textContent = '✓ Logged';
    } catch (err) {
      toast(err.message || 'Could not log this meal.', 'error');
      btn.disabled = false; btn.textContent = label;
    }
  }

  // Convert the captured data URL → Blob so we can post it as a real photo.
  function dataURLtoBlob(dataUrl) {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function shareToFeed() {
    if (!current) return;
    const btn = document.getElementById('snapShare');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sharing…';
    const a = current;
    const caption = `📸 Snap & Analyze: ${a.foodName} (${a.serving})\n`
      + `🔥 ${a.calories} kcal · P ${a.protein}g · C ${a.carbs}g · F ${a.fat}g · Fiber ${a.fiber}g\n`
      + `💚 Health score: ${a.healthScore}/10`
      + (a.verdict ? `\n${a.verdict}` : '')
      + `\n#SnapAndAnalyze #NutriFell`;
    try {
      const fd = new FormData();
      if (currentImage) {
        fd.append('type', 'photo');
        fd.append('media', dataURLtoBlob(currentImage), 'snap.jpg');
      } else {
        fd.append('type', 'text');
      }
      fd.append('caption', caption);
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + Auth.token() },
        body: fd,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || 'Could not share to the feed.');
      toast('Shared to the feed! 🎉', 'success');
      btn.textContent = '✓ Shared';
      closeSheet();
      // If the feed module is on this page, refresh it so the new post shows.
      if (window.Feed && typeof Feed.init === 'function' && document.getElementById('feedList')) {
        const banner = document.getElementById('feedNewBanner');
        if (banner) banner.click();
      }
    } catch (err) {
      toast(err.message || 'Could not share to the feed.', 'error');
      btn.disabled = false; btn.textContent = label;
    }
  }

  // ── init ─────────────────────────────────────────────────────────────────
  function init() {
    document.querySelectorAll('[data-open-snap]').forEach(b => b.addEventListener('click', start));
    const input = document.getElementById('snapInput');
    if (input) input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.value = ''; // allow re-picking the same file
      onFilePicked(f);
    });
    document.getElementById('snapClose')?.addEventListener('click', closeSheet);
    document.getElementById('snapOverlay')?.addEventListener('click', closeSheet);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
  }

  return { init, start };
})();

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('snapSheet')) Snap.init();
});
