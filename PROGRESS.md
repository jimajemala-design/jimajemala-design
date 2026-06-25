# NutriFell — Progress & Roadmap

> Last updated: 2026-06-25
> Formerly "NutriBase Georgia" — rebranded to **NutriFell** on 2026-06-16.

An interactive 3D nutrition explorer + installable PWA. Browse 74 foods with
complete nutritional profiles rendered in real-time 3D, plus personalized
calorie planning, a virtual fridge, AI meal planning, and a NutriAI chat
assistant.

## Tech stack

- **Backend:** Node.js + Express 4 (`server.js`, single file), hardened with
  `compression` (gzip), `helmet`, and `express-rate-limit`
- **Auth:** JWT (7-day expiry) + bcrypt password hashing
- **Storage:** Hybrid — **MySQL on Hostinger** for users/auth (Phase 1 complete);
  file-based JSON in `data/` for all other collections (fridges, posts, water,
  etc.) until Phase 2+ migration. JSON files auto-created on boot; gitignored.
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
5. ~~**Social media assets**~~ — ✅ done (2026-06-24). 6 vertical feature-highlight
   clips built in Remotion (see "Social media assets" below).

### Social media assets — feature highlight clips (done 2026-06-24)
Built via the remotion-video skill, reusing the PromoVideo brand system. Six
short vertical clips, **1080x1920 @ 30fps**, dark theme (`#080c14`) + green
accents (`#22c55e`), Space Grotesk, drifting particle field, and the shared
`music.wav` soundtrack (fade in/out). All render-safe (CSS-transform "3D", no
WebGL — the skill warns WebGL crashes during render). Rendered to
`public/videos/social/`:
- `3d-food-explorer.mp4` (15s) — apple/salmon/broccoli rotating with real
  nutrition chips orbiting; "74 foods in stunning 3D".
- `ai-nutrition-chat.mp4` (20s) — phone mockup, NutriAI chat + a meal plan
  generating row-by-row; "Your personal AI nutritionist".
- `smart-fridge.mp4` (15s) — fridge ingredients popping in → auto-generated
  meal plan; "Meal plans from your fridge".
- `quit-smoking.mp4` (20s) — count-up days/money/cigs + milestone badges
  unlocking; "Your quit smoking companion".
- `water-tracker.mp4` (15s) — blue progress ring + animated water wave fill;
  "Stay hydrated every day".
- `social-feed.mp4` (20s) — feed cards sliding in with live like counts +
  reactions flying up; "Join the NutriFell community".

**Code:** shared brand primitives in `remotion/src/lib/brand.tsx`
(tokens, `useUnit`/`useEnter`, `Backdrop`, `Stage`, `Caption`, `Wordmark`,
`Particles`); all six clips in `remotion/src/compositions/FeatureClips.tsx`;
registered in `Root.tsx` as `ClipFood`/`ClipAI`/`ClipFridge`/`ClipQuit`/
`ClipWater`/`ClipFeed`. npm scripts: `render:clips` (all) + per-clip
`render:clip:*`. **Render note:** same as the promo — Remotion's bundled Chrome
fails to extract in this env, so render with
`--browser-executable="/c/Program Files/Google/Chrome/Application/chrome.exe"`.

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
- ~~Taste: bulk rewrite of all 74 food `description`s to be more appetising.~~
  ✅ **COMPLETE** (commit `0fb2b71`, 2026-06-24) — all 74 descriptions rewritten
  (sensory taste profile + key benefit + interesting fact, 2-3 sentences, no
  em-dashes; every nutritional claim verified against the foods data). Rendered
  in the detail view below the name, above the nutrition data (italic/muted,
  staggered fade-up, reduced-motion aware).
- ~~Remotion: feature-highlight / per-feature short clips.~~ ✅ **COMPLETE**
  (2026-06-24) — 6 vertical (1080x1920 @ 30fps) feature clips: 3D Food Explorer,
  AI Nutrition Chat, Smart Fridge, Quit Smoking Tracker, Water Tracker, Social
  Feed. Rendered to `public/videos/social/`. See "Social media assets" below.
