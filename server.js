require('dotenv').config();

// ─── Startup environment check ───────────────────────────────────────────
// Runs before anything else so it's the first thing in the logs. If values
// show here but email still fails, the problem is SMTP auth, not .env loading.
console.log('=== ENV CHECK ===');
console.log('EMAIL_USER:', process.env.EMAIL_USER || 'undefined');
console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? 'SET' : 'NOT SET');
console.log('GEMINI_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET');
console.log('=================');

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = express();
const PORT = process.env.PORT || 3000;
app.set('etag', 'strong'); // strong ETags on dynamic responses for conditional GETs

// ─── Security, compression & resilience middleware ───────────────────────
// Loaded defensively so a missing dep never takes the whole server down.
let compression = null, helmet = null, rateLimit = null;
try { compression = require('compression'); } catch (e) { /* gzip disabled */ }
try { helmet = require('helmet'); } catch (e) { /* security headers disabled */ }
try { rateLimit = require('express-rate-limit'); } catch (e) { /* rate limiting disabled */ }

if (helmet) {
  // CSP is left off: the app loads Three.js/Stripe from CDNs and uses inline
  // bootstrap scripts. The remaining helmet protections (HSTS, noSniff, frame
  // guards, referrer policy, etc.) all still apply. COEP off so CDN/3D assets load.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
}
if (compression) app.use(compression()); // gzip all eligible responses

// Lightweight request logger: METHOD /path → status (Nms)
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (req.originalUrl !== '/favicon.ico') {
      console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

// CORS — permissive for the JSON API (same-origin app, but explicit + safe)
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Cache-Control policy:
//   • GET /api/foods, /api/foods/:id → 1 hour (static catalog)
//   • other GET /api → 5 minutes, private
//   • mutations + everything else → no-store
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') {
    if (req.path === '/foods' || /^\/foods\//.test(req.path)) {
      res.set('Cache-Control', 'public, max-age=3600');
    } else {
      res.set('Cache-Control', 'private, max-age=300');
    }
  } else {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Rate limiting — generous global cap, tighter on auth/AI to deter abuse.
if (rateLimit) {
  const std = { standardHeaders: true, legacyHeaders: false };
  app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, ...std,
    message: { error: 'Too many requests — slow down and try again shortly.' } }));
  const tight = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, ...std,
    message: { error: 'Too many attempts. Please wait a few minutes and retry.' } });
  app.use(['/api/login', '/api/register', '/api/auth'], tight);
  app.use(['/api/ai', '/api/recipes'], rateLimit({ windowMs: 60 * 1000, max: 60, ...std,
    message: { error: 'Too many requests — please pause a moment.' } }));
}

// Static assets — long-lived immutable cache, except HTML which must revalidate.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.html$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(?:js|css|png|jpg|jpeg|webp|svg|gif|woff2?|glb|mp4|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// The Stripe webhook needs the raw request body for signature verification,
// so JSON parsing is skipped for that one route (it uses express.raw instead).
app.use((req, res, next) => {
  if (req.originalUrl === '/api/webhook/stripe') return next();
  express.json()(req, res, next);
});

// Google Gemini — primary AI provider for the nutrition chat assistant
let genAI = null;
try {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const key = process.env.GEMINI_API_KEY;
  if (key && key !== 'your_key_here' && key.length > 12) {
    genAI = new GoogleGenerativeAI(key);
  }
} catch (e) { /* SDK not installed or no key — fall back to built-in assistant */ }

// ─── Stripe (subscription payments) ──────────────────────────────────────
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
} catch (e) { /* stripe SDK not installed — payment routes return 503 */ }

// plan + billing cycle → Stripe Price ID (created via scripts/setup-stripe-prices.js)
const STRIPE_PRICES = {
  pro:   { monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,   annual: process.env.STRIPE_PRICE_PRO_ANNUAL },
  elite: { monthly: process.env.STRIPE_PRICE_ELITE_MONTHLY, annual: process.env.STRIPE_PRICE_ELITE_ANNUAL },
};

// ─── Email (Nodemailer) — registration verification codes ────────────────
let mailer = null;
try {
  const nodemailer = require('nodemailer');
  const u = process.env.EMAIL_USER, p = process.env.EMAIL_PASS;
  // Real email whenever both creds are present; otherwise the send-code endpoint
  // uses the dev-code fallback. No placeholder-string matching.
  if (u && p) {
    mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: u, pass: p } });
  }
} catch (e) { /* nodemailer not installed — falls back to dev code in response */ }

// Startup diagnostic — confirms whether email creds were loaded from .env
console.log('Email configured:', !!mailer, '| EMAIL_USER set:', !!process.env.EMAIL_USER);

// In-memory pending registrations: email -> { name, email, passwordHash, code, expiresAt, lastSent }
const pendingVerifications = new Map();
const VERIFY_TTL = 10 * 60 * 1000; // 10 minutes

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

function verificationEmailHTML(code) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#080c14;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:8px;">
      <span style="font-size:26px;font-weight:700;letter-spacing:-0.02em;color:#f8fafc;">Nutri<span style="color:#22c55e;">Fell</span></span>
    </div>
    <div style="background:#0d1117;border:1px solid rgba(255,255,255,0.08);border-radius:18px;padding:36px 32px;text-align:center;">
      <p style="color:#94a3b8;font-size:15px;margin:0 0 18px;">Your verification code is:</p>
      <div style="font-size:44px;font-weight:800;letter-spacing:10px;color:#22c55e;font-family:'Courier New',monospace;margin:8px 0 22px;">${code}</div>
      <p style="color:#64748b;font-size:13px;margin:0 0 6px;">⏱ Code expires in 10 minutes</p>
      <p style="color:#475569;font-size:12px;margin:18px 0 0;line-height:1.6;">If you didn't request this, you can safely ignore this email.</p>
    </div>
    <p style="text-align:center;color:#334155;font-size:11px;margin-top:24px;">NutriFell · Fuel Your Best Self</p>
  </div>
</body></html>`;
}

async function sendVerificationEmail(to, code) {
  if (!mailer) return false;
  console.log('Sending real email to:', to);
  console.log('From:', process.env.EMAIL_USER);
  await mailer.sendMail({
    from: `"NutriFell" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Your NutriFell verification code',
    html: verificationEmailHTML(code),
  });
  return true;
}

// ─── File uploads (Multer + optional Sharp resize) ──────────────────────
let multer = null, sharp = null;
try { multer = require('multer'); } catch (e) { /* uploads disabled until installed */ }
try { sharp = require('sharp'); } catch (e) { /* resize skipped if unavailable */ }

// ─── Data storage (server-side JSON files) ──────────────────────────────
// .trim() guards against a stray trailing space/newline in .env so the secret
// used to SIGN is byte-for-byte identical to the one used to VERIFY.
const JWT_SECRET = (process.env.JWT_SECRET || 'nutrifell-georgia-secret-key-2035').trim();
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const FRIDGES_FILE = path.join(DATA_DIR, 'fridges.json');
const MEALPLANS_FILE = path.join(DATA_DIR, 'mealplans.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const WATER_FILE = path.join(DATA_DIR, 'water.json');
const SMOKING_FILE = path.join(DATA_DIR, 'smoking.json');
const RECIPES_FILE = path.join(DATA_DIR, 'recipes.json');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
const REACTIONS_FILE = path.join(DATA_DIR, 'reactions.json');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const WAITLIST_FILE = path.join(DATA_DIR, 'waitlist.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'recipes');
// ── Social feed stores (Phase 1) ──
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const FOLLOWS_FILE = path.join(DATA_DIR, 'follows.json');
const POST_REACTIONS_FILE = path.join(DATA_DIR, 'post_reactions.json');
const POST_COMMENTS_FILE = path.join(DATA_DIR, 'post_comments.json');
const POST_SAVES_FILE = path.join(DATA_DIR, 'post_saves.json');
const POST_REPORTS_FILE = path.join(DATA_DIR, 'post_reports.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const HASHTAG_FOLLOWS_FILE = path.join(DATA_DIR, 'hashtag_follows.json');
const POSTS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'posts');
const REELS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'reels');
const AVATARS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
const COVERS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'covers');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const d of [UPLOADS_DIR, POSTS_UPLOAD_DIR, REELS_UPLOAD_DIR, AVATARS_UPLOAD_DIR, COVERS_UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
for (const f of [USERS_FILE, FRIDGES_FILE, MEALPLANS_FILE, LOGS_FILE, WATER_FILE,
  SMOKING_FILE, RECIPES_FILE, COMMENTS_FILE, REACTIONS_FILE, BOOKMARKS_FILE, REPORTS_FILE,
  WAITLIST_FILE, POSTS_FILE, FOLLOWS_FILE, POST_REACTIONS_FILE, POST_COMMENTS_FILE,
  POST_SAVES_FILE, POST_REPORTS_FILE, NOTIFICATIONS_FILE, HASHTAG_FOLLOWS_FILE]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '[]', 'utf8');
}

// ─── FREE LAUNCH (BETA) ──────────────────────────────────────────────────
// During the beta launch every feature is unlocked for everyone and paid
// checkout is turned off. Flip FREE_LAUNCH to false (env) to re-enable Stripe
// subscriptions when paid plans go live. The pricing page reads this via
// GET /api/launch-status to show the "Free Launch" banner + waitlist.
const FREE_LAUNCH = process.env.FREE_LAUNCH !== 'false';
// In-memory JSON cache keyed by file path + last-modified time. Reads skip the
// disk parse when the file is unchanged; writes refresh the cache immediately,
// and an external edit busts it automatically via the mtime check.
const _jsonCache = new Map();
const readJSON = (f) => {
  try {
    const mtime = fs.statSync(f).mtimeMs;
    const hit = _jsonCache.get(f);
    // Return a clone so callers that mutate the result before (or without)
    // writing can never corrupt the shared cache entry.
    if (hit && hit.mtime === mtime) return structuredClone(hit.data);
    const data = JSON.parse(fs.readFileSync(f, 'utf8') || '[]');
    _jsonCache.set(f, { mtime, data });
    return structuredClone(data);
  } catch { return []; }
};
const writeJSON = (f, data) => {
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
  try { _jsonCache.set(f, { mtime: fs.statSync(f).mtimeMs, data }); } catch {}
};
const publicUser = (u) => { const { password, ...rest } = u; return rest; };

// JWT auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // A signature-valid token whose user no longer exists is a dead session
  // (e.g. data reset, or a token from a previous run). Return 401 — NOT 404 —
  // so the client clears it and routes to login, instead of every endpoint
  // failing with a confusing "User not found" (notably on profile Save).
  const user = readJSON(USERS_FILE).find(u => u.id === payload.id);
  if (!user) {
    console.warn('Auth: token valid but user missing:', payload.id);
    return res.status(401).json({ error: 'Session no longer valid — please log in again' });
  }
  req.userId = payload.id;
  req.user = user;
  next();
}

// Activity multipliers
const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, extreme: 1.9 };
const CALS_PER_KG = 7700;
const MAX_DEFICIT = -1000;   // 2 kg/week max loss
const MAX_SURPLUS = 500;     // 0.5 kg/week max gain

// Advanced Mifflin-St Jeor + target-weight/timeline calorie engine
function calcCalories(p) {
  if (!p || !p.weight || !p.height || !p.age) return null;
  const gender = p.gender === 'female' ? 'female' : 'male';
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (gender === 'female' ? -161 : 5);
  const mult = ACTIVITY[p.activityLevel] || 1.55;
  const tdee = bmr * mult;

  const current = Number(p.weight);
  const targetW = (p.targetWeight != null && p.targetWeight !== '') ? Number(p.targetWeight) : current;
  const weeks = Number(p.timeline) || 12;
  const diff = +(targetW - current).toFixed(2);                 // +gain / -lose (kg)
  const direction = diff < -0.05 ? 'lose' : diff > 0.05 ? 'gain' : 'maintain';

  const totalCals = diff * CALS_PER_KG;
  const requestedDaily = weeks > 0 ? totalCals / (weeks * 7) : 0; // +surplus / -deficit

  let dailyAdjust = requestedDaily;
  let warning = null, suggestedWeeks = null;
  if (requestedDaily < MAX_DEFICIT) {
    dailyAdjust = MAX_DEFICIT;
    suggestedWeeks = Math.ceil(Math.abs(totalCals) / (Math.abs(MAX_DEFICIT) * 7));
    warning = `This pace is too aggressive. Losing more than 1kg/week can cause muscle loss and nutrient deficiencies. We recommend ${suggestedWeeks} weeks instead for healthy results.`;
  } else if (requestedDaily > MAX_SURPLUS) {
    dailyAdjust = MAX_SURPLUS;
    suggestedWeeks = Math.ceil(totalCals / (MAX_SURPLUS * 7));
    warning = `This pace is too aggressive. Gaining more than 0.5kg/week tends to add fat rather than muscle. We recommend ${suggestedWeeks} weeks instead for lean results.`;
  }

  let target = Math.round(tdee + dailyAdjust);
  const minCal = gender === 'female' ? 1200 : 1500;
  let minClamped = false;
  if (target < minCal) { target = minCal; dailyAdjust = Math.round(target - tdee); minClamped = true; }

  const weeklyChange = +((dailyAdjust * 7) / CALS_PER_KG).toFixed(3);  // signed kg/week
  let effWeeks = weeks;
  if (direction === 'maintain') effWeeks = 0;
  else if (Math.abs(weeklyChange) > 0.0001) effWeeks = Math.abs(diff / weeklyChange);
  effWeeks = Math.round(effWeeks * 10) / 10;

  const completionDate = direction === 'maintain'
    ? null
    : new Date(Date.now() + effWeeks * 7 * 86400000).toISOString().slice(0, 10);

  const prediction = [];
  const totalWeeks = Math.min(Math.max(Math.ceil(effWeeks), 1), 52);
  for (let w = 0; w <= totalWeeks; w++) {
    let val = current + weeklyChange * w;
    if (direction === 'lose') val = Math.max(val, targetW);
    if (direction === 'gain') val = Math.min(val, targetW);
    prediction.push({ week: w, weight: +val.toFixed(1) });
  }

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    target,
    dailyAdjust: Math.round(dailyAdjust),
    weeklyChange,
    direction,
    goalKg: +Math.abs(diff).toFixed(1),
    currentWeight: current,
    targetWeight: targetW,
    weeks,
    effWeeks,
    completionDate,
    minClamped,
    warning,
    suggestedWeeks,
    activityMultiplier: mult,
    protein: Math.round((target * 0.30) / 4),
    carbs: Math.round((target * 0.40) / 4),
    fats: Math.round((target * 0.30) / 9),
    prediction,
  };
}

