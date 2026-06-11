/* app.js — NutriBase Georgia UI Controller */
'use strict';

const App = (() => {
  let foods = [];
  let sceneReady = false;

  const $ = id => document.getElementById(id);
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // ── Helpers ──────────────────────────────────────────────────────────

  function countUp(el, target, duration = 1600) {
    const start = performance.now();
    // If the element has child nodes (e.g. unit span), only update the first text node
    const hasChildren = el.childElementCount > 0;
    if (hasChildren && !el.firstChild) return;
    const tick = now => {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      const val = Math.round(target * ease);
      if (hasChildren) {
        // Update leading text node only — preserves child spans (unit labels)
        if (el.firstChild.nodeType === Node.TEXT_NODE) {
          el.firstChild.textContent = val;
        }
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

  // ── Navbar scroll effect ─────────────────────────────────────────────
  function initNavbar() {
    const nav = document.querySelector('.navbar');
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 20);
    }, { passive: true });
  }

  // ── Hero count-up (intersection observer) ────────────────────────────
  function initHeroStats() {
    const stats = document.querySelectorAll('.hero-stat-num');
    if (!stats.length) return;

    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const target = parseInt(el.dataset.count, 10);
          if (target) countUp(el, target, 1800);
          io.unobserve(el);
        }
      });
    }, { threshold: 0.5 });

    stats.forEach(el => io.observe(el));
  }

  // ── Fetch foods ───────────────────────────────────────────────────────
  async function fetchFoods() {
    const res = await fetch('/api/foods');
    foods = await res.json();
  }

  // ── Render bento grid ─────────────────────────────────────────────────
  function renderGrid() {
    const grid = $('foodGrid');
    grid.innerHTML = foods.map((f, i) => {
      const num = String(i + 1).padStart(2, '0');
      const isFeature = i === 0;
      return `
        <div class="bento-item${isFeature ? ' featured' : ''}"
             role="listitem button"
             tabindex="0"
             data-id="${f.id}"
             aria-label="Explore ${f.name} — ${f.calories} kcal">
          <div class="card-num">
            <span class="card-num-text">${num}</span>
            <div class="card-arrow" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 8L8 2M8 2H4M8 2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
          </div>
          ${isFeature ? '<span class="card-accent"></span>' : ''}
          <span class="card-emoji" aria-hidden="true">${f.emoji}</span>
          <div class="card-name">${f.name}</div>
          <span class="card-cal">${f.calories} kcal</span>
          <p class="card-desc">${f.description}</p>
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

      // Hover: inline transform beats the running card-float animation
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-10px)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = '';
      });
    });
  }

  // ── Open detail view ──────────────────────────────────────────────────
  function openDetail(id) {
    const food = foods.find(f => f.id === id);
    if (!food) return;

    transition(() => {
      $('gridView').style.display = 'none';
      $('detailSection').removeAttribute('style');

      // Update breadcrumb
      const bc = $('bcCurrent');
      if (bc) bc.textContent = food.name;

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

  // ── Render macro chips ────────────────────────────────────────────────
  function renderMacros(food) {
    const n = food.nutrition;
    const macros = [
      { label: 'Protein', value: n.protein || 0, unit: 'g', max: 40, cls: 'protein' },
      { label: 'Carbs',   value: n.carbs   || 0, unit: 'g', max: 60, cls: 'carbs'   },
      { label: 'Fat',     value: n.fat     || 0, unit: 'g', max: 20, cls: 'fat'      },
    ];

    $('quickStats').innerHTML = macros.map(m => {
      const pct = Math.min(100, Math.round((m.value / m.max) * 100));
      return `
        <div class="macro-chip ${m.cls}">
          <span class="macro-chip-value"><!-- leading text node for count-up -->0<span class="macro-chip-unit">${m.unit}</span></span>
          <span class="macro-chip-label">${m.label}</span>
          <div class="macro-bar">
            <div class="macro-bar-fill ${m.cls}" data-target="${pct}"></div>
          </div>
        </div>`;
    }).join('');

    // Stamp target values into the leading text nodes
    $('quickStats').querySelectorAll('.macro-chip-value').forEach((el, i) => {
      // Replace HTML comment node with a real text node containing "0"
      el.childNodes[0].textContent = '0';
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

  // ── Render info panel ─────────────────────────────────────────────────
  function renderInfo(food) {
    const n = food.nutrition;
    const maxCal = 300;
    const calPct = Math.min(100, Math.round((food.calories / maxCal) * 100));

    const labels = {
      protein: 'Protein', carbs: 'Carbs', fat: 'Fat', fiber: 'Fiber',
      sugar: 'Sugar', vitaminC: 'Vit C', potassium: 'Potassium',
      vitaminB12: 'Vit B12', sodium: 'Sodium', omega3: 'Omega-3',
      vitaminD: 'Vit D', vitaminE: 'Vit E', magnesium: 'Mg'
    };
    const units = {
      protein: 'g', carbs: 'g', fat: 'g', fiber: 'g', sugar: 'g',
      vitaminC: 'mg', potassium: 'mg', vitaminB12: 'µg', sodium: 'mg',
      omega3: 'g', vitaminD: 'IU', vitaminE: 'mg', magnesium: 'mg'
    };
    const maxVals = {
      protein: 40, carbs: 60, fat: 20, fiber: 25, sugar: 30,
      vitaminC: 90, potassium: 700, vitaminB12: 2.4, sodium: 150,
      omega3: 3, vitaminD: 600, vitaminE: 15, magnesium: 200
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
      <li class="bl-item">
        <span class="bl-icon plus" aria-hidden="true">✓</span>
        <span>${b}</span>
      </li>`).join('');

    const drawbacks = food.drawbacks.map(d => `
      <li class="bl-item">
        <span class="bl-icon minus" aria-hidden="true">✕</span>
        <span>${d}</span>
      </li>`).join('');

    $('infoPanel').innerHTML = `
      <div class="food-header">
        <div class="food-header-left">
          <div class="food-tag">
            <span class="food-tag-dot"></span>
            Superfood Profile
          </div>
          <h2 class="food-name">${food.name}</h2>
          <span class="food-serving">Per serving: ${food.serving}</span>
        </div>
        <div class="calorie-box">
          <span class="calorie-num" data-target="${food.calories}">${food.calories}</span>
          <span class="calorie-label">kcal</span>
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
        <p class="section-label-sm"><span class="accent">Micronutrients</span></p>
        <div class="nutrient-grid">${microCards}</div>
        <div class="panel-divider"></div>
      ` : ''}

      <p class="section-label-sm"><span class="accent">Health Benefits</span></p>
      <ul class="bl-list">${benefits}</ul>

      <div class="panel-divider"></div>

      <p class="section-label-sm"><span>Considerations</span></p>
      <ul class="bl-list">${drawbacks}</ul>
    `;

    // Trigger bar animations after render
    requestAnimationFrame(() => {
      $('infoPanel').querySelectorAll('.energy-bar-fill, .nutrient-bar-fill').forEach(el => {
        animateBar(el, el.dataset.target);
      });

      // Count-up calorie number
      const calEl = $('infoPanel').querySelector('.calorie-num');
      if (calEl) countUp(calEl, parseInt(calEl.dataset.target, 10), 1000);
    });

    // Stagger nutrient item entrance
    const items = $('infoPanel').querySelectorAll('.nutrient-item, .bl-item');
    items.forEach((el, i) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      setTimeout(() => {
        el.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      }, i * 40 + 200);
    });
  }

  // ── Show grid ─────────────────────────────────────────────────────────
  function showGrid() {
    transition(() => {
      $('detailSection').style.display = 'none';
      $('gridView').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────
  async function init() {
    initNavbar();
    initHeroStats();

    try {
      await fetchFoods();
    } catch (err) {
      $('foodGrid').innerHTML = `
        <div class="bento-loading" style="color:var(--text-muted)">
          <span>Failed to load foods. Please refresh.</span>
        </div>`;
      return;
    }

    renderGrid();
    $('backBtn').addEventListener('click', showGrid);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
