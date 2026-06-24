/* i18n.js — NutriFell bilingual engine (English + ქართული).
   Self-contained: ships the translation table, injects the Georgian webfont and
   the language-switcher styles, auto-mounts the switcher, and localizes any
   [data-i18n] / [data-i18n-placeholder] element. Including this one script on a
   page is all that's needed. Dispatches a `languagechange` event so dynamic
   views (e.g. the 3D food gallery) can re-render in the active language. */
'use strict';

const LANG_KEY = 'nf_lang';

const translations = {
  en: {
    // Navigation
    nav_home: 'Home',
    nav_feed: 'Social Feed',
    nav_database: 'Food Database',
    nav_fridge: 'My Fridge',
    nav_water: 'Water Tracker',
    nav_smoking: 'Quit Smoking',
    nav_recipes: 'Recipes',
    nav_pricing: 'Pricing',
    nav_profile: 'My Profile',
    nav_logout: 'Logout',
    nav_login: 'Login',
    nav_register: 'Register',

    // Hero
    hero_title: 'Discover What You',
    hero_title_highlight: 'Eat',
    hero_subtitle: 'Explore superfoods in real-time 3D with complete nutritional profiles, health benefits, and honest drawbacks.',
    hero_cta: 'Explore Foods',
    hero_stats_foods: 'Superfoods',
    hero_stats_nutrients: 'Nutrients tracked',
    hero_stats_3d: '3D rotation',

    // Food Database
    search_placeholder: 'Search foods...',
    filter_all: 'All',
    filter_fruit: 'Fruit',
    filter_protein: 'Protein',
    filter_vegetable: 'Vegetable',
    filter_grain: 'Grain',
    filter_legume: 'Legume',
    filter_nut: 'Nut',
    food_calories: 'calories',
    food_protein: 'Protein',
    food_carbs: 'Carbs',
    food_fats: 'Fats',
    food_fiber: 'Fiber',
    food_benefits: 'Health Benefits',
    food_drawbacks: 'Drawbacks',
    food_serving: 'Per 100g serving',

    // Auth
    login_title: 'Welcome Back',
    login_subtitle: 'Sign in to your NutriFell account',
    login_email: 'Email address',
    login_password: 'Password',
    login_btn: 'Sign In',
    login_no_account: "Don't have an account?",
    login_register: 'Register',
    register_title: 'Your nutrition journey starts here',
    register_subtitle: '74 foods in 3D. AI meal plans. Free to start.',
    register_name: 'Full Name',
    register_email: 'Email address',
    register_password: 'Password',
    register_confirm: 'Confirm Password',
    register_btn: 'Create Account',
    register_have_account: 'Already have an account?',
    register_login: 'Sign In',

    // Profile
    profile_title: 'Your Profile',
    profile_age: 'Age',
    profile_weight: 'Current Weight',
    profile_target: 'Target Weight',
    profile_height: 'Height',
    profile_gender: 'Gender',
    profile_male: 'Male',
    profile_female: 'Female',
    profile_goal: 'Your Goal',
    profile_lose: 'Lose Weight',
    profile_maintain: 'Maintain Weight',
    profile_gain: 'Gain Muscle',
    profile_activity: 'Activity Level',
    profile_timeline: 'Timeline',
    profile_save: 'Save & Continue',
    profile_calories: 'Daily Calories',
    profile_bmr: 'BMR',
    profile_tdee: 'TDEE',

    // Fridge
    fridge_title: 'My Fridge',
    fridge_empty: 'Your fridge is empty',
    fridge_empty_sub: 'Add ingredients to get personalized meal plans',
    fridge_add: 'Add Ingredient',
    fridge_search: 'Search foods...',
    fridge_generate: 'Generate Plan',
    fridge_tip: 'Tip of the Day',

    // Water
    water_title: 'Water Tracker',
    water_goal: 'Daily Goal',
    water_consumed: 'Consumed',
    water_remaining: 'Remaining',
    water_add: 'Add Water',
    water_glasses: 'glasses',

    // Quit Smoking
    smoking_title: 'Quit Smoking',
    smoking_days: 'Days Smoke-Free',
    smoking_saved: 'Money Saved',
    smoking_cigarettes: 'Cigarettes Not Smoked',
    smoking_health: 'Health Score',
    smoking_craving: 'I Have a Craving',

    // Feed
    feed_title: 'Social Feed',
    feed_new_posts: 'new posts',
    feed_create: 'Create Post',
    feed_like: 'Like',
    feed_comment: 'Comment',
    feed_share: 'Share',
    feed_save: 'Save',
    feed_follow: 'Follow',
    feed_unfollow: 'Unfollow',
    feed_following: 'Following',

    // Recipes
    recipes_title: 'Community Recipes',
    recipes_share: 'Share Recipe',
    recipes_search: 'Search recipes...',

    // Pricing
    pricing_title: 'Choose Your Plan',
    pricing_monthly: 'Monthly',
    pricing_annual: 'Annual',
    pricing_save: 'Save 22%',
    pricing_free: 'Free',
    pricing_pro: 'Pro',
    pricing_elite: 'Elite',
    pricing_get_started: 'Get Started Free',
    pricing_subscribe: 'Subscribe Now',

    // Common
    loading: 'Loading...',
    error: 'Something went wrong',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    back: 'Back',
    next: 'Next',
    done: 'Done',
    close: 'Close',
    search: 'Search',
    submit: 'Submit',
    yes: 'Yes',
    no: 'No',
  },

  ka: {
    // Navigation
    nav_home: 'მთავარი',
    nav_feed: 'სოციალური ფიდი',
    nav_database: 'საკვების ბაზა',
    nav_fridge: 'ჩემი მაცივარი',
    nav_water: 'წყლის ტრეკერი',
    nav_smoking: 'მოწევის დატოვება',
    nav_recipes: 'რეცეპტები',
    nav_pricing: 'ფასები',
    nav_profile: 'ჩემი პროფილი',
    nav_logout: 'გამოსვლა',
    nav_login: 'შესვლა',
    nav_register: 'რეგისტრაცია',

    // Hero
    hero_title: 'აღმოაჩინე რას',
    hero_title_highlight: 'მიირთმევ',
    hero_subtitle: 'შეისწავლე სუპერსაკვები 3D-ში სრული კვებითი პროფილებით, ჯანმრთელობის სარგებლით და გულწრფელი ნაკლოვანებებით.',
    hero_cta: 'საკვების შესწავლა',
    hero_stats_foods: 'სუპერსაკვები',
    hero_stats_nutrients: 'თვალყურდევნებული საკვები ნივთიერება',
    hero_stats_3d: '3D ბრუნვა',

    // Food Database
    search_placeholder: 'საკვების ძიება...',
    filter_all: 'ყველა',
    filter_fruit: 'ხილი',
    filter_protein: 'ცილა',
    filter_vegetable: 'ბოსტნეული',
    filter_grain: 'მარცვლეული',
    filter_legume: 'პარკოსნები',
    filter_nut: 'კაკალი',
    food_calories: 'კალორია',
    food_protein: 'ცილა',
    food_carbs: 'ნახშირწყლები',
    food_fats: 'ცხიმები',
    food_fiber: 'ბოჭკო',
    food_benefits: 'სასარგებლო თვისებები',
    food_drawbacks: 'ნაკლოვანებები',
    food_serving: '100გ-ზე',

    // Auth
    login_title: 'კეთილი დაბრუნება',
    login_subtitle: 'შედი შენს NutriFell ანგარიშში',
    login_email: 'ელ-ფოსტა',
    login_password: 'პაროლი',
    login_btn: 'შესვლა',
    login_no_account: 'არ გაქვს ანგარიში?',
    login_register: 'რეგისტრაცია',
    register_title: 'შენი კვების მოგზაურობა იწყება',
    register_subtitle: '74 საკვები 3D-ში. AI კვების გეგმები. უფასო.',
    register_name: 'სახელი და გვარი',
    register_email: 'ელ-ფოსტა',
    register_password: 'პაროლი',
    register_confirm: 'პაროლის დადასტურება',
    register_btn: 'ანგარიშის შექმნა',
    register_have_account: 'უკვე გაქვს ანგარიში?',
    register_login: 'შესვლა',

    // Profile
    profile_title: 'შენი პროფილი',
    profile_age: 'ასაკი',
    profile_weight: 'მიმდინარე წონა',
    profile_target: 'სამიზნე წონა',
    profile_height: 'სიმაღლე',
    profile_gender: 'სქესი',
    profile_male: 'მამრობითი',
    profile_female: 'მდედრობითი',
    profile_goal: 'შენი მიზანი',
    profile_lose: 'წონის დაკლება',
    profile_maintain: 'წონის შენარჩუნება',
    profile_gain: 'კუნთების მომატება',
    profile_activity: 'აქტიურობის დონე',
    profile_timeline: 'ვადა',
    profile_save: 'შენახვა და გაგრძელება',
    profile_calories: 'დღიური კალორიები',
    profile_bmr: 'BMR',
    profile_tdee: 'TDEE',

    // Fridge
    fridge_title: 'ჩემი მაცივარი',
    fridge_empty: 'მაცივარი ცარიელია',
    fridge_empty_sub: 'დაამატე ინგრედიენტები პერსონალური კვების გეგმისთვის',
    fridge_add: 'ინგრედიენტის დამატება',
    fridge_search: 'საკვების ძიება...',
    fridge_generate: 'გეგმის შექმნა',
    fridge_tip: 'დღის რჩევა',

    // Water
    water_title: 'წყლის ტრეკერი',
    water_goal: 'დღიური მიზანი',
    water_consumed: 'მიღებული',
    water_remaining: 'დარჩენილი',
    water_add: 'წყლის დამატება',
    water_glasses: 'ჭიქა',

    // Quit Smoking
    smoking_title: 'მოწევის დატოვება',
    smoking_days: 'დღე უმოწეოდ',
    smoking_saved: 'დაზოგილი ფული',
    smoking_cigarettes: 'გამოტოვებული სიგარეტი',
    smoking_health: 'ჯანმრთელობის ქულა',
    smoking_craving: 'მსურს მოწევა',

    // Feed
    feed_title: 'სოციალური ფიდი',
    feed_new_posts: 'ახალი პოსტი',
    feed_create: 'პოსტის შექმნა',
    feed_like: 'მოწონება',
    feed_comment: 'კომენტარი',
    feed_share: 'გაზიარება',
    feed_save: 'შენახვა',
    feed_follow: 'გამოწერა',
    feed_unfollow: 'გამოწერის გაუქმება',
    feed_following: 'გამოწერილი',

    // Recipes
    recipes_title: 'საზოგადოების რეცეპტები',
    recipes_share: 'რეცეპტის გაზიარება',
    recipes_search: 'რეცეპტების ძიება...',

    // Pricing
    pricing_title: 'აირჩიე შენი გეგმა',
    pricing_monthly: 'ყოველთვიური',
    pricing_annual: 'წლიური',
    pricing_save: '22% დაზოგვა',
    pricing_free: 'უფასო',
    pricing_pro: 'პრო',
    pricing_elite: 'ელიტა',
    pricing_get_started: 'დაიწყე უფასოდ',
    pricing_subscribe: 'გამოწერა',

    // Common
    loading: 'იტვირთება...',
    error: 'შეცდომა მოხდა',
    save: 'შენახვა',
    cancel: 'გაუქმება',
    delete: 'წაშლა',
    edit: 'რედაქტირება',
    back: 'უკან',
    next: 'შემდეგი',
    done: 'დასრულება',
    close: 'დახურვა',
    search: 'ძიება',
    submit: 'გაგზავნა',
    yes: 'დიახ',
    no: 'არა',
  }
};

