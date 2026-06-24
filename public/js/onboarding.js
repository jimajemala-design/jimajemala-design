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
        <h1 class="nf-welcome-title">Finally — nutrition that makes sense.</h1>
        <p class="nf-welcome-sub">Explore 74 whole foods in stunning 3D. Track calories, water, and more. Your body, your plan.</p>
        <div class="nf-welcome-actions">
          <button class="nf-btn-primary" id="nfWelcomeStart">Get Started Free</button>
          <button class="nf-btn-ghost" id="nfWelcomeExplore">Just Exploring</button>
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
  // Each step carries both English and Georgian text; `render()` picks the
  // active language via window.i18n so the tour is fully bilingual.
  const STEPS = [
    { sel: '#gallery', sidebar: false,
      title: 'Food Database',
      titleKa: 'საკვების ბაზა',
      body: '74 whole foods with real-time 3D models, full micronutrient profiles, and honest health benefits and drawbacks.',
      bodyKa: '74 მთელი საკვები 3D მოდელებით, სრული მიკრო-საკვები ნივთიერებებით და გულწრფელი სასარგებლო თვისებებითა და ნაკლოვანებებით.' },
    { sel: '.nb-sidebar-nav a[href="/fridge.html"]', sidebar: true,
      title: 'My Fridge',
      titleKa: 'ჩემი მაცივარი',
      body: 'Tell NutriFell what is in your fridge. The AI builds a full meal plan tuned to your exact calorie target.',
      bodyKa: 'შეიყვანე რა გაქვს მაცივარში. AI შექმნის კვების გეგმას შენი ზუსტი კალორიული მიზნის გათვალისწინებით.' },
    { sel: '.nb-sidebar-nav a[href="/water.html"]', sidebar: true,
      title: 'Water & Wellness',
      titleKa: 'წყალი და ჯანმრთელობა',
      body: 'Log your water intake and track your quit-smoking journey — milestones, money saved, and a CBT quit coach.',
      bodyKa: 'დაიწყე წყლის ჩაწერა და თვალყური ადევნე მოწევის დატოვებას — ეტაპები, დაზოგილი ფული და CBT ქოჩი.' },
    { sel: '.nb-sidebar-nav a[href="/recipes.html"]', sidebar: true,
      title: 'Community Recipes',
      titleKa: 'საზოგადოების რეცეპტები',
      body: 'Browse community recipes with ratings, reactions, and comments. Upload yours and get instant AI nutrition analysis.',
      bodyKa: 'დაათვალიერე საზოგადოების რეცეპტები შეფასებებით. გაუგზავნე შენი — მიიღე AI კვებითი ანალიზი.' },
    { sel: '.nb-sidebar-nav a[href="/profile-view.html"]', sidebar: true,
      title: 'Your Profile',
      titleKa: 'შენი პროფილი',
      body: 'Your daily calorie target, macro split, and streak badges — plus NutriAI, your personal nutrition advisor, always ready.',
      bodyKa: 'შენი დღიური კალორიული მიზანი, ბადჟები და NutriAI — შენი პირადი კვების კონსულტანტი, ყოველთვის მზად.' },
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
    const ka = window.i18n && i18n.lang === 'ka';
    els.count.textContent = ka ? `ნაბიჯი ${idx + 1} / ${STEPS.length}` : `Step ${idx + 1} of ${STEPS.length}`;
    els.title.textContent = (ka && step.titleKa) ? step.titleKa : step.title;
    els.body.textContent = (ka && step.bodyKa) ? step.bodyKa : step.body;
    els.next.textContent = idx === STEPS.length - 1 ? (ka ? 'დასრულება' : 'Finish') : (ka ? 'შემდეგი' : 'Next');
    els.skip.textContent = ka ? 'გამოტოვება' : 'Skip tour';
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
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    // Capture the root BEFORE nulling `els`. The delayed remove() must not read
    // a nulled `els` — that threw a TypeError, the remove() never ran, and the
    // full-screen z-index:6000 overlay stayed on top blocking every click.
    const root = els && els.root;
    els = null;
    if (root) {
      root.classList.remove('in');
      setTimeout(() => root.remove(), 300);
    }
    // Belt-and-braces: never leave the page scroll-locked, pointer-events
    // disabled, or any stray tour DOM around.
    document.body.style.overflow = '';
    document.body.style.pointerEvents = '';
    document.querySelectorAll('#nfTour, .nf-tour').forEach((el) => {
      if (el !== root) el.remove();
    });
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
    // Safety: never leave the page scroll-locked or an overlay stuck around.
    document.body.style.overflow = '';
    document.body.style.pointerEvents = '';
    document.querySelectorAll('#nfWelcome, #nfTour, .nf-welcome, .nf-tour, .nf-tour-mask')
      .forEach((el) => el.remove());

    // Hard guard: this module only ever runs on the homepage. (It isn't even
    // loaded elsewhere, but guard anyway so it can never block another page.)
    const isHomepage = location.pathname === '/' || /(^|\/)index\.html$/.test(location.pathname);
    if (!isHomepage) return;

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
