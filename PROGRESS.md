# NutriFell — Progress & Roadmap

> Last updated: 2026-06-17
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
- **Water tracker** — goal from weight (×0.033 L/day, manual override stored on
  user), `POST /api/water/add`, `GET /api/water/today` (summary + today's entries),
  `GET /api/water/history` (7-day), `DELETE /api/water/:id`, `POST /api/water/goal`.
  Data in `data/water.json`.
- **Quit smoking** — `POST /api/smoking/setup`, `GET /api/smoking/stats` (live time
  free, money saved, cigs avoided, life regained, health-score curve, 12 recovery
  milestones with reached/expected dates, 6 achievement badges), `POST/GET
  /api/smoking/craving(s)`, `POST /api/smoking/chat` (Gemini CBT quit-coach +
  fallback). Data in `data/smoking.json`.
- **Community recipes** — full CRUD (`/api/recipes`), multipart photo upload via
  **multer** (memory) + **sharp** resize to ≤1200px WebP into
  `public/uploads/recipes/` (gracefully skips resize if sharp missing). Reactions
  (`/react`, 6 emojis, one per user, toggle), ratings (`/rate` 1–5), bookmarks,
  reports, threaded comments (`/comments`, `/reply`, `/like`), AI analysis
  (`/ai-analysis`, Gemini → cached on recipe, scored fallback), and
  `GET /api/recipes/meta`. Auto-calculates per-serving nutrition from ingredients
  matched to the food DB. Ranking score = reactions×1 + avgRating×20 + comments×2 +
  recency. Data in `recipes/comments/reactions/bookmarks/reports.json`.

### Frontend (`public/`)
- `index.html` — hero + searchable/filterable bento food gallery + 3D detail view.
- Pages: `login`, `register`, `profile`, `profile-view`, `fridge`, `pricing`.
- Feature pages: `water.html`, `quit-smoking.html`, `recipes.html`,
  `recipe-detail.html`, `recipe-upload.html` (all linked from the sidebar nav).
- `js/scene.js` (~3,770 lines) — the 3D rendering engine.
- `js/app.js`, `js/auth.js`, `js/fridge.js`, `js/pricing.js`.
- Feature JS: `js/water.js`, `js/quit-smoking.js`, `js/recipes.js`,
  `js/recipe-detail.js`, `js/recipe-upload.js`. Shared styles in `css/features.css`.
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

### Homepage upgrade — Wave 1 (done 2026-06-18)
Applied via ui-ux-pro-max + taste-skill (redesign-preserve: kept the
"specimen/database · EST. 2035" voice; honoured anti-slop rules — zero
em-dashes, no fake testimonials, honest copy). All on `index.html` +
`css/style.css` (§24–29) + `app.js`:
- **Food of the Day** — deterministic by UTC day-of-year, note falls back
  `description → benefits[0]`, click opens detail. (`initFotd`)
- **Recently viewed** — localStorage `nf_recent_v1`, max 8, horizontal chip
  row, hidden when empty. Tracked in `openDetail` via `pushRecent`. (`renderRecent`)
- **How it works** — 3-step protocol grid with staggered scroll-reveal.
- **Trust strip** — 4 factual badges (offline PWA, no trackers, per-100g, honest).
- **FAQ** — accessible single-open accordion (`aria-expanded`, max-height). (`initFaq`)
- **A11y/UX** — fixed invalid `role="listitem button"` → `role="button"` on
  food cards; `[data-reveal]` IntersectionObserver reveal that collapses under
  `prefers-reduced-motion`; focus-visible rings; mobile breakpoints at 860/640px.

### Backlog — remaining "major upgrade" waves (requested, not yet done)
- Other pages (profile, fridge, pricing, water, quit-smoking, recipes): same
  polish pass, empty/loading states, copy.
- Marketing: hero/CTA copy, pricing copy, onboarding text.
- Taste: richer food descriptions, appetising-but-honest nutrient copy.
- Context-engineering: AI system prompts, Gemini context injection, meal-plan accuracy.
- Remotion: promo + feature-highlight videos.
- Perf: JS/bundle/caching review; error handling.
- Micro-features: streak counter, "popular this week", tip of the day, more facts.

### Later / backlog
- Add GLB models for the remaining foods.

## Running locally
```bash
npm install
npm run dev      # nodemon, or: npm start
# http://localhost:3000
```
Env (`.env`): `GEMINI_API_KEY`, `JWT_SECRET`, `PORT`.