const LANG_META = {
  en: { flag: '🇬🇧', code: 'EN', label: 'English' },
  ka: { flag: '🇬🇪', code: 'KA', label: 'ქართული' },
};

// ── i18n engine ───────────────────────────────────────────────────────────
window.i18n = {
  // First visit with no stored choice: default from the browser's language.
  lang: localStorage.getItem(LANG_KEY) ||
        (String((navigator.language || '')).toLowerCase().startsWith('ka') ? 'ka' : 'en'),
  translations,

  t(key) {
    return (translations[this.lang] && translations[this.lang][key]) ||
           translations.en[key] ||
           key;
  },

  setLang(lang) {
    if (!translations[lang]) return;
    this.lang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private mode */ }
    document.documentElement.lang = lang;
    this.applyToPage();
    this.updateSwitcher();
    closeDropdown();
    // Persist to the user's profile when signed in, so the choice follows them.
    if (window.Auth && Auth.isAuthed && Auth.isAuthed() && Auth.api) {
      Auth.api('/api/profile', { method: 'PUT', body: JSON.stringify({ language: lang }) }).catch(() => {});
    }
    // Let dynamic views (3D gallery, detail panel) re-render in the new language.
    document.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
  },

  applyToPage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = this.t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.setAttribute('placeholder', this.t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = this.t(el.getAttribute('data-i18n-html'));
    });
  },

  updateSwitcher() {
    const m = LANG_META[this.lang] || LANG_META.en;
    document.querySelectorAll('.lang-switcher .lang-flag').forEach(e => e.textContent = m.flag);
    document.querySelectorAll('.lang-switcher .lang-text').forEach(e => e.textContent = m.code);
    document.querySelectorAll('.lang-option').forEach(o =>
      o.classList.toggle('active', o.dataset.lang === this.lang));
  },

  init() {
    injectAssets();
    document.documentElement.lang = this.lang;
    mountSwitcher();
    this.applyToPage();
    this.updateSwitcher();
  },
};

