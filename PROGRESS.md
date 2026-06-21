# NutriFell — Progress & Roadmap

> Last updated: 2026-06-18
> Formerly "NutriBase Georgia" — rebranded to **NutriFell** on 2026-06-16.

An interactive 3D nutrition explorer + installable PWA. Browse 74 foods with
complete nutritional profiles rendered in real-time 3D, plus personalized
calorie planning, a virtual fridge, AI meal planning, and a NutriAI chat
assistant.

## Tech stack

- **Backend:** Node.js + Express 4 (`server.js`, single file), hardened with
  `compression` (gzip), `helmet`, and `express-rate-limit`
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
- **Optimized 2026-06-19** via `@gltf-transform/cli optimize`: `apple.glb`
  39.57 MB → 847 KB (8192² textures downscaled to 1024², recompressed in place);
  `salmon.glb` 15.38 MB → 6.84 MB (pruned unused UV sets/tangents + Draco
  re-quantize, no mesh simplification). Both kept Draco + original texture
  formats (JPEG/PNG) so the r128 GLTFLoader needs no new extensions. Re-run with
  `--texture-size 1024 --texture-compress auto --compress draco --simplify false`.

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
4. ~~**Free beta launch**~~ — ✅ done. All features are unlocked for everyone;
   paid checkout is turned off and replaced with a waitlist.
   - `FREE_LAUNCH` flag in `server.js` (env `FREE_LAUNCH=false` to re-enable
     Stripe). While on: `/api/checkout/create-session` returns 503
     (`freeLaunch:true`) and `/api/subscription/status` reports `plan:'free'`
     for everyone. NB: no feature was ever actually gated server-side — the
     advertised Pro/Elite limits were marketing only — so nothing needed
     un-gating; this just disables payment and the "current plan" framing.
   - New endpoints: `GET /api/launch-status` (public flag) and
     `POST /api/waitlist` (email+plan, validated + de-duped, stored in
     `data/waitlist.json`).
   - `pricing.html` — "Free Launch" banner + "All features free during beta,
     subscribe later" copy; Free button → "Get Started Free"; Pro/Elite buttons
     → "Join Waitlist" with a "Free for you during beta" tag; trust row + FAQ
     rewritten for beta. `pricing.js` — checkout flow replaced by a waitlist
     modal (POST `/api/waitlist`). New CSS appended to `pricing.css`.
5. **Social media assets** — promo imagery/video (leverage `remotion/`). ← next

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

### AI + context — Wave 2 (done 2026-06-18)
Applied via context-engineering skill (fundamentals + degradation). All in
`server.js`, `buildSystemPrompt` / `fallbackReply`:
- **Bookended critical info** — non-negotiable rules + targets at the TOP, and a
  "REMEMBER" recap restating the calorie/macro target at the BOTTOM (combats the
  lost-in-middle / U-shaped-attention degradation pattern).
- **Real fridge macros** — new `matchFood()` recovers each fridge item's verified
  per-100g kcal/P/C/F from the food DB and injects it (high signal); the full
  74-food catalog is demoted to a clearly-labelled "reference only" block.
- **Anti-hallucination guardrails** — explicit "use ONLY the numbers provided,
  never invent values"; missing profile fields are detected and listed so the
  model asks for them instead of guessing. Verified end-to-end: with no profile,
  NutriAI now asks for the data rather than fabricating a target.
- **Personalisation** — the rich `cal` planning data (tdee, direction, daily
  adjust, goal kg, weekly change, projected completion) is now injected; it was
  previously computed but never sent to the model.
- **Fallback** — meal-plan suggestions now show matched real macros; added a
  hydration intent that points to the Water page.

### Page polish — Wave 3 (done 2026-06-18)
Applied via ui-ux-pro-max (21st.dev MCP was NOT exposing component tools in the
env, so drove it with the skill + existing system). Lifted all 6 secondary pages
to homepage quality with shared, reusable primitives instead of per-page rewrites:
- **Universal scroll-reveal** — added `initReveal()` to `auth.js` (loads on every
  page) so `[data-reveal]` works app-wide, reduced-motion aware. NB: homepage's
  observer is in `app.js` which only loads there; this fixes the other pages.
- **Shared primitives in `style.css` §30** — `.skeleton` shimmer loader,
  `.assure-row`/`.assure` factual trust microbar, `.empty-cta` + `.empty-hint`.
- **pricing.html** — reveal on the 3 plan cards; stronger trust row (Stripe-secured,
  no-card-for-free); added a cancel/refund FAQ.
- **fridge.html** — assurance microbar; reveal on both panels; warmer meal-plan empty state.
- **water.html** — assurance bar; reveal; skeleton replaces "Loading…"; richer empty log.
- **quit-smoking.html** — supportive assurance bar; reveal on the stats grid.
- **recipes.html** — assurance bar; empty state upgraded to a CTA button.
- **profile-view.html** — bare spinner replaced with a layout-matched skeleton
  scaffold (progressive-loading). Verified: all 6 pages return 200.