const foods = [
  {
    id: 'apple',
    name: 'Apple',
    emoji: '🍎',
    color: '#e74c3c',
    calories: 52,
    nutrition: { protein: 0.3, carbs: 14, fat: 0.2, fiber: 2.4, vitaminC: 7.2, vitaminK: 2.4, vitaminB6: 0.02 },
    benefits: [
      'Rich in antioxidants and quercetin',
      'High dietary fiber supports digestion',
      'May reduce risk of heart disease',
      'Supports gut microbiome health',
      'Natural energy boost from fructose'
    ],
    drawbacks: [
      'High natural sugar content',
      'May cause blood sugar spikes in diabetics',
      'Pesticide residue risk if non-organic',
      'Acidic — can affect tooth enamel'
    ],
    description: 'A crisp, sweet fruit packed with fiber and vitamin C.',
    serving: '100g'
  },
  {
    id: 'banana',
    name: 'Banana',
    emoji: '🍌',
    color: '#f1c40f',
    calories: 89,
    nutrition: { protein: 1.1, carbs: 23, fat: 0.3, fiber: 2.6, vitaminB6: 0.34, vitaminC: 8.1, potassium: 376 },
    benefits: [
      'Excellent source of potassium for heart health',
      'Provides quick, sustained energy',
      'Rich in vitamin B6 for brain health',
      'Contains dopamine antioxidants',
      'Supports muscle recovery post-exercise'
    ],
    drawbacks: [
      'High glycemic index when ripe',
      'High in sugar compared to other fruits',
      'Not ideal for low-carb diets',
      'Unripe bananas can cause bloating'
    ],
    description: 'A tropical fruit rich in potassium and natural energy.',
    serving: '100g'
  },
  {
    id: 'chicken',
    name: 'Chicken Breast',
    emoji: '🍗',
    color: '#f39c12',
    calories: 165,
    nutrition: { protein: 31, carbs: 0, fat: 3.6, fiber: 0, vitaminB6: 0.85, vitaminB12: 0.48, niacin: 9.6 },
    benefits: [
      'Highest protein-to-calorie ratio of common meats',
      'Complete amino acid profile for muscle building',
      'Low in saturated fat',
      'Rich in niacin for metabolic health',
      'Supports immune function via zinc and selenium'
    ],
    drawbacks: [
      'Can become dry/tough if overcooked',
      'Factory-farmed versions may contain antibiotics',
      'Low in omega-3 fatty acids',
      'Minimal micronutrient diversity'
    ],
    description: 'Lean protein powerhouse ideal for muscle growth and repair.',
    serving: '100g'
  },
  {
    id: 'fish',
    name: 'Fish (Salmon)',
    emoji: '🐟',
    color: '#e67e22',
    calories: 208,
    nutrition: { protein: 20, carbs: 0, fat: 13, fiber: 0, omega3: 2.3, vitaminD: 600, vitaminB12: 1.22, selenium: 19.8 },
    benefits: [
      'Highest dietary source of omega-3 fatty acids',
      'Reduces inflammation throughout the body',
      'Exceptional source of vitamin D',
      'Supports brain health and cognitive function',
      'Linked to reduced cardiovascular disease risk'
    ],
    drawbacks: [
      'Higher mercury levels in larger species',
      'Farmed salmon may contain PCBs',
      'Expensive compared to other proteins',
      'Allergenic for fish-sensitive individuals'
    ],
    description: 'Omega-3 rich fatty fish with exceptional cardiovascular benefits.',
    serving: '100g'
  },
  {
    id: 'almond',
    name: 'Almond',
    emoji: '🥜',
    color: '#8B6914',
    calories: 579,
    nutrition: { protein: 21, carbs: 22, fat: 49, fiber: 12.5, vitaminE: 20.6, magnesium: 281, calcium: 260 },
    benefits: [
      'Outstanding source of vitamin E antioxidant',
      'Rich in monounsaturated heart-healthy fats',
      'High magnesium supports blood sugar control',
      'Reduces LDL cholesterol levels',
      'Promotes satiety and weight management'
    ],
    drawbacks: [
      'Very calorie-dense — easy to overeat',
      'Contains oxalates that may affect kidney stones',
      'Common allergen (tree nut)',
      'Phytic acid can reduce mineral absorption'
    ],
    description: 'Nutrient-dense tree nut rich in healthy fats and vitamin E.',
    serving: '100g'
  },
  {
    id: 'egg',
    name: 'Eggs',
    emoji: '🥚',
    color: '#F5E6C8',
    calories: 155,
    nutrition: { protein: 13, carbs: 1.1, fat: 11, fiber: 0, vitaminB12: 1.1, selenium: 24.2, choline: 330 },
    benefits: [
      'Complete protein with all 9 essential amino acids',
      'Rich in choline for brain health and memory',
      'Lutein and zeaxanthin support eye health',
      'Most affordable high-quality protein source',
      'Supports muscle building and repair'
    ],
    drawbacks: [
      'High dietary cholesterol (though largely benign for most people)',
      'Common allergen — affects ~1-2% of children',
      'Must be cooked properly to avoid Salmonella risk',
      'Factory-farmed eggs lower in omega-3 than pasture-raised'
    ],
    description: "Nature's most complete food — affordable, versatile, and nutritionally dense.",
    serving: '100g'
  },
  {
    id: 'sweetpotato',
    name: 'Sweet Potato',
    emoji: '🍠',
    color: '#E8611A',
    calories: 86,
    nutrition: { protein: 1.6, carbs: 20, fat: 0.1, fiber: 3, vitaminA: 2556, vitaminC: 3.6, vitaminB6: 0.24 },
    benefits: [
      'Extraordinary beta-carotene source — over 960% daily vitamin A',
      'Powerful anti-inflammatory carotenoids',
      'Complex carbs provide sustained, stable energy',
      'High fiber supports gut health and satiety',
      'Naturally sweet with no added sugar'
    ],
    drawbacks: [
      'High glycemic index — can spike blood sugar when baked',
      'High carbohydrate content (not keto-friendly)',
      'Can cause bloating and gas if eaten in large amounts',
      'Oxalates may be a concern for kidney stone prone individuals'
    ],
    description: 'An orange root vegetable loaded with beta-carotene, fiber, and complex carbs.',
    serving: '100g'
  },
  {
    id: 'broccoli', name: 'Broccoli', emoji: '🥦', color: '#22863a', calories: 34,
    nutrition: { protein: 2.8, carbs: 7, fiber: 2.6, fat: 0.4, vitaminC: 80.1, vitaminK: 92.4, folate: 56 },
    benefits: [
      'Cancer-fighting sulforaphane compound',
      'Exceptional vitamin K supports bone density',
      'High vitamin C boosts immune system',
      'Powerful anti-inflammatory antioxidants',
      'High fiber supports healthy digestion'
    ],
    drawbacks: [
      'Can cause bloating and gas from raffinose fiber',
      'Goitrogens may interfere with thyroid if eaten raw in large amounts',
      'Bitter taste when overcooked'
    ],
    description: 'A cruciferous vegetable powerhouse loaded with cancer-fighting sulforaphane.',
    serving: '100g'
  },
  {
    id: 'avocado', name: 'Avocado', emoji: '🥑', color: '#355e3b', calories: 160,
    nutrition: { protein: 2, carbs: 9, fiber: 7, fat: 15, vitaminK: 31.2, folate: 80, vitaminB6: 0.22 },
    benefits: [
      'Rich in heart-healthy monounsaturated fats',
      'High folate supports brain and cell health',
      'Boosts absorption of fat-soluble vitamins from other foods',
      'Promotes healthy skin and reduces inflammation',
      'Reduces LDL (bad) cholesterol levels'
    ],
    drawbacks: [
      'Very calorie-dense — easy to overeat',
      'Expensive and seasonal',
      'High fat content (though mostly healthy)'
    ],
    description: 'A creamy, nutrient-rich fruit packed with heart-healthy fats and folate.',
    serving: '100g'
  },
  {
    id: 'blueberry', name: 'Blueberries', emoji: '🫐', color: '#4b3b8c', calories: 57,
    nutrition: { protein: 0.7, carbs: 14, fiber: 2.4, fat: 0.3, vitaminC: 14.4, vitaminK: 28.8, manganese: 0.39 },
    benefits: [
      'Highest antioxidant content of all common fruits',
      'Anthocyanins improve brain function and memory',
      'Reduces oxidative stress and anti-aging effects',
      'Supports heart health and lowers blood pressure',
      'Helps regulate blood sugar levels'
    ],
    drawbacks: [
      'Can stain teeth with regular consumption',
      'High in natural sugars',
      'Expensive when out of season'
    ],
    description: 'A small but mighty berry with the highest antioxidant capacity of any common fruit.',
    serving: '100g'
  },
  {
    id: 'spinach', name: 'Spinach', emoji: '🥬', color: '#2d6a2f', calories: 23,
    nutrition: { protein: 2.9, carbs: 3.6, fiber: 2.2, fat: 0.4, vitaminK: 552, vitaminA: 1692, folate: 196, vitaminC: 42.3 },
    benefits: [
      'Extraordinary vitamin K content for bone health',
      'Lutein and zeaxanthin protect eye health',
      'Iron supports healthy blood and oxygen transport',
      'Extremely low calorie — virtually free nutrition',
      'Powerful anti-inflammatory flavonoids'
    ],
    drawbacks: [
      'Oxalates block calcium and iron absorption',
      'High vitamin K interacts with blood thinners',
      'Can contribute to kidney stones in excess'
    ],
    description: 'One of the most nutrient-dense foods on earth — extremely high vitamin K with near-zero calories.',
    serving: '100g'
  },
  {
    id: 'greekyogurt', name: 'Greek Yogurt', emoji: '🍦', color: '#f0ede6', calories: 59,
    nutrition: { protein: 10, carbs: 3.6, fiber: 0, fat: 0.4, vitaminB12: 0.31, calcium: 110, phosphorus: 90 },
    benefits: [
      'Extremely high protein — twice that of regular yogurt',
      'Probiotics support gut health and immune function',
      'High calcium and phosphorus for strong bones',
      'Promotes satiety and supports weight management',
      'Fast muscle recovery after exercise'
    ],
    drawbacks: [
      'Lactose intolerance can cause digestive discomfort',
      'Flavored versions often loaded with added sugar',
      'More expensive than regular yogurt'
    ],
    description: 'A strained yogurt with double the protein of regular yogurt and powerful probiotic benefits.',
    serving: '100g'
  },
  {
    id: 'carrot', name: 'Carrot', emoji: '🥕', color: '#f97316', calories: 41,
    nutrition: { protein: 0.9, carbs: 10, fiber: 2.8, fat: 0.2, vitaminA: 3006, vitaminK: 15.6, vitaminB6: 0.14 },
    benefits: [
      'Extraordinary beta-carotene source for vision and immune health',
      'Antioxidants reduce risk of certain cancers',
      'Supports healthy skin from the inside out',
      'Excellent low-calorie snack with satisfying crunch',
      'Biotin supports hair and nail health'
    ],
    drawbacks: [
      'High glycemic index when cooked',
      'Excessive consumption can turn skin orange (carotenemia)',
      'Low in complete protein'
    ],
    description: 'An orange root packed with beta-carotene — one of the best plant sources of vitamin A.',
    serving: '100g'
  },
  {
    id: 'oats', name: 'Oats', emoji: '🥣', color: '#d4a853', calories: 389,
    nutrition: { protein: 17, carbs: 66, fiber: 10.6, fat: 7, manganese: 5.66, phosphorus: 520, magnesium: 185 },
    benefits: [
      'Beta-glucan fiber clinically proven to lower LDL cholesterol',
      'Sustained slow-release energy from complex carbohydrates',
      'Prebiotic fiber supports beneficial gut bacteria',
      'Helps stabilize blood sugar after meals',
      'One of the best plant-based sources of manganese'
    ],
    drawbacks: [
      'High in carbohydrates — not ideal for keto/low-carb',
      'Risk of gluten cross-contamination for celiac disease',
      'Phytic acid can reduce mineral absorption if not soaked'
    ],
    description: 'The gold standard breakfast grain — beta-glucan fiber actively lowers cholesterol.',
    serving: '100g'
  },
  {
    id: 'lemon', name: 'Lemon', emoji: '🍋', color: '#fde047', calories: 29,
    nutrition: { protein: 1.1, carbs: 9, fiber: 2.8, fat: 0.3, vitaminC: 79.2, vitaminB6: 0.1, folate: 12 },
    benefits: [
      'High vitamin C strengthens immune system',
      'Aids digestion and promotes bile production',
      'Alkalizing effect despite acidic taste',
      'Antibacterial properties from limonene',
      'Brightens skin and reduces hyperpigmentation'
    ],
    drawbacks: [
      'Highly acidic — erodes tooth enamel with frequent contact',
      'Can trigger acid reflux in sensitive individuals',
      'Needs to be combined — too sour to eat alone'
    ],
    description: 'A tangy citrus powerhouse with high vitamin C and powerful digestive benefits.',
    serving: '100g'
  },
  {
    id: 'walnut', name: 'Walnuts', emoji: '🫘', color: '#8b5e3c', calories: 654,
    nutrition: { protein: 15, carbs: 14, fiber: 6.7, fat: 65, omega3: 9, manganese: 3.75, copper: 0.7 },
    benefits: [
      'Highest omega-3 content of all tree nuts',
      'Compounds that directly support brain health',
      'Reduces inflammation throughout the body',
      'Lowers LDL cholesterol and blood pressure',
      'Contains melatonin to support sleep quality'
    ],
    drawbacks: [
      'Very calorie-dense — easy to overconsume',
      'Expensive compared to other nuts',
      'Oxalates can contribute to kidney stones'
    ],
    description: 'Brain-shaped and brain-boosting — the richest nut source of plant-based omega-3.',
    serving: '100g'
  },
  {
    id: 'tomato', name: 'Tomato', emoji: '🍅', color: '#dc2626', calories: 18,
    nutrition: { protein: 0.9, carbs: 3.9, fiber: 1.2, fat: 0.2, vitaminC: 20.7, vitaminK: 9.6, lycopene: 2.6, vitaminA: 72 },
    benefits: [
      'Lycopene is a powerful antioxidant linked to cancer prevention',
      'Supports heart health and reduces cardiovascular risk',
      'UV skin protection from carotenoids',
      'Anti-inflammatory and immune-boosting properties',
      'Extremely low in calories for volume of nutrition'
    ],
    drawbacks: [
      'Acidic — can trigger acid reflux or heartburn',
      'Nightshade sensitivity in some individuals',
      'Lycopene bioavailability is highest only when cooked'
    ],
    description: 'A lycopene-rich red fruit with powerful cancer-preventive antioxidant properties.',
    serving: '100g'
  },
  {
    id: 'garlic', name: 'Garlic', emoji: '🧄', color: '#f5f0e0', calories: 149,
    nutrition: { protein: 6.4, carbs: 33, fiber: 2.1, fat: 0.5, vitaminB6: 1.62, vitaminC: 34.2, manganese: 1.68 },
    benefits: [
      'Allicin compound has potent antibacterial and antiviral effects',
      'Clinically proven to lower blood pressure',
      'Boosts immune system function',
      'Anti-cancer properties from organosulfur compounds',
      'Functions as a natural antibiotic'
    ],
    drawbacks: [
      'Strong breath and body odor after consumption',
      'Can cause digestive upset and bloating',
      'Blood-thinning interaction with medications',
      'Very pungent flavor requires careful culinary use'
    ],
    description: 'The original medicine — allicin makes garlic one of the most powerful natural antibiotics.',
    serving: '100g'
  },
  {
    id: 'darkchocolate', name: 'Dark Chocolate', emoji: '🍫', color: '#3d1a0a', calories: 598,
    nutrition: { protein: 7.8, carbs: 46, fiber: 10.9, fat: 43, iron: 12.06, magnesium: 244, copper: 0.8, manganese: 2.25 },
    benefits: [
      'Richest food source of antioxidant flavonoids',
      'Theobromine and serotonin precursors improve mood',
      'Reduces LDL oxidation and supports heart health',
      'Improves brain blood flow and cognitive function',
      'Magnesium supports muscle and nerve function'
    ],
    drawbacks: [
      'High in calories — easy to overindulge',
      'Contains caffeine (may affect sleep)',
      'High fat content despite being healthy fat',
      'Sugar content varies significantly by brand'
    ],
    description: 'Luxury nutrition — high-cacao dark chocolate is one of the best antioxidant foods on earth.',
    serving: '100g'
  },
  {
    id: 'kiwi', name: 'Kiwi', emoji: '🥝', color: '#4d7c0f', calories: 61,
    nutrition: { protein: 1.1, carbs: 15, fiber: 3, fat: 0.5, vitaminC: 138.6, vitaminK: 48, vitaminE: 1.5 },
    benefits: [
      'Higher vitamin C per gram than oranges',
      'Improves sleep quality via serotonin pathway',
      'Actinidin enzyme aids protein digestion',
      'Controls blood pressure via potassium balance',
      'Antioxidants protect skin from UV damage'
    ],
    drawbacks: [
      'Oral allergy syndrome in some individuals',
      'Oxalates can aggravate kidney stone risk',
      'Can be expensive depending on region'
    ],
    description: 'A furry brown fruit hiding extraordinary vitamin C and sleep-improving compounds.',
    serving: '100g'
  },
  {
    id: 'quinoa', name: 'Quinoa', emoji: '🌾', color: '#d4c5a0', calories: 368,
    nutrition: { protein: 14, carbs: 64, fiber: 7, fat: 6, manganese: 2.14, phosphorus: 590, magnesium: 206 },
    benefits: [
      'One of the few plant foods containing all 9 essential amino acids',
      'Naturally gluten-free — safe for celiac disease',
      'High fiber supports gut health and satiety',
      'Low glycemic index despite high carb content',
      'Exceptionally rich in magnesium and manganese'
    ],
    drawbacks: [
      'High in carbohydrates for a "protein food"',
      'Saponin coating must be rinsed before cooking',
      'More expensive than rice or pasta',
      'High oxalate content'
    ],
    description: 'The complete plant protein — one of only a few plant foods with all essential amino acids.',
    serving: '100g'
  },
  {
    id: 'ginger', name: 'Ginger', emoji: '🫚', color: '#c8a96e', calories: 80,
    nutrition: { protein: 1.8, carbs: 18, fiber: 2, fat: 0.8, vitaminB6: 0.19, magnesium: 42, potassium: 329 },
    benefits: [
      'Gingerol is a uniquely potent anti-inflammatory compound',
      'Clinically proven to relieve nausea and morning sickness',
      'Reduces exercise-induced muscle pain and soreness',
      'Lowers blood sugar and improves insulin sensitivity',
      'Powerful digestive aid for bloating and discomfort'
    ],
    drawbacks: [
      'Blood-thinning properties interact with medications',
      'Can cause heartburn in sensitive individuals',
      'Very strong spicy flavor requires careful dosing',
      'Not safe in large medicinal doses during pregnancy'
    ],
    description: 'A knobby root with extraordinary anti-inflammatory power from its active compound gingerol.',
    serving: '100g'
  },
  {
    id: 'whiterice', name: 'White Rice', emoji: '🍚', color: '#f5f5f0', calories: 130,
    nutrition: { protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4, manganese: 0.32, thiamine: 0.12, niacin: 1.28 },
    benefits: [
      'Fast, easily accessible energy source',
      'Very easy to digest — gentle on the stomach',
      'Naturally gluten-free',
      'Versatile staple that pairs with almost anything',
      'Naturally low in fat'
    ],
    drawbacks: [
      'Low in fiber compared to whole grains',
      'High glycemic index — spikes blood sugar quickly',
      'Nutrient-poor relative to brown rice',
      'Minimal protein and micronutrient density'
    ],
    description: 'A fluffy, easily digestible staple grain — quick energy that pairs with everything.',
    serving: '100g'
  },
  {
    id: 'brownrice', name: 'Brown Rice', emoji: '🍚', color: '#b08d57', calories: 111,
    nutrition: { protein: 2.6, carbs: 23, fat: 0.9, fiber: 1.8, manganese: 1.04, magnesium: 46, phosphorus: 80 },
    benefits: [
      'Much higher fiber than white rice',
      'Sustained, slow-release energy',
      'Supports heart health via whole-grain compounds',
      'Better blood sugar control than white rice',
      'Exceptionally rich in manganese and magnesium'
    ],
    drawbacks: [
      'Longer cooking time than white rice',
      'Harder to digest for some people',
      'Can contain trace arsenic from the bran layer',
      'Shorter shelf life due to natural oils'
    ],
    description: 'The whole-grain rice — bran and germ intact for far more fiber and minerals.',
    serving: '100g'
  },
  {
    id: 'wholewheatbread', name: 'Whole Wheat Bread', emoji: '🍞', color: '#b5793a', calories: 247,
    nutrition: { protein: 13, carbs: 41, fat: 3.4, fiber: 7, manganese: 3.75, selenium: 34.1, thiamine: 0.46 },
    benefits: [
      'Higher fiber than refined white bread',
      'Sustained energy from complex carbohydrates',
      'Whole grains support heart health',
      'Prebiotic fiber supports gut health',
      'Good source of B vitamins'
    ],
    drawbacks: [
      'Contains gluten — unsuitable for celiac disease',
      'Phytic acid can reduce mineral absorption',
      'Some commercial brands add sugar',
      'Calorie-dense if eaten in large amounts'
    ],
    description: 'Whole-grain bread with intact bran — far more fiber and B vitamins than white.',
    serving: '100g'
  },
  {
    id: 'pasta', name: 'Pasta', emoji: '🍝', color: '#e8cd6d', calories: 158,
    nutrition: { protein: 5.8, carbs: 31, fat: 0.9, fiber: 1.8, selenium: 14.3, manganese: 0.37, folate: 28 },
    benefits: [
      'Reliable energy source for active days',
      'High in selenium for antioxidant defense',
      'Endlessly versatile culinary base',
      'Filling and satisfying',
      'Lower glycemic index than white bread'
    ],
    drawbacks: [
      'High in carbohydrates',
      'Usually made from refined flour',
      'Contains gluten',
      'Very easy to overeat large portions',
      'Low nutrient density unless whole-grain'
    ],
    description: 'A beloved energy staple — high in selenium and endlessly versatile.',
    serving: '100g'
  },
  {
    id: 'corn', name: 'Corn', emoji: '🌽', color: '#f5c542', calories: 86,
    nutrition: { protein: 3.2, carbs: 19, fat: 1.2, fiber: 2.4, thiamine: 0.18, vitaminB6: 0.14, folate: 28 },
    benefits: [
      'Rich in eye-protecting antioxidants lutein and zeaxanthin',
      'Good source of dietary fiber',
      'Satisfying natural energy source',
      'Naturally gluten-free',
      'Versatile across countless dishes'
    ],
    drawbacks: [
      'Higher in natural sugar than most vegetables',
      'Often genetically modified',
      'High glycemic index',
      'Lower-quality protein profile',
      'Can cause bloating in some people'
    ],
    description: 'A sweet, antioxidant-rich grain vegetable loaded with eye-protecting carotenoids.',
    serving: '100g'
  },
  {
    id: 'lentils', name: 'Lentils', emoji: '🫘', color: '#6b8e23', calories: 116,
    nutrition: { protein: 9, carbs: 20, fat: 0.4, fiber: 7.9, folate: 180, manganese: 0.58, iron: 3.42 },
    benefits: [
      'Extraordinarily high in dietary fiber',
      'Excellent plant-based protein source',
      'Helps control blood sugar levels',
      'Supports heart health',
      'Strong source of plant iron and folate'
    ],
    drawbacks: [
      'Can cause gas and bloating',
      'Contains antinutrients that reduce mineral absorption',
      'Requires longer cooking time',
      'Lower in some essential amino acids'
    ],
    description: 'A fiber-and-protein powerhouse legume — one of the best plant iron sources.',
    serving: '100g'
  },
  {
    id: 'blackbeans', name: 'Black Beans', emoji: '🫘', color: '#2a2a2e', calories: 132,
    nutrition: { protein: 8.9, carbs: 24, fat: 0.5, fiber: 8.7, folate: 148, manganese: 0.51, thiamine: 0.19 },
    benefits: [
      'Powerful fiber-plus-protein combination',
      'Supports heart health',
      'Helps stabilize blood sugar',
      'Antioxidant anthocyanins from the dark skin',
      'An inexpensive nutritional superfood'
    ],
    drawbacks: [
      'Can cause gas and bloating',
      'Antinutrients — soak before cooking',
      'High in carbohydrates',
      'Incomplete protein on its own'
    ],
    description: 'A glossy antioxidant-rich legume delivering an exceptional fiber-and-protein combo.',
    serving: '100g'
  },
  {
    id: 'chickpeas', name: 'Chickpeas', emoji: '🫛', color: '#e3c79a', calories: 164,
    nutrition: { protein: 8.9, carbs: 27, fat: 2.6, fiber: 7.6, folate: 172, manganese: 1.2, copper: 0.16 },
    benefits: [
      'High in both fiber and plant protein',
      'Helps control blood sugar',
      'Promotes satiety and weight management',
      'Supports heart health',
      'Incredibly versatile — the base of hummus'
    ],
    drawbacks: [
      'High in carbohydrates',
      'Can cause gas and bloating',
      'Contains antinutrients',
      'Not a complete protein on its own'
    ],
    description: 'A versatile, mineral-dense legume — the protein-packed foundation of hummus.',
    serving: '100g'
  },
  {
    id: 'corntortilla', name: 'Corn Tortilla', emoji: '🫓', color: '#ecd9a0', calories: 218,
    nutrition: { protein: 5.7, carbs: 46, fat: 2.5, fiber: 6.7, calcium: 90, iron: 1.98, magnesium: 34 },
    benefits: [
      'Naturally gluten-free',
      'Low in calories',
      'Easy to digest',
      'Versatile traditional staple',
      'Nixtamalized corn provides bioavailable calcium'
    ],
    drawbacks: [
      'Low overall nutrient density',
      'High glycemic index',
      'Low in protein',
      'Often made from refined corn masa'
    ],
    description: 'A traditional gluten-free flatbread — light, foldable, and endlessly versatile.',
    serving: '100g'
  },
  {
    id: 'buckwheat', name: 'Buckwheat', emoji: '🌾', color: '#a8825a', calories: 92,
    nutrition: { protein: 3.4, carbs: 20, fat: 0.6, fiber: 2.7, manganese: 0.46, copper: 0.06, magnesium: 29 },
    benefits: [
      'A complete protein with all essential amino acids',
      'Naturally gluten-free despite the name',
      'Supports heart health',
      'Helps regulate blood sugar',
      'Rich in the antioxidant rutin'
    ],
    drawbacks: [
      'Distinctive earthy taste some dislike',
      'Less widely available',
      'Can trigger allergies in sensitive people',
      'Strong flavor dominates mild dishes'
    ],
    description: 'A gluten-free pseudo-grain that is a rare complete plant protein, rich in rutin.',
    serving: '100g'
  },
  {
    id: 'millet', name: 'Millet', emoji: '🌾', color: '#e6cf6a', calories: 119,
    nutrition: { protein: 3.5, carbs: 23, fat: 1, fiber: 1.3, manganese: 0.32, phosphorus: 100, magnesium: 38 },
    benefits: [
      'Gluten-free ancient grain',
      'Mildly alkaline-forming',
      'Supports heart health',
      'Gentle on blood sugar',
      'Easy to digest'
    ],
    drawbacks: [
      'Contains goitrogens that may affect the thyroid',
      'Low in the amino acid lysine',
      'Not widely known or used',
      'Bland flavor on its own'
    ],
    description: 'A tiny gluten-free ancient grain — alkaline-forming and gentle to digest.',
    serving: '100g'
  },
  {
    id: 'barley', name: 'Barley', emoji: '🌾', color: '#d8c89a', calories: 123,
    nutrition: { protein: 2.3, carbs: 28, fat: 0.4, fiber: 3.8, selenium: 6.05, manganese: 0.25, phosphorus: 60 },
    benefits: [
      'Beta-glucan fiber lowers cholesterol like oats',
      'Very high in dietary fiber',
      'Helps control blood sugar',
      'Supports gut and digestive health',
      'Promotes heart health'
    ],
    drawbacks: [
      'Contains gluten',
      'Phytic acid reduces mineral absorption',
      'High in carbohydrates',
      'Requires long cooking time'
    ],
    description: 'A chewy whole grain whose beta-glucan fiber actively lowers cholesterol.',
    serving: '100g'
  },
  {
    id: 'tuna', name: 'Tuna', emoji: '🐟', color: '#c8554d', calories: 116,
    nutrition: { protein: 26, carbs: 0, fat: 1, fiber: 0, vitaminB12: 1.97, selenium: 41.8, niacin: 8.64, vitaminD: 112 },
    benefits: [
      'Extremely high protein with minimal fat',
      'Naturally low in fat',
      'Contains heart-healthy omega-3 fatty acids',
      'Supports brain health and cognition',
      'Affordable and shelf-stable'
    ],
    drawbacks: [
      'Mercury content limits frequency',
      'Canned versions often high in sodium',
      'Overfishing and sustainability concerns',
      'Not recommended in large amounts for pregnant women'
    ],
    description: 'A lean, protein-dense fish loaded with B12 and selenium.',
    serving: '100g'
  },
  {
    id: 'turkey', name: 'Turkey Breast', emoji: '🦃', color: '#e8c4a0', calories: 135,
    nutrition: { protein: 30, carbs: 0, fat: 1, fiber: 0, vitaminB6: 0.99, vitaminB12: 0.58, selenium: 25.3, niacin: 8 },
    benefits: [
      'One of the leanest high-protein meats',
      'Tryptophan supports sleep and mood',
      'Very low in fat',
      'Rich in B vitamins for energy metabolism',
      'Excellent for weight management'
    ],
    drawbacks: [
      'Dries out easily if overcooked',
      'Milder flavor than chicken',
      'Often most available seasonally'
    ],
    description: 'The leanest of the poultry proteins — high protein with almost no fat.',
    serving: '100g'
  },
  {
    id: 'cottagecheese', name: 'Cottage Cheese', emoji: '🧀', color: '#f5f3ee', calories: 98,
    nutrition: { protein: 11, carbs: 3.4, fat: 4.3, fiber: 0, vitaminB12: 0.38, selenium: 7.7, calcium: 80, phosphorus: 160 },
    benefits: [
      'High in slow-release casein protein',
      'Ideal for overnight muscle recovery',
      'Low in calories for the protein it delivers',
      'Supports gut health',
      'Extremely versatile in the kitchen'
    ],
    drawbacks: [
      'Often high in sodium',
      'Problematic for the lactose intolerant',
      'Bland on its own',
      'Short refrigerated shelf life'
    ],
    description: 'A curd cheese rich in slow-digesting casein — perfect for overnight recovery.',
    serving: '100g'
  },
  {
    id: 'beef', name: 'Beef', emoji: '🥩', color: '#8b3a2f', calories: 250,
    nutrition: { protein: 26, carbs: 0, fat: 17, fiber: 0, vitaminB12: 2.35, zinc: 6.27, iron: 2.7, selenium: 16.5, niacin: 4.8 },
    benefits: [
      'Complete protein with all essential amino acids',
      'One of the richest food sources of B12',
      'High in bioavailable zinc and iron',
      'Excellent for muscle building',
      'Natural source of creatine'
    ],
    drawbacks: [
      'High in saturated fat',
      'Significant environmental footprint',
      'Excess linked to colorectal cancer risk',
      'More expensive than poultry'
    ],
    description: 'A complete protein and the richest everyday source of B12, zinc, and iron.',
    serving: '100g'
  },
  {
    id: 'pork', name: 'Pork Tenderloin', emoji: '🥓', color: '#e0a99a', calories: 143,
    nutrition: { protein: 26, carbs: 0, fat: 3.5, fiber: 0, thiamine: 0.65, vitaminB6: 0.63, vitaminB12: 0.43, selenium: 22, niacin: 6.24 },
    benefits: [
      'Lean cut with high-quality protein',
      'Highest thiamine of any meat',
      'Supports muscle building',
      'Rich in energy-releasing B vitamins',
      'One of the leanest pork cuts'
    ],
    drawbacks: [
      'Must be fully cooked (trichinosis risk)',
      'Less popular than other cuts',
      'Costs more than chicken'
    ],
    description: 'A lean pork cut with the highest thiamine content of any meat.',
    serving: '100g'
  },
  {
    id: 'shrimp', name: 'Shrimp', emoji: '🦐', color: '#f08070', calories: 99,
    nutrition: { protein: 24, carbs: 0.2, fat: 0.3, fiber: 0, selenium: 26.4, vitaminB12: 0.38, iodine: 52.5, phosphorus: 200 },
    benefits: [
      'Very high protein for very few calories',
      'Extremely low in fat',
      'Iodine supports thyroid function',
      'Contains the antioxidant astaxanthin',
      'Naturally low calorie'
    ],
    drawbacks: [
      'High in dietary cholesterol',
      'Common shellfish allergen',
      'Farming can carry environmental concerns',
      'Highly perishable'
    ],
    description: 'A lean shellfish delivering big protein and thyroid-supporting iodine for few calories.',
    serving: '100g'
  },
  {
    id: 'whey', name: 'Whey Protein', emoji: '🥛', color: '#f0ede6', calories: 400,
    nutrition: { protein: 80, carbs: 8, fat: 5, fiber: 0, calcium: 200, riboflavin: 0.33, vitaminB12: 0.72, leucine: 8 },
    benefits: [
      'Fastest-absorbing protein source',
      'Powerful trigger for muscle protein synthesis',
      'Complete amino acid profile',
      'Ideal for post-workout recovery',
      'Convenient and concentrated'
    ],
    drawbacks: [
      'A processed supplement, not whole food',
      'Can cause issues for the lactose intolerant',
      'Relatively expensive per serving',
      'May cause digestive discomfort in some'
    ],
    description: 'The gold-standard fast protein — concentrated, complete, and leucine-rich.',
    serving: '100g'
  },
  {
    id: 'edamame', name: 'Edamame', emoji: '🫛', color: '#7cb342', calories: 121,
    nutrition: { protein: 11, carbs: 8.9, fat: 5.2, fiber: 5.2, folate: 312, vitaminK: 31.2, manganese: 1.1, iron: 2.34 },
    benefits: [
      'A complete plant protein',
      'Very high folate supports pregnancy',
      'Isoflavones may support hormone balance',
      'Rich in dietary fiber',
      'Packed with antioxidants'
    ],
    drawbacks: [
      'Common soy allergen',
      'Phytoestrogen content concerns some',
      'Much soy is genetically modified',
      'Contains antinutrients'
    ],
    description: 'Young soybeans — a complete plant protein exceptionally high in folate.',
    serving: '100g'
  },
  {
    id: 'sardines', name: 'Sardines', emoji: '🐠', color: '#c0c4cc', calories: 208,
    nutrition: { protein: 25, carbs: 0, fat: 11, fiber: 0, vitaminB12: 3.58, selenium: 28.6, calcium: 380, vitaminD: 96, omega3: 1.5 },
    benefits: [
      'One of the richest B12 sources',
      'Edible bones make them rich in calcium and D',
      'High in anti-inflammatory omega-3',
      'A sustainable, low-mercury fish',
      'Inexpensive and shelf-stable'
    ],
    drawbacks: [
      'Strong smell and flavor',
      'Canned versions can be high in sodium',
      'Soft edible bones unappealing to some',
      'An acquired taste'
    ],
    description: 'A tiny powerhouse fish — extraordinary B12 plus calcium and D from edible bones.',
    serving: '100g'
  },
  {
    id: 'tempeh', name: 'Tempeh', emoji: '🧆', color: '#b08850', calories: 193,
    nutrition: { protein: 19, carbs: 9.4, fat: 11, fiber: 0, manganese: 1.24, phosphorus: 210, magnesium: 58.8, riboflavin: 0.18 },
    benefits: [
      'A complete fermented plant protein',
      'Probiotics from fermentation support gut health',
      'Firm, satisfying meat alternative',
      'Good source of calcium',
      'More digestible than unfermented soy'
    ],
    drawbacks: [
      'Common soy allergen',
      'An acquired, nutty flavor',
      'Less widely available',
      'Contains phytoestrogens'
    ],
    description: 'A firm fermented-soy cake — a complete plant protein with gut-friendly probiotics.',
    serving: '100g'
  },
  {
    id: 'lamb', name: 'Lamb', emoji: '🐑', color: '#9b3b30', calories: 294,
    nutrition: { protein: 25, carbs: 0, fat: 21, fiber: 0, vitaminB12: 1.87, zinc: 5.06, iron: 2.16, selenium: 14.3, niacin: 4 },
    benefits: [
      'Rich in B12 and bioavailable zinc',
      'Complete protein for muscle building',
      'Contains beneficial CLA fatty acid',
      'Good source of heme iron',
      'Highly satiating'
    ],
    drawbacks: [
      'High in saturated fat',
      'Strong, gamey flavor',
      'Expensive cut of meat',
      'High in calories'
    ],
    description: 'A rich red meat packed with B12, zinc, and the beneficial fatty acid CLA.',
    serving: '100g'
  },
  {
    id: 'cannedsalmon', name: 'Canned Salmon', emoji: '🥫', color: '#f08a5d', calories: 139,
    nutrition: { protein: 21, carbs: 0, fat: 6.1, fiber: 0, vitaminB12: 3.19, vitaminD: 728, selenium: 19.8, omega3: 1.2, calcium: 180 },
    benefits: [
      'Exceptionally high in vitamin D and B12',
      'Rich in anti-inflammatory omega-3',
      'Soft edible bones add calcium',
      'Far cheaper than fresh salmon',
      'Convenient and shelf-stable'
    ],
    drawbacks: [
      'Often high in sodium',
      'Cans may contain BPA',
      'Less appealing than fresh',
      'Softer, flakier texture'
    ],
    description: 'An affordable pantry protein with sky-high vitamin D and B12.',
    serving: '100g'
  },
  {
    id: 'tofu', name: 'Tofu', emoji: '🧈', color: '#f5f2e8', calories: 144,
    nutrition: { protein: 17, carbs: 3, fat: 8.7, fiber: 0.3, calcium: 350, manganese: 0.71, selenium: 7.7, iron: 2.7 },
    benefits: [
      'A complete plant protein',
      'One of the highest plant calcium sources',
      'Extremely versatile in cooking',
      'Supports heart health',
      'Contains beneficial isoflavones'
    ],
    drawbacks: [
      'Common soy allergen',
      'Contains phytoestrogens',
      'Bland without seasoning',
      'Contains some antinutrients'
    ],
    description: 'A versatile soy curd — a complete plant protein and a top plant calcium source.',
    serving: '100g'
  },
  {
    id: 'octopus', name: 'Octopus', emoji: '🐙', color: '#c97a8e', calories: 164,
    nutrition: { protein: 30, carbs: 4.4, fat: 2.1, fiber: 0, vitaminB12: 12.24, iron: 9.18, selenium: 38.5, copper: 0.9 },
    benefits: [
      'Extraordinary B12 content',
      'Very lean, high-quality protein',
      'Copper supports brain and nerve function',
      'Rich in iron',
      'Naturally low in fat'
    ],
    drawbacks: [
      'Chewy texture if poorly cooked',
      'Expensive',
      'Tricky to prepare well',
      'Raises ethical concerns for some'
    ],
    description: 'A lean cephalopod protein with off-the-charts B12 and brain-supporting copper.',
    serving: '100g'
  },
  {
    id: 'duck', name: 'Duck Breast', emoji: '🦆', color: '#8a4a3a', calories: 201,
    nutrition: { protein: 19, carbs: 0, fat: 13, fiber: 0, vitaminB12: 0.5, iron: 3.06, zinc: 1.65, selenium: 11, vitaminB6: 0.31 },
    benefits: [
      'Rich, flavorful protein',
      'Good source of heme iron',
      'Zinc supports immune function',
      'Provides a range of B vitamins',
      'Deeply satisfying and satiating'
    ],
    drawbacks: [
      'High in fat, mostly in the skin',
      'Expensive',
      'Less commonly cooked at home',
      'Higher calorie than chicken'
    ],
    description: 'A rich, flavorful poultry protein with good iron and immune-supporting zinc.',
    serving: '100g'
  },
  {
    id: 'hempseeds', name: 'Hemp Seeds', emoji: '🌱', color: '#b5b08a', calories: 553,
    nutrition: { protein: 31, carbs: 8.7, fat: 49, fiber: 4, manganese: 8.33, phosphorus: 830, magnesium: 294, omega3: 8.7 },
    benefits: [
      'A complete plant protein',
      'Near-perfect omega 3-to-6 ratio',
      'Supports heart health',
      'Easy to digest',
      'Contains all essential amino acids'
    ],
    drawbacks: [
      'Very high in calories',
      'Relatively expensive',
      'Distinct earthy flavor',
      'Very high fat content'
    ],
    description: 'Tiny complete-protein seeds with an ideal omega-3 to omega-6 balance.',
    serving: '100g'
  },
  {
    id: 'pumpkinseeds', name: 'Pumpkin Seeds', emoji: '🎃', color: '#c5d18a', calories: 559,
    nutrition: { protein: 30, carbs: 10.7, fat: 49, fiber: 6, manganese: 5.22, phosphorus: 920, magnesium: 386, zinc: 7.59, iron: 8.1 },
    benefits: [
      'Among the richest food sources of magnesium',
      'Tryptophan supports sleep',
      'Zinc supports prostate and immune health',
      'High in plant iron',
      'Support heart health'
    ],
    drawbacks: [
      'Very high in calories',
      'High fat content',
      'Easy to overeat',
      'Can be expensive'
    ],
    description: 'Crunchy green seeds that are one of nature\'s richest sources of magnesium.',
    serving: '100g'
  },
  {
    id: 'beefliver', name: 'Beef Liver', emoji: '🫀', color: '#6b3528', calories: 175,
    nutrition: { protein: 27, carbs: 5, fat: 5, fiber: 0, vitaminB12: 83.04, copper: 12.47, vitaminA: 7740, folate: 260, iron: 7.02 },
    benefits: [
      'Among the most nutrient-dense foods on earth',
      'Astronomical B12 content',
      'Extraordinarily rich in copper and vitamin A',
      'A complete, high-quality protein',
      'Loaded with bioavailable iron'
    ],
    drawbacks: [
      'Very strong, distinctive flavor',
      'Vitamin A toxicity risk if eaten daily',
      'High in cholesterol',
      'Filters toxins as the body\'s detox organ'
    ],
    description: 'Arguably the most nutrient-dense food on earth — staggering B12, copper, and vitamin A.',
    serving: '100g'
  },
  {
    id: 'mussels', name: 'Mussels', emoji: '🦪', color: '#3a4a6b', calories: 172,
    nutrition: { protein: 24, carbs: 7.4, fat: 4.5, fiber: 0, vitaminB12: 8.16, selenium: 52.8, manganese: 5.7, iron: 6.66, omega3: 0.7 },
    benefits: [
      'Extraordinary B12 and selenium content',
      'One of the most sustainable seafoods',
      'Contains anti-inflammatory omega-3',
      'Rich in iron',
      'High protein for low calories'
    ],
    drawbacks: [
      'Common shellfish allergen',
      'Filter feeders can accumulate toxins',
      'Strong oceanic taste',
      'Very perishable'
    ],
    description: 'A sustainable shellfish delivering massive B12, selenium, and manganese.',
    serving: '100g'
  },
  {
    id: 'spirulina', name: 'Spirulina', emoji: '🌀', color: '#1a6b5a', calories: 290,
    nutrition: { protein: 57, carbs: 24, fat: 7.7, fiber: 3.6, riboflavin: 2.77, iron: 28.4, copper: 0.77, thiamine: 2.48, gla: 1.3 },
    benefits: [
      'The highest protein density of any food',
      'A complete protein with all amino acids',
      'Supports the body\'s detox pathways',
      'Powerfully anti-inflammatory',
      'A nutrient-dense superfood'
    ],
    drawbacks: [
      'Strong taste and smell',
      'Contamination risk if poorly sourced',
      'Expensive',
      'Not widely available'
    ],
    description: 'A blue-green algae with the highest protein density of any known food.',
    serving: '100g'
  },
  {
    id: 'mango', name: 'Mango', emoji: '🥭', color: '#f5a623', calories: 60,
    nutrition: { protein: 0.8, carbs: 15, fat: 0.4, fiber: 1.6, vitaminC: 39.6, vitaminA: 486, vitaminB6: 0.15, folate: 44 },
    benefits: [
      'High in both vitamin C and vitamin A',
      'Contains digestive enzymes (amylase)',
      'Boosts immune function',
      'Carotenoids support eye health',
      'Anti-inflammatory polyphenols'
    ],
    drawbacks: [
      'High in natural sugar',
      'High glycemic index',
      'Can trigger allergies in sensitive people',
      'Higher calorie than many fruits'
    ],
    description: 'A lush tropical fruit rich in vitamins C and A plus digestive enzymes.',
    serving: '100g'
  },
  {
    id: 'pineapple', name: 'Pineapple', emoji: '🍍', color: '#e8c84a', calories: 50,
    nutrition: { protein: 0.5, carbs: 13, fat: 0.1, fiber: 1.4, vitaminC: 71.1, manganese: 1.01, vitaminB6: 0.12, thiamine: 0.07 },
    benefits: [
      'Bromelain enzyme aids protein digestion',
      'Anti-inflammatory properties',
      'Boosts immune function',
      'Manganese supports bone health',
      'Antioxidants support eye health'
    ],
    drawbacks: [
      'High in natural sugar',
      'Acidic — can erode tooth enamel',
      'Bromelain can irritate the mouth',
      'High glycemic for diabetics'
    ],
    description: 'A tangy tropical fruit packed with vitamin C and the digestive enzyme bromelain.',
    serving: '100g'
  },
  {
    id: 'strawberry', name: 'Strawberry', emoji: '🍓', color: '#e63946', calories: 32,
    nutrition: { protein: 0.7, carbs: 7.7, fat: 0.3, fiber: 2, vitaminC: 88.2, manganese: 0.41, folate: 24, vitaminK: 3.6 },
    benefits: [
      'Extremely high in vitamin C',
      'Supports heart health',
      'Helps regulate blood sugar',
      'Anti-inflammatory antioxidants',
      'Promotes healthy skin'
    ],
    drawbacks: [
      'High pesticide residue (a "dirty dozen" crop)',
      'Very short shelf life',
      'Mildly acidic',
      'Allergenic for some people'
    ],
    description: 'A vitamin-C powerhouse berry — one of the richest sources per calorie.',
    serving: '100g'
  },
  {
    id: 'watermelon', name: 'Watermelon', emoji: '🍉', color: '#f0506a', calories: 30,
    nutrition: { protein: 0.6, carbs: 7.6, fat: 0.2, fiber: 0.4, vitaminC: 11.7, vitaminA: 99, lycopene: 4.5, vitaminB6: 0.07 },
    benefits: [
      'Exceptionally hydrating (about 92% water)',
      'Lycopene antioxidant supports heart health',
      'L-citrulline may aid muscle recovery',
      'Very low in calories',
      'Naturally cooling and refreshing'
    ],
    drawbacks: [
      'Very high glycemic index',
      'Low in fiber',
      'High in natural sugar',
      'Can cause bloating in some'
    ],
    description: 'The ultimate hydrating fruit — 92% water with heart-healthy lycopene.',
    serving: '100g'
  },
  {
    id: 'grapes', name: 'Grapes', emoji: '🍇', color: '#6b3fa0', calories: 69,
    nutrition: { protein: 0.7, carbs: 18, fat: 0.2, fiber: 0.9, vitaminK: 16.8, vitaminC: 5.4, vitaminB6: 0.09, resveratrol: 2 },
    benefits: [
      'Resveratrol is a powerful antioxidant',
      'Supports heart health',
      'Anti-aging polyphenols',
      'Supports brain health',
      'May help with cancer prevention'
    ],
    drawbacks: [
      'High in natural sugar',
      'Low in fiber',
      'High glycemic index',
      'High pesticide residue',
      'Very easy to overeat'
    ],
    description: 'Bite-sized antioxidant bombs rich in heart-protective resveratrol.',
    serving: '100g'
  },
  {
    id: 'peach', name: 'Peach', emoji: '🍑', color: '#f5b08a', calories: 39,
    nutrition: { protein: 0.9, carbs: 9.5, fat: 0.3, fiber: 1.5, vitaminC: 9.9, vitaminA: 54, vitaminK: 6, niacin: 0.8 },
    benefits: [
      'Low in calories',
      'Provides vitamins C and A',
      'Supports healthy skin',
      'Aids digestion with fiber',
      'Contains protective antioxidants'
    ],
    drawbacks: [
      'Short growing season',
      'Bruises very easily',
      'Moderate sugar content',
      'High pesticide residue'
    ],
    description: 'A juicy stone fruit with skin-supporting vitamins C and A.',
    serving: '100g'
  },
  {
    id: 'pear', name: 'Pear', emoji: '🍐', color: '#c8d44a', calories: 57,
    nutrition: { protein: 0.4, carbs: 15, fat: 0.1, fiber: 3.1, vitaminK: 4.8, vitaminC: 6.3, copper: 0.04, vitaminB6: 0.03 },
    benefits: [
      'High in fiber, especially pectin',
      'Supports gut health',
      'Anti-inflammatory flavonoids',
      'Supports heart health',
      'Low in calories for its size'
    ],
    drawbacks: [
      'High in natural sugar',
      'Low overall vitamin content',
      'High glycemic when very ripe',
      'Bruises easily'
    ],
    description: 'A high-fiber fruit loaded with gut-friendly pectin.',
    serving: '100g'
  },
  {
    id: 'orange', name: 'Orange', emoji: '🍊', color: '#f5921e', calories: 47,
    nutrition: { protein: 0.9, carbs: 12, fat: 0.1, fiber: 2.4, vitaminC: 79.2, folate: 32, thiamine: 0.1, potassium: 188 },
    benefits: [
      'Very high in vitamin C',
      'Strengthens the immune system',
      'Flavonoids support heart health',
      'Good source of folate',
      'Pectin fiber aids digestion'
    ],
    drawbacks: [
      'Acidic — can trigger reflux',
      'Higher sugar than vegetables',
      'Can erode tooth enamel',
      'Juicing strips the fiber'
    ],
    description: 'The classic immune-boosting citrus, brimming with vitamin C.',
    serving: '100g'
  },
  {
    id: 'pomegranate', name: 'Pomegranate', emoji: '🔴', color: '#b71c2b', calories: 83,
    nutrition: { protein: 1.7, carbs: 19, fat: 1.2, fiber: 4, vitaminK: 19.2, vitaminC: 10.8, folate: 40, punicalagins: 15 },
    benefits: [
      'Punicalagins are exceptionally powerful antioxidants',
      'Strongly anti-inflammatory',
      'Supports heart health',
      'May support memory and cognition',
      'Studied for anti-cancer properties'
    ],
    drawbacks: [
      'Expensive',
      'Messy and time-consuming to eat',
      'Can interact with medications like grapefruit',
      'High in natural sugar'
    ],
    description: 'Ruby arils packed with punicalagins — among the most potent food antioxidants.',
    serving: '100g'
  },
  {
    id: 'cherry', name: 'Cherry', emoji: '🍒', color: '#9b1c31', calories: 63,
    nutrition: { protein: 1.1, carbs: 16, fat: 0.2, fiber: 2.1, vitaminC: 10.8, vitaminK: 3.6, potassium: 235, anthocyanins: 30 },
    benefits: [
      'A natural source of melatonin for sleep',
      'Anti-inflammatory anthocyanins',
      'May help prevent gout',
      'Supports heart health',
      'Aids exercise recovery'
    ],
    drawbacks: [
      'High in natural sugar',
      'Very short season',
      'Expensive',
      'Pits must be removed'
    ],
    description: 'A sleep-supporting stone fruit rich in melatonin and anthocyanins.',
    serving: '100g'
  },
  {
    id: 'papaya', name: 'Papaya', emoji: '🟠', color: '#f5832a', calories: 43,
    nutrition: { protein: 0.5, carbs: 11, fat: 0.3, fiber: 1.7, vitaminC: 92.7, vitaminA: 198, folate: 40, vitaminK: 3.6, papain: 8 },
    benefits: [
      'Papain enzyme aids protein digestion',
      'Very high in vitamin C',
      'Carotenoids support eye health',
      'Anti-inflammatory properties',
      'Promotes healthy skin'
    ],
    drawbacks: [
      'Strong, musky smell',
      'Linked to latex allergy in some',
      'High in natural sugar',
      'Laxative effect in excess'
    ],
    description: 'A tropical fruit with the digestive enzyme papain and over a day of vitamin C.',
    serving: '100g'
  },
  {
    id: 'fig', name: 'Fig', emoji: '🟣', color: '#7a4a8c', calories: 74,
    nutrition: { protein: 0.8, carbs: 19, fat: 0.3, fiber: 2.9, vitaminK: 4.8, vitaminB6: 0.1, copper: 0.03, manganese: 0.14 },
    benefits: [
      'High in dietary fiber',
      'Supports bone health',
      'Helps control blood pressure',
      'Promotes digestive health',
      'Rich in antioxidants'
    ],
    drawbacks: [
      'Very high in natural sugar',
      'High glycemic index',
      'Calorie-dense, especially dried',
      'Very short fresh shelf life'
    ],
    description: 'A honeyed, fiber-rich fruit that supports bone health and digestion.',
    serving: '100g'
  },
  {
    id: 'raspberries', name: 'Raspberries', emoji: '🔴', color: '#d11e4a', calories: 52,
    nutrition: { protein: 1.2, carbs: 12, fat: 0.7, fiber: 6.5, vitaminC: 38.7, vitaminK: 8.4, manganese: 0.74, folate: 20 },
    benefits: [
      'One of the highest-fiber common fruits',
      'Ellagic acid studied for anti-cancer effects',
      'Helps regulate blood sugar',
      'Supports heart health',
      'Low in sugar for a fruit'
    ],
    drawbacks: [
      'Extremely fragile and perishable',
      'Expensive',
      'Seedy texture',
      'Very short shelf life'
    ],
    description: 'A delicate berry boasting more fiber than almost any other fruit.',
    serving: '100g'
  },
  {
    id: 'blackberries', name: 'Blackberries', emoji: '⚫', color: '#2e1a3a', calories: 43,
    nutrition: { protein: 1.4, carbs: 10, fat: 0.5, fiber: 5.3, vitaminK: 22.8, vitaminC: 31.5, manganese: 0.67, folate: 24 },
    benefits: [
      'Very high in dietary fiber',
      'Vitamin K supports bone health',
      'Anti-cancer anthocyanins',
      'Supports brain health',
      'Low in calories'
    ],
    drawbacks: [
      'Fragile and perishable',
      'Short shelf life',
      'Seedy texture',
      'Expensive out of season'
    ],
    description: 'A dark, antioxidant-rich berry high in fiber and bone-supporting vitamin K.',
    serving: '100g'
  },
  {
    id: 'apricot', name: 'Apricot', emoji: '🟧', color: '#f0a04a', calories: 48,
    nutrition: { protein: 1.4, carbs: 11, fat: 0.4, fiber: 2, vitaminA: 234, vitaminC: 10.8, vitaminK: 4.8, vitaminE: 0.9, betacarotene: 1090 },
    benefits: [
      'High in beta-carotene for eye health',
      'Supports healthy skin',
      'Potassium supports heart health',
      'Good source of fiber',
      'Low in calories'
    ],
    drawbacks: [
      'Short growing season',
      'Bruises easily',
      'Moderate sugar content',
      'Dried versions are much higher in sugar'
    ],
    description: 'A golden stone fruit loaded with eye-protecting beta-carotene.',
    serving: '100g'
  },
  {
    id: 'plum', name: 'Plum', emoji: '🟪', color: '#5e2a6b', calories: 46,
    nutrition: { protein: 0.7, carbs: 11, fat: 0.3, fiber: 1.4, vitaminC: 14.4, vitaminK: 7.2, vitaminA: 45, riboflavin: 0.04 },
    benefits: [
      'Sorbitol acts as a natural laxative',
      'Vitamin K supports bone health',
      'Rich in antioxidants',
      'Supports heart health',
      'Low in calories'
    ],
    drawbacks: [
      'Laxative effect in excess',
      'High in natural sugar',
      'Pesticide residue',
      'Short season'
    ],
    description: 'A juicy stone fruit with antioxidants and gentle digestive benefits.',
    serving: '100g'
  },
  {
    id: 'lychee', name: 'Lychee', emoji: '🌸', color: '#f06a8a', calories: 66,
    nutrition: { protein: 0.8, carbs: 17, fat: 0.4, fiber: 1.3, vitaminC: 107.1, vitaminB6: 0.14, copper: 0.08, potassium: 235 },
    benefits: [
      'Extremely high in vitamin C',
      'Oligonol antioxidant supports circulation',
      'Supports heart health',
      'Promotes healthy skin',
      'Boosts immune function'
    ],
    drawbacks: [
      'Very high in natural sugar',
      'Not widely available',
      'Unripe fruit can be toxic',
      'Short season'
    ],
    description: 'A fragrant tropical fruit with more vitamin C than an orange.',
    serving: '100g'
  },
  {
    id: 'passionfruit', name: 'Passion Fruit', emoji: '🟣', color: '#6b2a8c', calories: 97,
    nutrition: { protein: 2.2, carbs: 23, fat: 0.7, fiber: 10.4, vitaminA: 225, vitaminC: 27, iron: 2.16, potassium: 376 },
    benefits: [
      'Exceptionally high in dietary fiber',
      'Compounds with calming, sleep-supporting effects',
      'Boosts immune function',
      'Carotenoids support eye health',
      'Supports heart health'
    ],
    drawbacks: [
      'Very high in natural sugar',
      'Intensely sour taste',
      'Expensive',
      'Not widely available'
    ],
    description: 'A tart tropical fruit with extraordinary fiber and calming compounds.',
    serving: '100g'
  },
  {
    id: 'coconut', name: 'Coconut', emoji: '🥥', color: '#d8c8a8', calories: 354,
    nutrition: { protein: 3.3, carbs: 15, fat: 33, fiber: 9, manganese: 1.73, copper: 0.2, selenium: 7.7, iron: 2.34 },
    benefits: [
      'MCT fats provide quick energy',
      'Lauric acid has antimicrobial effects',
      'High in dietary fiber',
      'Supports ketone production for brain fuel',
      'Manganese supports metabolism'
    ],
    drawbacks: [
      'Very high in saturated fat',
      'Very calorie-dense',
      'Some health claims are overstated',
      'Fiber can slow digestion'
    ],
    description: 'A rich tropical fruit high in fiber and quick-energy MCT fats.',
    serving: '100g'
  },
  {
    id: 'dragonfruit', name: 'Dragon Fruit', emoji: '🐉', color: '#e84a8c', calories: 60,
    nutrition: { protein: 1.2, carbs: 13, fat: 0, fiber: 3, vitaminC: 8.1, iron: 1.44, magnesium: 29.4, betalains: 9 },
    benefits: [
      'Betalain antioxidants fight inflammation',
      'Prebiotic fiber supports gut health',
      'May enhance iron absorption',
      'Anti-inflammatory properties',
      'Low in calories'
    ],
    drawbacks: [
      'Expensive',
      'Mild, subtle flavor',
      'Short shelf life',
      'Limited availability'
    ],
    description: 'A striking tropical fruit with gut-friendly fiber and betalain antioxidants.',
    serving: '100g'
  }
];

