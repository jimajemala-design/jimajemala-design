# NutriFell — Progress & Roadmap

> Last updated: 2026-06-16
> Formerly "NutriBase Georgia" — rebranded to **NutriFell** on 2026-06-16.

An interactive 3D nutrition explorer + installable PWA. Browse 74 foods with
complete nutritional profiles rendered in real-time 3D, plus personalized
calorie planning, a virtual fridge, AI meal planning, and a NutriAI chat
assistant.

## Tech stack

- **Backend:** Node.js + Express 4 (`server.js`, single file)
- **Auth:** JWT (7-day expiry) + bcrypt password hashing
- **Storage:** File-based JSON in `data/` (no database) — `users`, `fridges`,
  `mealplans`, `logs`. Auto-created on boot; gitignored.
- **AI:** Google Gemini (`gemini-2.5-flash`) with a rule-based fallback when no
  API key is configured.
- **Frontend:** Vanilla JS, no framework. Three.js r128 (GLTFLoader + Draco +
  UnrealBloom) for the 3D viewer.
- **PWA:** manifest + service worker + full icon set + iOS/Android install prompts.
- **Video:** `remotion/` — Remotion compositions for promo/social assets.

## What's built

### Backend (`server.js`)
- **Food database** — large hardcoded `foods` array (74 items) with calories,
  micronutrient profiles, benefits, drawbacks, descriptions. `GET /api/foods`,
  `GET /api/foods/:id`.
- **Auth** — `POST /api/register`, `POST /api/login` (bcrypt + JWT).
- **Calorie engine** (`calcCalories`) — Mifflin-St Jeor BMR → TDEE via activity
  multiplier; target-weight/timeline planning with safe-pace clamps (max 1kg/wk
  loss, 0.5kg/wk gain), min-calorie floors, weekly weight-prediction curve, and
  a 30/40/30 macro split.
- **Profile** — `GET/PUT /api/profile`, `GET /api/profile/stats` (BMI, BMR,
  TDEE, completion date, prediction).
- **Fridge** — CRUD (`/api/fridge`), ingredients auto-matched to the food DB.
- **Meal planner** — `/api/mealplan/generate` builds Breakfast/Lunch/Dinner/
  Snacks scaled to calorie targets with rotating variety; save/retrieve.
- **Daily log** — `/api/logs` calorie/macro tracker CRUD.
- **AI chat (NutriAI)** — `/api/ai/chat`, Gemini with context-rich system prompt
  (profile + fridge + food DB) and a smart rule-based fallback.

### Frontend (`public/`)
- `index.html` — hero + searchable/filterable bento food gallery + 3D detail view.
- Pages: `login`, `register`, `profile`, `profile-view`, `fridge`.
- `js/scene.js` (~3,770 lines) — the 3D rendering engine.
- `js/app.js`, `js/auth.js`, `js/fridge.js`.
- PWA install flow + offline service worker.

### 3D models (`public/models/`)
- 11 real `.glb` models with Draco compression: apple, banana, chicken, salmon,
  egg, sweet potato, broccoli, avocado, blueberry, greek yogurt, carrot.
- Remaining foods fall back to procedural meshes in `scene.js`.

## Auth notes
- **Registration is two-step with email verification:** `POST /api/auth/send-code`
  (emails a 6-digit code, 10-min expiry, pending reg held in memory) →
  `POST /api/auth/verify-code` (creates the account, returns JWT). Legacy
  `POST /api/register` still exists but the UI no longer uses it.
- **Email needs Gmail creds:** set `EMAIL_USER` + `EMAIL_PASS` (Gmail App
  Password) in `.env`. Until then the server returns the code as `devCode`
  in the response and logs it (dev fallback) instead of emailing.
- Client treats an expired JWT (`exp`) as logged-out and clears the stale
  session (`Auth.isAuthed()` in `auth.js`).

## Known gaps / loose ends
- Only 11 of 74 foods have real GLB models.
- The `NutriAI` assistant sub-brand and the `EST. 2035` aesthetic were
  intentionally kept through the rebrand.

## Roadmap (next up)
1. ~~**Rebrand**~~ — ✅ done: renamed "NutriBase Georgia" → **NutriFell**.
2. ~~**Pricing / subscription plans page**~~ — ✅ done. `/pricing.html` with 3
   tiers (Explorer Free / Nutritionist Pro / Elite Premium), monthly⇄annual
   toggle, and a nav link. Subscribe buttons are stubbed (toast) pending Stripe.
   Files: `public/pricing.html`, `public/css/pricing.css`, `public/js/pricing.js`.
   Placeholder prices: Pro $9/mo ($7 annual), Elite $19/mo ($15 annual).
3. ~~**Stripe payment integration**~~ — ✅ done (test mode). Subscription Checkout
   wired end-to-end:
   - `scripts/setup-stripe-prices.js` creates products/prices idempotently
     (lookup_key based). Price IDs live in `.env` (see `.env.example`).
   - Endpoints in `server.js`: `POST /api/checkout/create-session`,
     `POST /api/webhook/stripe` (raw-body signature verify), `GET /api/subscription/status`.
   - User records gain `plan` (free/pro/elite), `stripeCustomerId`,
     `stripeSubscriptionId`, `planValidUntil`, `cancelAtPeriodEnd`.
   - `pricing.js` calls the checkout endpoint and redirects to Stripe; success
     returns to `/fridge.html?upgraded=true` (celebration); cancel returns to pricing.
   - **Local webhooks:** run `stripe listen --forward-to localhost:3000/api/webhook/stripe`
     and put the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`. Without it, the
     server parses webhooks UNVERIFIED (dev only) and logs a warning.
4. **Social media assets** — promo imagery/video (leverage `remotion/`). ← next

### Later / backlog
- Add GLB models for the remaining foods.

## Running locally
```bash
npm install
npm run dev      # nodemon, or: npm start
# http://localhost:3000
```
Env (`.env`): `GEMINI_API_KEY`, `JWT_SECRET`, `PORT`.
