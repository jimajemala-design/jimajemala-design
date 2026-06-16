'use strict';

const VERSION = '2.1.0';
const CACHE_NAME = 'nutrifell-' + VERSION;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/fridge.html',
  '/login.html',
  '/register.html',
  '/profile.html',
  '/profile-view.html',
  '/pricing.html',
  '/css/style.css',
  '/css/auth.css',
  '/css/pricing.css',
  '/js/app.js',
  '/js/scene.js',
  '/js/fridge.js',
  '/js/auth.js',
  '/js/pricing.js',
  '/manifest.json',
];

// ── Install: pre-cache static assets ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete all old caches, claim clients immediately ───────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for everything ──────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: network only, graceful offline error
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ error: 'You are offline. Please reconnect to use this feature.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Network-first for all static assets
  event.respondWith(
    fetch(request)
      .then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }

        // Never cache HTML or responses marked no-cache / no-store
        const isHTML = request.destination === 'document'
          || url.pathname.endsWith('.html')
          || url.pathname === '/';
        const cc = response.headers.get('Cache-Control') || '';
        const noCache = cc.includes('no-cache') || cc.includes('no-store');

        if (!isHTML && !noCache) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }

        return response;
      })
      .catch(() =>
        // Network failed — serve from cache
        caches.match(request).then(cached => {
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match('/index.html');
        })
      )
  );
});
