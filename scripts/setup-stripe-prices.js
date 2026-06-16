/* setup-stripe-prices.js — idempotently create NutriFell subscription products
   and prices in Stripe, then print the price IDs as .env-style lines.

   Run:  node scripts/setup-stripe-prices.js
   Re-running is safe: prices are looked up by lookup_key and reused. */
'use strict';
require('dotenv').config();

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !key.startsWith('sk_')) {
  console.error('Missing/invalid STRIPE_SECRET_KEY in .env');
  process.exit(1);
}
const stripe = require('stripe')(key);

// plan → { product name, lookup_key, amount (cents), interval }
const PLANS = [
  { env: 'STRIPE_PRICE_PRO_MONTHLY',   product: 'NutriFell Pro',   lookup: 'nutrifell_pro_monthly',   amount: 900,   interval: 'month' },
  { env: 'STRIPE_PRICE_PRO_ANNUAL',    product: 'NutriFell Pro',   lookup: 'nutrifell_pro_annual',    amount: 8400,  interval: 'year'  },
  { env: 'STRIPE_PRICE_ELITE_MONTHLY', product: 'NutriFell Elite', lookup: 'nutrifell_elite_monthly', amount: 1900,  interval: 'month' },
  { env: 'STRIPE_PRICE_ELITE_ANNUAL',  product: 'NutriFell Elite', lookup: 'nutrifell_elite_annual',  amount: 18000, interval: 'year'  },
];

const productCache = {}; // name -> id (created/looked up once per run)

async function findOrCreateProduct(name) {
  if (productCache[name]) return productCache[name];
  // Reuse a product already created by a previous price (matched via lookup below);
  // otherwise create a fresh one.
  const product = await stripe.products.create({ name, metadata: { app: 'nutrifell' } });
  productCache[name] = product.id;
  return product.id;
}

async function ensurePrice(plan) {
  const existing = await stripe.prices.list({ lookup_keys: [plan.lookup], expand: ['data.product'], limit: 1 });
  if (existing.data.length) {
    const p = existing.data[0];
    if (p.product && p.product.name) productCache[plan.product] = p.product.id;
    return p.id;
  }
  const productId = await findOrCreateProduct(plan.product);
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: plan.amount,
    currency: 'usd',
    recurring: { interval: plan.interval },
    lookup_key: plan.lookup,
    nickname: plan.lookup,
  });
  return price.id;
}

(async () => {
  const out = [];
  for (const plan of PLANS) {
    const id = await ensurePrice(plan);
    out.push(`${plan.env}=${id}`);
    console.error(`✓ ${plan.lookup} → ${id}`);
  }
  console.log('\n----- ENV LINES -----');
  out.forEach(l => console.log(l));
})().catch(err => { console.error('Stripe setup failed:', err.message); process.exit(1); });
