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

  // ── Subscribe / Get Started ────────────────────────────────────────────
  async function startCheckout(btn, plan) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Redirecting…';
    try {
      const billing = annual ? 'annual' : 'monthly';
      const { sessionUrl } = await Auth.api('/api/checkout/create-session', {
        method: 'POST',
        body: JSON.stringify({ plan, billing }),
      });
      if (sessionUrl) { window.location.href = sessionUrl; return; }
      throw new Error('Could not start checkout');
    } catch (err) {
      if (typeof toast === 'function') toast(err.message || 'Checkout failed', 'error', 4000);
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  document.querySelectorAll('[data-action="subscribe"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const plan = btn.dataset.plan;
      const authed = window.Auth && Auth.isAuthed();

      if (plan === 'free') {
        location.href = authed ? '/fridge.html' : '/register.html';
        return;
      }
      if (!authed) {
        if (typeof toast === 'function') toast('Please log in to subscribe', 'info', 2600);
        setTimeout(() => { location.href = '/login.html'; }, 900);
        return;
      }
      startCheckout(btn, plan);
    });
  });

  // ── Reflect the user's current plan ────────────────────────────────────
  async function markCurrentPlan() {
    if (!(window.Auth && Auth.isAuthed())) return;
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