- Perf: JS/bundle/caching review; error handling hardening.
- Onboarding: dedicated welcome flow copy on register/profile.

### Internationalization — Georgian/English (done 2026-06-24) ✅
Commit `383cdba`. Full bilingual support across the whole app:
- **`public/js/i18n.js`** (461 lines, `window.I18n`) — translation dictionary +
  runtime language switch (`ka`/`en`), persisted to `localStorage`; applies to
  any `[data-i18n]` / `[data-i18n-placeholder]` element and updates `<html lang>`.
- Wired into every page (script tag added to all 16 HTML pages) and into the
  dynamic renderers in `app.js` / `auth.js`. Server (`server.js`) updated to
  serve/accept the locale where relevant.
- Language toggle exposed in the UI; Georgian is the default-locale option.

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

### Phase 3 — Notifications, hashtags, search (done 2026-06-21)
- **Notifications** — navbar dropdown (`js/notifications.js`, `window.Notif`) wired
  to any `[data-notif-bell]` with a `[data-notif-badge]`; polls
  `/api/notifications/count` every 30s. Rows show actor avatar + type icon
  (❤️/💬/🔁/👤/📌/🏷️), text, time-ago, post thumbnail, and deep-link; click marks
  read + navigates. Full page `notifications.html` with All/Likes/Comments/Follows
  filter tabs + infinite scroll + mark-all-read. Backend: `GET /api/notifications`
  now paginated + `type` filter + enriched (`postThumb`, `link`, fresh
  avatar/username); new `PUT /api/notifications/:id/read`. New notification types
  wired: `reply`, `save`, `mention`.
- **Hashtags** — `hashtag.html` + `js/hashtag.js`: hero with post count, Follow
  (persisted in `data/hashtag_follows.json`) + Share, related (co-occurring) tags,
  Top + Recent grids that open the shared post modal. Backend:
  `GET /api/hashtags/trending` (7-day window), `GET /api/hashtags/:tag` (counts +
  related + isFollowing), `GET /api/hashtags/:tag/posts?sort=top|recent`,
  `POST /api/hashtags/:tag/follow`. Caption hashtags now link to `/hashtag.html`.
- **Search + Explore** — `search.html` + `js/search.js`: debounced (300ms)
  search-as-you-type across People / Posts / Recipes / Hashtags / Foods; recent
  searches in localStorage (`nf_recent_searches`); Explore view (trending hashtags
  + suggested users + popular foods) when empty. Backend: `GET /api/search` (mixed)
  + `/api/search/{users,posts,hashtags,foods}`. Food results deep-link to the 3D
  viewer via new `?food=<id>` support in `app.js`. Feed/profile "Explore" now point
  here; the feed search bar routes #tags → hashtag page, else → search.
- **Mentions** — `@username` resolved server-side (custom username or derived
  handle) on post + comment + reply creation → `mention` notifications; rendered as
  clickable `.mention` links across feed, profile, and the shared post modal.
  Create-post caption has #hashtag + @mention autocomplete (arrow keys / click).
- **Shared post modal** — `js/post-modal.js` (`PostModal.open(posts, index)`):
  fullscreen media + comments + like/react/comment + prev/next, reused by the
  hashtag and search pages (profile keeps its own copy). Styles reuse profile.css.
- SW bumped to v4.4.0; new CSS/JS added to precache. Verified end-to-end against a
  running server (search shapes, hashtag aggregation, mention + save + like
  notifications, single/all read, pagination + filters).

### Phase 4 — DMs, Stories, Reels viewer, ranking (DONE 2026-06-22) ✅
Spec'd + built 2026-06-22. Build order **4A→4B→4C→4D**; each verified end-to-end
against a running server. Status: **all four sub-phases done** ✅.
SW bumped to 4.5.0 with all new html/js/css precached; new per-user/time-sensitive
APIs (`/api/conversations`, `/api/messages`, `/api/stories`, `/api/reels`) added
to NEVER_CACHE. NB: a stale `node server.js` can hold the port (EADDRINUSE) and
serve old routes — kill all node procs before re-testing.
Conventions: file-based JSON via `readJSON`/`writeJSON`; uploads = multer-memory
+ sharp WebP (video written raw, no ffmpeg); realtime = polling (no websockets;
SSE noted as a future upgrade); new nav entries **Reels** + **Messages** in
`side-nav` + `bottom-nav` with a `[data-dm-badge]` unread badge; `sw.js`
VERSION → `4.5.0` with new assets precached.

