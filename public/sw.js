'use strict';

// Bump VERSION to roll all caches on deploy.
// 4.1.0 — evict stale scene.js + the pre-optimization (39MB) apple/salmon GLBs.
// 4.2.0 — fix blank canvas: buffer sized from real client size + ResizeObserver
//         (rescues the display:none-at-init race) + spinner handoff fix.
// 4.3.0 — social feed (Phase 1): precache feed assets; never-cache the
//         per-viewer feed/posts/users/notifications APIs.
const VERSION = '4.4.0';
const STATIC_CACHE = `nutrifell-static-${VERSION}`;
const API_CACHE = `nutrifell-api-${VERSION}`;
const CDN_CACHE = `nutrifell-cdn-${VERSION}`;
const ALL_CACHES = [STATIC_CACHE, API_CACHE, CDN_CACHE];

// App shell precached on install so the PWA opens instantly / offline.
const PRECACHE = [
  '/',
  '/index.html',
  '/fridge.html',
  '/feed.html',
  '/css/style.css',
  '/css/auth.css',
  '/css/features.css',
  '/css/feed.css',
  '/css/profile.css',
  '/css/phase3.css',
  '/js/app.js',
  '/js/auth.js',
  '/js/feed.js',
  '/js/notifications.js',
  '/js/post-modal.js',
  '/manifest.json',
];

// Private / per-user API routes that must NEVER be cached — caching these on a
// shared device could leak one account's data to another, or serve stale
// authed state. Everything here always goes straight to the network.
const NEVER_CACHE = [
  '/api/auth',
  '/api/profile',
  '/api/fridge',
  '/api/mealplan',
  '/api/water',
  '/api/smoking',
  '/api/logs',
  '/api/ai',
  '/api/checkout',
  '/api/subscription',
  '/api/recipes/bookmarks',
  '/api/recipes/react',
  '/api/recipes/rate',
  // Social feed is per-viewer and changes constantly — always hit the network.
  '/api/feed',
  '/api/posts',
  '/api/users',
  '/api/notifications',
];
const isPrivateApi = (pathname) => NEVER_CACHE.some((p) => pathname.startsWith(p));

// Per-endpoint freshness windows. Within the window a cached API response is
// served without touching the network; past it we revalidate. (ms)
const API_TTL = [
  { test: (p) => p === '/api/foods' || /^\/api\/foods\//.test(p), ttl: 60 * 60 * 1000 },      // 1 hour
  { test: (p) => p === '/api/profile' || p === '/api/profile/stats', ttl: 30 * 60 * 1000 },    // 30 min
  { test: () => true, ttl: 5 * 60 * 1000 },                                                     // default 5 min
];
const ttlFor = (pathname) => (API_TTL.find((r) => r.test(pathname)) || { ttl: 0 }).ttl;
const CACHED_AT = 'sw-cached-at';

// Wrap a response with a timestamp header so we can age it out later.
function stamp(response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT, String(Date.now()));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
const ageOf = (response) => Date.now() - Number(response.headers.get(CACHED_AT) || 0);

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: drop caches from older versions, take control ─────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => !ALL_CACHES.includes(n)).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch routing ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache mutations

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // 1a) Private / authenticated API — network only, never cached or read from
  //     cache. A graceful offline JSON response keeps the UI from hard-failing.
  if (sameOrigin && isPrivateApi(url.pathname)) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'You are offline. Please reconnect to use this feature.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // 1b) Public API (food database, public recipe reads) — cache-first within a
  //     freshness window, then network, then stale.
  if (sameOrigin && url.pathname.startsWith('/api/')) {
    event.respondWith(apiStrategy(request, url));
    return;
  }

  // 2) Navigations (HTML) — network-first so pages stay fresh, cache as fallback.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match('/index.html')))
    );
    return;
  }

  // 3) Cross-origin CDN assets (Three.js, fonts) — cache-first, revalidate.
  if (!sameOrigin) {
    if (/cdnjs\.cloudflare\.com|jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
      event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    }
    return; // anything else (Stripe, Gemini, analytics) goes straight to network
  }

  // 4) Same-origin static assets — cache-first with background revalidate.
  event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});

// Cache-first inside the TTL; otherwise revalidate from network and fall back
// to any cached copy (even stale) when offline.
async function apiStrategy(request, url) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  const ttl = ttlFor(url.pathname);

  if (cached && ttl > 0 && ageOf(cached) < ttl) return cached; // fresh enough

  try {
    const res = await fetch(request);
    if (res && res.status === 200) cache.put(request, stamp(res.clone()));
    return res;
  } catch {
    if (cached) return cached; // stale-but-useful when offline
    return new Response(
      JSON.stringify({ error: 'You are offline. Please reconnect to use this feature.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && (res.status === 200 || res.type === 'opaque')) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || network || fetch(request);
}

// Allow the page to trigger an immediate activation after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
