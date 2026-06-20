/* pricing.js — billing toggle + Stripe Checkout subscribe actions */
'use strict';

(function () {
  const PLAN_NAMES = { free: 'Explorer', pro: 'Nutritionist', elite: 'Elite' };

  let annual = false;

  const switchEl = document.getElementById('billingSwitch');
  const lblMonthly = document.getElementById('lblMonthly');
  const lblAnnual = document.getElementById('lblAnnual');
  const amounts = document.querySelectorAll('.plan-price .amount');
  const billedLines = document.querySelectorAll('.plan-billed[data-annual-total]');

  function applyBilling() {
    amounts.forEach(el => { el.textContent = annual ? el.dataset.annual : el.dataset.monthly; });
    billedLines.forEach(el => {
      if (annual) { el.textContent = el.dataset.annualTotal; el.classList.add('show-annual'); }
      else { el.innerHTML = '&nbsp;'; el.classList.remove('show-annual'); }
    });
    switchEl.classList.toggle('annual', annual);
    switchEl.setAttribute('aria-checked', String(annual));
    lblMonthly.classList.toggle('active', !annual);
    lblAnnual.classList.toggle('active', annual);
  }

  function toggleBilling() { annual = !annual; applyBilling(); }

  if (switchEl) {
    switchEl.addEventListener('click', toggleBilling);
    lblMonthly.addEventListener('click', () => { if (annual) toggleBilling(); });
    lblAnnual.addEventListener('click', () => { if (!annual) toggleBilling(); });
  }

  // ── Free launch: payments are off, paid plans collect a waitlist ─────────
  // The "Get Started Free" button takes everyone straight into the app; the
  // Pro/Elite buttons open a waitlist modal instead of Stripe Checkout.

  // Get Started Free → register (or app if already signed in)
  document.querySelectorAll('[data-action="subscribe"]').forEach(btn => {
    btn.addEventListener('click', () => {
      // NOTE: auth.js declares `const Auth` (a lexical global, NOT a window
      // property), so check the bare `Auth` binding — never `window.Auth`.
      const authed = typeof Auth !== 'undefined' && Auth.isAuthed();
      location.href = authed ? '/fridge.html' : '/register.html';
    });
  });

  // ── Waitlist modal ──────────────────────────────────────────────────────
  let modal;
  function buildModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'waitlist-overlay';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="waitlist-modal" role="dialog" aria-modal="true" aria-labelledby="wlTitle">
        <button class="waitlist-close" aria-label="Close">&times;</button>
        <div class="waitlist-icon">🔔</div>
        <h3 id="wlTitle">Join the <span class="wl-plan">Pro</span> waitlist</h3>
        <p class="waitlist-sub">Everything is free during beta — no need to pay today. Leave your email and we'll let you know (with early-bird pricing) the moment paid plans launch.</p>
        <form class="waitlist-form" novalidate>
          <input type="email" class="waitlist-input" placeholder="you@email.com" autocomplete="email" required />
          <button type="submit" class="btn-primary waitlist-submit">Notify Me</button>
        </form>
        <p class="waitlist-msg" role="status"></p>
      </div>`;
    document.body.appendChild(modal);

    const close = () => closeModal();
    modal.querySelector('.waitlist-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });

    modal.querySelector('.waitlist-form').addEventListener('submit', onSubmit);
    return modal;
  }

  function openModal(plan) {
    buildModal();
    modal.dataset.plan = plan;
    modal.querySelector('.wl-plan').textContent = PLAN_NAMES[plan] || 'Pro';
    const msg = modal.querySelector('.waitlist-msg');
    msg.textContent = ''; msg.className = 'waitlist-msg';
    const input = modal.querySelector('.waitlist-input');
    // Pre-fill if signed in
    try { if (typeof Auth !== 'undefined' && Auth.user && Auth.user()) input.value = Auth.user().email || ''; } catch (e) {}
    const submit = modal.querySelector('.waitlist-submit');
    submit.disabled = false; submit.textContent = 'Notify Me';
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(() => input.focus(), 60);
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  async function onSubmit(e) {
    e.preventDefault();
    const input = modal.querySelector('.waitlist-input');
    const submit = modal.querySelector('.waitlist-submit');
    const msg = modal.querySelector('.waitlist-msg');
    const email = (input.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msg.textContent = 'Please enter a valid email address.';
      msg.className = 'waitlist-msg err';
      input.focus();
      return;
    }
    submit.disabled = true; submit.innerHTML = '<span class="spinner"></span> Joining…';
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, plan: modal.dataset.plan || 'pro' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not join the waitlist.');
      msg.textContent = data.message || "You're on the list!";
      msg.className = 'waitlist-msg ok';
      submit.textContent = '✓ Added';
      if (typeof toast === 'function') toast(data.message || "You're on the waitlist!", 'success', 4000);
      setTimeout(closeModal, 1600);
    } catch (err) {
      msg.textContent = err.message || 'Something went wrong. Please try again.';
      msg.className = 'waitlist-msg err';
      submit.disabled = false; submit.textContent = 'Notify Me';
    }
  }

  document.querySelectorAll('[data-action="waitlist"]').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.plan));
  });

  // ── Reflect the user's current plan ────────────────────────────────────
  async function markCurrentPlan() {
    if (!(typeof Auth !== 'undefined' && Auth.isAuthed())) return;
    try {
      const { plan } = await Auth.api('/api/subscription/status');
      const current = plan || 'free';
      document.querySelectorAll('.plan-card[data-plan]').forEach(card => {
        if (card.dataset.plan !== current) return;
        const btn = card.querySelector('[data-action="subscribe"]');
        if (!btn) return;
        btn.textContent = 'Current Plan';
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'default';
      });
    } catch { /* not logged in or status unavailable — ignore */ }
  }

  applyBilling();
  markCurrentPlan();
})();
