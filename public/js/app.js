/* app.js — NutriBase Georgia UI Controller · AAA edition */
'use strict';

const App = (() => {
  let foods = [];
  let sceneReady = false;

  const $ = id => document.getElementById(id);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Food categories (drives card badges) ─────────────────────────────
  const CATEGORIES = {
    apple: 'fruit', banana: 'fruit', blueberry: 'fruit', lemon: 'fruit',
    tomato: 'fruit', kiwi: 'fruit', avocado: 'fruit',
    chicken: 'protein', fish: 'protein', egg: 'protein', greekyogurt: 'protein',
    tuna: 'protein', turkey: 'protein', cottagecheese: 'protein', beef: 'protein',
    pork: 'protein', shrimp: 'protein', whey: 'protein', edamame: 'protein',
    sardines: 'protein', tempeh: 'protein', lamb: 'protein', cannedsalmon: 'protein',
    tofu: 'protein', octopus: 'protein', duck: 'protein', hempseeds: 'protein',
    pumpkinseeds: 'protein', beefliver: 'protein', mussels: 'protein', spirulina: 'protein',
    broccoli: 'vegetable', spinach: 'vegetable', carrot: 'vegetable',
    sweetpotato: 'vegetable', garlic: 'vegetable', ginger: 'vegetable',
    corn: 'vegetable',
    almond: 'nut', walnut: 'nut',
    oats: 'grain', quinoa: 'grain', whiterice: 'grain', brownrice: 'grain',
    wholewheatbread: 'grain', pasta: 'grain', corntortilla: 'grain',
    buckwheat: 'grain', millet: 'grain', barley: 'grain',
    lentils: 'legume', blackbeans: 'legume', chickpeas: 'legume',
    darkchocolate: 'treat',
  };
  const CATEGORY_LABELS = {
    fruit: 'FRUIT', protein: 'PROTEIN', vegetable: 'VEGETABLE',
    nut: 'NUT', grain: 'GRAIN', treat: 'TREAT', legume: 'LEGUME',
  };

  // ── Custom cursor ─────────────────────────────────────────────────────
  function initCursor() {
    const dot = $('cursorDot');
    if (!dot || window.matchMedia('(hover: none)').matches) return;

    let tx = 0, ty = 0, cx = 0, cy = 0, visible = false;
    window.addEventListener('mousemove', e => {
      tx = e.clientX; ty = e.clientY;
      if (!visible) { dot.style.opacity = '1'; visible = true; }
    }, { passive: true });

    (function loop() {
      cx += (tx - cx) * 0.25;
      cy += (ty - cy) * 0.25;
      dot.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      requestAnimationFrame(loop);
    })();

    // Grow over interactive elements (event delegation)
    document.addEventListener('mouseover', e => {
      if (e.target.closest('[data-hover], .bento-item, button, a')) dot.classList.add('grow');
    });
    document.addEventListener('mouseout', e => {
      if (e.target.closest('[data-hover], .bento-item, button, a')) dot.classList.remove('grow');
    });
  }

  // ── Hero particles ────────────────────────────────────────────────────
  function initParticles() {
    const host = $('heroParticles');
    if (!host || reducedMotion) return;
    let html = '';
    for (let i = 0; i < 24; i++) {
      const size = 2 + Math.random() * 3;
      const left = Math.random() * 100;
      const dur = 14 + Math.random() * 18;
      const del = -Math.random() * dur;
      html += `<span class="hp" style="width:${size}px;height:${size}px;left:${left}%;bottom:-10px;animation-duration:${dur}s;animation-delay:${del}s"></span>`;
    }
    host.innerHTML = html;
  }

  // ── Infinite food ticker ──────────────────────────────────────────────
  function initTicker() {
    const track = $('tickerTrack');
    if (!track || !foods.length) return;
    const items = foods.map(f =>
      `<span class="ticker-item">${f.emoji} ${f.name}</span>`).join('');
    track.innerHTML = items + items; // duplicate for seamless -50% loop
  }

  // ── Count-up (preserves trailing unit spans) ──────────────────────────
  function countUp(el, target, duration = 1600) {
    const start = performance.now();
    const hasChildren = el.childElementCount > 0;
    if (hasChildren && !el.firstChild) return;
    const decimals = target % 1 !== 0 ? 1 : 0;
    const tick = now => {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      const val = (target * ease).toFixed(decimals);
      if (hasChildren) {
        if (el.firstChild.nodeType === Node.TEXT_NODE) el.firstChild.textContent = val;
      } else {
        el.textContent = val;
      }
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function animateBar(el, targetPct) {
    requestAnimationFrame(() => { el.style.width = targetPct + '%'; });
  }

  async function transition(fn) {
    const overlay = $('pageOverlay');
    overlay.classList.add('active');
    await delay(300);
    fn();
    await delay(40);
    overlay.classList.remove('active');
  }

  // ── Navbar scroll state ───────────────────────────────────────────────
  function initNavbar() {
    const nav = $('navbar');
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 20);
    }, { passive: true });
  }

  // ── Hero stat count-up on scroll into view ────────────────────────────
  function initHeroStats() {
    const stats = document.querySelectorAll('.hero-stat-num');
    if (!stats.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const target = parseInt(entry.target.dataset.count, 10);
          if (target) countUp(entry.target, target, 1800);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });
    stats.forEach(el => io.observe(el));
  }

  // ── Data ──────────────────────────────────────────────────────────────
  async function fetchFoods() {
    const res = await fetch('/api/foods');
    foods = await res.json();
  }

  // ── Bento grid ────────────────────────────────────────────────────────
  function renderGrid() {
    const grid = $('foodGrid');
    grid.innerHTML = foods.map((f, i) => {
      const num = String(i + 1).padStart(2, '0');
      const cat = CATEGORIES[f.id] || 'fruit';
      const n = f.nutrition;
      return `
        <div class="bento-item"
             style="--glow:${hexToGlow(f.color)}"
             role="listitem button"
             tabindex="0"
             data-id="${f.id}"
             aria-label="Explore ${f.name} — ${f.calories} kcal">
          <div class="card-top">
            <span class="card-num">${num}</span>
            <span class="card-badge ${cat}">${CATEGORY_LABELS[cat]}</span>
          </div>
          <span class="card-emoji" aria-hidden="true">${f.emoji}</span>
          <div class="card-name">${f.name}</div>
          <span class="card-cal">${f.calories} KCAL <span class="card-cal-unit">/ 100g</span></span>
          <div class="card-macros">
            <span>P <b>${n.protein}g</b></span>
            <span>C <b>${n.carbs}g</b></span>
            <span>F <b>${n.fat}g</b></span>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.bento-item').forEach(card => {
      card.addEventListener('click', () => openDetail(card.dataset.id));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail(card.dataset.id);
        }
      });

      // Magnetic hover — card leans toward the cursor
      if (!reducedMotion) {
        card.addEventListener('mousemove', e => {
          const r = card.getBoundingClientRect();
          const dx = (e.clientX - r.left - r.width / 2) / r.width;
          const dy = (e.clientY - r.top - r.height / 2) / r.height;
          card.style.transform = `translate(${dx * 8}px, ${dy * 8 - 5}px)`;
        });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; });
      }
    });
  }

  function hexToGlow(hex) {
    // food color → low-alpha rgba for the hover glow
    const h = (hex || '#22c55e').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},0.16)`;
  }

  // ── Detail view ───────────────────────────────────────────────────────
  function openDetail(id) {
    const food = foods.find(f => f.id === id);
    if (!food) return;

    transition(() => {
      $('gridView').style.display = 'none';
      $('detailSection').removeAttribute('style');

      const bc = $('bcCurrent');
      if (bc) bc.textContent = food.name.toUpperCase();

      renderMacros(food);
      renderInfo(food);

      if (!sceneReady) {
        FoodScene.init($('threeCanvas'));
        sceneReady = true;
      }
      FoodScene.loadFood(food.id);
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }

  function renderMacros(food) {
    const n = food.nutrition;
    const macros = [
      { label: 'Protein', value: n.protein || 0, unit: 'g', max: 40, cls: 'protein' },
      { label: 'Carbs',   value: n.carbs   || 0, unit: 'g', max: 60, cls: 'carbs'   },
      { label: 'Fat',     value: n.fat     || 0, unit: 'g', max: 20, cls: 'fat'     },
    ];

    $('quickStats').innerHTML = macros.map(m => {
      const pct = Math.min(100, Math.round((m.value / m.max) * 100));
      return `
        <div class="macro-chip ${m.cls}">
          <span class="macro-chip-value">0<span class="macro-chip-unit">${m.unit}</span></span>
          <span class="macro-chip-label">${m.label}</span>
          <div class="macro-bar">
            <div class="macro-bar-fill ${m.cls}" data-target="${pct}"></div>
          </div>
        </div>`;
    }).join('');

    $('quickStats').querySelectorAll('.macro-chip-value').forEach((el, i) => {
      el.dataset.target = macros[i].value;
    });

    requestAnimationFrame(() => {
      $('quickStats').querySelectorAll('.macro-bar-fill').forEach(el => {
        animateBar(el, el.dataset.target);
      });
      $('quickStats').querySelectorAll('.macro-chip-value').forEach(el => {
        countUp(el, parseFloat(el.dataset.target), 1200);
      });
    });
  }

  function renderInfo(food) {
    const n = food.nutrition;
    const maxCal = 300;
    const calPct = Math.min(100, Math.round((food.calories / maxCal) * 100));

    const labels = {
      protein: 'Protein', carbs: 'Carbs', fat: 'Fat', fiber: 'Fiber',
      sugar: 'Sugar', vitaminC: 'Vit C', potassium: 'Potassium',
      vitaminB12: 'Vit B12', sodium: 'Sodium', omega3: 'Omega-3',
      vitaminD: 'Vit D', vitaminE: 'Vit E', magnesium: 'Mg',
      selenium: 'Selenium', choline: 'Choline', vitaminA: 'Vit A', vitaminB6: 'Vit B6',
      vitaminK: 'Vit K', folate: 'Folate', manganese: 'Manganese',
      copper: 'Copper', zinc: 'Zinc', biotin: 'Biotin',
      riboflavin: 'Riboflavin', calcium: 'Calcium', phosphorus: 'Phosphorus',
      lycopene: 'Lycopene', allicin: 'Allicin', flavonoids: 'Flavonoids',
      gingerol: 'Gingerol', betaGlucan: 'Beta-Glucan',
      thiamine: 'Thiamine', niacin: 'Niacin', iron: 'Iron',
      iodine: 'Iodine', leucine: 'Leucine', gla: 'GLA'
    };
    const units = {
      protein: 'g', carbs: 'g', fat: 'g', fiber: 'g', sugar: 'g',
      vitaminC: 'mg', potassium: 'mg', vitaminB12: 'µg', sodium: 'mg',
      omega3: 'g', vitaminD: 'IU', vitaminE: 'mg', magnesium: 'mg',
      selenium: 'µg', choline: 'mg', vitaminA: 'µg', vitaminB6: 'mg',
      vitaminK: 'µg', folate: 'µg', manganese: 'mg',
      copper: 'mg', zinc: 'mg', biotin: 'µg',
      riboflavin: 'mg', calcium: 'mg', phosphorus: 'mg',
      lycopene: 'mg', allicin: 'mg', flavonoids: 'mg',
      gingerol: 'mg', betaGlucan: 'g',
      thiamine: 'mg', niacin: 'mg', iron: 'mg',
      iodine: 'µg', leucine: 'g', gla: 'g'
    };
    const maxVals = {
      protein: 40, carbs: 60, fat: 20, fiber: 25, sugar: 30,
      vitaminC: 90, potassium: 700, vitaminB12: 2.4, sodium: 150,
      omega3: 3, vitaminD: 600, vitaminE: 15, magnesium: 200,
      selenium: 55, choline: 550, vitaminA: 900, vitaminB6: 1.7,
      vitaminK: 120, folate: 400, manganese: 2.3,
      copper: 0.9, zinc: 11, biotin: 30,
      riboflavin: 1.3, calcium: 1000, phosphorus: 700,
      lycopene: 15, allicin: 10, flavonoids: 200,
      gingerol: 50, betaGlucan: 6,
      thiamine: 1.2, niacin: 16, iron: 18,
      iodine: 150, leucine: 10, gla: 2
    };

    const macroKeys = new Set(['protein', 'carbs', 'fat']);
    const microEntries = Object.entries(n).filter(([k]) => !macroKeys.has(k));

    const microCards = microEntries.map(([key, val]) => {
      const pct = maxVals[key] ? Math.min(100, Math.round((val / maxVals[key]) * 100)) : 0;
      return `
        <div class="nutrient-item">
          <span class="nutrient-label">${labels[key] || key}</span>
          <span class="nutrient-value" data-target="${val}">
            ${val}<span class="nutrient-unit">${units[key] || ''}</span>
          </span>
          <div class="nutrient-bar">
            <div class="nutrient-bar-fill" data-target="${pct}"></div>
          </div>
        </div>`;
    }).join('');

    const benefits = food.benefits.map(b => `
      <li class="bl-item benefit">
        <span class="bl-icon plus" aria-hidden="true">→</span>
        <span>${b}</span>
      </li>`).join('');

    const drawbacks = food.drawbacks.map(d => `
      <li class="bl-item drawback">
        <span class="bl-icon minus" aria-hidden="true">!</span>
        <span>${d}</span>
      </li>`).join('');

    const cat = CATEGORIES[food.id] || 'fruit';

    $('infoPanel').innerHTML = `
      <div class="food-header">
        <div class="food-header-left">
          <div class="food-tag">
            <span class="food-tag-dot"></span>
            ${CATEGORY_LABELS[cat]} · SPECIMEN PROFILE
          </div>
          <h2 class="food-name">${food.name}</h2>
          <span class="food-serving">VALUES PER ${food.serving}</span>
        </div>
        <div class="calorie-box">
          <span class="calorie-num" data-target="${food.calories}">${food.calories}</span>
          <span class="calorie-label">KCAL</span>
        </div>
      </div>

      <div class="energy-bar-wrap">
        <div class="energy-bar-header">
          <span class="energy-bar-label">Energy density</span>
          <span class="energy-bar-max">vs ${maxCal} kcal</span>
        </div>
        <div class="energy-bar-track">
          <div class="energy-bar-fill" data-target="${calPct}"></div>
        </div>
      </div>

      <div class="panel-divider"></div>

      ${microEntries.length ? `
        <p class="section-label-sm"><span class="accent">// Micronutrients</span></p>
        <div class="nutrient-grid">${microCards}</div>
        <div class="panel-divider"></div>
      ` : ''}

      <p class="section-label-sm"><span class="accent">// Health Benefits</span></p>
      <ul class="bl-list">${benefits}</ul>

      <div class="panel-divider"></div>

      <p class="section-label-sm">// Considerations</p>
      <ul class="bl-list">${drawbacks}</ul>
    `;

    requestAnimationFrame(() => {
      $('infoPanel').querySelectorAll('.energy-bar-fill, .nutrient-bar-fill').forEach(el => {
        animateBar(el, el.dataset.target);
      });
      const calEl = $('infoPanel').querySelector('.calorie-num');
      if (calEl) countUp(calEl, parseInt(calEl.dataset.target, 10), 1100);
    });

    // Stagger entrance of items
    const items = $('infoPanel').querySelectorAll('.nutrient-item, .bl-item');
    items.forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      setTimeout(() => {
        el.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      }, i * 35 + 180);
    });
  }

  function showGrid() {
    transition(() => {
      $('detailSection').style.display = 'none';
      $('gridView').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────
  async function init() {
    initCursor();
    initNavbar();
    initHeroStats();
    initParticles();

    try {
      await fetchFoods();
    } catch (err) {
      $('foodGrid').innerHTML = `
        <div class="bento-loading">
          <span>CONNECTION FAILED — PLEASE REFRESH</span>
        </div>`;
      return;
    }

    initTicker();
    renderGrid();
    $('backBtn').addEventListener('click', showGrid);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
