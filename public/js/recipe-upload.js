/* recipe-upload.js — multi-step recipe submission */
'use strict';

const $ = id => document.getElementById(id);
const STEP_LABELS = ['Basics', 'Photos', 'Ingredients', 'Instructions', 'Opinion'];
let step = 0;
let photos = [];          // { file, url }
let foodDb = [];          // {id,name,emoji,calories}
const UNITS = ['g', 'ml', 'cups', 'tbsp', 'tsp', 'pcs', 'oz'];

function renderSteps() {
  $('upSteps').innerHTML = STEP_LABELS.map((l, i) =>
    `<div class="up-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}"><span class="dot">${i < step ? '✓' : i + 1}</span>${l}</div>`).join('');
  document.querySelectorAll('.up-pane').forEach(p => p.classList.toggle('active', Number(p.dataset.step) === step));
  $('prevBtn').style.visibility = step === 0 ? 'hidden' : 'visible';
  $('nextBtn').textContent = step === STEP_LABELS.length - 1 ? '✓ Publish Recipe' : 'Next →';
}

// ── Photos ──
function renderPreviews() {
  $('previews').innerHTML = photos.map((p, i) => `
    <div class="photo-prev">
      <img src="${p.url}" alt="" />
      <button class="rm" data-i="${i}">✕</button>
      ${i === 0 ? '<div class="cover-tag">COVER</div>' : ''}
    </div>`).join('');
  $('previews').querySelectorAll('.rm').forEach(b => b.addEventListener('click', () => {
    URL.revokeObjectURL(photos[Number(b.dataset.i)].url);
    photos.splice(Number(b.dataset.i), 1); renderPreviews();
  }));
}
function addFiles(files) {
  for (const f of files) {
    if (photos.length >= 5) { toast('Maximum 5 photos', 'error'); break; }
    if (!/^image\/(jpe?g|png|webp)$/.test(f.type)) { toast('Only JPG, PNG or WebP', 'error'); continue; }
    if (f.size > 5 * 1024 * 1024) { toast(`${f.name} is over 5MB`, 'error'); continue; }
    photos.push({ file: f, url: URL.createObjectURL(f) });
  }
  renderPreviews();
}

// ── Ingredients ──
function addIngredientRow(data) {
  const wrap = document.createElement('div');
  wrap.className = 'dyn-row';
  wrap.style.position = 'relative';
  wrap.innerHTML = `
    <div style="flex:1;position:relative">
      <input class="form-input ing-name" placeholder="Ingredient" autocomplete="off" />
      <div class="food-suggest"></div>
    </div>
    <input class="form-input sm ing-qty" type="number" min="0" placeholder="Qty" />
    <select class="form-select ing-unit" style="flex:0 0 90px">${UNITS.map(u => `<option>${u}</option>`).join('')}</select>
    <button class="rm-btn" title="Remove">✕</button>`;
  $('ingList').appendChild(wrap);

  const nameInp = wrap.querySelector('.ing-name');
  const sug = wrap.querySelector('.food-suggest');
  nameInp.dataset.foodId = '';
  nameInp.addEventListener('input', () => {
    nameInp.dataset.foodId = '';
    const q = nameInp.value.toLowerCase().trim();
    if (!q) { sug.classList.remove('show'); return; }
    const matches = foodDb.filter(f => f.name.toLowerCase().includes(q)).slice(0, 6);
    sug.innerHTML = matches.map(m => `<div class="fs-item" data-id="${m.id}" data-name="${m.name}">${m.emoji} ${m.name} <span style="margin-left:auto;color:var(--text-3)">${m.calories}kcal</span></div>`).join('');
    sug.classList.toggle('show', matches.length > 0);
    sug.querySelectorAll('.fs-item').forEach(it => it.addEventListener('click', () => {
      nameInp.value = it.dataset.name; nameInp.dataset.foodId = it.dataset.id;
      sug.classList.remove('show'); updateNutri();
    }));
  });
  nameInp.addEventListener('blur', () => setTimeout(() => sug.classList.remove('show'), 180));
  wrap.querySelector('.ing-qty').addEventListener('input', updateNutri);
  wrap.querySelector('.ing-unit').addEventListener('change', updateNutri);
  wrap.querySelector('.rm-btn').addEventListener('click', () => { wrap.remove(); updateNutri(); });

  if (data) { nameInp.value = data.name || ''; nameInp.dataset.foodId = data.foodId || ''; }
}

