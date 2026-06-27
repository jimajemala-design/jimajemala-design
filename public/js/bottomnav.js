/* bottomnav.js — shared floating bottom navigation (design handoff).
   Self-injecting: drops its own <style> + markup, highlights the active item
   from the URL, wires the profile link from the Auth session, and routes the
   centre FAB to the create-post modal (feed) or to /feed.html elsewhere.

   Usage: include AFTER auth.js on any page that wants the nav —
     <script src="/js/bottomnav.js"></script>
   (No old <nav class="bottom-nav"> markup needed; remove it.) */
(function () {
  'use strict';
  if (document.getElementById('nfBottomNavStyle')) return; // guard double-include

  // ── styles (literal hex from the handoff so it renders identically on every
  //    page regardless of that page's own design tokens) ──
  var style = document.createElement('style');
  style.id = 'nfBottomNavStyle';
  style.textContent = [
    '.nf-bottomnav{position:fixed;left:0;right:0;bottom:0;z-index:200;display:flex;justify-content:center;',
    'padding:12px 20px 24px;background:linear-gradient(to top,#090A0A 60%,rgba(9,10,10,0));pointer-events:none;}',
    '.nf-bottomnav-pill{pointer-events:auto;width:100%;max-width:460px;display:flex;align-items:center;',
    'justify-content:space-between;background:#141816;border:1px solid rgba(255,255,255,.07);border-radius:22px;',
    'padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.45);}',
    '.nf-nav-item{position:relative;width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:#7d837e;}',
    '.nf-nav-item svg{width:23px;height:23px;}',
    '.nf-nav-item.active{color:#46D98A;}',
    '.nf-fab{width:50px;height:44px;border-radius:14px;display:grid;place-items:center;flex:none;border:none;cursor:pointer;',
    'background:linear-gradient(135deg,#46D98A,#28b06d);color:#06140d;box-shadow:0 6px 18px rgba(70,217,138,.4);}',
    '.nf-fab svg{width:24px;height:24px;}',
    '.nf-nav-item .bn-badge{position:absolute;top:5px;right:5px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;',
    'background:#46D98A;color:#06140d;font-size:10px;font-weight:700;display:grid;place-items:center;}',
    /* feed already shows a desktop left rail, so hide the floating nav there ≥1024px */
    '@media (min-width:1024px){.nf-bottomnav.nf-has-rail{display:none;}}'
  ].join('');
  document.head.appendChild(style);

  // Explicit width/height attributes (in addition to the CSS) so an icon can
  // never balloon to fill the screen if the injected style is delayed/missing.
  var I = {
    home: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    search: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>',
    plus: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    message: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.6A8.4 8.4 0 1 1 21 11.5z"/></svg>',
    user: '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>'
  };

  // Which item is "active" for this page.
  var p = (location.pathname || '').toLowerCase();
  var has = function (s) { return p.indexOf(s) !== -1; };
  var act = {
    home: has('/feed.html') || p === '/' || p === '' || has('/index.html'),
    search: has('/search.html'),
    messages: has('/messages.html'),
    profile: has('/profile')
  };

  // Profile destination from the signed-in user (matches the rest of the app).
  var profileHref = '/login.html';
  try {
    if (window.Auth && Auth.isAuthed && Auth.isAuthed()) {
      var u = Auth.user();
      profileHref = (u && u.id) ? '/profile-social.html?id=' + u.id : '/profile-view.html';
    }
  } catch (e) { /* not signed in */ }

  var on = function (k) { return act[k] ? ' active' : ''; };
  var nav = document.createElement('nav');
  nav.className = 'nf-bottomnav';
  nav.setAttribute('aria-label', 'Primary');
  nav.innerHTML =
    '<div class="nf-bottomnav-pill">' +
      '<a class="nf-nav-item' + on('home') + '" href="/feed.html" aria-label="Home">' + I.home + '</a>' +
      '<a class="nf-nav-item' + on('search') + '" href="/search.html" aria-label="Search">' + I.search + '</a>' +
      '<button class="nf-fab" data-open-create aria-label="Create post">' + I.plus + '</button>' +
      '<a class="nf-nav-item' + on('messages') + '" href="/messages.html" aria-label="Messages">' + I.message +
        '<span class="bn-badge" data-dm-badge hidden>0</span></a>' +
      '<a class="nf-nav-item' + on('profile') + '" id="bnProfile" href="' + profileHref + '" aria-label="Profile">' + I.user + '</a>' +
    '</div>';

  // On the feed (which has a desktop left rail) hide the floating nav ≥1024px.
  if (document.querySelector('.feed-rail')) nav.classList.add('nf-has-rail');

  (document.body || document.documentElement).appendChild(nav);

  // Centre FAB: if the page hosts the create-post modal (feed), let that page's
  // own [data-open-create] handler open it; otherwise jump to the feed.
  nav.querySelector('.nf-fab').addEventListener('click', function () {
    if (!document.getElementById('createModal')) location.href = '/feed.html';
  });
})();