### Promo video — Wave 4 (done 2026-06-18)
Built via remotion-video skill. 30 s @ 30fps (900 frames), 6 scenes, in two
aspect ratios from ONE component (`remotion/src/compositions/PromoVideo.tsx`):
- Scenes: logo reveal → 74-foods showcase → AI chat → wellness features →
  community recipes → "Start Free Today" CTA. Spring entrances, drifting green
  particle field, brand tokens (#080c14 / #22c55e / #f59e0b), Space Grotesk via
  `@remotion/google-fonts`. No `@remotion/three` — "3D" food is CSS-transform
  rotated emoji (render-safe; skill warns WebGL crashes during render).
- Sizing in `vmin` units so the single component serves both formats cleanly
  (both share a 1080px min dimension). Registered in `Root.tsx` as
  `PromoVertical` (1080x1920) and `PromoHorizontal` (1920x1080).
- Rendered both + a poster to `public/videos/`
  (`nutrifell-promo-horizontal.mp4`, `nutrifell-promo-vertical.mp4` ~4 MB each,
  `promo-poster.jpg`). npm scripts: `render:promo`, `render:promo:h/v`.
- **Render note:** Remotion's bundled Chrome download failed to extract in this
  env; rendered with `--browser-executable` pointing at local Chrome. The npm
  scripts assume the bundled browser; pass `--browser-executable=<chrome>` if the
  download fails.
- Embedded on the homepage as a "See it in motion" section (`index.html`,
  `.promo` styles in `style.css` §31) — lazy `<video controls preload="none">`
  with the poster.

### Micro-features + marketing + SEO — Wave 5 (done 2026-06-18)
Via copywriting + taste-skill + ui-ux-pro-max. Honest urgency only (taste-skill
bans fake scarcity); zero em-dashes.
- **Streak counter** — `Streak` module in `auth.js` (`nf_streak_v1`): consecutive
  days the app is opened, resets on a missed day, tracks best. Chip in the sidebar
  ("🔥 N day streak"); milestone toast at 3/7/30/100. Exposed as `window.Streak`.
- **Streak badges** — `profile-view.html` shows current/best streak + 4 tiers
  (On Fire 3 / Week Warrior 7 / Monthly Master 30 / Legend 100), locked until earned.
- **Trending this week** — `app.js` logs views (`nf_views_v1`) and renders a top-5
  "🔥 Trending this week" strip on the homepage from a 7-day rolling window (hidden
  until ≥2 foods have views).
- **Food facts** — detail view shows a data-derived standout-nutrient line
  (e.g. "Spinach covers 460% of your daily Vitamin K in a 100g serving"). Computed
  from each food's real %DV, so it's honest by construction and scales to all 74.
- **Tip of the Day** — `fridge.html`: 30 honest tips, rotates daily by day-of-year,
  dismissible per day (`nf_tip_dismiss`).
- **Marketing copy** — sharper hero subheading + concrete CTA ("EXPLORE 74 FOODS"),
  rewritten NutriAI chat welcome (`fridge.js`), pricing honest-urgency line
  ("Start free in under a minute. No card required, cancel anytime.").
- **SEO** — homepage gets OG + Twitter cards + `WebApplication` JSON-LD (share image
  = the branded promo poster); OG/Twitter on pricing + recipes; meta descriptions
  added to fridge/water/quit-smoking. Verified JSON-LD parses; all pages 200.
- CSS for all of the above in `style.css` §32–34. New shared primitives reused.

### Performance + Onboarding — Wave 6 (done 2026-06-18)
Via ui-ux-pro-max + context-engineering + marketing. Two parts.

**Part 1 · Performance pass**
- **Server hardening (`server.js`)** — added `compression` (gzip), `helmet`
  (CSP/COEP off so the CDN 3D + Stripe still load; all other headers on),
  `express-rate-limit` (global 300/min on `/api`, tight 40/15min on
  auth/register, 60/min on AI/recipes). Explicit CORS on `/api` (+OPTIONS 204),
  strong ETags, request logger (`METHOD url → status (Nms)`), and a
  **Cache-Control policy**: static assets `max-age=31536000, immutable`, HTML
  `no-cache`, `/api/foods` 1h, other GET `/api` 5min private, mutations
  `no-store`. All verified via curl.
- **In-memory JSON cache** — `readJSON` now caches parsed data keyed by file
  path + mtime (returns a `structuredClone` so callers can't corrupt the cache);
  `writeJSON` refreshes it; external edits bust it via the mtime check.
- **Styled 404/500** — unknown `.html` → branded 404 page; unknown `/api` →
  JSON 404; global error handler (HTML or JSON by `Accept`); `unhandledRejection`
  / `uncaughtException` guards.
- **Service worker (`sw.js` v3)** — cache-first-within-TTL for API GETs (foods
  1h, profile 30m, default 5m, stamped with a `sw-cached-at` header), network-first
  for navigations, stale-while-revalidate for static + CDN assets, versioned
  cache cleanup, `SKIP_WAITING` message hook.
- **Lazy 3D + video** — Three.js, its post-processing passes, loaders and
  `scene.js` (~1MB) are now injected on demand the first time a food detail opens
  (`ensure3D()` in `app.js`, memoised); homepage no longer ships any of it.
  Promo video uses `data-src` + IntersectionObserver (loads near viewport, plays
  muted only while ≥60% visible). Resource hints: preconnect cdnjs, dns-prefetch
  jsdelivr/Stripe/Gemini. Mobile: `scene.js` drops AA + shadows and caps pixel
  ratio at 1.5 on small/touch screens. `loading="lazy"` on recipe images.
- **Resilience** — `Auth.api` retries transient failures (network drop, 502/503/504)
  3× with backoff; 4xx never retried. Offline/online banner + "Back online" toast.

**Part 2 · Onboarding**
- **Unified toasts** — replaced the single-slot toast with a stacked, typed,
  top-right system (`success`/`error`/`info`/`warning`, icon, dismiss, auto-expire,
  slide in/out, reduced-motion aware). `toast()` signature kept for back-compat;
  exposed as `window.Toast`. (No `alert()` calls existed.)
- **Welcome overlay** (`onboarding.js`, homepage only) — first-visit full-screen
  overlay with animated logo, "Get Started" (→ register, queues the tour) /
  "Explore First" (→ starts the tour) / Skip. `localStorage` flag.
- **5-step spotlight feature tour** — dark mask via a box-shadow cutout with an
  animated green border, tooltip with title/body, progress dots (Step N of 5),
  Skip/Next, Esc/Enter support, resize/scroll reposition, mobile bottom-pinned
  tooltip. Opens the sidebar for nav-anchored steps. Runs after registration
  (pending flag) or from the welcome overlay; completion stored.
- **Profile wizard** (`profile.html` + `initProfile`) — 3 steps (Basics / Body
  stats / Goals) with a progress bar + label, per-step validation, Enter advances,
  encouraging messages between steps, live calorie preview on step 3, and a
  **celebration screen** (confetti + count-up daily target + "Go to My Dashboard").
- **Tooltips** — `.nf-tip` component (hover on desktop, tap-to-toggle on touch,
  keyboard-accessible) on BMR / Mifflin-St Jeor / TDEE / macro-split terms.
- CSS for all of the above in `style.css` §35–40.

### Backlog — remaining
- Taste: bulk rewrite of all 74 food `description`s to be more appetising
  (deferred — too many entries to safely verify in one pass; food-facts feature
  partially covers "interesting facts").
- Remotion: feature-highlight / per-feature short clips (30s promo done).
- Perf: JS/bundle/caching review; error handling hardening.
- Onboarding: dedicated welcome flow copy on register/profile.

### Later / backlog
- Add GLB models for the remaining foods.

## Social feed

### Phase 1 (commit 3d86519)
Instagram/TikTok-style feed: scored "For You" ranking, 4 post types (photo
carousel / video reel / recipe share / text tip), 6-emoji reactions, threaded
comments, save/report/view, follow/unfollow, suggested users, create-post modal
with multer+sharp media upload. Backend in `server.js`; UI in `feed.html` +
`js/feed.js` + `css/feed.css`. Notifications data layer built; bell UI deferred.

### Phase 2 — Full user profiles (done 2026-06-21)
Complete profile system on `profile-social.html` + new `js/profile-social.js` +
`css/profile.css` (builds on feed.css tokens/modals):
- **Profile header** — uploadable cover (200px) + avatar (overlapping circle),
  display name, @username, bio, location, website, and Posts/Followers/Following
  stats (followers/following are clickable → list modal). Follow/Unfollow for
  others; Edit Profile for own.
- **Tabs** — Posts (photo+text 3-col grid), Reels (video grid), Recipes (cards),
  Liked (own only), About (links to the nutrition dashboard at profile-view.html).
- **Edit-profile modal** — avatar + cover upload (live preview, persists
  immediately), name, username (unique + format check, inline errors), bio
  (150-char counter), location, website. Full-screen on mobile (feed.css modal).
- **Followers/Following modal** — viewer-relative follow buttons + client-side
  search.
- **Fullscreen post modal** — media left / info+caption+comments right, like +
  6-emoji react, comment + threaded replies, save, share (Web Share/clipboard),
  and prev/next navigation (arrow keys). Collapses to a single column on mobile.
- **Feed sidebar** suggested users now refresh after you follow someone.
- **New backend endpoints** (`server.js`): `PUT /api/users/profile`,
  `POST /api/upload/avatar`, `POST /api/upload/cover`,
  `GET /api/users/:id/followers|following|liked`. Avatar resized to 400² WebP,
  cover to ≤1600px WebP via sharp (graceful fallback if sharp missing). Username
  validated `^[a-z0-9_]{3,20}$` and unique across users. Verified end-to-end
  (uniqueness 409, bad-format 400, follow counts, viewer flags, image upload+serve).

## Running locally
```bash
npm install
npm run dev      # nodemon, or: npm start
# http://localhost:3000
```
Env (`.env`): `GEMINI_API_KEY`, `JWT_SECRET`, `PORT`.