// Global used by the inline onclick in the switcher button.
window.toggleLang = function () {
  const dd = document.querySelector('.lang-dropdown');
  if (dd) dd.classList.toggle('open');
};
function closeDropdown() {
  document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
}

// ── Asset injection (font + switcher CSS) — so a page needs only this script ──
function injectAssets() {
  if (document.getElementById('nf-i18n-assets')) return;
  // Georgian webfont
  const pre = document.createElement('link');
  pre.rel = 'preconnect'; pre.href = 'https://fonts.googleapis.com';
  document.head.appendChild(pre);
  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Georgian:wght@300;400;500;600;700&display=swap';
  document.head.appendChild(font);

  const style = document.createElement('style');
  style.id = 'nf-i18n-assets';
  style.textContent = `
    [lang="ka"], [lang="ka"] h1, [lang="ka"] h2, [lang="ka"] h3, [lang="ka"] button, [lang="ka"] input, [lang="ka"] textarea {
      font-family: 'Noto Sans Georgian', var(--font-sans, system-ui, sans-serif);
    }
    [lang="ka"] h1, [lang="ka"] h2, [lang="ka"] h3 { letter-spacing: 0; }
    .lang-switcher-wrap { position: fixed; top: 14px; right: 14px; z-index: 4000; }
    .lang-switcher {
      display: flex; align-items: center; gap: 6px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; padding: 6px 12px; color: var(--text-1, #e6edf3);
      cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s;
      backdrop-filter: blur(8px);
    }
    .lang-switcher:hover { background: rgba(255,255,255,0.12); border-color: var(--green, #22c55e); }
    .lang-switcher .chev { width: 14px; height: 14px; opacity: 0.7; }
    .lang-switcher-wrap { /* anchor for dropdown */ }
    .lang-dropdown {
      position: absolute; top: calc(100% + 6px); right: 0; min-width: 150px;
      background: #0d1117; border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; overflow: hidden; display: none;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
    }
    .lang-dropdown.open { display: block; }
    .lang-option {
      display: flex; align-items: center; gap: 8px; padding: 10px 16px; width: 100%;
      color: var(--text-1, #e6edf3); background: none; border: none; cursor: pointer;
      font-size: 14px; text-align: left;
    }
    .lang-option:hover { background: rgba(255,255,255,0.06); color: var(--green, #22c55e); }
    .lang-option.active { color: var(--green, #22c55e); font-weight: 700; }
    @media (max-width: 640px) { .lang-switcher-wrap { top: 10px; right: 10px; } }
  `;
  document.head.appendChild(style);
}