app.get('/api/foods', (req, res) => res.json(foods));
app.get('/api/foods/:id', (req, res) => {
  const food = foods.find(f => f.id === req.params.id);
  food ? res.json(food) : res.status(404).json({ error: 'Food not found' });
});

// Match a free-text ingredient name to a food in the database
function matchFoodId(name) {
  const n = String(name).toLowerCase().trim();
  let f = foods.find(food => food.name.toLowerCase() === n);
  if (!f) f = foods.find(food => food.name.toLowerCase().includes(n) || n.includes(food.name.toLowerCase()));
  return f ? f.id : null;
}

// ─── AUTH ────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Step 1 — validate details, store a pending registration, email a 6-digit code
app.post('/api/auth/send-code', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const emailNorm = String(email).trim().toLowerCase();
  const users = readJSON(USERS_FILE);
  if (users.find(u => u.email.toLowerCase() === emailNorm)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const code = genCode();
  const passwordHash = await bcrypt.hash(String(password), 10);
  pendingVerifications.set(emailNorm, {
    name: String(name).trim(), email: emailNorm, passwordHash,
    code, expiresAt: Date.now() + VERIFY_TTL, lastSent: Date.now(),
  });

  let sent = false;
  try { sent = await sendVerificationEmail(emailNorm, code); }
  catch (err) { console.error('Email send failed:', err.message); sent = false; }

  if (sent) return res.json({ success: true, emailSent: true });
  // Email not configured (or send failed) — dev fallback so the flow is testable
  console.log(`[verify] code for ${emailNorm}: ${code}`);
  res.json({ success: true, emailSent: false, devCode: code, note: 'Email not configured — using dev code (set EMAIL_USER/EMAIL_PASS).' });
});