// grams estimate per unit for nutrition preview
const UNIT_G = { g: 1, ml: 1, cups: 240, tbsp: 15, tsp: 5, pcs: 100, oz: 28 };
function collectIngredients() {
  return [...$('ingList').querySelectorAll('.dyn-row')].map(r => {
    const name = r.querySelector('.ing-name').value.trim();
    const foodId = r.querySelector('.ing-name').dataset.foodId || '';
    const qty = Number(r.querySelector('.ing-qty').value) || 0;
    const unit = r.querySelector('.ing-unit').value;
    return { name, foodId, quantity: qty ? String(qty) : '', unit, grams: qty * (UNIT_G[unit] || 1) };
  }).filter(i => i.name);
}
function updateNutri() {
  const ings = collectIngredients();
  const servings = Math.max(1, Number($('fServings').value) || 1);
  const tot = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  let matched = 0;
  ings.forEach(i => {
    const food = foodDb.find(f => f.id === i.foodId);
    if (!food || !i.grams) return;
    matched++;
    const factor = i.grams / 100;
    // foodDb from /meta only has calories; fetch full macros lazily is overkill — show calories live
    tot.calories += (food.calories || 0) * factor;
  });
  $('nutriPreview').innerHTML = matched
    ? `<b>${Math.round(tot.calories / servings)}</b> kcal/serving · <span>${matched} ingredient${matched===1?'':'s'} matched to the food database</span>`
    : '<span>Match ingredients to the food database to preview calories →</span>';
}

// ── Instructions ──
function addStepRow(text) {
  const wrap = document.createElement('div');
  wrap.className = 'dyn-row';
  wrap.innerHTML = `<textarea class="form-input step-text" placeholder="Describe this step…">${text || ''}</textarea><button class="rm-btn" title="Remove">✕</button>`;
  wrap.querySelector('.rm-btn').addEventListener('click', () => wrap.remove());
  $('stepList').appendChild(wrap);
}
function collectSteps() {
  return [...$('stepList').querySelectorAll('.step-text')].map(t => ({ text: t.value.trim() })).filter(s => s.text);
}

function validateStep() {
  if (step === 0 && !$('fName').value.trim()) { toast('Please enter a recipe name', 'error'); return false; }
  if (step === 2 && collectIngredients().length === 0) { toast('Add at least one ingredient', 'error'); return false; }
  if (step === 3 && collectSteps().length === 0) { toast('Add at least one instruction step', 'error'); return false; }
  return true;
}

async function submit() {
  const fd = new FormData();
  fd.append('name', $('fName').value.trim());
  fd.append('category', $('fCategory').value);
  fd.append('difficulty', $('fDifficulty').value);
  fd.append('description', $('fDesc').value.trim());
  fd.append('prepTime', $('fPrep').value || 0);
  fd.append('cookTime', $('fCook').value || 0);
  fd.append('servings', $('fServings').value || 1);
  fd.append('opinion', $('fOpinion').value.trim());
  fd.append('tips', $('fTips').value.trim());
  fd.append('tags', $('fTags').value.trim());
  fd.append('ingredients', JSON.stringify(collectIngredients()));
  fd.append('steps', JSON.stringify(collectSteps()));
  photos.forEach(p => fd.append('photos', p.file));

  const btn = $('nextBtn'); const lbl = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Publishing…';
  try {
    // multipart — don't set Content-Type (browser sets boundary); send token manually
    const res = await fetch('/api/recipes', { method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token() }, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast('Recipe published! 🎉', 'success');
    setTimeout(() => location.href = '/recipe-detail.html?id=' + data.id, 800);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false; btn.innerHTML = lbl;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  renderNav();
  if (!requireAuth()) return;

  try { const meta = await Auth.api('/api/recipes/meta'); foodDb = meta.foods; } catch {}

  renderSteps();
  addIngredientRow(); addStepRow();

  $('nextBtn').addEventListener('click', () => {
    if (!validateStep()) return;
    if (step < STEP_LABELS.length - 1) { step++; renderSteps(); }
    else submit();
  });
  $('prevBtn').addEventListener('click', () => { if (step > 0) { step--; renderSteps(); } });
  $('addIng').addEventListener('click', () => addIngredientRow());
  $('addStep').addEventListener('click', () => addStepRow());
  $('fServings').addEventListener('input', updateNutri);

  // photo dropzone
  const dz = $('dropzone'), fi = $('fileInput');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { addFiles(fi.files); fi.value = ''; });
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files) addFiles(e.dataTransfer.files); });
});