// ── Switcher UI ─────────────────────────────────────────────────────────────
function mountSwitcher() {
  if (document.querySelector('.lang-switcher-wrap')) return;
  // Prefer an explicit placement hook; otherwise float top-right on every page.
  const host = document.querySelector('[data-lang-switcher]') || document.body;
  const wrap = document.createElement('div');
  wrap.className = 'lang-switcher-wrap';
  const m = LANG_META[window.i18n.lang] || LANG_META.en;
  wrap.innerHTML = `
    <button class="lang-switcher" type="button" onclick="toggleLang()" aria-label="Change language" aria-haspopup="true">
      <span class="lang-flag">${m.flag}</span>
      <span class="lang-text">${m.code}</span>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="lang-dropdown" role="menu">
      <button class="lang-option" data-lang="en" type="button" role="menuitem"><span>🇬🇧</span> English</button>
      <button class="lang-option" data-lang="ka" type="button" role="menuitem"><span>🇬🇪</span> ქართული</button>
    </div>`;
  host.appendChild(wrap);
  wrap.querySelectorAll('.lang-option').forEach(btn =>
    btn.addEventListener('click', () => window.i18n.setLang(btn.dataset.lang)));
  // Close on outside click / Escape.
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) closeDropdown(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });
}

if (document.readyState !== 'loading') window.i18n.init();
else document.addEventListener('DOMContentLoaded', () => window.i18n.init());