**Decisions locked:** DMs **open to everyone** (message-requests tier deferred);
Stories visible to **followers + self**.

**4A · Direct Messages** — ✅ built & verified 2026-06-22
- Files: `public/messages.html` + `public/js/messages.js` + `public/css/messages.css`.
  DM badge poller added to `js/notifications.js` (`[data-dm-bell]`/`[data-dm-badge]`,
  30s). `feed.html` top DM icon now links to the inbox with a live badge.
  `profile-social.js` gained a **Message** button (`?to=<userId>` deep link).
  SW → 4.5.0; `/api/conversations` + `/api/messages` added to NEVER_CACHE.
- Verified: static 200s; auth 401; create/dedup; send + unread 1→0; per-thread
  read; shared-post attachment enrichment; self-message 400; unknown recipient 404.
- Data: `conversations.json` `{ id, participants:[a,b], createdAt, lastMessageAt,
  lastMessage:{text,fromUserId,at} }` (1:1 only, deduped by sorted pair);
  `messages.json` `{ id, conversationId, fromUserId, text, attachment:{kind:'image'|
  'post'|'reel', url|postId}|null, read, at }`.
- Endpoints: `GET /api/conversations`, `POST /api/conversations` (find-or-create),
  `GET /api/conversations/:id/messages?before=<cursor>` (participant-only, 403),
  `POST /api/conversations/:id/messages` (rate-limited), `PUT /api/conversations/:id/read`,
  `GET /api/messages/unread-count`.
- DMs use a **dedicated badge**, NOT `notifications.json` rows (avoids feed noise).
- Frontend: `messages.html` + `js/messages.js` + `css/messages.css`. Two-pane
  desktop / list→thread mobile. Thread polls ~5s while focused; nav badge 30s.
  Entry points: **Message** button on `profile-social.html`; **Share → Send as
  message** from post modal + reels; story replies create a DM.

**4B · Stories (24h)** — ✅ built & verified 2026-06-22
- Files: `public/js/stories.js` (`window.Stories`) + `public/css/stories.css`;
  tray mounted in `feed.html` (`#storyTray`, logged-in only). Composer uploads
  via raw `fetch` (FormData) since `Auth.api` forces JSON. SW → 4.5.0 precache +
  `/api/stories` in NEVER_CACHE.
- Verified: image upload → WebP; follower visibility + grouping; self-first /
  unseen-first ordering; view tracking flips seen + hasUnseen; owner-only viewers
  list (403 for others); owner-only delete (403 for others, media file unlinked);
  media served. NB: sharp rejects malformed test PNGs (use a real image).
- Data: `stories.json` `{ id, userId, type:'image'|'video', media, caption?,
  createdAt, expiresAt(+24h) }`; `story_views.json` `{ storyId, userId, at }`.
- Uploads → new `public/uploads/stories/` (image=WebP, video=raw).
- Endpoints: `POST /api/stories`; `GET /api/stories` (active, followers+self,
  grouped by author, self→unseen→seen, `hasUnseen`); `POST /api/stories/:id/view`;
  `GET /api/stories/:id/viewers` (own only); `DELETE /api/stories/:id` (own only).
- Expiry: lazy `expiresAt > now` filter on read + boot/interval sweep deleting
  expired media files.
- Frontend: avatar-ring story tray atop `feed.html` (`js/stories.js`); fullscreen
  viewer with auto-advancing progress bars (5s images / video length), tap L/R,
  hold-to-pause, swipe-down/X close, reply box (→ DM), viewer list on own stories.

