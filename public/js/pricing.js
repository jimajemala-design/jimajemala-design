/* pricing.js — billing toggle + (stubbed) subscribe actions
   Stripe checkout is wired up in a later step; for now paid plans show a
   "coming soon" toast and the selected plan/billing is logged for dev. */
'use strict';

(function () {
  const PLAN_NAMES = { free: 'Explorer', pro: 'Nutritionist', premium: 'Elite' };

  let annual = false;

  const switchEl = document.getElementById('billingSwitch');
  const lblMonthly = document.getElementById('lblMonthly');
  const lblAnnual = document.getElementById('lblAnnual');
  const amounts = document.querySelectorAll('.plan-price .amount');
  const billedLines = document.querySelectorAll('.plan-billed[data-annual-total]');

  function applyBilling() {
    // Prices
    amounts.forEach(el => {
      el.textContent = annual ? el.dataset.annual : el.dataset.monthly;
    });
    // Annual "billed $X/yr" sublines (paid plans only)
    billedLines.forEach(el => {
      if (annual) { el.textContent = el.dataset.annualTotal; el.classList.add('show-annual'); }
      else { el.innerHTML = '&nbsp;'; el.classList.remove('show-annual'); }
    });
    // Toggle UI state
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

  // Subscribe / Get Started buttons
  document.querySelectorAll('[data-action="subscribe"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const plan = btn.dataset.plan;

      if (plan === 'free') {
        // Free plan: send to sign-up (or the app if already logged in)
        location.href = (window.Auth && Auth.isAuthed()) ? '/fridge.html' : '/register.html';
        return;
      }

      // Paid plan — Stripe checkout placeholder
      const billing = annual ? 'annual' : 'monthly';
      console.log('[checkout] selected plan:', plan, 'billing:', billing); // wired to Stripe later
      const name = PLAN_NAMES[plan] || plan;
      if (typeof toast === 'function') {
        toast(`💳 ${name} (${billing}) checkout is coming soon — payments launch shortly!`, 'success', 4000);
      } else {
        alert(`${name} (${billing}) checkout coming soon!`);
      }
    });
  });

  applyBilling();
})();