// Step 2 — verify the code, create the account, return a JWT
app.post('/api/auth/verify-code', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  const emailNorm = String(email).trim().toLowerCase();

  const pending = pendingVerifications.get(emailNorm);
  if (!pending) return res.status(400).json({ error: 'No pending verification — please start again.' });
  if (Date.now() > pending.expiresAt) {
    pendingVerifications.delete(emailNorm);
    return res.status(400).json({ error: 'Code expired — please request a new one.' });
  }
  if (String(code).trim() !== pending.code) return res.status(400).json({ error: 'Incorrect code — please try again.' });

  const users = readJSON(USERS_FILE);
  if (users.find(u => u.email.toLowerCase() === emailNorm)) {
    pendingVerifications.delete(emailNorm);
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const user = {
    id: uuidv4(), email: emailNorm, password: pending.passwordHash, name: pending.name,
    age: null, weight: null, height: null, gender: null, goal: 'maintain',
    emailVerified: true, plan: 'free', createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJSON(USERS_FILE, users);
  pendingVerifications.delete(emailNorm);

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/register', async (req, res) => {
  const { email, password, name, age, weight, goal } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = readJSON(USERS_FILE);
  if (users.find(u => u.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const user = {
    id: uuidv4(),
    email: String(email).trim().toLowerCase(),
    password: await bcrypt.hash(String(password), 10),
    name: String(name).trim(),
    age: age ? Number(age) : null,
    weight: weight ? Number(weight) : null,
    height: null,
    gender: null,
    goal: goal || 'maintain',
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJSON(USERS_FILE, users);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  console.log('Login attempt:', email);
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  console.log('User found:', !!user);
  const passwordMatch = user ? await bcrypt.compare(String(password), user.password) : false;
  console.log('Password match:', passwordMatch);
  if (!user || !passwordMatch) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  console.log('Token generated:', !!token);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/profile', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user), calories: calcCalories(user) });
});

app.put('/api/profile', auth, (req, res) => {
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const u = users[idx];
  const { name, age, weight, currentWeight, targetWeight, height, gender, goal, timeline, activityLevel } = req.body || {};
  if (name != null) u.name = String(name).trim();
  if (age != null) u.age = Number(age);
  const cw = currentWeight != null ? currentWeight : weight;
  if (cw != null) u.weight = Number(cw);
  if (targetWeight != null) u.targetWeight = Number(targetWeight);
  if (height != null) u.height = Number(height);
  if (gender != null) u.gender = String(gender);
  if (timeline != null) u.timeline = Number(timeline);
  if (activityLevel != null) u.activityLevel = String(activityLevel);
  // Derive goal from target vs current weight (falls back to explicit goal)
  if (u.targetWeight != null && u.weight != null) {
    u.goal = u.targetWeight < u.weight - 0.05 ? 'lose_weight'
      : u.targetWeight > u.weight + 0.05 ? 'gain_muscle' : 'maintain';
  } else if (goal != null) {
    u.goal = String(goal);
  }
  users[idx] = u;
  writeJSON(USERS_FILE, users);
  res.json({ user: publicUser(u), calories: calcCalories(u) });
});

// ─── PROFILE STATS ────────────────────────────────────────────────────────
app.get('/api/profile/stats', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const cal = calcCalories(user);
  if (!cal) return res.status(400).json({ error: 'Profile incomplete — fill in your stats first.' });
  const bmi = user.height ? +(user.weight / Math.pow(user.height / 100, 2)).toFixed(1) : null;
  res.json({
    bmi,
    bmr: cal.bmr,
    tdee: cal.tdee,
    dailyCalories: cal.target,
    weeklyLoss: +Math.abs(cal.weeklyChange).toFixed(2),
    weeksRemaining: cal.effWeeks,
    progressPercent: 0,
    estimatedCompletion: cal.completionDate,
    direction: cal.direction,
    goalKg: cal.goalKg,
    currentWeight: cal.currentWeight,
    targetWeight: cal.targetWeight,
    activityMultiplier: cal.activityMultiplier,
    macros: { protein: cal.protein, carbs: cal.carbs, fats: cal.fats },
    prediction: cal.prediction,
    warning: cal.warning,
  });
});

// ─── FRIDGE ──────────────────────────────────────────────────────────────
app.get('/api/fridge', auth, (req, res) => {
  res.json(readJSON(FRIDGES_FILE).filter(i => i.userId === req.userId));
});

app.post('/api/fridge', auth, (req, res) => {
  const { name, quantity, category, foodId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Ingredient name is required' });
  const fridges = readJSON(FRIDGES_FILE);
  const item = {
    id: uuidv4(),
    userId: req.userId,
    name: String(name).trim(),
    quantity: quantity ? String(quantity).trim() : '100g',
    category: category || 'protein',
    foodId: foodId || matchFoodId(name),
    addedAt: new Date().toISOString(),
  };
  fridges.push(item);
  writeJSON(FRIDGES_FILE, fridges);
  res.status(201).json(item);
});

app.put('/api/fridge/:id', auth, (req, res) => {
  const fridges = readJSON(FRIDGES_FILE);
  const item = fridges.find(i => i.id === req.params.id && i.userId === req.userId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { quantity, category } = req.body || {};
  if (quantity != null) item.quantity = String(quantity).trim();
  if (category != null) item.category = String(category);
  writeJSON(FRIDGES_FILE, fridges);
  res.json(item);
});

app.delete('/api/fridge/:id', auth, (req, res) => {
  let fridges = readJSON(FRIDGES_FILE);
  const before = fridges.length;
  fridges = fridges.filter(i => !(i.id === req.params.id && i.userId === req.userId));
  if (fridges.length === before) return res.status(404).json({ error: 'Item not found' });
  writeJSON(FRIDGES_FILE, fridges);
  res.json({ success: true });
});

// ─── MEAL PLAN ─────────────────────────────────────────────────────────────
function buildMeal(name, time, targetCal, picks) {
  const verbs = {
    Breakfast: 'Prepare', Lunch: 'Cook and combine', Dinner: 'Lightly cook and plate', Snacks: 'Enjoy',
  };
  const per = picks.length ? targetCal / picks.length : 0;
  const items = picks.map(food => {
    const grams = Math.min(400, Math.max(20, Math.round((per / (food.calories || 1)) * 100)));
    const factor = grams / 100;
    return {
      foodId: food.id, name: food.name, emoji: food.emoji,
      quantity: grams + 'g',
      calories: Math.round(food.calories * factor),
      protein: +(food.nutrition.protein * factor).toFixed(1),
      carbs: +(food.nutrition.carbs * factor).toFixed(1),
      fat: +(food.nutrition.fat * factor).toFixed(1),
    };
  });
  const tot = items.reduce((a, it) => ({
    calories: a.calories + it.calories, protein: a.protein + it.protein,
    carbs: a.carbs + it.carbs, fat: a.fat + it.fat,
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const names = items.map(i => i.name);
  const instructions = items.length
    ? `${verbs[name]} ${names.join(', ').replace(/, ([^,]*)$/, ' and $1')} (${items.map(i => i.quantity).join(', ')}).`
    : 'Add more ingredients to your fridge for a richer plan.';
  return {
    name, time, instructions, items,
    calories: tot.calories,
    protein: +tot.protein.toFixed(1),
    carbs: +tot.carbs.toFixed(1),
    fat: +tot.fat.toFixed(1),
  };
}

function buildPlan(allFoods, cal, offset) {
  const pick = (start, count) => {
    const out = [];
    for (let k = 0; k < count && allFoods.length; k++) out.push(allFoods[(start + k) % allFoods.length]);
    return out;
  };
  const o = offset || 0;
  const meals = [
    buildMeal('Breakfast', '08:00', Math.round(cal.target * 0.25), pick(o + 0, Math.min(2, allFoods.length))),
    buildMeal('Lunch', '13:00', Math.round(cal.target * 0.35), pick(o + 2, Math.min(3, allFoods.length))),
    buildMeal('Dinner', '19:00', Math.round(cal.target * 0.30), pick(o + 5, Math.min(3, allFoods.length))),
    buildMeal('Snacks', '16:00', Math.round(cal.target * 0.10), pick(o + 8, Math.min(1, allFoods.length))),
  ];
  const totals = meals.reduce((a, m) => ({
    calories: a.calories + m.calories, protein: a.protein + m.protein,
    carbs: a.carbs + m.carbs, fat: a.fat + m.fat,
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return {
    meals,
    target: cal,
    totals: {
      calories: totals.calories,
      protein: +totals.protein.toFixed(1),
      carbs: +totals.carbs.toFixed(1),
      fat: +totals.fat.toFixed(1),
    },
    generatedAt: new Date().toISOString(),
  };
}

function setUserPlan(userId, plan, saved) {
  const all = readJSON(MEALPLANS_FILE);
  const idx = all.findIndex(p => p.userId === userId);
  const rec = { userId, plan, saved: !!saved, updatedAt: new Date().toISOString() };
  if (idx === -1) all.push(rec); else all[idx] = rec;
  writeJSON(MEALPLANS_FILE, all);
}

app.post('/api/mealplan/generate', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const cal = calcCalories(user);
  if (!cal) return res.status(400).json({ error: 'Complete your profile (age, weight, height, gender) first' });

  const fridge = readJSON(FRIDGES_FILE).filter(i => i.userId === req.userId);
  if (!fridge.length) return res.status(400).json({ error: 'Your fridge is empty — add some ingredients first' });

  const resolved = fridge
    .map(i => foods.find(f => f.id === i.foodId) || foods.find(f => f.name.toLowerCase() === i.name.toLowerCase()))
    .filter(Boolean);
  if (!resolved.length) {
    return res.status(400).json({ error: 'None of your fridge items match the food database. Try common names like "Chicken Breast" or "Banana".' });
  }
  // rotate the starting offset each generation for variety
  const prev = readJSON(MEALPLANS_FILE).find(p => p.userId === req.userId);
  const offset = ((prev && prev.offset) || 0) + 1;
  const plan = buildPlan(resolved, cal, offset);

  const all = readJSON(MEALPLANS_FILE);
  const idx = all.findIndex(p => p.userId === req.userId);
  const rec = { userId: req.userId, plan, saved: false, offset, updatedAt: new Date().toISOString() };
  if (idx === -1) all.push(rec); else all[idx] = rec;
  writeJSON(MEALPLANS_FILE, all);

  res.json(plan);
});

app.get('/api/mealplan', auth, (req, res) => {
  const rec = readJSON(MEALPLANS_FILE).find(p => p.userId === req.userId);
  res.json(rec ? rec.plan : null);
});

app.post('/api/mealplan/save', auth, (req, res) => {
  const bodyPlan = req.body && req.body.plan;
  const existing = readJSON(MEALPLANS_FILE).find(p => p.userId === req.userId);
  const plan = bodyPlan || (existing && existing.plan);
  if (!plan) return res.status(400).json({ error: 'No meal plan to save — generate one first' });
  setUserPlan(req.userId, plan, true);
  res.json({ success: true, message: 'Meal plan saved' });
});

// ─── DAILY MEAL LOG (calorie tracker + weekly overview) ────────────────────
app.get('/api/logs', auth, (req, res) => {
  res.json(readJSON(LOGS_FILE).filter(l => l.userId === req.userId));
});

app.post('/api/logs', auth, (req, res) => {
  const { name, calories, protein, carbs, fat, date } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Meal name is required' });
  const logs = readJSON(LOGS_FILE);
  const entry = {
    id: uuidv4(),
    userId: req.userId,
    name: String(name).trim(),
    calories: Math.round(Number(calories) || 0),
    protein: +(Number(protein) || 0).toFixed(1),
    carbs: +(Number(carbs) || 0).toFixed(1),
    fat: +(Number(fat) || 0).toFixed(1),
    date: date || new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };
  logs.push(entry);
  writeJSON(LOGS_FILE, logs);
  res.status(201).json(entry);
});

app.delete('/api/logs/:id', auth, (req, res) => {
  let logs = readJSON(LOGS_FILE);
  const before = logs.length;
  logs = logs.filter(l => !(l.id === req.params.id && l.userId === req.userId));
  if (logs.length === before) return res.status(404).json({ error: 'Log not found' });
  writeJSON(LOGS_FILE, logs);
  res.json({ success: true });
});

// ─── AI CHAT (NutriAI) ─────────────────────────────────────────────────────

// Match a fridge ingredient back to the food DB to recover real per-100g nutrition.
function matchFood(name) {
  if (!name) return null;
  const q = String(name).toLowerCase().trim();
  return foods.find(f => f.name.toLowerCase() === q)
      || foods.find(f => f.name.toLowerCase().includes(q) || q.includes(f.name.toLowerCase()))
      || null;
}

// Context-engineered system prompt: critical rules + targets are bookended at the
// top AND bottom (combats lost-in-middle); fridge gets real macros (high signal);
// the full catalog is demoted to reference (signal-to-noise); guardrails block
// invented numbers (anti-hallucination).
function buildSystemPrompt(user, fridge, cal) {
  // Profile with explicit missing-field detection so the model asks instead of guessing.
  const fields = [
    ['name', user && user.name], ['age', user && user.age], ['gender', user && user.gender],
    ['height_cm', user && user.height], ['current_weight_kg', user && user.weight],
    ['target_weight_kg', user && user.targetWeight], ['activity', user && user.activityLevel],
    ['goal', user && user.goal], ['timeline_weeks', user && user.timeline],
  ];
  const filled = v => v !== undefined && v !== null && v !== '';
  const known = fields.filter(([, v]) => filled(v));
  const missing = fields.filter(([, v]) => !filled(v)).map(([k]) => k);
  const profileLines = known.length ? known.map(([k, v]) => `  - ${k}: ${v}`).join('\n') : '  - (no profile saved yet)';

  // Highest-signal block: personalised targets, including the rich planning data.
  const targetBlock = cal ? [
    `  - daily_calorie_target: ${cal.target} kcal`,
    `  - macros: ${cal.protein}g protein / ${cal.carbs}g carbs / ${cal.fats}g fat`,
    `  - tdee: ${cal.tdee} kcal · direction: ${cal.direction} (${cal.dailyAdjust >= 0 ? '+' : ''}${cal.dailyAdjust} kcal/day vs TDEE)`,
    cal.goalKg ? `  - goal: ${cal.direction} ${cal.goalKg}kg over ~${cal.effWeeks} weeks (~${Math.abs(cal.weeklyChange)}kg/week)` : null,
    cal.completionDate ? `  - projected_completion: ${cal.completionDate}` : null,
  ].filter(Boolean).join('\n') : '  - not calculated yet (profile incomplete)';

  // Fridge with REAL per-100g nutrition recovered from the DB (what the user can cook now).
  const fridgeBlock = fridge.length ? fridge.map(i => {
    const f = matchFood(i.name);
    const macros = f ? ` [${f.calories}kcal · P${f.nutrition.protein} C${f.nutrition.carbs} F${f.nutrition.fat} /100g]` : ' [not in DB — no verified macros]';
    const qty = i.quantity ? ` x${i.quantity}` : '';
    return `  - ${i.name}${qty}${macros}`;
  }).join('\n') : '  - (fridge is empty)';

  // Reference catalog: compact, explicitly lower priority than the fridge.
  const catalog = foods
    .map(f => `${f.name} (${f.calories}kcal P${f.nutrition.protein}/C${f.nutrition.carbs}/F${f.nutrition.fat})`)
    .join(', ');

  const targetRecap = cal
    ? `${cal.target} kcal/day (${cal.protein}g P / ${cal.carbs}g C / ${cal.fats}g F)`
    : "the user's targets once their profile is complete";

  return `You are NutriAI, the nutrition and fitness assistant inside NutriFell.
Give specific, accurate, encouraging guidance grounded ONLY in the data below.

NON-NEGOTIABLE RULES:
1. Use ONLY the numbers provided here. NEVER invent or estimate calories, macros, or nutrient values you were not given. If a food's data is not below, say you don't have verified data for it.
2. If a profile field you need is missing, ask the user for it instead of guessing. Currently missing: ${missing.length ? missing.join(', ') : 'none'}.
3. Suggest meals FRIDGE-FIRST. You may add 1-2 catalog items to complete a meal, but label them "to buy".
4. Attach calories and macros (and gram portions) to every meal you suggest, and keep the day within the calorie target.
5. No medical diagnosis. For conditions or medication, recommend seeing a doctor.
6. Be concise and practical: short paragraphs or tight bullet lists.

USER PROFILE:
${profileLines}

DAILY TARGETS (base every recommendation on these):
${targetBlock}

FRIDGE (cook with these first; macros are per 100g):
${fridgeBlock}

FOOD CATALOG (reference only, per 100g — use when the fridge lacks something):
${catalog}

REMEMBER: keep advice within ${targetRecap}. Use real numbers from above, go fridge-first, attach macros to meals, and stay encouraging.`;
}

// Smart rule-based assistant used when no Gemini API key is configured (or the API errors)
function fallbackReply(message, user, fridge, cal) {
  const m = String(message).toLowerCase();
  const name = user && user.name ? user.name.split(' ')[0] : 'there';
  const t = cal ? cal.target : null;
  const names = fridge.map(f => f.name);
  const has = names.length ? names.join(', ') : 'nothing yet';
  const noKey = genAI ? '' : '\n\n_(Tip: add a real GEMINI_API_KEY to .env for full conversational AI — these are smart built-in answers.)_';

  if (/protein/.test(m)) {
    return cal
      ? `Based on your ${t} kcal/day target, aim for about **${cal.protein}g of protein** daily (~${(cal.protein / (user.weight || 70)).toFixed(1)}g per kg). Spread it out — eggs at breakfast, chicken/fish at lunch & dinner, Greek yogurt as a snack.${noKey}`
      : `Complete your profile and I'll calculate your exact protein target.${noKey}`;
  }
  if (/(how many )?calorie|target|tdee/.test(m)) {
    return cal
      ? `Your personalized target is **${t} kcal/day** — a ${cal.direction === 'lose' ? 'deficit' : cal.direction === 'gain' ? 'surplus' : 'maintenance'} of ${Math.abs(cal.dailyAdjust)} cal vs your TDEE of ${cal.tdee}. Macros: ${cal.protein}g P / ${cal.carbs}g C / ${cal.fats}g F.${noKey}`
      : `Finish your profile (weight, height, age, activity, goal) and I'll compute your exact target.${noKey}`;
  }
  if (/meal plan|plan for (today|the day)|day plan|1\d{3}\s*cal/.test(m)) {
    if (!fridge.length) return `Your fridge is empty, ${name}! Add a few ingredients and I'll build a full day around your ${t || 'daily'} kcal target. Use the **Generate Meal Plan** button once stocked.${noKey}`;
    const line = (label, nm) => {
      const f = matchFood(nm);
      return `• **${label}** — ${nm || 'your items'}${f ? ` (${f.calories} kcal/100g · ${f.nutrition.protein}g P)` : ''}`;
    };
    return `From your fridge (${has}) for a ${t || ''} kcal day:\n${line('Breakfast', names[0] || 'eggs')}\n${line('Lunch', names[1] || names[0])}\n${line('Dinner', names[2] || names[0])}\n${line('Snack', names[3] || names[0])}\nHit **Generate Meal Plan** for exact portions and macros!${noKey}`;
  }
  if (/cook|make with|recipe|what can i (eat|make|cook)|20 min|quick/.test(m)) {
    return fridge.length
      ? `With ${has}, build a plate of protein + carb + veg. A quick option: ${names.slice(0, 2).join(' + ') || 'your items'} — ready in ~15 min. Tap **Generate Meal Plan** for portioned macros.${noKey}`
      : `Add a few ingredients first, then I'll suggest recipes you can actually make with what you have.${noKey}`;
  }
  if (/give up|quit|too hard|can.?t do|motivat|hate this/.test(m)) {
    return `Don't give up, ${name}! ${cal && cal.goalKg ? `You're aiming to ${cal.direction} ${cal.goalKg}kg — totally achievable at a healthy pace.` : ''} Progress isn't linear; consistency beats perfection. One good choice at a time. 💪${noKey}`;
  }
  if (/realistic|how long|when will|see results|results/.test(m)) {
    return cal && cal.completionDate
      ? `At a safe pace you'd hit your goal around **${cal.completionDate}** (~${cal.effWeeks} weeks), changing about ${Math.abs(cal.weeklyChange)}kg/week. Visible results usually show in 3-4 weeks. Stay consistent!${noKey}`
      : `Set a target weight and timeline in your profile and I'll project your completion date.${noKey}`;
  }
  if (/cheat|ate too much|over\s?ate|already ate|slipped/.test(m)) {
    return `No worries — one meal won't undo your progress. Get back on track at your next meal, hit your ${t || 'daily'} target tomorrow, drink water, and add a walk if you can. You've got this.${noKey}`;
  }
  if (/rice|carb|sugar|bread|good for/.test(m)) {
    return `Carbs aren't the enemy — they fuel training and recovery. For ${cal && cal.direction === 'lose' ? 'fat loss' : 'your goal'}, keep portions aligned to your ${cal ? cal.carbs + 'g' : 'daily'} carb target and favor whole sources (rice, oats, sweet potato) over refined ones.${noKey}`;
  }
  if (/water|hydrat|drink|thirsty/.test(m)) {
    const goal = user && user.weight ? `${Math.round(user.weight * 0.033 * 10) / 10} L` : '2–3 L';
    return `Hydration counts as much as food, ${name}. A simple daily target is about **${goal}**, more on training days or in the heat. Track it on the **Water** page.${noKey}`;
  }
  return `Hi ${name}! I'm **NutriAI**. I can suggest meals from your fridge (${has}), explain your ${t ? t + ' kcal' : ''} targets, and answer nutrition questions. Try: "make me a meal plan", "how much protein do I need?", or "what can I cook?"${noKey}`;
}

app.post('/api/ai/chat', auth, async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });

  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const fridge = readJSON(FRIDGES_FILE).filter(i => i.userId === req.userId);
  const cal = calcCalories(user);

  if (!genAI) {
    return res.json({ reply: fallbackReply(message, user, fridge, cal), fallback: true });
  }
  try {
    const model = genAI.getGenerativeModel({
      // gemini-1.5-flash is retired (404) on this key; gemini-2.5-flash is the
      // current free-tier flash model with available quota. Override via GEMINI_MODEL.
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      systemInstruction: buildSystemPrompt(user, fridge, cal),
    });
    // Gemini requires history to start with a 'user' turn; include prior turns as context text
    const prior = Array.isArray(history) ? history.slice(-10) : [];
    const convo = prior
      .map(h => `${h.role === 'assistant' ? 'NutriAI' : 'User'}: ${String(h.content)}`)
      .join('\n');
    const prompt = (convo ? convo + '\n' : '') + 'User: ' + String(message);
    const result = await model.generateContent(prompt);
    const reply = (result.response.text() || '').trim();
    res.json({ reply: reply || fallbackReply(message, user, fridge, cal) });
  } catch (err) {
    res.json({ reply: fallbackReply(message, user, fridge, cal), fallback: true, note: 'AI service temporarily unavailable' });
  }
});

// ─── STRIPE SUBSCRIPTIONS ───────────────────────────────────────────────
function updateUserSub(userId, fields) {
  if (!userId) return;
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return;
  users[idx] = { ...users[idx], ...fields };
  writeJSON(USERS_FILE, users);
}
function findUserByStripe(customerId, subId) {
  const users = readJSON(USERS_FILE);
  return users.find(u =>
    (subId && u.stripeSubscriptionId === subId) ||
    (customerId && u.stripeCustomerId === customerId)
  ) || null;
}

// Create a Stripe Checkout session for a subscription, return its URL
app.post('/api/checkout/create-session', auth, async (req, res) => {
  if (FREE_LAUNCH) return res.status(503).json({ error: 'Paid plans are not available yet — all features are free during beta.', freeLaunch: true });
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured on this server.' });
  const planKey = String((req.body && req.body.plan) || '').toLowerCase();
  const cycle = (req.body && req.body.billing) === 'annual' ? 'annual' : 'monthly';
  const priceId = STRIPE_PRICES[planKey] && STRIPE_PRICES[planKey][cycle];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan or billing cycle' });

  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    // Reuse this user's Stripe customer, or create one and persist the id
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      writeJSON(USERS_FILE, users);
    }

    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/fridge.html?upgraded=true`,
      cancel_url: `${origin}/pricing.html`,
      metadata: { userId: user.id, plan: planKey, billing: cycle },
      subscription_data: { metadata: { userId: user.id, plan: planKey } },
      allow_promotion_codes: true,
    });
    res.json({ sessionUrl: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Stripe webhook — keeps user plan in sync with subscription lifecycle
app.post('/api/webhook/stripe', express.raw({ type: '*/*' }), async (req, res) => {
  if (!stripe) return res.status(503).end();
  const sig = req.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (whSecret && whSecret.startsWith('whsec_') && !whSecret.includes('replace_me')) {
      event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
    } else {
      // Dev fallback when no verified secret is configured — parse unverified.
      event = JSON.parse(req.body.toString('utf8'));
      console.warn('⚠ Stripe webhook signature NOT verified — set STRIPE_WEBHOOK_SECRET for production.');
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const userId = s.client_reference_id || (s.metadata && s.metadata.userId);
        const plan = (s.metadata && s.metadata.plan) || 'pro';
        let validUntil = null, cancelAtPeriodEnd = false;
        const subId = s.subscription;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          validUntil = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
          cancelAtPeriodEnd = !!sub.cancel_at_period_end;
        }
        updateUserSub(userId, {
          plan, stripeCustomerId: s.customer, stripeSubscriptionId: subId,
          planValidUntil: validUntil, cancelAtPeriodEnd,
        });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = findUserByStripe(sub.customer, sub.id);
        if (user) {
          const active = ['active', 'trialing', 'past_due'].includes(sub.status);
          const keepPlan = user.plan && user.plan !== 'free' ? user.plan : ((sub.metadata && sub.metadata.plan) || 'pro');
          updateUserSub(user.id, {
            plan: active ? keepPlan : 'free',
            planValidUntil: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : user.planValidUntil,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
            stripeSubscriptionId: sub.id,
          });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = findUserByStripe(sub.customer, sub.id);
        if (user) updateUserSub(user.id, { plan: 'free', planValidUntil: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null });
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }
  res.json({ received: true });
});

// Current subscription status for the logged-in user
app.get('/api/subscription/status', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    // During the free launch everyone has full access regardless of stored plan.
    plan: FREE_LAUNCH ? 'free' : (user.plan || 'free'),
    freeLaunch: FREE_LAUNCH,
    validUntil: user.planValidUntil || null,
    cancelAtPeriodEnd: !!user.cancelAtPeriodEnd,
  });
});

// Public launch flag — lets the pricing page render the right banner/buttons.
app.get('/api/launch-status', (req, res) => {
  res.json({ freeLaunch: FREE_LAUNCH });
});

// Waitlist signup for paid plans (captured now, contacted when plans launch).
app.post('/api/waitlist', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const plan = String((req.body && req.body.plan) || 'pro').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const list = readJSON(WAITLIST_FILE);
  const existing = list.find(w => w.email === email && w.plan === plan);
  if (existing) {
    return res.json({ ok: true, alreadyJoined: true, message: "You're already on the waitlist — we'll be in touch!" });
  }
  list.push({
    email,
    plan: ['pro', 'elite'].includes(plan) ? plan : 'pro',
    createdAt: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || null,
  });
  writeJSON(WAITLIST_FILE, list);
  res.json({ ok: true, message: "You're on the list! We'll email you when paid plans launch." });
});

// ═══════════════════════════════════════════════════════════════════════
//  WATER TRACKER
// ═══════════════════════════════════════════════════════════════════════
const GLASS_ML = 250;
const today = () => new Date().toISOString().slice(0, 10);

// Recommended daily water = weight(kg) × 0.033 L → ml. Falls back to 2000ml.
function waterGoalFor(user) {
  if (user && user.waterGoalMl) return Math.round(user.waterGoalMl);          // manual override
  if (user && user.weight) return Math.round(Number(user.weight) * 33);        // 0.033 L per kg
  return 2000;
}

function waterSummary(userId) {
  const user = readJSON(USERS_FILE).find(u => u.id === userId);
  const goalMl = waterGoalFor(user);
  const all = readJSON(WATER_FILE).filter(w => w.userId === userId);
  const t = today();
  const todays = all.filter(w => w.date === t).sort((a, b) => a.at.localeCompare(b.at));
  const consumedMl = todays.reduce((s, w) => s + w.ml, 0);
  return {
    goalMl, goalL: +(goalMl / 1000).toFixed(2), glassSize: GLASS_ML,
    goalGlasses: Math.round(goalMl / GLASS_ML),
    consumedMl, consumedL: +(consumedMl / 1000).toFixed(2),
    glassesDone: +(consumedMl / GLASS_ML).toFixed(1),
    glassesRemaining: Math.max(0, Math.ceil((goalMl - consumedMl) / GLASS_ML)),
    percent: goalMl ? Math.round((consumedMl / goalMl) * 100) : 0,
    entries: todays,
    autoGoal: !(user && user.waterGoalMl),
    weight: user ? user.weight : null,
  };
}

app.get('/api/water/today', auth, (req, res) => res.json(waterSummary(req.userId)));

app.post('/api/water/add', auth, (req, res) => {
  const ml = Math.round(Number(req.body && req.body.ml));
  if (!ml || ml <= 0 || ml > 5000) return res.status(400).json({ error: 'Enter a valid amount (1–5000 ml)' });
  const all = readJSON(WATER_FILE);
  const now = new Date();
  const entry = { id: uuidv4(), userId: req.userId, ml, date: today(), at: now.toISOString() };
  all.push(entry);
  writeJSON(WATER_FILE, all);
  res.status(201).json({ entry, summary: waterSummary(req.userId) });
});

app.delete('/api/water/:id', auth, (req, res) => {
  let all = readJSON(WATER_FILE);
  const before = all.length;
  all = all.filter(w => !(w.id === req.params.id && w.userId === req.userId));
  if (all.length === before) return res.status(404).json({ error: 'Entry not found' });
  writeJSON(WATER_FILE, all);
  res.json({ success: true, summary: waterSummary(req.userId) });
});

// Override the daily goal (manual). Pass goalMl=0/null to revert to auto.
app.post('/api/water/goal', auth, (req, res) => {
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const raw = req.body && req.body.goalMl;
  const goalMl = raw == null || raw === '' || Number(raw) <= 0 ? null : Math.round(Number(raw));
  if (goalMl != null && (goalMl < 500 || goalMl > 8000)) return res.status(400).json({ error: 'Goal must be 0.5–8 L' });
  users[idx].waterGoalMl = goalMl;
  writeJSON(USERS_FILE, users);
  res.json(waterSummary(req.userId));
});

app.get('/api/water/history', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const goalMl = waterGoalFor(user);
  const all = readJSON(WATER_FILE).filter(w => w.userId === req.userId);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const totalMl = all.filter(w => w.date === d).reduce((s, w) => s + w.ml, 0);
    days.push({
      date: d, totalMl, goalMl,
      percent: goalMl ? Math.round((totalMl / goalMl) * 100) : 0,
      onTrack: totalMl >= goalMl,
    });
  }
  res.json({ goalMl, days });
});

// ═══════════════════════════════════════════════════════════════════════
//  QUIT SMOKING TRACKER
// ═══════════════════════════════════════════════════════════════════════
// Health recovery milestones (minutes after the quit moment)
const SMOKING_MILESTONES = [
  { key: '20min', minutes: 20,            title: '20 Minutes',  desc: 'Heart rate and blood pressure drop.' },
  { key: '12hr',  minutes: 12 * 60,       title: '12 Hours',    desc: 'Carbon monoxide levels normalize.' },
  { key: '24hr',  minutes: 24 * 60,       title: '24 Hours',    desc: 'Heart attack risk begins to decrease.' },
  { key: '48hr',  minutes: 48 * 60,       title: '48 Hours',    desc: 'Nerve endings regrow; smell and taste improve.' },
  { key: '2wk',   minutes: 14 * 1440,     title: '2 Weeks',     desc: 'Circulation improves; lung function increases.' },
  { key: '1mo',   minutes: 30 * 1440,     title: '1 Month',     desc: 'Coughing and shortness of breath decrease.' },
  { key: '3mo',   minutes: 90 * 1440,     title: '3 Months',    desc: 'Lung function improves up to 30%.' },
  { key: '6mo',   minutes: 180 * 1440,    title: '6 Months',    desc: 'Stress levels lower than when smoking.' },
  { key: '1yr',   minutes: 365 * 1440,    title: '1 Year',      desc: 'Heart disease risk cut in half.' },
  { key: '5yr',   minutes: 5 * 365 * 1440,  title: '5 Years',   desc: 'Stroke risk same as a non-smoker.' },
  { key: '10yr',  minutes: 10 * 365 * 1440, title: '10 Years',  desc: 'Lung cancer risk cut in half.' },
  { key: '15yr',  minutes: 15 * 365 * 1440, title: '15 Years',  desc: 'Heart disease risk same as a non-smoker.' },
];
// Achievement badges (days smoke-free)
const SMOKING_BADGES = [
  { key: 'day1',  days: 1,   icon: '🥉', title: 'First 24 Hours', desc: 'Survived one full day.' },
  { key: 'week1', days: 7,   icon: '🥈', title: 'One Week Warrior', desc: '7 days smoke-free.' },
  { key: 'month', days: 30,  icon: '🥇', title: 'Month Master', desc: '30 days smoke-free.' },
  { key: 'q',     days: 90,  icon: '💎', title: 'Quarter Champion', desc: '90 days smoke-free.' },
  { key: 'half',  days: 180, icon: '👑', title: 'Half Year Hero', desc: '180 days smoke-free.' },
  { key: 'year',  days: 365, icon: '🏆', title: 'Year Legend', desc: '365 days smoke-free.' },
];

const getSmokingRec = (userId) => readJSON(SMOKING_FILE).find(s => s.userId === userId) || null;

function smokingStats(rec) {
  if (!rec) return null;
  const quitMs = new Date(rec.quitDate).getTime();
  const now = Date.now();
  const elapsedMin = Math.max(0, (now - quitMs) / 60000);
  const days = elapsedMin / 1440;
  const cigsNotSmoked = Math.floor(days * rec.cigsPerDay);
  const moneySaved = +((cigsNotSmoked / rec.cigsPerPack) * rec.pricePerPack).toFixed(2);
  const lifeMinutes = cigsNotSmoked * 11; // ~11 min of life per cigarette
  const healthScore = Math.min(100, Math.round(100 * (1 - Math.exp(-days / 30))));
  const milestones = SMOKING_MILESTONES.map(m => {
    const reachedAt = new Date(quitMs + m.minutes * 60000);
    return { ...m, reached: elapsedMin >= m.minutes, reachedAt: reachedAt.toISOString(), current: false };
  });
  // mark the first not-yet-reached milestone as the "current" one being worked toward
  const nextIdx = milestones.findIndex(m => !m.reached);
  if (nextIdx !== -1) milestones[nextIdx].current = true;
  const cravingsSurvived = (rec.cravings || []).length;
  const badges = SMOKING_BADGES.map(b => ({ ...b, unlocked: days >= b.days,
    unlockAt: new Date(quitMs + b.days * 1440 * 60000).toISOString() }));
  return {
    quitDate: rec.quitDate, cigsPerDay: rec.cigsPerDay, cigsPerPack: rec.cigsPerPack,
    pricePerPack: rec.pricePerPack, currency: rec.currency || '$', brand: rec.brand || '',
    motivation: rec.motivation || '',
    daysQuit: +days.toFixed(2), cigsNotSmoked, moneySaved,
    lifeMinutes, lifeHours: +(lifeMinutes / 60).toFixed(1),
    healthScore, milestones, badges, cravingsSurvived,
  };
}

app.get('/api/smoking/stats', auth, (req, res) => {
  const rec = getSmokingRec(req.userId);
  if (!rec) return res.json({ setup: false });
  res.json({ setup: true, ...smokingStats(rec) });
});

app.post('/api/smoking/setup', auth, (req, res) => {
  const b = req.body || {};
  const quitDate = b.quitDate ? new Date(b.quitDate) : null;
  const cigsPerDay = Number(b.cigsPerDay);
  const pricePerPack = Number(b.pricePerPack);
  const cigsPerPack = Number(b.cigsPerPack) || 20;
  if (!quitDate || isNaN(quitDate.getTime())) return res.status(400).json({ error: 'A valid quit date is required' });
  if (!cigsPerDay || cigsPerDay <= 0) return res.status(400).json({ error: 'Enter cigarettes per day' });
  if (!pricePerPack || pricePerPack <= 0) return res.status(400).json({ error: 'Enter the price per pack' });

  const all = readJSON(SMOKING_FILE);
  const idx = all.findIndex(s => s.userId === req.userId);
  const existing = idx !== -1 ? all[idx] : null;
  const rec = {
    userId: req.userId,
    quitDate: quitDate.toISOString(),
    cigsPerDay, pricePerPack, cigsPerPack,
    brand: b.brand ? String(b.brand).trim() : '',
    currency: b.currency ? String(b.currency).trim().slice(0, 4) : '$',
    motivation: b.motivation ? String(b.motivation).trim() : '',
    cravings: existing ? existing.cravings || [] : [],
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (idx === -1) all.push(rec); else all[idx] = rec;
  writeJSON(SMOKING_FILE, all);
  res.json({ setup: true, ...smokingStats(rec) });
});

app.post('/api/smoking/craving', auth, (req, res) => {
  const all = readJSON(SMOKING_FILE);
  const idx = all.findIndex(s => s.userId === req.userId);
  if (idx === -1) return res.status(400).json({ error: 'Set up your quit plan first' });
  all[idx].cravings = all[idx].cravings || [];
  all[idx].cravings.push({ id: uuidv4(), at: new Date().toISOString(), note: (req.body && req.body.note) || '' });
  writeJSON(SMOKING_FILE, all);
  res.status(201).json({ cravingsSurvived: all[idx].cravings.length });
});

app.get('/api/smoking/cravings', auth, (req, res) => {
  const rec = getSmokingRec(req.userId);
  res.json(rec && rec.cravings ? rec.cravings.slice().reverse() : []);
});

// AI quit-smoking support chat (Gemini with CBT-flavoured context, rule-based fallback)
function smokingFallback(message, st) {
  const m = String(message).toLowerCase();
  if (/craving|urge|want.*smoke|need.*cig/.test(m)) {
    return `This craving will pass in 3–5 minutes — it always does. Right now: sip a glass of water slowly, take 5 deep breaths, and step outside or do 10 pushups. You've already avoided ${st ? st.cigsNotSmoked : 'many'} cigarettes — don't hand one back. You've got this. 💪`;
  }
  if (/money|saved|cost/.test(m)) {
    return st ? `You've saved ${st.currency}${st.moneySaved} so far by not buying ${st.cigsNotSmoked} cigarettes. That money is yours now — picture what you'll do with it.` : `Set up your plan and I'll show you exactly how much you've saved.`;
  }
  if (/give up|relapse|slip|failed|weak/.test(m)) {
    return `One slip doesn't erase your progress${st ? ` — you've been mostly smoke-free for ${Math.floor(st.daysQuit)} days` : ''}. Be kind to yourself, identify the trigger, and recommit right now. Quitting is a skill you're learning, not a pass/fail test.`;
  }
  return st
    ? `You've been smoke-free and avoided ${st.cigsNotSmoked} cigarettes — that's real progress. Remember why you started${st.motivation ? `: "${st.motivation}"` : ''}. What's on your mind right now?`
    : `I'm here to support your quit journey. Tell me what you're feeling, or tap the craving button if you need help right now.`;
}

app.post('/api/smoking/chat', auth, async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });
  const rec = getSmokingRec(req.userId);
  const st = rec ? smokingStats(rec) : null;
  if (!genAI) return res.json({ reply: smokingFallback(message, st), fallback: true });
  try {
    const ctx = st ? `The user quit smoking. Days smoke-free: ${Math.floor(st.daysQuit)}. Cigarettes avoided: ${st.cigsNotSmoked}. Money saved: ${st.currency}${st.moneySaved}. Cravings they've already beaten: ${st.cravingsSurvived}. Their motivation for quitting: "${st.motivation || 'not stated'}".` : 'The user has not set up their quit plan yet.';
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      systemInstruction: `You are a warm, encouraging quit-smoking coach for NutriFell. Use Cognitive Behavioral Therapy (CBT) techniques and practical craving-management strategies. Be supportive, never judgmental. Keep replies short, concrete and actionable. Celebrate progress. If the user mentions a craving, give an immediate 3–5 minute coping plan. Never give medical diagnoses; suggest a doctor for medication questions.\n\n${ctx}`,
    });
    const prior = Array.isArray(history) ? history.slice(-10) : [];
    const convo = prior.map(h => `${h.role === 'assistant' ? 'Coach' : 'User'}: ${String(h.content)}`).join('\n');
    const prompt = (convo ? convo + '\n' : '') + 'User: ' + String(message);
    const result = await model.generateContent(prompt);
    const reply = (result.response.text() || '').trim();
    res.json({ reply: reply || smokingFallback(message, st) });
  } catch (err) {
    res.json({ reply: smokingFallback(message, st), fallback: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  COMMUNITY RECIPES
// ═══════════════════════════════════════════════════════════════════════
const REACTION_EMOJIS = ['❤️', '😍', '🔥', '👏', '😋', '🤩'];
const RECIPE_CATEGORIES = ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Drinks', 'Desserts'];

// Multer: in-memory, 5MB/file, images only
const recipeUpload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 5 },
      fileFilter: (req, file, cb) => {
        cb(/^image\/(jpe?g|png|webp)$/.test(file.mimetype) ? null : new Error('Only JPG, PNG or WebP images allowed'), true);
      },
    })
  : { array: () => (req, res, next) => next() }; // no-op if multer missing

// Persist uploaded buffers → /uploads/recipes/*.webp (resized to ≤1200px when sharp is available)
async function saveRecipePhotos(files) {
  const urls = [];
  for (const file of files || []) {
    const base = `${Date.now()}-${uuidv4().slice(0, 8)}`;
    if (sharp) {
      const name = `${base}.webp`;
      await sharp(file.buffer).rotate().resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 82 }).toFile(path.join(UPLOADS_DIR, name));
      urls.push(`/uploads/recipes/${name}`);
    } else {
      const ext = (file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const name = `${base}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, name), file.buffer);
      urls.push(`/uploads/recipes/${name}`);
    }
  }
  return urls;
}

// Compute total + per-serving nutrition by matching ingredients to the food DB
function computeRecipeNutrition(ingredients, servings) {
  const tot = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  let matched = 0;
  for (const ing of ingredients || []) {
    const food = foods.find(f => f.id === ing.foodId) || (ing.name ? foods.find(f => f.id === matchFoodId(ing.name)) : null);
    const grams = Number(ing.grams) || 0;
    if (!food || !grams) continue;
    matched++;
    const factor = grams / 100;
    tot.calories += (food.calories || 0) * factor;
    tot.protein += (food.nutrition.protein || 0) * factor;
    tot.carbs += (food.nutrition.carbs || 0) * factor;
    tot.fat += (food.nutrition.fat || 0) * factor;
    tot.fiber += (food.nutrition.fiber || 0) * factor;
  }
  const s = Math.max(1, Number(servings) || 1);
  const per = (v) => +(v / s).toFixed(1);
  return {
    matched,
    total: { calories: Math.round(tot.calories), protein: +tot.protein.toFixed(1), carbs: +tot.carbs.toFixed(1), fat: +tot.fat.toFixed(1), fiber: +tot.fiber.toFixed(1) },
    perServing: { calories: Math.round(tot.calories / s), protein: per(tot.protein), carbs: per(tot.carbs), fat: per(tot.fat), fiber: per(tot.fiber) },
  };
}

// Aggregate reactions/ratings/comments + compute the ranking score for a recipe
function decorateRecipe(r, allReactions, allComments, allRatings) {
  const reactions = allReactions.filter(x => x.recipeId === r.id);
  const counts = {};
  for (const e of REACTION_EMOJIS) counts[e] = 0;
  reactions.forEach(x => { if (counts[x.emoji] != null) counts[x.emoji]++; });
  const totalReactions = reactions.length;
  const ratings = (r.ratings || []);
  const avgRating = ratings.length ? +(ratings.reduce((s, x) => s + x.value, 0) / ratings.length).toFixed(1) : 0;
  const commentCount = allComments.filter(c => c.recipeId === r.id).length;
  const daysSince = (Date.now() - new Date(r.createdAt).getTime()) / 86400000;
  const recencyScore = Math.max(0, 30 - daysSince);
  const score = totalReactions * 1 + avgRating * 20 + commentCount * 2 + recencyScore;
  const topReactions = Object.entries(counts).filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([emoji, count]) => ({ emoji, count }));
  const quick = (Number(r.prepTime) || 0) + (Number(r.cookTime) || 0) <= 30;
  const healthy = (r.aiAnalysis && r.aiAnalysis.score >= 7) || false;
  return {
    ...r,
    reactionCounts: counts, totalReactions, topReactions,
    avgRating, ratingCount: ratings.length, commentCount,
    score, badges: { quick, healthy },
  };
}

app.get('/api/recipes', (req, res) => {
  const recipes = readJSON(RECIPES_FILE);
  const reactions = readJSON(REACTIONS_FILE);
  const comments = readJSON(COMMENTS_FILE);
  let list = recipes.map(r => decorateRecipe(r, reactions, comments));
  const { category, q, sort } = req.query;
  if (category && category !== 'All') list = list.filter(r => r.category === category);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter(r =>
      r.name.toLowerCase().includes(needle) ||
      (r.tags || []).some(t => String(t).toLowerCase().includes(needle)) ||
      (r.ingredients || []).some(i => String(i.name).toLowerCase().includes(needle)) ||
      r.category.toLowerCase().includes(needle));
  }
  switch (sort) {
    case 'newest': list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); break;
    case 'top': list.sort((a, b) => b.avgRating - a.avgRating || b.totalReactions - a.totalReactions); break;
    case 'comments': list.sort((a, b) => b.commentCount - a.commentCount); break;
    default: list.sort((a, b) => b.score - a.score); // "Most Reacted" / overall ranking
  }
  // Strip heavy fields for the grid
  res.json(list.map(r => ({
    id: r.id, name: r.name, category: r.category, description: r.description,
    cover: (r.photos || [])[0] || null, authorName: r.authorName, userId: r.userId,
    prepTime: r.prepTime, cookTime: r.cookTime, servings: r.servings, difficulty: r.difficulty,
    calories: r.nutrition ? r.nutrition.perServing.calories : null,
    avgRating: r.avgRating, ratingCount: r.ratingCount, commentCount: r.commentCount,
    totalReactions: r.totalReactions, topReactions: r.topReactions, badges: r.badges,
    tags: r.tags || [], createdAt: r.createdAt,
  })));
});

app.get('/api/recipes/meta', (req, res) => {
  res.json({ categories: RECIPE_CATEGORIES, reactions: REACTION_EMOJIS,
    foods: foods.map(f => ({ id: f.id, name: f.name, emoji: f.emoji, calories: f.calories })) });
});

app.get('/api/recipes/:id', (req, res) => {
  const recipes = readJSON(RECIPES_FILE);
  const r = recipes.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  const decorated = decorateRecipe(r, readJSON(REACTIONS_FILE), readJSON(COMMENTS_FILE));
  // who reacted with what (for current user highlight) handled client-side via token-less GET → skip
  res.json(decorated);
});

// Parse the multipart body into a normalized recipe payload
function parseRecipeBody(body) {
  const parseJSON = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const ingredients = (parseJSON(body.ingredients, []) || []).map(i => ({
    name: String(i.name || '').trim(), foodId: i.foodId || matchFoodId(i.name || ''),
    quantity: i.quantity != null ? String(i.quantity) : '', unit: i.unit || 'g',
    grams: Number(i.grams) || 0,
  })).filter(i => i.name);
  const steps = (parseJSON(body.steps, []) || []).map(s =>
    (typeof s === 'string' ? { text: s } : { text: String(s.text || '').trim(), photo: s.photo || null })
  ).filter(s => s.text);
  const tags = (body.tags ? String(body.tags).split(',') : []).map(t => t.trim()).filter(Boolean).slice(0, 12);
  return { ingredients, steps, tags };
}

app.post('/api/recipes', auth, (req, res) => {
  recipeUpload.array('photos', 5)(req, res, async (uErr) => {
    if (uErr) return res.status(400).json({ error: uErr.message });
    try {
      const b = req.body || {};
      if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Recipe name is required' });
      const category = RECIPE_CATEGORIES.includes(b.category) ? b.category : 'Dinner';
      const { ingredients, steps, tags } = parseRecipeBody(b);
      const servings = Math.max(1, Number(b.servings) || 1);
      const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
      const photos = await saveRecipePhotos(req.files);
      const recipe = {
        id: uuidv4(), userId: req.userId, authorName: (user && user.name) || 'NutriFell Chef',
        name: String(b.name).trim(), category,
        description: b.description ? String(b.description).trim() : '',
        prepTime: Number(b.prepTime) || 0, cookTime: Number(b.cookTime) || 0,
        servings, difficulty: ['Easy', 'Medium', 'Hard'].includes(b.difficulty) ? b.difficulty : 'Easy',
        photos, ingredients, steps,
        opinion: b.opinion ? String(b.opinion).trim() : '',
        tips: b.tips ? String(b.tips).trim() : '',
        tags,
        nutrition: computeRecipeNutrition(ingredients, servings),
        ratings: [], aiAnalysis: null,
        createdAt: new Date().toISOString(),
      };
      const all = readJSON(RECIPES_FILE);
      all.push(recipe);
      writeJSON(RECIPES_FILE, all);
      res.status(201).json(recipe);
    } catch (err) {
      console.error('Recipe create error:', err.message);
      res.status(500).json({ error: 'Could not save recipe. Please try again.' });
    }
  });
});

app.put('/api/recipes/:id', auth, (req, res) => {
  const all = readJSON(RECIPES_FILE);
  const idx = all.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Recipe not found' });
  if (all[idx].userId !== req.userId) return res.status(403).json({ error: 'Not your recipe' });
  const b = req.body || {};
  const r = all[idx];
  if (b.name != null) r.name = String(b.name).trim();
  if (b.category && RECIPE_CATEGORIES.includes(b.category)) r.category = b.category;
  if (b.description != null) r.description = String(b.description).trim();
  if (b.opinion != null) r.opinion = String(b.opinion).trim();
  if (b.tips != null) r.tips = String(b.tips).trim();
  if (b.prepTime != null) r.prepTime = Number(b.prepTime) || 0;
  if (b.cookTime != null) r.cookTime = Number(b.cookTime) || 0;
  if (b.servings != null) r.servings = Math.max(1, Number(b.servings) || 1);
  if (Array.isArray(b.ingredients)) r.ingredients = b.ingredients;
  if (Array.isArray(b.steps)) r.steps = b.steps;
  if (Array.isArray(b.tags)) r.tags = b.tags;
  r.nutrition = computeRecipeNutrition(r.ingredients, r.servings);
  r.aiAnalysis = null; // invalidate stale analysis after edits
  writeJSON(RECIPES_FILE, all);
  res.json(r);
});

app.delete('/api/recipes/:id', auth, (req, res) => {
  const all = readJSON(RECIPES_FILE);
  const r = all.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  if (r.userId !== req.userId) return res.status(403).json({ error: 'Not your recipe' });
  writeJSON(RECIPES_FILE, all.filter(x => x.id !== req.params.id));
  writeJSON(COMMENTS_FILE, readJSON(COMMENTS_FILE).filter(c => c.recipeId !== req.params.id));
  writeJSON(REACTIONS_FILE, readJSON(REACTIONS_FILE).filter(x => x.recipeId !== req.params.id));
  writeJSON(BOOKMARKS_FILE, readJSON(BOOKMARKS_FILE).filter(x => x.recipeId !== req.params.id));
  // remove this recipe's photo files (best-effort)
  (r.photos || []).forEach(p => { try { fs.unlinkSync(path.join(__dirname, 'public', p)); } catch {} });
  res.json({ success: true });
});

// Toggle a reaction (one emoji per user per recipe; re-posting the same emoji removes it)
app.post('/api/recipes/:id/react', auth, (req, res) => {
  const emoji = (req.body && req.body.emoji) || '';
  if (!REACTION_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction' });
  const all = readJSON(REACTIONS_FILE);
  const mine = all.find(x => x.recipeId === req.params.id && x.userId === req.userId);
  let next = all;
  if (mine && mine.emoji === emoji) {
    next = all.filter(x => x !== mine); // toggle off
  } else if (mine) {
    mine.emoji = emoji; mine.at = new Date().toISOString(); // switch reaction
  } else {
    next.push({ id: uuidv4(), recipeId: req.params.id, userId: req.userId, emoji, at: new Date().toISOString() });
  }
  writeJSON(REACTIONS_FILE, next);
  const counts = {}; REACTION_EMOJIS.forEach(e => counts[e] = 0);
  next.filter(x => x.recipeId === req.params.id).forEach(x => { if (counts[x.emoji] != null) counts[x.emoji]++; });
  const myReaction = next.find(x => x.recipeId === req.params.id && x.userId === req.userId);
  res.json({ counts, total: Object.values(counts).reduce((a, c) => a + c, 0), mine: myReaction ? myReaction.emoji : null });
});

app.post('/api/recipes/:id/rate', auth, (req, res) => {
  const value = Math.round(Number(req.body && req.body.value));
  if (!(value >= 1 && value <= 5)) return res.status(400).json({ error: 'Rating must be 1–5' });
  const all = readJSON(RECIPES_FILE);
  const r = all.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  r.ratings = r.ratings || [];
  const mine = r.ratings.find(x => x.userId === req.userId);
  if (mine) mine.value = value; else r.ratings.push({ userId: req.userId, value });
  writeJSON(RECIPES_FILE, all);
  const avg = +(r.ratings.reduce((s, x) => s + x.value, 0) / r.ratings.length).toFixed(1);
  res.json({ avgRating: avg, ratingCount: r.ratings.length, mine: value });
});

app.post('/api/recipes/:id/bookmark', auth, (req, res) => {
  const all = readJSON(BOOKMARKS_FILE);
  const mine = all.find(x => x.recipeId === req.params.id && x.userId === req.userId);
  let next = all, bookmarked;
  if (mine) { next = all.filter(x => x !== mine); bookmarked = false; }
  else { next.push({ userId: req.userId, recipeId: req.params.id, at: new Date().toISOString() }); bookmarked = true; }
  writeJSON(BOOKMARKS_FILE, next);
  res.json({ bookmarked });
});

app.get('/api/bookmarks', auth, (req, res) => {
  const ids = readJSON(BOOKMARKS_FILE).filter(b => b.userId === req.userId).map(b => b.recipeId);
  res.json(ids);
});

app.post('/api/recipes/:id/report', auth, (req, res) => {
  const all = readJSON(REPORTS_FILE);
  all.push({ id: uuidv4(), recipeId: req.params.id, userId: req.userId,
    reason: (req.body && String(req.body.reason || '').slice(0, 500)) || 'Unspecified', at: new Date().toISOString() });
  writeJSON(REPORTS_FILE, all);
  res.json({ success: true, message: 'Thanks — our team will review this recipe.' });
});

// ── Comments (threaded one level) ──
function shapeComments(recipeId) {
  const all = readJSON(COMMENTS_FILE).filter(c => c.recipeId === recipeId);
  const roots = all.filter(c => !c.parentId).sort((a, b) => b.at.localeCompare(a.at));
  return roots.map(c => ({
    ...c, likeCount: (c.likes || []).length,
    replies: all.filter(r => r.parentId === c.id).sort((a, b) => a.at.localeCompare(b.at))
      .map(r => ({ ...r, likeCount: (r.likes || []).length })),
  }));
}

app.get('/api/recipes/:id/comments', (req, res) => res.json(shapeComments(req.params.id)));

app.post('/api/recipes/:id/comments', auth, (req, res) => {
  const text = req.body && String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const all = readJSON(COMMENTS_FILE);
  const comment = { id: uuidv4(), recipeId: req.params.id, userId: req.userId,
    authorName: (user && user.name) || 'NutriFell User', text: text.slice(0, 2000),
    parentId: null, likes: [], at: new Date().toISOString() };
  all.push(comment);
  writeJSON(COMMENTS_FILE, all);
  res.status(201).json(comment);
});

app.post('/api/recipes/:id/comments/:cid/reply', auth, (req, res) => {
  const text = req.body && String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Reply cannot be empty' });
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const all = readJSON(COMMENTS_FILE);
  const parent = all.find(c => c.id === req.params.cid);
  if (!parent) return res.status(404).json({ error: 'Comment not found' });
  const reply = { id: uuidv4(), recipeId: req.params.id, userId: req.userId,
    authorName: (user && user.name) || 'NutriFell User', text: text.slice(0, 2000),
    parentId: parent.parentId || parent.id, likes: [], at: new Date().toISOString() };
  all.push(reply);
  writeJSON(COMMENTS_FILE, all);
  res.status(201).json(reply);
});

app.post('/api/recipes/:id/comments/:cid/like', auth, (req, res) => {
  const all = readJSON(COMMENTS_FILE);
  const c = all.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  c.likes = c.likes || [];
  const i = c.likes.indexOf(req.userId);
  let liked;
  if (i === -1) { c.likes.push(req.userId); liked = true; } else { c.likes.splice(i, 1); liked = false; }
  writeJSON(COMMENTS_FILE, all);
  res.json({ liked, likeCount: c.likes.length });
});

// ── AI recipe analysis (Gemini, cached on the recipe) ──
function recipeAnalysisFallback(r) {
  const n = r.nutrition ? r.nutrition.perServing : null;
  const score = n ? Math.max(1, Math.min(10, Math.round(
    7 + (n.protein >= 20 ? 1 : 0) + (n.fiber >= 5 ? 1 : 0) - (n.calories > 800 ? 2 : 0)
  ))) : 6;
  return {
    score,
    pros: [
      n && n.protein >= 15 ? `Good protein per serving (~${n.protein}g)` : 'Made with whole-food ingredients',
      n && n.fiber >= 4 ? `Solid fiber content (~${n.fiber}g)` : 'Reasonable portion size',
    ],
    cons: [
      n && n.calories > 700 ? 'Calorie-dense — watch portion sizes' : 'Nutrition is estimated from matched ingredients',
      'Sodium and added sugar aren\'t tracked here',
    ],
    suggestions: [
      'Add a non-starchy vegetable to boost fiber and volume',
      n && n.protein < 15 ? 'Increase the protein source for better satiety' : 'Pair with water instead of a sugary drink',
    ],
    bestTime: n && n.protein >= 25 ? 'Post-workout or lunch' : (r.category === 'Breakfast' ? 'Breakfast' : 'Lunch or dinner'),
    fallback: true,
  };
}

app.post('/api/recipes/:id/ai-analysis', async (req, res) => {
  const all = readJSON(RECIPES_FILE);
  const r = all.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  if (r.aiAnalysis) return res.json(r.aiAnalysis); // cached

  const persist = (analysis) => {
    r.aiAnalysis = analysis;
    const fresh = readJSON(RECIPES_FILE);
    const i = fresh.findIndex(x => x.id === r.id);
    if (i !== -1) { fresh[i].aiAnalysis = analysis; writeJSON(RECIPES_FILE, fresh); }
  };

  if (!genAI) { const a = recipeAnalysisFallback(r); persist(a); return res.json(a); }
  try {
    const ingList = (r.ingredients || []).map(i => `${i.name} ${i.quantity || ''}${i.unit || ''}`).join(', ');
    const n = r.nutrition ? r.nutrition.perServing : {};
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      systemInstruction: 'You are a registered-dietitian-style recipe analyst. Respond ONLY with strict minified JSON: {"score":<1-10 integer>,"pros":[3 short strings],"cons":[2-3 short strings],"suggestions":[2-3 short strings],"bestTime":"<short>"}. No markdown, no prose.',
    });
    const prompt = `Recipe: ${r.name} (${r.category}). Ingredients: ${ingList}. Per-serving nutrition: ${JSON.stringify(n)}. Servings: ${r.servings}. Analyze its healthiness.`;
    const result = await model.generateContent(prompt);
    let txt = (result.response.text() || '').trim().replace(/^```json\s*|\s*```$/g, '');
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = null; }
    const analysis = parsed && parsed.score
      ? { score: Math.max(1, Math.min(10, Math.round(parsed.score))),
          pros: parsed.pros || [], cons: parsed.cons || [], suggestions: parsed.suggestions || [],
          bestTime: parsed.bestTime || 'Anytime' }
      : recipeAnalysisFallback(r);
    persist(analysis);
    res.json(analysis);
  } catch (err) {
    const a = recipeAnalysisFallback(r);
    persist(a);
    res.json(a);
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  SOCIAL FEED  (Phase 1 — posts, feed, reactions, comments, saves, follows)
//  Generalizes the recipe social primitives (reactions/comments/bookmarks/
//  reports) to first-class posts. Feed scoring uses the "For You" formula.
// ═══════════════════════════════════════════════════════════════════════
const POST_REACTIONS = ['❤️', '🔥', '😋', '👏', '🤩', '💪'];
const POST_TYPES = ['photo', 'video', 'recipe', 'text'];

// @handle derived from username → name → email local-part.
function userHandle(u) {
  if (!u) return '@nutrifell';
  if (u.username) return '@' + String(u.username).replace(/^@/, '');
  const base = (u.name || (u.email || '').split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return '@' + (base || 'user');
}

// Token is OPTIONAL here (feed/single-post work logged-out); returns userId or null.
function optionalAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET).id; } catch { return null; }
}

// Store a notification (best-effort; never notify yourself). Powers the Phase 3
// bell UI; counts are already queryable via /api/notifications/count.
function pushNotification(type, { toUserId, fromUserId, postId, text }) {
  if (!toUserId || toUserId === fromUserId) return;
  const from = readJSON(USERS_FILE).find(u => u.id === fromUserId);
  const all = readJSON(NOTIFICATIONS_FILE);
  all.unshift({
    id: uuidv4(), type, toUserId, fromUserId,
    fromName: (from && from.name) || 'Someone', fromAvatar: (from && from.avatar) || null,
    postId: postId || null, text: text || '', read: false, at: new Date().toISOString(),
  });
  writeJSON(NOTIFICATIONS_FILE, all.slice(0, 500));
}

function extractHashtags(text) {
  const tags = new Set();
  (String(text || '').match(/#[\p{L}0-9_]+/gu) || []).forEach(t => tags.add(t.slice(1).toLowerCase()));
  return [...tags].slice(0, 30);
}

// Resolve @mentions in free text to unique userIds (custom username first, then
// the derived @handle). Powers mention notifications + clickable @links.
function resolveMentions(text) {
  const tokens = [...new Set((String(text || '').match(/@([a-z0-9_]{2,30})/gi) || []).map(t => t.slice(1).toLowerCase()))];
  if (!tokens.length) return [];
  const users = readJSON(USERS_FILE);
  const ids = [];
  for (const tok of tokens) {
    const u = users.find(x => (x.username || '').toLowerCase() === tok)
      || users.find(x => userHandle(x).slice(1).toLowerCase() === tok);
    if (u) ids.push(u.id);
  }
  return [...new Set(ids)];
}
function notifyMentions(text, fromUserId, postId, label) {
  resolveMentions(text).forEach(toUserId => {
    pushNotification('mention', { toUserId, fromUserId, postId, text: label || 'mentioned you in a post' });
  });
}

// Multer for posts: up to 10 images (JPG/PNG/WebP) OR one video (MP4/WebM/MOV).
// 180MB cap covers ≤3-min reels. Transcoding/thumbnails deferred (no ffmpeg yet).
const postUpload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 180 * 1024 * 1024, files: 10 },
      fileFilter: (req, file, cb) => {
        const ok = /^image\/(jpe?g|png|webp)$/.test(file.mimetype)
          || /^video\/(mp4|webm|quicktime)$/.test(file.mimetype);
        cb(ok ? null : new Error('Only JPG/PNG/WebP images or MP4/WebM/MOV video allowed'), ok);
      },
    })
  : { array: () => (req, res, next) => next() }; // no-op if multer missing

// Persist uploaded buffers → photos (resized WebP) into /uploads/posts and a
// single video into /uploads/reels. Returns { photos:[], video:url|null }.
async function savePostMedia(files) {
  const photos = [];
  let video = null;
  for (const file of files || []) {
    const base = `${Date.now()}-${uuidv4().slice(0, 8)}`;
    if (/^image\//.test(file.mimetype)) {
      if (photos.length >= 10) continue;
      if (sharp) {
        const name = `${base}.webp`;
        await sharp(file.buffer).rotate().resize({ width: 1280, withoutEnlargement: true })
          .webp({ quality: 82 }).toFile(path.join(POSTS_UPLOAD_DIR, name));
        photos.push(`/uploads/posts/${name}`);
      } else {
        const ext = (file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const name = `${base}.${ext}`;
        fs.writeFileSync(path.join(POSTS_UPLOAD_DIR, name), file.buffer);
        photos.push(`/uploads/posts/${name}`);
      }
    } else if (/^video\//.test(file.mimetype) && !video) {
      const ext = file.mimetype === 'video/quicktime' ? 'mov' : (file.mimetype.split('/')[1] || 'mp4');
      const name = `${base}.${ext}`;
      fs.writeFileSync(path.join(REELS_UPLOAD_DIR, name), file.buffer);
      video = `/uploads/reels/${name}`;
    }
  }
  return { photos, video };
}

// Aggregate reactions/comments/saves/views + the For You ranking score, and the
// viewer's own reaction / saved state. Score = likes×3 + comments×5 + saves×4 +
// views×0.1 − hours_old×0.5  (shares deferred to a later phase).
function decoratePost(p, reactions, comments, saves, viewerId) {
  const rs = reactions.filter(x => x.postId === p.id);
  const counts = {}; POST_REACTIONS.forEach(e => counts[e] = 0);
  rs.forEach(x => { if (counts[x.emoji] != null) counts[x.emoji]++; });
  const totalReactions = rs.length;
  const commentCount = comments.filter(c => c.postId === p.id).length;
  const saveCount = saves.filter(s => s.postId === p.id).length;
  const views = p.views || 0;
  const hours = (Date.now() - new Date(p.createdAt).getTime()) / 3600000;
  const score = totalReactions * 3 + commentCount * 5 + saveCount * 4 + views * 0.1 - hours * 0.5;
  const myReaction = viewerId ? ((rs.find(x => x.userId === viewerId) || {}).emoji || null) : null;
  const saved = viewerId ? saves.some(s => s.postId === p.id && s.userId === viewerId) : false;
  return { ...p, reactionCounts: counts, totalReactions, commentCount, saveCount, views, score, myReaction, saved };
}

// ── Feed (paginated, scored, works logged-out) ──
app.get('/api/feed', (req, res) => {
  const viewerId = optionalAuth(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 20;
  const reactions = readJSON(POST_REACTIONS_FILE);
  const comments = readJSON(POST_COMMENTS_FILE);
  const saves = readJSON(POST_SAVES_FILE);
  let list = readJSON(POSTS_FILE).map(p => decoratePost(p, reactions, comments, saves, viewerId));
  const { type, tag, userId } = req.query;
  if (type && POST_TYPES.includes(type)) list = list.filter(p => p.type === type);
  if (tag) list = list.filter(p => (p.hashtags || []).includes(String(tag).toLowerCase()));
  if (userId) list = list.filter(p => p.userId === userId);
  list.sort((a, b) => b.score - a.score);
  const total = list.length;
  const start = (page - 1) * perPage;
  const pageItems = list.slice(start, start + perPage);
  let followingSet = new Set();
  if (viewerId) followingSet = new Set(readJSON(FOLLOWS_FILE).filter(f => f.followerId === viewerId).map(f => f.followingId));
  pageItems.forEach(p => { p.isFollowingAuthor = followingSet.has(p.userId); p.isOwn = p.userId === viewerId; });
  res.json({ posts: pageItems, page, perPage, total, hasMore: start + perPage < total });
});

// ── Create a post ──
app.post('/api/posts', auth, (req, res) => {
  postUpload.array('media', 10)(req, res, async (uErr) => {
    if (uErr) return res.status(400).json({ error: uErr.message });
    try {
      const b = req.body || {};
      const type = POST_TYPES.includes(b.type) ? b.type : 'text';
      const caption = String(b.caption || '').trim().slice(0, 500);
      const { photos, video } = await savePostMedia(req.files);
      if (type === 'photo' && photos.length === 0) return res.status(400).json({ error: 'Add at least one photo.' });
      if (type === 'video' && !video) return res.status(400).json({ error: 'Add a video to post a reel.' });
      if (type === 'text' && !caption) return res.status(400).json({ error: 'Write something to share.' });
      let recipeRef = null;
      if (type === 'recipe') {
        const recipe = readJSON(RECIPES_FILE).find(r => r.id === b.recipeId);
        if (!recipe) return res.status(400).json({ error: 'Recipe not found.' });
        if (recipe.userId !== req.userId) return res.status(403).json({ error: 'You can only share your own recipes.' });
        recipeRef = { id: recipe.id, name: recipe.name, cover: (recipe.photos || [])[0] || null,
          calories: recipe.nutrition ? recipe.nutrition.perServing.calories : null, category: recipe.category };
      }
      const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
      let foodTags = [];
      try { foodTags = Array.isArray(JSON.parse(b.foodTags || '[]')) ? JSON.parse(b.foodTags).slice(0, 10) : []; } catch { foodTags = []; }
      const post = {
        id: uuidv4(), userId: req.userId,
        authorName: (user && user.name) || 'NutriFell User',
        authorUsername: userHandle(user),
        authorAvatar: (user && user.avatar) || null,
        type, caption, photos, video, recipe: recipeRef,
        hashtags: extractHashtags(`${caption} ${b.hashtags || ''}`),
        foodTags, location: b.location ? String(b.location).trim().slice(0, 80) : '',
        views: 0, createdAt: new Date().toISOString(),
      };
      const all = readJSON(POSTS_FILE);
      all.unshift(post);
      writeJSON(POSTS_FILE, all);
      notifyMentions(caption, req.userId, post.id, 'mentioned you in a post');
      res.status(201).json(post);
    } catch (err) {
      console.error('Post create error:', err.message);
      res.status(500).json({ error: 'Could not publish your post. Please try again.' });
    }
  });
});

// ── Single post ──
app.get('/api/posts/:id', (req, res) => {
  const viewerId = optionalAuth(req);
  const p = readJSON(POSTS_FILE).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const d = decoratePost(p, readJSON(POST_REACTIONS_FILE), readJSON(POST_COMMENTS_FILE), readJSON(POST_SAVES_FILE), viewerId);
  d.isOwn = p.userId === viewerId;
  res.json(d);
});

// ── Delete own post (+ its reactions/comments/saves + media files) ──
app.delete('/api/posts/:id', auth, (req, res) => {
  const all = readJSON(POSTS_FILE);
  const p = all.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  if (p.userId !== req.userId) return res.status(403).json({ error: 'Not your post' });
  writeJSON(POSTS_FILE, all.filter(x => x.id !== req.params.id));
  writeJSON(POST_REACTIONS_FILE, readJSON(POST_REACTIONS_FILE).filter(x => x.postId !== p.id));
  writeJSON(POST_COMMENTS_FILE, readJSON(POST_COMMENTS_FILE).filter(c => c.postId !== p.id));
  writeJSON(POST_SAVES_FILE, readJSON(POST_SAVES_FILE).filter(s => s.postId !== p.id));
  [...(p.photos || []), p.video].filter(Boolean).forEach(u => {
    try { fs.unlinkSync(path.join(__dirname, 'public', u)); } catch {}
  });
  res.json({ success: true });
});

// ── React (toggle one emoji per user per post) ──
function applyReaction(postId, userId, emoji) {
  const all = readJSON(POST_REACTIONS_FILE);
  const mine = all.find(x => x.postId === postId && x.userId === userId);
  let next = all;
  if (mine && mine.emoji === emoji) next = all.filter(x => x !== mine);
  else if (mine) { mine.emoji = emoji; mine.at = new Date().toISOString(); }
  else next.push({ id: uuidv4(), postId, userId, emoji, at: new Date().toISOString() });
  writeJSON(POST_REACTIONS_FILE, next);
  const counts = {}; POST_REACTIONS.forEach(e => counts[e] = 0);
  next.filter(x => x.postId === postId).forEach(x => { if (counts[x.emoji] != null) counts[x.emoji]++; });
  const myReaction = next.find(x => x.postId === postId && x.userId === userId);
  return { counts, total: Object.values(counts).reduce((a, c) => a + c, 0), mine: myReaction ? myReaction.emoji : null };
}

app.post('/api/posts/:id/react', auth, (req, res) => {
  const emoji = (req.body && req.body.emoji) || '';
  if (!POST_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction' });
  const post = readJSON(POSTS_FILE).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const out = applyReaction(req.params.id, req.userId, emoji);
  if (out.mine) pushNotification('reaction', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: `reacted ${emoji} to your post` });
  res.json(out);
});

// Convenience: double-tap "like" toggles the ❤️ reaction.
app.post('/api/posts/:id/like', auth, (req, res) => {
  const post = readJSON(POSTS_FILE).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const out = applyReaction(req.params.id, req.userId, '❤️');
  if (out.mine) pushNotification('like', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: 'liked your post' });
  res.json({ ...out, liked: out.mine === '❤️' });
});

// ── Save / unsave ──
app.post('/api/posts/:id/save', auth, (req, res) => {
  const all = readJSON(POST_SAVES_FILE);
  const mine = all.find(x => x.postId === req.params.id && x.userId === req.userId);
  let next = all, saved;
  if (mine) { next = all.filter(x => x !== mine); saved = false; }
  else { next.push({ userId: req.userId, postId: req.params.id, at: new Date().toISOString() }); saved = true; }
  writeJSON(POST_SAVES_FILE, next);
  if (saved) {
    const post = readJSON(POSTS_FILE).find(p => p.id === req.params.id);
    if (post) pushNotification('save', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: 'saved your post' });
  }
  res.json({ saved });
});

// ── Report ──
app.post('/api/posts/:id/report', auth, (req, res) => {
  const all = readJSON(POST_REPORTS_FILE);
  all.push({ id: uuidv4(), postId: req.params.id, userId: req.userId,
    reason: (req.body && String(req.body.reason || '').slice(0, 500)) || 'Unspecified', at: new Date().toISOString() });
  writeJSON(POST_REPORTS_FILE, all);
  res.json({ success: true, message: 'Thanks — our team will review this post.' });
});

// ── Views (client calls once when a post enters the viewport) ──
app.post('/api/posts/:id/view', (req, res) => {
  const all = readJSON(POSTS_FILE);
  const p = all.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  p.views = (p.views || 0) + 1;
  writeJSON(POSTS_FILE, all);
  res.json({ views: p.views });
});

// ── Comments (threaded one level) ──
function shapePostComments(postId) {
  const all = readJSON(POST_COMMENTS_FILE).filter(c => c.postId === postId);
  const roots = all.filter(c => !c.parentId).sort((a, b) => b.at.localeCompare(a.at));
  return roots.map(c => ({
    ...c, likeCount: (c.likes || []).length,
    replies: all.filter(r => r.parentId === c.id).sort((a, b) => a.at.localeCompare(b.at))
      .map(r => ({ ...r, likeCount: (r.likes || []).length })),
  }));
}

app.get('/api/posts/:id/comments', (req, res) => res.json(shapePostComments(req.params.id)));

app.post('/api/posts/:id/comments', auth, (req, res) => {
  const text = req.body && String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  const post = readJSON(POSTS_FILE).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const all = readJSON(POST_COMMENTS_FILE);
  const comment = { id: uuidv4(), postId: req.params.id, userId: req.userId,
    authorName: (user && user.name) || 'NutriFell User', authorAvatar: (user && user.avatar) || null,
    text: text.slice(0, 2000), parentId: null, likes: [], at: new Date().toISOString() };
  all.push(comment);
  writeJSON(POST_COMMENTS_FILE, all);
  pushNotification('comment', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: 'commented on your post' });
  notifyMentions(text, req.userId, post.id, 'mentioned you in a comment');
  res.status(201).json(comment);
});

app.post('/api/posts/:id/comments/:cid/reply', auth, (req, res) => {
  const text = req.body && String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Reply cannot be empty' });
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const all = readJSON(POST_COMMENTS_FILE);
  const parent = all.find(c => c.id === req.params.cid);
  if (!parent) return res.status(404).json({ error: 'Comment not found' });
  const reply = { id: uuidv4(), postId: req.params.id, userId: req.userId,
    authorName: (user && user.name) || 'NutriFell User', authorAvatar: (user && user.avatar) || null,
    text: text.slice(0, 2000), parentId: parent.parentId || parent.id, likes: [], at: new Date().toISOString() };
  all.push(reply);
  writeJSON(POST_COMMENTS_FILE, all);
  pushNotification('reply', { toUserId: parent.userId, fromUserId: req.userId, postId: req.params.id, text: 'replied to your comment' });
  notifyMentions(text, req.userId, req.params.id, 'mentioned you in a comment');
  res.status(201).json(reply);
});

app.post('/api/posts/:id/comments/:cid/like', auth, (req, res) => {
  const all = readJSON(POST_COMMENTS_FILE);
  const c = all.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  c.likes = c.likes || [];
  const i = c.likes.indexOf(req.userId);
  if (i === -1) c.likes.push(req.userId); else c.likes.splice(i, 1);
  writeJSON(POST_COMMENTS_FILE, all);
  res.json({ likeCount: c.likes.length, liked: i === -1 });
});

// ── Follow system ──
app.get('/api/users/suggested', (req, res) => {
  const viewerId = optionalAuth(req);
  const follows = readJSON(FOLLOWS_FILE);
  const followingIds = new Set(follows.filter(f => f.followerId === viewerId).map(f => f.followingId));
  const followerCount = {};
  follows.forEach(f => { followerCount[f.followingId] = (followerCount[f.followingId] || 0) + 1; });
  const users = readJSON(USERS_FILE)
    .filter(u => u.id !== viewerId && !followingIds.has(u.id))
    .map(u => ({ id: u.id, name: u.name, username: userHandle(u), avatar: u.avatar || null,
      bio: (u.bio || '').slice(0, 80), followers: followerCount[u.id] || 0 }))
    .sort((a, b) => b.followers - a.followers)
    .slice(0, 5);
  res.json(users);
});

function profileSummary(u, viewerId) {
  const follows = readJSON(FOLLOWS_FILE);
  const posts = readJSON(POSTS_FILE).filter(p => p.userId === u.id).length;
  const followers = follows.filter(f => f.followingId === u.id).length;
  const following = follows.filter(f => f.followerId === u.id).length;
  return {
    id: u.id, name: u.name, username: userHandle(u), avatar: u.avatar || null,
    cover: u.cover || null, bio: u.bio || '', location: u.location || '', website: u.website || '',
    stats: { posts, followers, following },
    isFollowing: viewerId ? follows.some(f => f.followerId === viewerId && f.followingId === u.id) : false,
    isOwn: viewerId === u.id,
  };
}

app.get('/api/users/:id', (req, res) => {
  const viewerId = optionalAuth(req);
  const u = readJSON(USERS_FILE).find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(profileSummary(u, viewerId));
});

app.get('/api/users/:id/posts', (req, res) => {
  const viewerId = optionalAuth(req);
  const reactions = readJSON(POST_REACTIONS_FILE);
  const comments = readJSON(POST_COMMENTS_FILE);
  const saves = readJSON(POST_SAVES_FILE);
  const list = readJSON(POSTS_FILE).filter(p => p.userId === req.params.id)
    .map(p => decoratePost(p, reactions, comments, saves, viewerId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

app.post('/api/users/:id/follow', auth, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.userId) return res.status(400).json({ error: "You can't follow yourself" });
  const target = readJSON(USERS_FILE).find(u => u.id === targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const all = readJSON(FOLLOWS_FILE);
  const mine = all.find(f => f.followerId === req.userId && f.followingId === targetId);
  let next = all, following;
  if (mine) { next = all.filter(f => f !== mine); following = false; }
  else {
    next.push({ followerId: req.userId, followingId: targetId, at: new Date().toISOString() });
    following = true;
    pushNotification('follow', { toUserId: targetId, fromUserId: req.userId, text: 'started following you' });
  }
  writeJSON(FOLLOWS_FILE, next);
  res.json({ following, followers: next.filter(f => f.followingId === targetId).length });
});

// ── Phase 2: full profiles (edit, image upload, followers/following, liked) ──

// Compact user card for follower/following/search lists.
function userMini(u, viewerId, viewerFollowing) {
  return {
    id: u.id, name: u.name, username: userHandle(u), avatar: u.avatar || null,
    bio: (u.bio || '').slice(0, 80),
    isFollowing: viewerFollowing ? viewerFollowing.has(u.id) : false,
    isOwn: viewerId === u.id,
  };
}

// Edit the social side of a profile (name/username/bio/location/website).
// Nutrition fields stay on PUT /api/profile. Username is unique + format-checked.
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
app.put('/api/users/profile', auth, (req, res) => {
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const u = users[idx];
  const b = req.body || {};
  if (b.name != null) {
    const name = String(b.name).trim().slice(0, 50);
    if (!name) return res.status(400).json({ error: 'Display name cannot be empty.' });
    u.name = name;
  }
  if (b.username != null) {
    const uname = String(b.username).trim().toLowerCase().replace(/^@/, '');
    if (!uname) {
      delete u.username; // revert to the derived @handle
    } else {
      if (!USERNAME_RE.test(uname)) return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers or underscore.' });
      if (users.some(x => x.id !== u.id && (x.username || '').toLowerCase() === uname)) return res.status(409).json({ error: 'That username is already taken.' });
      u.username = uname;
    }
  }
  if (b.bio != null) u.bio = String(b.bio).trim().slice(0, 150);
  if (b.location != null) u.location = String(b.location).trim().slice(0, 80);
  if (b.website != null) {
    let w = String(b.website).trim().slice(0, 120);
    if (w && !/^https?:\/\//i.test(w)) w = 'https://' + w;
    u.website = w;
  }
  users[idx] = u;
  writeJSON(USERS_FILE, users);
  res.json(profileSummary(u, req.userId));
});

// Single-image upload (avatar/cover). Reuses sharp when present.
const imageUpload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024, files: 1 },
      fileFilter: (req, file, cb) => {
        const ok = /^image\/(jpe?g|png|webp)$/.test(file.mimetype);
        cb(ok ? null : new Error('Only JPG/PNG/WebP images allowed'), ok);
      },
    })
  : { single: () => (req, res, next) => next() };

async function saveProfileImage(file, dir, urlBase, opts) {
  const base = `${Date.now()}-${uuidv4().slice(0, 8)}`;
  if (sharp) {
    const name = `${base}.webp`;
    let img = sharp(file.buffer).rotate();
    img = opts.square
      ? img.resize(opts.size, opts.size, { fit: 'cover' })
      : img.resize({ width: opts.width, withoutEnlargement: true });
    await img.webp({ quality: 82 }).toFile(path.join(dir, name));
    return `${urlBase}/${name}`;
  }
  const ext = (file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const name = `${base}.${ext}`;
  fs.writeFileSync(path.join(dir, name), file.buffer);
  return `${urlBase}/${name}`;
}

function profileImageHandler(field, dir, urlBase, opts) {
  return (req, res) => {
    imageUpload.single('image')(req, res, async (uErr) => {
      if (uErr) return res.status(400).json({ error: uErr.message });
      if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
      try {
        const url = await saveProfileImage(req.file, dir, urlBase, opts);
        const users = readJSON(USERS_FILE);
        const idx = users.findIndex(u => u.id === req.userId);
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        users[idx][field] = url;
        writeJSON(USERS_FILE, users);
        res.json({ [field]: url });
      } catch (e) {
        console.error('Profile image upload failed:', e);
        res.status(500).json({ error: 'Could not process that image.' });
      }
    });
  };
}
app.post('/api/upload/avatar', auth, profileImageHandler('avatar', AVATARS_UPLOAD_DIR, '/uploads/avatars', { square: true, size: 400 }));
app.post('/api/upload/cover', auth, profileImageHandler('cover', COVERS_UPLOAD_DIR, '/uploads/covers', { width: 1600 }));

// Followers / following lists (newest first; each row carries viewer follow-state).
function followList(targetField, idField) {
  return (req, res) => {
    const viewerId = optionalAuth(req);
    const follows = readJSON(FOLLOWS_FILE);
    const byId = new Map(readJSON(USERS_FILE).map(u => [u.id, u]));
    const viewerFollowing = new Set(follows.filter(f => f.followerId === viewerId).map(f => f.followingId));
    const list = follows.filter(f => f[targetField] === req.params.id)
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .map(f => byId.get(f[idField])).filter(Boolean)
      .map(u => userMini(u, viewerId, viewerFollowing));
    res.json(list);
  };
}
app.get('/api/users/:id/followers', followList('followingId', 'followerId'));
app.get('/api/users/:id/following', followList('followerId', 'followingId'));

// Posts a user has reacted to (their "Liked" tab).
app.get('/api/users/:id/liked', (req, res) => {
  const viewerId = optionalAuth(req);
  const reactions = readJSON(POST_REACTIONS_FILE);
  const likedIds = new Set(reactions.filter(r => r.userId === req.params.id).map(r => r.postId));
  const comments = readJSON(POST_COMMENTS_FILE);
  const saves = readJSON(POST_SAVES_FILE);
  const list = readJSON(POSTS_FILE).filter(p => likedIds.has(p.id))
    .map(p => decoratePost(p, reactions, comments, saves, viewerId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

// ── Notifications (Phase 3 bell UI + full page) ──
// Filter groups map UI tabs → stored notification types.
const NOTIF_GROUPS = { likes: ['like', 'reaction', 'save'], comments: ['comment', 'reply', 'mention'], follows: ['follow'] };
function notifThumb(post) {
  if (!post) return null;
  if ((post.photos || []).length) return post.photos[0];
  if (post.recipe && post.recipe.cover) return post.recipe.cover;
  return null;
}
// Join fresh author + post data so avatars/thumbnails stay current and the
// client gets a ready-made link target.
function decorateNotification(n, posts, users) {
  const post = n.postId ? posts.find(p => p.id === n.postId) : null;
  const from = users.find(u => u.id === n.fromUserId);
  return {
    ...n,
    fromName: (from && from.name) || n.fromName || 'Someone',
    fromAvatar: (from && from.avatar) || n.fromAvatar || null,
    fromUsername: from ? userHandle(from) : null,
    postThumb: notifThumb(post),
    postType: post ? post.type : null,
    link: n.type === 'follow'
      ? `/profile-social.html?id=${n.fromUserId}`
      : (n.postId ? `/feed.html?post=${n.postId}` : '#'),
  };
}

app.get('/api/notifications', auth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 20;
  let list = readJSON(NOTIFICATIONS_FILE).filter(n => n.toUserId === req.userId);
  const filter = req.query.type;
  if (filter && NOTIF_GROUPS[filter]) list = list.filter(n => NOTIF_GROUPS[filter].includes(n.type));
  const total = list.length;
  const unread = readJSON(NOTIFICATIONS_FILE).filter(n => n.toUserId === req.userId && !n.read).length;
  const start = (page - 1) * perPage;
  const posts = readJSON(POSTS_FILE);
  const users = readJSON(USERS_FILE);
  const items = list.slice(start, start + perPage).map(n => decorateNotification(n, posts, users));
  res.json({ notifications: items, page, perPage, total, unread, hasMore: start + perPage < total });
});
app.get('/api/notifications/count', auth, (req, res) => {
  const n = readJSON(NOTIFICATIONS_FILE).filter(x => x.toUserId === req.userId && !x.read).length;
  res.json({ count: n });
});
app.put('/api/notifications/read', auth, (req, res) => {
  const all = readJSON(NOTIFICATIONS_FILE);
  all.forEach(n => { if (n.toUserId === req.userId) n.read = true; });
  writeJSON(NOTIFICATIONS_FILE, all);
  res.json({ success: true });
});
app.put('/api/notifications/:id/read', auth, (req, res) => {
  const all = readJSON(NOTIFICATIONS_FILE);
  const n = all.find(x => x.id === req.params.id && x.toUserId === req.userId);
  if (!n) return res.status(404).json({ error: 'Notification not found' });
  n.read = true;
  writeJSON(NOTIFICATIONS_FILE, all);
  res.json({ success: true });
});

// ── Hashtags ──
// Shared: decorate posts matching a predicate, sorted top (by reactions) or recent.
function decoratePostsWhere(filterFn, viewerId, sort) {
  const reactions = readJSON(POST_REACTIONS_FILE);
  const comments = readJSON(POST_COMMENTS_FILE);
  const saves = readJSON(POST_SAVES_FILE);
  const list = readJSON(POSTS_FILE).filter(filterFn).map(p => decoratePost(p, reactions, comments, saves, viewerId));
  if (sort === 'top') list.sort((a, b) => b.totalReactions - a.totalReactions || b.createdAt.localeCompare(a.createdAt));
  else list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list;
}

app.get('/api/hashtags/trending', (req, res) => {
  const since = Date.now() - 7 * 864e5;
  const counts = {};
  readJSON(POSTS_FILE).forEach(p => {
    const recent = new Date(p.createdAt).getTime() >= since;
    (p.hashtags || []).forEach(t => {
      counts[t] = counts[t] || { tag: t, count: 0, recent: 0 };
      counts[t].count++; if (recent) counts[t].recent++;
    });
  });
  res.json(Object.values(counts).sort((a, b) => b.recent - a.recent || b.count - a.count).slice(0, 10));
});

app.get('/api/hashtags/:tag', (req, res) => {
  const viewerId = optionalAuth(req);
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '');
  const posts = readJSON(POSTS_FILE).filter(p => (p.hashtags || []).includes(tag));
  const since = Date.now() - 7 * 864e5;
  const recentCount = posts.filter(p => new Date(p.createdAt).getTime() >= since).length;
  const rel = {};
  posts.forEach(p => (p.hashtags || []).forEach(t => { if (t !== tag) rel[t] = (rel[t] || 0) + 1; }));
  const related = Object.entries(rel).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, c]) => ({ tag: t, count: c }));
  const isFollowing = viewerId ? readJSON(HASHTAG_FOLLOWS_FILE).some(f => f.userId === viewerId && f.tag === tag) : false;
  res.json({ tag, postCount: posts.length, recentCount, related, isFollowing });
});

app.get('/api/hashtags/:tag/posts', (req, res) => {
  const viewerId = optionalAuth(req);
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '');
  const sort = req.query.sort === 'top' ? 'top' : 'recent';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 18;
  const list = decoratePostsWhere(p => (p.hashtags || []).includes(tag), viewerId, sort);
  const start = (page - 1) * perPage;
  res.json({ posts: list.slice(start, start + perPage), total: list.length, page, perPage, hasMore: start + perPage < list.length });
});

app.post('/api/hashtags/:tag/follow', auth, (req, res) => {
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '');
  const all = readJSON(HASHTAG_FOLLOWS_FILE);
  const mine = all.find(f => f.userId === req.userId && f.tag === tag);
  let next = all, following;
  if (mine) { next = all.filter(f => f !== mine); following = false; }
  else { next.push({ userId: req.userId, tag, at: new Date().toISOString() }); following = true; }
  writeJSON(HASHTAG_FOLLOWS_FILE, next);
  res.json({ following });
});

// ── Unified search (people / posts / hashtags / foods) ──
function searchUsers(q, viewerId, limit) {
  const ql = q.toLowerCase();
  const follows = readJSON(FOLLOWS_FILE);
  const followerCount = {};
  follows.forEach(f => { followerCount[f.followingId] = (followerCount[f.followingId] || 0) + 1; });
  const viewerFollowing = new Set(follows.filter(f => f.followerId === viewerId).map(f => f.followingId));
  return readJSON(USERS_FILE)
    .filter(u => (u.name || '').toLowerCase().includes(ql) || userHandle(u).toLowerCase().includes(ql) || (u.bio || '').toLowerCase().includes(ql))
    .map(u => ({
      id: u.id, name: u.name, username: userHandle(u), avatar: u.avatar || null,
      bio: (u.bio || '').slice(0, 80), followers: followerCount[u.id] || 0,
      isFollowing: viewerFollowing.has(u.id), isOwn: u.id === viewerId,
    }))
    .sort((a, b) => b.followers - a.followers).slice(0, limit);
}
function searchPosts(q, viewerId, limit) {
  const ql = q.toLowerCase().replace(/^#/, '');
  return decoratePostsWhere(p => (p.caption || '').toLowerCase().includes(ql) || (p.hashtags || []).some(t => t.includes(ql)), viewerId, 'top').slice(0, limit);
}
function searchHashtags(q, limit) {
  const ql = q.toLowerCase().replace(/^#/, '');
  const counts = {};
  readJSON(POSTS_FILE).forEach(p => (p.hashtags || []).forEach(t => { if (!ql || t.includes(ql)) counts[t] = (counts[t] || 0) + 1; }));
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag, count]) => ({ tag, count }));
}
function searchFoods(q, limit) {
  const ql = q.toLowerCase();
  return foods
    .filter(f => f.name.toLowerCase().includes(ql) || (f.category || '').toLowerCase().includes(ql))
    .map(f => ({ id: f.id, name: f.name, emoji: f.emoji || '🍽️', calories: f.calories, category: f.category || null }))
    .slice(0, limit);
}

app.get('/api/search', (req, res) => {
  const viewerId = optionalAuth(req);
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], posts: [], hashtags: [], foods: [] });
  res.json({
    users: searchUsers(q, viewerId, 6),
    posts: searchPosts(q, viewerId, 9),
    hashtags: searchHashtags(q, 6),
    foods: searchFoods(q, 6),
  });
});
app.get('/api/search/users', (req, res) => { const q = String(req.query.q || '').trim(); res.json(q ? searchUsers(q, optionalAuth(req), 30) : []); });
app.get('/api/search/posts', (req, res) => { const q = String(req.query.q || '').trim(); res.json(q ? searchPosts(q, optionalAuth(req), 30) : []); });
app.get('/api/search/hashtags', (req, res) => { const q = String(req.query.q || '').trim(); res.json(q ? searchHashtags(q, 30) : []); });
app.get('/api/search/foods', (req, res) => { const q = String(req.query.q || '').trim(); res.json(q ? searchFoods(q, 40) : []); });

// ─── Styled error pages (404 / 500) ──────────────────────────────────────
function errorPage({ code, title, message }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${code} · NutriFell</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; text-align:center;
    background:#080c14; color:#f8fafc; font-family:'Space Grotesk','Segoe UI',Helvetica,Arial,sans-serif;
    background-image:radial-gradient(60% 50% at 50% 0%, rgba(34,197,94,0.10), transparent 70%); padding:24px; }
  .err { max-width:480px; }
  .err-logo { font-size:22px; font-weight:700; letter-spacing:-0.02em; margin-bottom:36px; }
  .err-logo span { color:#22c55e; }
  .err-code { font-size:clamp(72px,18vw,140px); line-height:1; font-weight:800;
    background:linear-gradient(180deg,#22c55e,#0f766e); -webkit-background-clip:text;
    background-clip:text; color:transparent; margin:0; }
  .err-title { font-size:22px; margin:10px 0 8px; }
  .err-msg { color:#94a3b8; font-size:15px; line-height:1.6; margin:0 0 30px; }
  .err-actions { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
  .err-btn { display:inline-flex; align-items:center; gap:8px; padding:12px 22px; border-radius:12px;
    font-weight:600; font-size:14px; text-decoration:none; transition:transform .15s ease, background .15s ease; }
  .err-btn:hover { transform:translateY(-2px); }
  .err-btn.primary { background:#22c55e; color:#04130a; }
  .err-btn.ghost { background:rgba(255,255,255,0.06); color:#f8fafc; border:1px solid rgba(255,255,255,0.12); }
</style></head>
<body><div class="err">
  <div class="err-logo">Nutri<span>Fell</span></div>
  <p class="err-code">${code}</p>
  <h1 class="err-title">${title}</h1>
  <p class="err-msg">${message}</p>
  <div class="err-actions">
    <a class="err-btn primary" href="/">← Back to home</a>
    <a class="err-btn ghost" href="/fridge.html">Open dashboard</a>
  </div>
</div></body></html>`;
}

// Unknown API route → JSON 404; unknown page → SPA shell (client routes) ...
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ... but a request that explicitly wants HTML for a missing .html file → styled 404
app.get('*', (req, res) => {
  if (/\.html$/.test(req.path) && req.path !== '/index.html') {
    return res.status(404).send(errorPage({
      code: 404, title: 'Page not found',
      message: "That page doesn't exist or has moved. Let's get you back on track.",
    }));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler — last line of defence for uncaught route errors.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const wantsJSON = req.path.startsWith('/api') || (req.headers.accept || '').includes('application/json');
  if (wantsJSON) {
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
  }
  res.status(500).send(errorPage({
    code: 500, title: 'Something went wrong',
    message: 'An unexpected error occurred on our end. Please try again in a moment.',
  }));
});

// Crash guards — log instead of letting the process die silently.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

app.listen(PORT, () => console.log(`NutriFell running at http://localhost:${PORT}`));