**4C · Reels viewer (TikTok-style)** — ✅ built & verified 2026-06-22
- Files: `public/reels.html` + `public/js/reels.js` + `public/css/reels.css`.
  Entry: desktop side-nav **Reels** (feed + messages); the feed "🎬 Reels" filter
  chip now opens the immersive viewer (`feed.js`); share/deep-link via
  `/reels.html?post=<id>`. SW → 4.5.0 precache + `/api/reels` in NEVER_CACHE.
- Verified: `/api/reels` shape (works logged-out), ranked video listing,
  enrichment (author/counts/isOwn/isFollowingAuthor), and reuse of
  like/save/comment/view endpoints. NB: video posts need a real video mimetype
  (`-F 'media=@clip.mp4;type=video/mp4'`); server writes video raw (no transcode).
- No new storage; reuses existing `type:'video'` posts.
- Endpoint: `GET /api/reels?page=` (ranked via `decoratePost` + 4D scoring,
  enriched + `hasMore`). Reuses `POST /api/posts/:id/view`.
- Frontend: `reels.html` + `js/reels.js`. Full-screen vertical CSS scroll-snap,
  autoplay-muted-in-view (IntersectionObserver), loop, tap pause/unmute. Right
  rail: 6-emoji react, comment sheet, save, share-to-DM, author+follow. **DOM
  windowing** (~3 mounted + preload next). Entry: nav **Reels**; tapping a video
  post in feed/profile opens the viewer at that post.

**4D · Feed ranking improvements** — ✅ built & verified 2026-06-22
- Files: `server.js` (`buildRankingContext`, `forYouScore`, `diversifyByAuthor`,
  refactored `/api/feed` with `?ranking=`). `feed.html` ranking tabs +
  `feed.js` (`state.ranking`) + `.feed-ranking`/`.rank-tab` in `feed.css`.
  `decoratePost`'s legacy `score` kept intact (reels/hashtags still use it);
  For You scoring is computed in the feed handler only.
- Verified: mode echoed in response; Latest = reverse-chron; Following =
  followed+own only (flags correct); For You personalizes; logged-out cold-start
  works. Seen penalty uses engaged-post proxy (no per-user post-view store exists).
- Replaces global `likes×3 + comments×5 + saves×4 + views×0.1 − hours×0.5`.
- Three modes via `?ranking=foryou|following|latest` surfaced as feed tabs:
  Following (reverse-chron from follows), Latest (reverse-chron all), For You
  (personalized; logged-out/cold-start = popularity+recency).
