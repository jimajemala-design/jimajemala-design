/* onboarding.js — first-visit welcome overlay + 5-step spotlight feature tour.
   Loads only on the homepage. Persists completion in localStorage. */
'use strict';

const Onboarding = (() => {
  const K_WELCOME = 'nf_onboarded_v1';   // welcome overlay seen
  const K_TOUR = 'nf_tour_done_v1';      // feature tour finished/skipped
  const K_PENDING = 'nf_tour_pending';   // set after registration → run tour next homepage visit
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isNarrow = () => window.innerWidth <= 640;
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  // ── Welcome overlay ────────────────────────────────────────────────────
  function showWelcome() {
    if (document.getElementById('nfWelcome')) return;
    const el = document.createElement('div');
    el.id = 'nfWelcome';
    el.className = 'nf-welcome';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Welcome to NutriFell');
    el.innerHTML = `
      <button class="nf-welcome-skip" id="nfWelcomeSkip">Skip</button>
      <div class="nf-welcome-card">
        <div class="nf-welcome-logo" aria-hidden="true">
          <span class="nf-wl-ring"></span>
          <span class="nf-wl-mark">Nutri<span>Fell</span></span>
        </div>
        <h1 class="nf-welcome-title">Welcome to NutriFell</h1>
        <p class="nf-welcome-sub">Your personal nutrition assistant</p>
        <div class="nf-welcome-actions">
          <button class="nf-btn-primary" id="nfWelcomeStart">Get Started</button>
          <button class="nf-btn-ghost" id="nfWelcomeExplore">Explore First</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => el.classList.add('in'));

    const close = () => {
      set(K_WELCOME, '1');
      el.classList.remove('in');
      document.body.style.overflow = '';
      setTimeout(() => el.remove(), 350);
    };
    document.getElementById('nfWelcomeStart').addEventListener('click', () => {
      close(); set(K_PENDING, '1'); // run the tour when they come back post-signup
      location.href = '/register.html';
    });
    document.getElementById('nfWelcomeExplore').addEventListener('click', () => {
      close();
      // Give the page a beat, then walk them through it.
      setTimeout(() => startTour(), 450);
    });
    document.getElementById('nfWelcomeSkip').addEventListener('click', close);
  }

  // ── Feature tour steps (anchored to real, on-page elements) ────────────
  const STEPS = [
    { sel: '#gallery', sidebar: false, title: 'Food Database',
      body: 'Browse 74 whole foods with real-time 3D models and complete nutrient profiles.' },
    { sel: '.nb-sidebar-nav a[href="/fridge.html"]', sidebar: true, title: 'My Fridge',
      body: 'Add foods you have at home. NutriAI uses them to build personalised meal plans.' },
    { sel: '.nb-sidebar-nav a[href="/water.html"]', sidebar: true, title: 'Water & Wellness',
      body: 'Track your hydration and your quit-smoking journey, all in one place.' },
    { sel: '.nb-sidebar-nav a[href="/recipes.html"]', sidebar: true, title: 'Community',
      body: 'Share and discover healthy recipes, rate them, and save your favourites.' },
    { sel: '.nb-sidebar-nav a[href="/profile-view.html"]', sidebar: true, title: 'Your Profile',
      body: 'See your stats, streaks and badges. Ask NutriAI anything about nutrition anytime.' },
  ];

  let idx = 0, els = null, onResize = null;

  function buildTourDOM() {
    const root = document.createElement('div');
    root.id = 'nfTour';
    root.className = 'nf-tour';
    root.innerHTML = `
      <div class="nf-tour-mask" id="nfTourBox"></div>
      <div class="nf-tour-pop" id="nfTourPop" role="dialog" aria-modal="true" aria-live="polite">
        <div class="nf-tour-step" id="nfTourCount"></div>
        <h3 class="nf-tour-title" id="nfTourTitle"></h3>
        <p class="nf-tour-body" id="nfTourBody"></p>
        <div class="nf-tour-dots" id="nfTourDots"></div>
        <div class="nf-tour-actions">
          <button class="nf-tour-skip" id="nfTourSkip">Skip tour</button>
          <button class="nf-btn-primary nf-tour-next" id="nfTourNext">Next</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    return {
      root,
      box: document.getElementById('nfTourBox'),
      pop: document.getElementById('nfTourPop'),
      count: document.getElementById('nfTourCount'),
      title: document.getElementById('nfTourTitle'),
      body: document.getElementById('nfTourBody'),
      dots: document.getElementById('nfTourDots'),
      next: document.getElementById('nfTourNext'),
      skip: document.getElementById('nfTourSkip'),
    };
  }

  function sidebarOpen(open) {
    const overlay = document.getElementById('nbSidebarOverlay');
    if (!overlay) return;
    overlay.classList.toggle('open', open);
  }

  function position() {
    const step = STEPS[idx];
    let target = document.querySelector(step.sel);
    // If a sidebar target is missing (logged-out nav variant), skip ahead.
    if (!target) { return next(); }

    const r = target.getBoundingClientRect();
    const pad = 8;
    const top = Math.max(6, r.top - pad), left = Math.max(6, r.left - pad);
    const w = r.width + pad * 2, h = r.height + pad * 2;
    Object.assign(els.box.style, {
      top: top + 'px', left: left + 'px', width: w + 'px', height: h + 'px',
    });

    // Place the tooltip: below wide page targets, to the right of sidebar links,
    // and pinned to the bottom on narrow screens.
    els.pop.classList.remove('place-below', 'place-right', 'place-bottom');
    const popW = els.pop.offsetWidth, popH = els.pop.offsetHeight;
    if (isNarrow()) {
      els.pop.classList.add('place-bottom');
      els.pop.style.left = ''; els.pop.style.top = '';
    } else if (step.sidebar) {
      els.pop.classList.add('place-right');
      els.pop.style.left = (r.right + 16) + 'px';
      els.pop.style.top = Math.min(window.innerHeight - popH - 12, Math.max(12, r.top)) + 'px';
    } else {
      els.pop.classList.add('place-below');
      const desiredLeft = Math.min(window.innerWidth - popW - 12, Math.max(12, r.left));
      els.pop.style.left = desiredLeft + 'px';
      els.pop.style.top = Math.min(window.innerHeight - popH - 12, r.bottom + 16) + 'px';
    }
  }

  function render() {
    const step = STEPS[idx];
    if (step.sidebar) sidebarOpen(true); else sidebarOpen(false);
    els.count.textContent = `Step ${idx + 1} of ${STEPS.length}`;
    els.title.textContent = step.title;
    els.body.textContent = step.body;
    els.next.textContent = idx === STEPS.length - 1 ? 'Finish' : 'Next';
    els.dots.innerHTML = STEPS.map((_, i) =>
      `<span class="nf-tour-dot ${i === idx ? 'active' : ''} ${i < idx ? 'done' : ''}"></span>`).join('');
    // Wait a frame so any just-opened sidebar has laid out before measuring.
    requestAnimationFrame(() => requestAnimationFrame(position));
  }

  function next() {
    if (idx >= STEPS.length - 1) return finish();
    idx++; render();
  }

  function finish() {
    set(K_TOUR, '1');
    set(K_PENDING, '');
    sidebarOpen(false);
    if (els) { els.root.classList.remove('in'); setTimeout(() => els.root.remove(), 300); }
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    els = null;
    if (typeof toast === 'function') toast("You're all set. Enjoy exploring NutriFell!", 'success');
  }

  function startTour() {
    if (els) return;
    idx = 0;
    els = buildTourDOM();
    requestAnimationFrame(() => els.root.classList.add('in'));
    els.next.addEventListener('click', next);
    els.skip.addEventListener('click', finish);
    onResize = () => { if (els) position(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    document.addEventListener('keydown', function esc(e) {
      if (!els) { document.removeEventListener('keydown', esc); return; }
      if (e.key === 'Escape') finish();
      if (e.key === 'Enter') next();
    });
    render();
  }

  // ── Entry point ────────────────────────────────────────────────────────
  function init() {
    // Only on the homepage.
    if (location.pathname !== '/' && !/index\.html$/.test(location.pathname)) return;
    const authed = window.Auth && Auth.isAuthed && Auth.isAuthed();

    // Tour queued after registration → run it once the gallery exists.
    if (get(K_PENDING) === '1' && get(K_TOUR) !== '1') {
      waitForGallery(() => startTour());
      return;
    }
    // Brand-new, logged-out visitor → welcome overlay.
    if (!authed && get(K_WELCOME) !== '1') {
      setTimeout(showWelcome, 700);
    }
  }

  // The gallery renders after /api/foods resolves; poll briefly for it.
  function waitForGallery(cb) {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (document.querySelector('#gallery') && document.querySelector('.bento-item')) {
        clearInterval(t); cb();
      } else if (tries > 40) { clearInterval(t); cb(); }
    }, 150);
  }

  return { init, startTour, showWelcome };
})();

window.Onboarding = Onboarding;
document.addEventListener('DOMContentLoaded', () => {
  // Defer slightly so auth.js has built the nav/sidebar first.
  setTimeout(() => Onboarding.init(), 200);
});