- For You score: **exponential HN-style decay** `engagement / (hours+2)^1.5`
  (bounded, positive) + **following affinity** boost + **interest match** boost
  (post hashtags/foodTags vs viewer's recently engaged tags/foods) + **seen
  penalty** (downrank already-viewed so refresh advances) + **author diversity**
  pass (max 2 consecutive posts per author). Weights documented inline; honest
  and explainable, no dark patterns.

### Phase 5 — Real-time (socket.io) + video transcoding (DONE 2026-06-24) ✅
Upgraded the social platform from polling to true real-time, and added a proper
video pipeline for reels. Verified end-to-end against a running server with
scripted socket clients: real-time DMs/notifications/presence
(`scripts/verify-phase5.js`), the video flow (`scripts/verify-video.js`), and the
live-feed event contract incl. `comment:new` room scoping
(`scripts/verify-feed-live.js`) — all checks green.

**New deps:** `socket.io` + `socket.io-client` (real-time); `fluent-ffmpeg` +
`@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` (transcoding). All
loaded defensively — if any are missing the server still boots (real-time off /
transcoding 503) and the client degrades to the existing polling.

**Real-time server (`server.js`)**
- The HTTP server now wraps Express so socket.io shares the port; falls back to
  plain `app.listen` when socket.io is absent. Boot log states `(real-time on/off)`.
- **Handshake JWT auth** (`io.use`) — anonymous sockets rejected; `socket.userId`
  set from the token. Each socket joins a `user:<id>` room.
- **Presence** — in-memory `onlineUsers` map (capped at 50k). On connect: broadcast
  `user:online` + send the newcomer a `presence:list`; on last-socket disconnect:
  `user:offline`. `GET /api/presence/:id` for snapshots.
- **`RT` emit hub** — `toUser` / `toPost` / `broadcast`, used throughout the
  existing REST handlers so writes push live without changing their contracts.
- **Live events wired:** `notification:new` (from `pushNotification`),
  `dm:receive` / `dm:read` / `dm:typing` / `dm:stop_typing` / `dm:sent`,
  `feed:new_post`, `post:reaction`, `post:comment` (+ per-post-room `comment:new`),
  `story:viewed`. DM persistence refactored into a shared `persistMessage()` used
  by both `POST …/messages` and the socket `dm:send` (ack-capable) path.

**Real-time client (`public/js/socket-client.js`, `window.Live`)**
- Connects with the stored JWT, routes events into existing primitives
  (`Notif`, `Toast`, `Messages`, `Feed`, `Stories`) + a `presence:change`
  DOM event. No-ops when logged out or socket.io is unavailable. Exposes
  presence helpers + `typing()` / `subscribePost()`.
- Wired into **feed, messages, notifications, profile-social, fridge, index**
  (two `<script>` tags before `</body>`: the served `/socket.io/socket.io.js`
  + `/js/socket-client.js`).
- `messages.js` now shows live incoming messages, typing dots, blue-tick read
  receipts, and online dots/"Active now" header (presence). `notifications.js`
  gained `prependLive`.
- **Live feed handlers (`feed.js`)** — `onNewPost` accumulates a sticky
  "🔥 N new posts · tap to load" banner that fetches + slides the new cards in
  from the top (own posts filtered, deduped against `seen`); `onReaction`
  live-updates a card's count + summary emojis with a count-pop + emoji-burst
  (without touching the viewer's own reaction); `onCommentCount` bumps the card
  comment count from the `post:comment` broadcast, while `onComment` live-prepends
  the full comment into the open sheet (the sheet subscribes via
  `Live.subscribePost` on open, unsubscribes on close, since `comment:new` is
  post-room scoped). Animations + reduced-motion guards in `feed.css`.

**Video transcoding pipeline**
- `POST /api/upload/video` (multipart, auth) → returns `{ jobId }` (202) and
  transcodes in the background; ffprobe duration guard (≤3 min). Produces a
  web-optimized MP4 + a 400² WebP thumbnail under `public/uploads/videos/`
  (+ `/thumbs`, `/tmp` scratch). `GET /api/upload/video/:jobId/status` polls
  `{ progress, status, videoUrl, thumbnailUrl, durationSec }` (owner-only).
- `POST /api/posts` accepts a pre-transcoded `videoUrl` (+ `videoThumb`),
  path-validated to `/uploads/videos/…`, instead of a raw multipart upload.
- **Create-post UI (`feed.js`)** — the "Photo / Video" tab auto-detects a video,
  kicks off the async upload, shows a progress bar while transcoding, swaps to a
  playable preview when ready, and only then lets you post (button disabled +
  "Processing video…" until complete). Progress-bar styles in `feed.css`.

**Service worker** — bumped `VERSION` `4.5.0 → 4.6.0` (rolls all caches);
`/js/socket-client.js` added to precache; `/socket.io/` requests explicitly
bypassed in the fetch handler (caching the polling endpoint would break the
handshake; the client lib is served dynamically, not precached).

## MySQL migration

### Phase 1 — Auth / Users ✅ (2026-06-25, commit fa12487)
- `npm install mysql2` added; connection pool via `mysql2/promise`.
- On startup: `CREATE TABLE IF NOT EXISTS users` (auto-creates, idempotent),
  then seeds from `data/users.json` if the table is empty (one-time migration).
- All auth + profile endpoints now read/write MySQL:
  `auth` middleware, `POST /api/auth/send-code`, `POST /api/auth/verify-code`,
  `POST /api/register`, `POST /api/login`, `GET /api/profile`,
  `PUT /api/profile`, `GET /api/profile/stats`.
- **Dual-write**: every user write also updates `data/users.json` so non-migrated
  endpoints (AI chat, Stripe webhooks, water goal, subscription status) continue
  to work until Phase 2 replaces them.
- `db` helper functions: `dbFindUserById`, `dbFindUserByEmail`, `dbInsertUser`,
  `dbUpdateUser`. All use parameterized queries (`execute()` with `?`).
- JSON fallback: if `DB_HOST`/`DB_USER` are unset, `db` stays `null` and every
  function falls back to `readJSON(USERS_FILE)` — server boots without MySQL.
- Audit: `node audit-run.js` → **36/36 passed** after Phase 1.
- Env vars required: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_PORT`.

### Phases 2a–2d — social collections ✅
Migrated to MySQL with the `s*` storage-helper pattern (`if (db) → MySQL, else
→ JSON`) plus **JSON dual-write** on every mutation: `posts` (2a),
`post_reactions` + `post_comments` (2b), `follows` + `notifications` (2c),
`conversations` + `messages` + `stories` (2d). Dual-write is intentional —
~100 direct `readJSON()` readers across feed/reels/profile/search still read
these collections from JSON, so the helpers keep both stores in sync.

### Phase 2e — recipes + remaining social tables ✅ (2026-06-26)
Final tables migrated, same `s*` + dual-write pattern as 2a–2d (kept dual-write;
full JSON removal deferred until every direct-JSON reader is migrated — a later
dedicated phase). New tables (each `CREATE TABLE IF NOT EXISTS` + one-time seed
from JSON when empty, in the boot IIFE):
- `recipes` — full recipe object; complex fields (`photos`, `ingredients`,
  `steps`, `tags`, `nutrition`, `ratings`, `aiAnalysis`) stored as JSON columns.
  Table mirrors the **actual** recipe shape (`name`/`opinion`/`tips`/`ratings[]`),
  not the idealized spec (`title`/`authorNote`/`averageRating`), so it round-trips.
- `recipe_comments`, `recipe_reactions`, `recipe_reports` — the recipe feature's
  comments (threaded, JSON `likes`), one-emoji-per-user reactions, and reports.
  (Not in the original 6-table spec, but required to fully migrate the recipe
  feature per step 3 "replace ALL remaining readJSON/writeJSON".)
- `bookmarks` (recipe saves; generated `id` since JSON rows had none),
  `post_saves`, `post_reports`, `hashtag_follows`.
- `hashtags` — counter table created per spec but left empty; hashtag pages still
  aggregate from `posts` on the fly. Populating it is a future phase.

Helpers (`s*`, all "MySQL-or-JSON + dual-write"): `sGetAllRecipes`,
`sGetRecipeById`, `sInsertRecipe`, `sUpdateRecipe`, `sDeleteRecipe` (cascades
comments/reactions/bookmarks), `sGetRecipeReactions`, `sToggleRecipeReaction`,
`sGetRecipeComments`, `sInsertRecipeComment`, `sGetRecipeCommentById`,
`sToggleRecipeCommentLike`, `sInsertRecipeReport`, `sGetBookmarks`,
`sToggleBookmark`, `sToggleSave`, `sInsertPostReport`, `sToggleHashtagFollow`,
`sIsFollowingHashtag`. All recipe/bookmark/save/hashtag-follow endpoints were
converted to `async` and routed through these. Verified end-to-end against the
live Hostinger DB (list/detail round-trip, react toggle, rate, comment/reply/like,
bookmark on/off, recipe + post report, hashtag follow/unfollow) and
`node audit-run.js` → **36/36 passed**.

### Still on JSON (not yet migrated)
`fridges`, `water`, `mealplans`, `logs`, `smoking`, `waitlist`, `story_views` —
no MySQL table yet; these remain pure file-based. A future phase can migrate them
and then remove dual-write once all direct-JSON readers are gone.

## Running locally
```bash
npm install
npm run dev      # nodemon, or: npm start
# http://localhost:3000
```
Env (`.env`): `GEMINI_API_KEY`, `JWT_SECRET`, `PORT`,
`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_PORT` (MySQL / Hostinger).
