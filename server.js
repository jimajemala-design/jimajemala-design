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

// ─── Phase 5: ffmpeg (video transcoding) + socket.io (real-time) ─────────
// Both loaded defensively: if a dep is missing the server still boots, just
// without transcoding / live features.
let ffmpeg = null, ffmpegInstaller = null, SocketServer = null;
try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  // ffprobe ships in the same installer package directory on most platforms.
  try { const ffprobe = require('@ffprobe-installer/ffprobe'); ffmpeg.setFfprobePath(ffprobe.path); } catch (e) { /* ffprobe alongside ffmpeg */ }
} catch (e) { ffmpeg = null; console.warn('ffmpeg unavailable — video transcoding disabled:', e.message); }
try { SocketServer = require('socket.io').Server; } catch (e) { console.warn('socket.io unavailable — real-time disabled:', e.message); }

// Realtime hub. `io` is assigned once the HTTP server is created at the bottom;
// route handlers emit through RT, which no-ops until then / if socket.io is
// missing. onlineUsers maps userId → { socketId, lastSeen }.
let io = null;
const onlineUsers = new Map();
const RT = {
  toUser(userId, event, payload) { if (io && userId) io.to(`user:${userId}`).emit(event, payload); },
  toPost(postId, event, payload) { if (io && postId) io.to(`post:${postId}`).emit(event, payload); },
  broadcast(event, payload) { if (io) io.emit(event, payload); },
  isOnline(userId) { return onlineUsers.has(userId); },
  lastSeen(userId) { const e = onlineUsers.get(userId); return e ? e.lastSeen : null; },
};

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
// ── Social feed stores (Phase 4) ──
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const STORIES_FILE = path.join(DATA_DIR, 'stories.json');
const STORY_VIEWS_FILE = path.join(DATA_DIR, 'story_views.json');
const POSTS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'posts');
const REELS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'reels');
const STORIES_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'stories');
const AVATARS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
const COVERS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'covers');
// Phase 5: transcoded videos + thumbnails, and a scratch dir for raw uploads.
const VIDEOS_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'videos');
const VIDEO_THUMBS_DIR = path.join(__dirname, 'public', 'uploads', 'videos', 'thumbs');
const VIDEO_TMP_DIR = path.join(__dirname, 'public', 'uploads', 'tmp');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const d of [UPLOADS_DIR, POSTS_UPLOAD_DIR, REELS_UPLOAD_DIR, STORIES_UPLOAD_DIR, AVATARS_UPLOAD_DIR, COVERS_UPLOAD_DIR,
  VIDEOS_UPLOAD_DIR, VIDEO_THUMBS_DIR, VIDEO_TMP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
for (const f of [USERS_FILE, FRIDGES_FILE, MEALPLANS_FILE, LOGS_FILE, WATER_FILE,
  SMOKING_FILE, RECIPES_FILE, COMMENTS_FILE, REACTIONS_FILE, BOOKMARKS_FILE, REPORTS_FILE,
  WAITLIST_FILE, POSTS_FILE, FOLLOWS_FILE, POST_REACTIONS_FILE, POST_COMMENTS_FILE,
  POST_SAVES_FILE, POST_REPORTS_FILE, NOTIFICATIONS_FILE, HASHTAG_FOLLOWS_FILE,
  CONVERSATIONS_FILE, MESSAGES_FILE, STORIES_FILE, STORY_VIEWS_FILE]) {
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

// ─── Phase 1: MySQL / Hostinger (Auth + Users) ───────────────────────────
// db is null until the pool is verified; all code falls back to JSON while
// null. Dual-write keeps data/users.json in sync for non-migrated endpoints.
let db = null;

// Columns that exist in the `users` table — used to safely pick fields
// before INSERT/UPDATE so extra properties never reach the SQL layer.
const USER_COLS = ['id', 'email', 'password', 'name', 'username', 'bio',
  'location', 'website', 'avatar', 'cover', 'age', 'weight', 'targetWeight',
  'height', 'gender', 'goal', 'activityLevel', 'timeline', 'emailVerified',
  'language', 'plan', 'planValidUntil', 'cancelAtPeriodEnd', 'stripeCustomerId',
  'stripeSubscriptionId', 'waterGoalMl', 'createdAt'];

function pickUserFields(obj) {
  const out = {};
  for (const k of USER_COLS) if (obj[k] !== undefined) out[k] = obj[k] ?? null;
  return out;
}
function rowToUser(row) {
  if (!row) return null;
  return { ...row, emailVerified: !!row.emailVerified, cancelAtPeriodEnd: !!row.cancelAtPeriodEnd };
}
async function dbFindUserById(id) {
  const [rows] = await db.execute('SELECT * FROM `users` WHERE `id` = ?', [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}
async function dbFindUserByEmail(email) {
  const [rows] = await db.execute('SELECT * FROM `users` WHERE `email` = ?', [email]);
  return rows[0] ? rowToUser(rows[0]) : null;
}
async function dbInsertUser(user) {
  const fields = pickUserFields(user);
  const cols = Object.keys(fields).map(k => `\`${k}\``).join(', ');
  const vals = Object.values(fields);
  await db.execute(
    `INSERT INTO \`users\` (${cols}) VALUES (${vals.map(() => '?').join(', ')})`,
    vals
  );
}
async function dbUpdateUser(id, user) {
  const fields = pickUserFields(user);
  delete fields.id;
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map(k => `\`${k}\` = ?`).join(', ');
  await db.execute(`UPDATE \`users\` SET ${set} WHERE \`id\` = ?`, [...Object.values(fields), id]);
}

(async () => {
  if (!process.env.DB_HOST || !process.env.DB_USER) {
    return console.warn('DB_HOST/DB_USER not set — MySQL disabled, JSON fallback active');
  }
  try {
    const mysql = require('mysql2/promise');
    db = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT) || 3306,
      waitForConnections: true,
      connectionLimit: 10,
      charset: 'utf8mb4',
      dateStrings: true,
    });
    // Auto-create users table (idempotent)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`users\` (
        \`id\`                   VARCHAR(36)   PRIMARY KEY,
        \`email\`                VARCHAR(255)  UNIQUE NOT NULL,
        \`password\`             VARCHAR(255),
        \`name\`                 VARCHAR(255),
        \`username\`             VARCHAR(100),
        \`bio\`                  TEXT,
        \`location\`             VARCHAR(255),
        \`website\`              VARCHAR(500),
        \`avatar\`               VARCHAR(500),
        \`cover\`                VARCHAR(500),
        \`age\`                  INT,
        \`weight\`               FLOAT,
        \`targetWeight\`         FLOAT,
        \`height\`               FLOAT,
        \`gender\`               VARCHAR(20),
        \`goal\`                 VARCHAR(50)   DEFAULT 'maintain',
        \`activityLevel\`        VARCHAR(50),
        \`timeline\`             INT,
        \`emailVerified\`        TINYINT(1)    DEFAULT 0,
        \`language\`             VARCHAR(10)   DEFAULT 'en',
        \`plan\`                 VARCHAR(20)   DEFAULT 'free',
        \`planValidUntil\`       DATETIME,
        \`cancelAtPeriodEnd\`    TINYINT(1)    DEFAULT 0,
        \`stripeCustomerId\`     VARCHAR(255),
        \`stripeSubscriptionId\` VARCHAR(255),
        \`waterGoalMl\`          INT,
        \`createdAt\`            DATETIME      DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    console.log('MySQL connected (Hostinger)');
    // One-time seed: import JSON users if the table is empty
    const [[{ cnt }]] = await db.execute('SELECT COUNT(*) AS cnt FROM `users`');
    if (cnt === 0) {
      const seed = readJSON(USERS_FILE);
      for (const u of seed) {
        try { await dbInsertUser(u); } catch { /* skip duplicates */ }
      }
      if (seed.length) console.log(`Migrated ${seed.length} users from JSON → MySQL`);
    }

    // ─── Phase 2a: posts table ────────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`posts\` (
        \`id\`            VARCHAR(36)  PRIMARY KEY,
        \`userId\`        VARCHAR(36)  NOT NULL,
        \`type\`          ENUM('photo','video','recipe','text') DEFAULT 'text',
        \`caption\`       TEXT,
        \`mediaUrls\`     JSON,
        \`videoUrl\`      VARCHAR(500),
        \`videoThumb\`    VARCHAR(500),
        \`videoDuration\` INT,
        \`recipe\`        JSON,
        \`hashtags\`      JSON,
        \`taggedFoods\`   JSON,
        \`location\`      VARCHAR(255),
        \`viewCount\`     INT          DEFAULT 0,
        \`score\`         FLOAT        DEFAULT 0,
        \`createdAt\`     DATETIME     DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\`     DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_userId\`    (\`userId\`),
        INDEX \`idx_createdAt\` (\`createdAt\`),
        INDEX \`idx_score\`     (\`score\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ postCnt }]] = await db.execute('SELECT COUNT(*) AS postCnt FROM `posts`');
    if (postCnt === 0) {
      const seedPosts = readJSON(POSTS_FILE);
      for (const p of seedPosts) {
        try {
          await db.execute(
            'INSERT INTO `posts` (`id`,`userId`,`type`,`caption`,`mediaUrls`,`videoUrl`,`videoThumb`,`recipe`,`hashtags`,`taggedFoods`,`location`,`viewCount`,`createdAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [p.id, p.userId, p.type || 'text', p.caption || null,
             JSON.stringify(p.photos || []), p.video || null, p.videoThumb || null,
             p.recipe ? JSON.stringify(p.recipe) : null,
             JSON.stringify(p.hashtags || []), JSON.stringify(p.foodTags || []),
             p.location || null, p.views || 0,
             p.createdAt || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedPosts.length) console.log(`Migrated ${seedPosts.length} posts from JSON → MySQL`);
    }

    // ─── Phase 2b: post_reactions table ──────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`post_reactions\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`postId\`    VARCHAR(36)  NOT NULL,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`emoji\`     VARCHAR(10)  NOT NULL,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`unique_reaction\` (\`postId\`, \`userId\`),
        INDEX \`idx_postId\` (\`postId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ rxnCnt }]] = await db.execute('SELECT COUNT(*) AS rxnCnt FROM `post_reactions`');
    if (rxnCnt === 0) {
      const seedRxns = readJSON(POST_REACTIONS_FILE);
      for (const r of seedRxns) {
        try {
          await db.execute(
            'INSERT INTO `post_reactions` (`id`,`postId`,`userId`,`emoji`,`createdAt`) VALUES (?,?,?,?,?)',
            [r.id, r.postId, r.userId, r.emoji, r.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedRxns.length) console.log(`Migrated ${seedRxns.length} post_reactions from JSON → MySQL`);
    }

    // ─── Phase 2b: post_comments table ───────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`post_comments\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`postId\`    VARCHAR(36)  NOT NULL,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`parentId\`  VARCHAR(36)  DEFAULT NULL,
        \`text\`      TEXT         NOT NULL,
        \`likes\`     JSON,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_postId\`   (\`postId\`),
        INDEX \`idx_parentId\` (\`parentId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ cmtCnt }]] = await db.execute('SELECT COUNT(*) AS cmtCnt FROM `post_comments`');
    if (cmtCnt === 0) {
      const seedCmts = readJSON(POST_COMMENTS_FILE);
      for (const c of seedCmts) {
        try {
          await db.execute(
            'INSERT INTO `post_comments` (`id`,`postId`,`userId`,`parentId`,`text`,`likes`,`createdAt`) VALUES (?,?,?,?,?,?,?)',
            [c.id, c.postId, c.userId, c.parentId || null, c.text || '',
             JSON.stringify(c.likes || []), c.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedCmts.length) console.log(`Migrated ${seedCmts.length} post_comments from JSON → MySQL`);
    }

    // ─── Phase 2c: follows table ──────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`follows\` (
        \`id\`          VARCHAR(36)  PRIMARY KEY,
        \`followerId\`  VARCHAR(36)  NOT NULL,
        \`followingId\` VARCHAR(36)  NOT NULL,
        \`createdAt\`   DATETIME     DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`unique_follow\` (\`followerId\`, \`followingId\`),
        INDEX \`idx_followerId\`  (\`followerId\`),
        INDEX \`idx_followingId\` (\`followingId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ flwCnt }]] = await db.execute('SELECT COUNT(*) AS flwCnt FROM `follows`');
    if (flwCnt === 0) {
      const seedFollows = readJSON(FOLLOWS_FILE);
      for (const f of seedFollows) {
        try {
          await db.execute(
            'INSERT INTO `follows` (`id`,`followerId`,`followingId`,`createdAt`) VALUES (?,?,?,?)',
            [f.id || uuidv4(), f.followerId, f.followingId, f.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedFollows.length) console.log(`Migrated ${seedFollows.length} follows from JSON → MySQL`);
    }

    // ─── Phase 2c: notifications table ───────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`notifications\` (
        \`id\`        VARCHAR(36)   PRIMARY KEY,
        \`userId\`    VARCHAR(36)   NOT NULL,
        \`type\`      VARCHAR(50)   NOT NULL,
        \`actorId\`   VARCHAR(36)   DEFAULT NULL,
        \`postId\`    VARCHAR(36)   DEFAULT NULL,
        \`commentId\` VARCHAR(36)   DEFAULT NULL,
        \`text\`      TEXT,
        \`read\`      TINYINT(1)    DEFAULT 0,
        \`createdAt\` DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_userId\`    (\`userId\`),
        INDEX \`idx_read\`      (\`read\`),
        INDEX \`idx_createdAt\` (\`createdAt\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ notifCnt }]] = await db.execute('SELECT COUNT(*) AS notifCnt FROM `notifications`');
    if (notifCnt === 0) {
      const seedNotifs = readJSON(NOTIFICATIONS_FILE);
      for (const n of seedNotifs) {
        try {
          await db.execute(
            'INSERT INTO `notifications` (`id`,`userId`,`type`,`actorId`,`postId`,`text`,`read`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)',
            [n.id, n.toUserId, n.type, n.fromUserId || null, n.postId || null, n.text || '', n.read ? 1 : 0, n.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedNotifs.length) console.log(`Migrated ${seedNotifs.length} notifications from JSON → MySQL`);
    }

    // ─── Phase 2d: conversations table ───────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`conversations\` (
        \`id\`            VARCHAR(36)   PRIMARY KEY,
        \`participant1\`  VARCHAR(36)   NOT NULL,
        \`participant2\`  VARCHAR(36)   NOT NULL,
        \`lastMessage\`   TEXT,
        \`lastMessageAt\` DATETIME,
        \`createdAt\`     DATETIME      DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`unique_conversation\` (\`participant1\`, \`participant2\`),
        INDEX \`idx_participant1\` (\`participant1\`),
        INDEX \`idx_participant2\` (\`participant2\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ convoCnt }]] = await db.execute('SELECT COUNT(*) AS convoCnt FROM `conversations`');
    if (convoCnt === 0) {
      const seedConvos = readJSON(CONVERSATIONS_FILE);
      for (const c of seedConvos) {
        const [p1, p2] = [...c.participants].sort();
        try {
          await db.execute(
            'INSERT INTO `conversations` (`id`,`participant1`,`participant2`,`lastMessage`,`lastMessageAt`,`createdAt`) VALUES (?,?,?,?,?,?)',
            [c.id, p1, p2, c.lastMessage ? JSON.stringify(c.lastMessage) : null,
             c.lastMessageAt || c.createdAt, c.createdAt]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedConvos.length) console.log(`Migrated ${seedConvos.length} conversations from JSON → MySQL`);
    }

    // ─── Phase 2d: messages table ─────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`messages\` (
        \`id\`             VARCHAR(36)   PRIMARY KEY,
        \`conversationId\` VARCHAR(36)   NOT NULL,
        \`senderId\`       VARCHAR(36)   NOT NULL,
        \`receiverId\`     VARCHAR(36)   NOT NULL,
        \`text\`           TEXT,
        \`read\`           TINYINT(1)    DEFAULT 0,
        \`readAt\`         DATETIME,
        \`createdAt\`      DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_conversationId\` (\`conversationId\`),
        INDEX \`idx_senderId\`       (\`senderId\`),
        INDEX \`idx_receiverId\`     (\`receiverId\`),
        INDEX \`idx_createdAt\`      (\`createdAt\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ msgCnt }]] = await db.execute('SELECT COUNT(*) AS msgCnt FROM `messages`');
    if (msgCnt === 0) {
      const seedConvos2 = readJSON(CONVERSATIONS_FILE);
      const convoMap = new Map(seedConvos2.map(c => [c.id, c]));
      const seedMsgs = readJSON(MESSAGES_FILE);
      for (const m of seedMsgs) {
        const convo = convoMap.get(m.conversationId);
        if (!convo) continue;
        const receiverId = convo.participants.find(p => p !== m.fromUserId) || convo.participants[0];
        try {
          await db.execute(
            'INSERT INTO `messages` (`id`,`conversationId`,`senderId`,`receiverId`,`text`,`read`,`createdAt`) VALUES (?,?,?,?,?,?,?)',
            [m.id, m.conversationId, m.fromUserId, receiverId, m.text || '', m.read ? 1 : 0, m.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedMsgs.length) console.log(`Migrated ${seedMsgs.length} messages from JSON → MySQL`);
    }

    // ─── Phase 2d: stories table ──────────────────────────────────────────
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`stories\` (
        \`id\`        VARCHAR(36)              PRIMARY KEY,
        \`userId\`    VARCHAR(36)              NOT NULL,
        \`mediaUrl\`  VARCHAR(500)             NOT NULL,
        \`mediaType\` ENUM('photo','video')    DEFAULT 'photo',
        \`caption\`   TEXT,
        \`viewers\`   JSON,
        \`expiresAt\` DATETIME                 NOT NULL,
        \`createdAt\` DATETIME                 DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_userId\`    (\`userId\`),
        INDEX \`idx_expiresAt\` (\`expiresAt\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ storyCnt }]] = await db.execute('SELECT COUNT(*) AS storyCnt FROM `stories`');
    if (storyCnt === 0) {
      const seedStories = readJSON(STORIES_FILE);
      for (const s of seedStories) {
        const mediaType = s.type === 'video' ? 'video' : 'photo';
        const views = readJSON(STORY_VIEWS_FILE).filter(v => v.storyId === s.id).map(v => v.userId);
        try {
          await db.execute(
            'INSERT INTO `stories` (`id`,`userId`,`mediaUrl`,`mediaType`,`caption`,`viewers`,`expiresAt`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)',
            [s.id, s.userId, s.media, mediaType, s.caption || '', JSON.stringify(views), s.expiresAt, s.createdAt]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedStories.length) console.log(`Migrated ${seedStories.length} stories from JSON → MySQL`);
    }

    // ─── Phase 2e: recipes + recipe comments/reactions/reports, bookmarks, ──
    //     post_saves, post_reports, hashtag_follows, hashtags. Each table is
    //     idempotent (CREATE … IF NOT EXISTS) + a one-time seed from JSON when
    //     empty. Endpoints route through s* helpers that dual-write JSON, so the
    //     many direct readJSON() readers (feed/profile/search) keep working.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`recipes\` (
        \`id\`          VARCHAR(36)  PRIMARY KEY,
        \`userId\`      VARCHAR(36)  NOT NULL,
        \`authorName\`  VARCHAR(255),
        \`name\`        VARCHAR(255) NOT NULL,
        \`category\`    VARCHAR(100),
        \`description\` TEXT,
        \`prepTime\`    INT          DEFAULT 0,
        \`cookTime\`    INT          DEFAULT 0,
        \`servings\`    INT          DEFAULT 1,
        \`difficulty\`  VARCHAR(50)  DEFAULT 'Easy',
        \`photos\`      JSON,
        \`ingredients\` JSON,
        \`steps\`       JSON,
        \`opinion\`     TEXT,
        \`tips\`        TEXT,
        \`tags\`        JSON,
        \`nutrition\`   JSON,
        \`ratings\`     JSON,
        \`aiAnalysis\`  JSON,
        \`createdAt\`   DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_userId\`    (\`userId\`),
        INDEX \`idx_category\`  (\`category\`),
        INDEX \`idx_createdAt\` (\`createdAt\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ recCnt }]] = await db.execute('SELECT COUNT(*) AS recCnt FROM `recipes`');
    if (recCnt === 0) {
      const seedRecipes = readJSON(RECIPES_FILE);
      for (const r of seedRecipes) {
        try {
          await db.execute(
            'INSERT INTO `recipes` (`id`,`userId`,`authorName`,`name`,`category`,`description`,`prepTime`,`cookTime`,`servings`,`difficulty`,`photos`,`ingredients`,`steps`,`opinion`,`tips`,`tags`,`nutrition`,`ratings`,`aiAnalysis`,`createdAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [r.id, r.userId, r.authorName || null, r.name, r.category || null,
             r.description || '', r.prepTime || 0, r.cookTime || 0, r.servings || 1,
             r.difficulty || 'Easy', JSON.stringify(r.photos || []),
             JSON.stringify(r.ingredients || []), JSON.stringify(r.steps || []),
             r.opinion || '', r.tips || '', JSON.stringify(r.tags || []),
             r.nutrition ? JSON.stringify(r.nutrition) : null,
             JSON.stringify(r.ratings || []),
             r.aiAnalysis ? JSON.stringify(r.aiAnalysis) : null,
             r.createdAt || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedRecipes.length) console.log(`Migrated ${seedRecipes.length} recipes from JSON → MySQL`);
    }

    // recipe_comments (threaded one level; likes is a JSON userId array)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`recipe_comments\` (
        \`id\`         VARCHAR(36)  PRIMARY KEY,
        \`recipeId\`   VARCHAR(36)  NOT NULL,
        \`userId\`     VARCHAR(36)  NOT NULL,
        \`authorName\` VARCHAR(255),
        \`text\`       TEXT         NOT NULL,
        \`parentId\`   VARCHAR(36)  DEFAULT NULL,
        \`likes\`      JSON,
        \`createdAt\`  DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_recipeId\` (\`recipeId\`),
        INDEX \`idx_parentId\` (\`parentId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ rcmtCnt }]] = await db.execute('SELECT COUNT(*) AS rcmtCnt FROM `recipe_comments`');
    if (rcmtCnt === 0) {
      const seedRc = readJSON(COMMENTS_FILE);
      for (const c of seedRc) {
        try {
          await db.execute(
            'INSERT INTO `recipe_comments` (`id`,`recipeId`,`userId`,`authorName`,`text`,`parentId`,`likes`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)',
            [c.id, c.recipeId, c.userId, c.authorName || null, c.text || '',
             c.parentId || null, JSON.stringify(c.likes || []), c.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedRc.length) console.log(`Migrated ${seedRc.length} recipe_comments from JSON → MySQL`);
    }

    // recipe_reactions (one emoji per user per recipe)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`recipe_reactions\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`recipeId\`  VARCHAR(36)  NOT NULL,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`emoji\`     VARCHAR(10)  NOT NULL,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`unique_recipe_reaction\` (\`recipeId\`, \`userId\`),
        INDEX \`idx_recipeId\` (\`recipeId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ rrxnCnt }]] = await db.execute('SELECT COUNT(*) AS rrxnCnt FROM `recipe_reactions`');
    if (rrxnCnt === 0) {
      const seedRr = readJSON(REACTIONS_FILE);
      for (const r of seedRr) {
        try {
          await db.execute(
            'INSERT INTO `recipe_reactions` (`id`,`recipeId`,`userId`,`emoji`,`createdAt`) VALUES (?,?,?,?,?)',
            [r.id, r.recipeId, r.userId, r.emoji, r.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedRr.length) console.log(`Migrated ${seedRr.length} recipe_reactions from JSON → MySQL`);
    }

    // recipe_reports
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`recipe_reports\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`recipeId\`  VARCHAR(36)  NOT NULL,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`reason\`    TEXT,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_recipeId\` (\`recipeId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ rrepCnt }]] = await db.execute('SELECT COUNT(*) AS rrepCnt FROM `recipe_reports`');
    if (rrepCnt === 0) {
      const seedRrep = readJSON(REPORTS_FILE);
      for (const r of seedRrep) {
        try {
          await db.execute(
            'INSERT INTO `recipe_reports` (`id`,`recipeId`,`userId`,`reason`,`createdAt`) VALUES (?,?,?,?,?)',
            [r.id || uuidv4(), r.recipeId, r.userId, r.reason || null, r.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedRrep.length) console.log(`Migrated ${seedRrep.length} recipe_reports from JSON → MySQL`);
    }

    // bookmarks (recipe saves; JSON rows have no id, so generate one)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`bookmarks\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`recipeId\`  VARCHAR(36)  DEFAULT NULL,
        \`postId\`    VARCHAR(36)  DEFAULT NULL,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_userId\`   (\`userId\`),
        INDEX \`idx_recipeId\` (\`recipeId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ bmCnt }]] = await db.execute('SELECT COUNT(*) AS bmCnt FROM `bookmarks`');
    if (bmCnt === 0) {
      const seedBm = readJSON(BOOKMARKS_FILE);
      for (const b of seedBm) {
        try {
          await db.execute(
            'INSERT INTO `bookmarks` (`id`,`userId`,`recipeId`,`postId`,`createdAt`) VALUES (?,?,?,?,?)',
            [b.id || uuidv4(), b.userId, b.recipeId || null, b.postId || null, b.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedBm.length) console.log(`Migrated ${seedBm.length} bookmarks from JSON → MySQL`);
    }

    // post_saves (one save per user per post; JSON rows have no id)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`post_saves\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`postId\`    VARCHAR(36)  NOT NULL,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`unique_save\` (\`postId\`, \`userId\`),
        INDEX \`idx_userId\` (\`userId\`),
        INDEX \`idx_postId\` (\`postId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ saveCnt }]] = await db.execute('SELECT COUNT(*) AS saveCnt FROM `post_saves`');
    if (saveCnt === 0) {
      const seedSaves = readJSON(POST_SAVES_FILE);
      for (const s of seedSaves) {
        try {
          await db.execute(
            'INSERT INTO `post_saves` (`id`,`postId`,`userId`,`createdAt`) VALUES (?,?,?,?)',
            [s.id || uuidv4(), s.postId, s.userId, s.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedSaves.length) console.log(`Migrated ${seedSaves.length} post_saves from JSON → MySQL`);
    }

    // post_reports
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`post_reports\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`postId\`    VARCHAR(36)  NOT NULL,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`reason\`    TEXT,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_postId\` (\`postId\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ prepCnt }]] = await db.execute('SELECT COUNT(*) AS prepCnt FROM `post_reports`');
    if (prepCnt === 0) {
      const seedPrep = readJSON(POST_REPORTS_FILE);
      for (const r of seedPrep) {
        try {
          await db.execute(
            'INSERT INTO `post_reports` (`id`,`postId`,`userId`,`reason`,`createdAt`) VALUES (?,?,?,?,?)',
            [r.id || uuidv4(), r.postId, r.userId, r.reason || null, r.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedPrep.length) console.log(`Migrated ${seedPrep.length} post_reports from JSON → MySQL`);
    }

    // hashtag_follows
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`hashtag_follows\` (
        \`id\`        VARCHAR(36)  PRIMARY KEY,
        \`userId\`    VARCHAR(36)  NOT NULL,
        \`tag\`       VARCHAR(100) NOT NULL,
        \`createdAt\` DATETIME     DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`unique_follow\` (\`userId\`, \`tag\`),
        INDEX \`idx_userId\` (\`userId\`),
        INDEX \`idx_tag\`    (\`tag\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    const [[{ hfCnt }]] = await db.execute('SELECT COUNT(*) AS hfCnt FROM `hashtag_follows`');
    if (hfCnt === 0) {
      const seedHf = readJSON(HASHTAG_FOLLOWS_FILE);
      for (const f of seedHf) {
        try {
          await db.execute(
            'INSERT INTO `hashtag_follows` (`id`,`userId`,`tag`,`createdAt`) VALUES (?,?,?,?)',
            [f.id || uuidv4(), f.userId, f.tag, f.at || new Date().toISOString()]
          );
        } catch { /* skip duplicates */ }
      }
      if (seedHf.length) console.log(`Migrated ${seedHf.length} hashtag_follows from JSON → MySQL`);
    }

    // hashtags — aggregate counters table (created per spec; populated lazily by
    // a future phase — hashtag pages currently aggregate from posts on the fly).
    await db.execute(`
      CREATE TABLE IF NOT EXISTS \`hashtags\` (
        \`id\`          VARCHAR(36)  PRIMARY KEY,
        \`tag\`         VARCHAR(100) NOT NULL UNIQUE,
        \`postCount\`   INT          DEFAULT 0,
        \`weeklyCount\` INT          DEFAULT 0,
        \`lastUsed\`    DATETIME,
        INDEX \`idx_tag\`         (\`tag\`),
        INDEX \`idx_weeklyCount\` (\`weeklyCount\`)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    console.log('Phase 2e tables ready (recipes, recipe_comments/reactions/reports, bookmarks, post_saves, post_reports, hashtag_follows, hashtags)');
  } catch (e) {
    console.error('MySQL setup failed:', e.message);
    db = null;
  }
})();

// JWT auth middleware
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided', code: 'AUTH_REQUIRED' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  }
  // A signature-valid token whose user no longer exists is a dead session
  // (e.g. data reset, or a token from a previous run). Return 401 — NOT 404 —
  // so the client clears it and routes to login, instead of every endpoint
  // failing with a confusing "User not found" (notably on profile Save).
  const user = db
    ? await dbFindUserById(payload.id)
    : readJSON(USERS_FILE).find(u => u.id === payload.id);
  if (!user) {
    console.warn('Auth: token valid but user missing:', payload.id);
    return res.status(401).json({ error: 'Session no longer valid — please log in again', code: 'SESSION_EXPIRED' });
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
    nameKa: "ვაშლი",
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
    description: "Crisp and juicy with a refreshing sweet-tart snap, the apple is built for satisfying, low-effort snacking. Its pectin fiber feeds the gut while quercetin and other antioxidants support heart health. With more than 7,500 varieties grown worldwide, no two apples have to taste quite the same.",
    descriptionKa: "მკვრივი და გამაგრილებლად მოტკბო-მომჟავო, ვაშლი იდეალურია მსუბუქი წასახემსებლად. მისი პექტინის ბოჭკო კვებავს ნაწლავებს, ხოლო კვერცეტინი და სხვა ანტიოქსიდანტები გულის ჯანმრთელობას უჭერენ მხარს. მსოფლიოში 7500-ზე მეტი ჯიში არსებობს.",
    serving: '100g'
  },
  {
    id: 'banana',
    name: 'Banana',
    nameKa: "ბანანი",
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
    description: "Soft, creamy, and naturally sweet, a ripe banana is nature's grab-and-go fuel. Each one delivers around 376mg of potassium plus vitamin B6 to support heart and muscle function. Botanically they are berries, and they grow pointing up toward the sun rather than hanging down.",
    descriptionKa: "რბილი, ნაღებისებური და ბუნებრივად ტკბილი, მომწიფებული ბანანი იდეალური სწრაფი ენერგიის წყაროა. თითოეული შეიცავს დაახლოებით 376 მგ კალიუმს და B6 ვიტამინს გულისა და კუნთების მხარდასაჭერად. ბოტანიკურად ბანანი კენკრაა.",
    serving: '100g'
  },
  {
    id: 'chicken',
    name: 'Chicken Breast',
    nameKa: "მთელი ქათმის მკერდი",
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
    description: "Lean, mild, and endlessly adaptable, chicken breast is the clean canvas of the protein world. It offers one of the highest protein-to-calorie ratios of any common meat, 31g per 100g, with very little fat. That blank-slate flavor is exactly why it anchors cuisines on every continent.",
    descriptionKa: "მჭლე, რბილი და მრავალმხრივი, ქათმის მკერდი ცილის სუფთა წყაროა. მას ერთ-ერთი საუკეთესო ცილა-კალორიის თანაფარდობა აქვს, 100 გრამზე 31 გრამი ცილა და ძალიან ცოტა ცხიმი. სწორედ ამიტომ გვხვდება იგი მსოფლიოს ყველა სამზარეულოში.",
    serving: '100g'
  },
  {
    id: 'fish',
    name: 'Fish (Salmon)',
    nameKa: "ორაგული",
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
    description: "Rich, buttery, and tender with a savory depth, salmon is the fish even skeptics enjoy. It is one of the best dietary sources of omega-3 fats, which calm inflammation and support the brain and heart, plus an exceptional dose of vitamin D. Its pink flesh comes from the same antioxidant family that turns flamingos pink.",
    descriptionKa: "მდიდარი, ნაღებისებური და ნაზი, ორაგული ცხიმიანი თევზია გამორჩეული გემოთი. ის ომეგა-3 ცხიმოვანი მჟავების ერთ-ერთი საუკეთესო წყაროა, რომელიც ანთებას ამცირებს და ტვინსა და გულს უჭერს მხარს, ასევე D ვიტამინით მდიდარია. მისი ვარდისფერი ხორცი იმავე ანტიოქსიდანტისგან მოდის, რომელიც ფლამინგოს აფერადებს.",
    serving: '100g'
  },
  {
    id: 'almond',
    name: 'Almond',
    nameKa: "ნუში",
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
    description: "Rich, crunchy, and subtly sweet, almonds are the snack that feels good to reach for. They are an outstanding source of vitamin E, an antioxidant that protects your cells, plus heart-healthy fats and magnesium. Almonds are not true nuts but the seeds of a fruit related to peaches.",
    descriptionKa: "მდიდარი, ხრაშუნა და ოდნავ ტკბილი, ნუში სასიამოვნო და სასარგებლო საუზმობელია. ის E ვიტამინის შესანიშნავი წყაროა, ანტიოქსიდანტის, რომელიც უჯრედებს იცავს, ასევე გულისთვის სასარგებლო ცხიმებითა და მაგნიუმით მდიდარია. ნუში ნამდვილი კაკალი არ არის, ის ატმის ნათესავი ხილის თესლია.",
    serving: '100g'
  },
  {
    id: 'egg',
    name: 'Eggs',
    nameKa: "კვერცხი",
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
    description: "Creamy, rich, and infinitely versatile, eggs are a kitchen staple for good reason. They are a complete protein with all nine essential amino acids and one of the best sources of choline, a nutrient vital for memory. A whole egg is also one of the most affordable high-quality proteins you can buy.",
    descriptionKa: "ნაღებისებური, მკვებავი და მრავალმხრივი, კვერცხი სამზარეულოს საფუძველია. ის სრულყოფილი ცილაა ცხრავე აუცილებელი ამინომჟავით და ქოლინის ერთ-ერთი საუკეთესო წყაროა, რომელიც მეხსიერებას უჭერს მხარს. ამავე დროს ეს ერთ-ერთი ყველაზე იაფი მაღალხარისხიანი ცილაა.",
    serving: '100g'
  },
  {
    id: 'sweetpotato',
    name: 'Sweet Potato',
    nameKa: "ტკბილი კარტოფილი",
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
    description: "Naturally sweet and creamy when roasted, sweet potato is comfort with a nutritional backbone. A single serving provides well over a day's worth of vitamin A as beta-carotene, plus steady fiber and complex carbs. Despite the name, it is not closely related to the regular potato at all.",
    descriptionKa: "ბუნებრივად ტკბილი და ნაზი შეწვისას, ტკბილი კარტოფილი მკვებავი კომფორტის საკვებია. ერთი პორცია დღიურ ნორმაზე მეტ A ვიტამინს იძლევა ბეტა-კაროტინის სახით, ასევე ბოჭკოსა და რთულ ნახშირწყლებს. სახელის მიუხედავად, ის ჩვეულებრივ კარტოფილს ნათესავად არ უკავშირდება.",
    serving: '100g'
  },
  {
    id: 'broccoli', name: 'Broccoli', nameKa: "ბროკოლი", emoji: '🥦', color: '#22863a', calories: 34,
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
    description: "Fresh and grassy with a satisfying crunch raw and a tender bite cooked, broccoli rewards good cooking. It is famous for sulforaphane, a compound studied for cancer protection, and it delivers more vitamin C than an orange. Broccoli is a human invention, bred from wild cabbage over 2,000 years ago.",
    descriptionKa: "სუფთა, ხრაშუნა და გემრიელი, ბროკოლი ანტიოქსიდანტებით მდიდარი ბოსტნეულია. ის ცნობილია სულფორაფანით, ნაერთით, რომელსაც კიბოსგან დაცვისთვის სწავლობენ, და ფორთოხალზე მეტ C ვიტამინს შეიცავს. ბროკოლი ადამიანის შექმნილია, გამოყვანილი ველური კომბოსტოსგან 2000 წელზე მეტი ხნის წინ.",
    serving: '100g'
  },
  {
    id: 'avocado', name: 'Avocado', nameKa: "ავოკადო", emoji: '🥑', color: '#355e3b', calories: 160,
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
    description: "Buttery and rich with a smooth, almost custardy flesh, avocado feels like an indulgence that happens to be good for you. It is loaded with heart-healthy monounsaturated fat and 7g of fiber per 100g, and that fat helps your body absorb vitamins from the foods you eat alongside it. Despite the savory profile, it is botanically a berry.",
    serving: '100g'
  },
  {
    id: 'blueberry', name: 'Blueberries', nameKa: "მოცვი", emoji: '🫐', color: '#4b3b8c', calories: 57,
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
    description: "Tiny and plump with a sweet-tart burst, blueberries are one of the easiest superfoods to love. They carry the highest antioxidant content of any common fruit, led by anthocyanins linked to sharper memory. That deep blue-purple skin is where most of those antioxidants live.",
    descriptionKa: "პატარა და წვნიანი, მოტკბო-მომჟავო აფეთქებით, მოცვი ერთ-ერთი ყველაზე საყვარელი სუპერსაკვებია. მას ნებისმიერ გავრცელებულ ხილს შორის ყველაზე მაღალი ანტიოქსიდანტური შემცველობა აქვს, განსაკუთრებით ანთოციანინებით, რომლებიც მეხსიერებას უკავშირდება. სწორედ მუქ ლურჯ კანშია ამ ანტიოქსიდანტების უმეტესობა.",
    serving: '100g'
  },
  {
    id: 'spinach', name: 'Spinach', nameKa: "ისპანახი", emoji: '🥬', color: '#2d6a2f', calories: 23,
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
    description: "Mild and faintly earthy, spinach wilts into almost anything and vanishes into smoothies. It is extraordinarily high in vitamin K for bone health, with more than four times a day's worth in 100g, plus eye-protecting lutein. Cooking shrinks it dramatically, so a huge handful becomes a few concentrated bites.",
    descriptionKa: "რბილი და ოდნავ მიწიერი გემოს, ისპანახი თითქმის ნებისმიერ კერძში ერწყმის. ის უაღრესად მდიდარია K ვიტამინით ძვლების ჯანმრთელობისთვის, 100 გრამში დღიური ნორმის ოთხჯერ მეტი, ასევე თვალისთვის სასარგებლო ლუტეინით. მოხარშვისას ის მკვეთრად მცირდება.",
    serving: '100g'
  },
  {
    id: 'greekyogurt', name: 'Greek Yogurt', nameKa: "ბერძნული იოგურტი", emoji: '🍦', color: '#f0ede6', calories: 59,
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
    description: "Thick, tangy, and luxuriously creamy, Greek yogurt is comfort food that loves you back. Straining gives it about double the protein of regular yogurt, around 10g per 100g, plus probiotics that support gut health. It takes roughly four cups of milk to make a single cup.",
    descriptionKa: "სქელი, მომჟავო და ნაღებისებური, ბერძნული იოგურტი სასარგებლო კომფორტის საკვებია. გაფილტვრის წყალობით მას ჩვეულებრივ იოგურტზე ორჯერ მეტი ცილა აქვს, 100 გრამზე დაახლოებით 10 გრამი, ასევე პრობიოტიკები ნაწლავების ჯანმრთელობისთვის. ერთი ჭიქის დასამზადებლად დაახლოებით ოთხი ჭიქა რძეა საჭირო.",
    serving: '100g'
  },
  {
    id: 'carrot', name: 'Carrot', nameKa: "სტაფილო", emoji: '🥕', color: '#f97316', calories: 41,
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
    description: "Sweet, crisp, and snappy, carrots are the crunchy snack that doubles as one of the best sources of beta-carotene. Your body converts that pigment into vitamin A, which supports healthy vision. The familiar orange carrot is a fairly recent creation, as early carrots were purple, white, or yellow.",
    descriptionKa: "ტკბილი, მკვრივი და ხრაშუნა, სტაფილო ბეტა-კაროტინის ერთ-ერთი საუკეთესო წყაროა. ორგანიზმი ამ პიგმენტს A ვიტამინად გარდაქმნის, რომელიც მხედველობას უჭერს მხარს. ნაცნობი ნარინჯისფერი სტაფილო შედარებით ახალია, ადრე ის იისფერი, თეთრი ან ყვითელი იყო.",
    serving: '100g'
  },
  {
    id: 'oats', name: 'Oats', nameKa: "შვრია", emoji: '🥣', color: '#d4a853', calories: 389,
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
    description: "Warm, creamy, and comforting, a bowl of oats is the definition of a steady morning. They are rich in beta-glucan, a soluble fiber clinically shown to lower cholesterol, and they release energy slowly to keep you full. Oats are naturally gluten-free, though they are often processed alongside wheat.",
    descriptionKa: "თბილი, ნაზი და დამამშვიდებელი, შვრიის ფაფა მშვიდი დილის სიმბოლოა. ის მდიდარია ბეტა-გლუკანით, ხსნადი ბოჭკოთი, რომელიც ქოლესტერინს ამცირებს, და ენერგიას ნელა გასცემს. შვრია ბუნებრივად უგლუტენოა, თუმცა ხშირად ხორბალთან ერთად მუშავდება.",
    serving: '100g'
  },
  {
    id: 'lemon', name: 'Lemon', nameKa: "ლიმონი", emoji: '🍋', color: '#fde047', calories: 29,
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
    description: "Bright, mouth-puckering, and intensely tart, lemon wakes up everything it touches. A single one packs about 79mg of vitamin C, close to a full day's worth, to power the immune system. Curiously, despite its sharp acidity, lemon has an alkalizing effect on the body once metabolized.",
    descriptionKa: "კაშკაშა და ძალიან მჟავე, ლიმონი ყველაფერს ამძაფრებს გემოს. ერთი ლიმონი დაახლოებით 79 მგ C ვიტამინს შეიცავს, თითქმის დღიურ ნორმას, იმუნიტეტის გასაძლიერებლად. საინტერესოა, რომ მჟავიანობის მიუხედავად, ლიმონს ორგანიზმში ტუტოვანი ეფექტი აქვს.",
    serving: '100g'
  },
  {
    id: 'walnut', name: 'Walnuts', nameKa: "კაკალი", emoji: '🫘', color: '#8b5e3c', calories: 654,
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
    description: "Rich and buttery with a pleasant edge of bitterness, walnuts bring complexity to every bite. They hold the highest omega-3 content of any tree nut, fats linked to better brain health. Fittingly, the wrinkled walnut even looks a little like the brain it helps support.",
    descriptionKa: "მდიდარი და ნაღებისებური, ოდნავ მომწარო გემოთი, კაკალი ყოველ ლუკმას სიღრმეს მატებს. მას ყველა კაკალს შორის ყველაზე მაღალი ომეგა-3 შემცველობა აქვს, ცხიმები, რომლებიც ტვინის ჯანმრთელობას უკავშირდება. შესაბამისად, დანაოჭებული კაკალი ცოტათი თავად ტვინსაც კი ჰგავს.",
    serving: '100g'
  },
  {
    id: 'tomato', name: 'Tomato', nameKa: "პომიდორი", emoji: '🍅', color: '#dc2626', calories: 18,
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
    description: "Juicy and savory with a gentle sweet-acid balance, the tomato brings a hit of umami to nearly any dish. It is rich in lycopene, an antioxidant tied to heart health and cancer prevention. Cooking actually makes that lycopene easier to absorb, so a simmered sauce can be more potent than raw.",
    serving: '100g'
  },
  {
    id: 'garlic', name: 'Garlic', nameKa: "ნიორი", emoji: '🧄', color: '#f5f0e0', calories: 149,
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
    description: "Pungent and aromatic raw, mellow and savory once cooked, garlic is the backbone of kitchens worldwide. Crushing it releases allicin, a compound with genuine antibacterial power that may help lower blood pressure. That allicin only forms when the clove is cut or crushed, so chopping is what unlocks it.",
    serving: '100g'
  },
  {
    id: 'darkchocolate', name: 'Dark Chocolate', nameKa: "შავი შოკოლადი", emoji: '🍫', color: '#3d1a0a', calories: 598,
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
    description: "Intense, bittersweet, and smooth as it melts, dark chocolate is indulgence with genuine upside. It is one of the richest food sources of flavonoid antioxidants and supplies real iron and magnesium. It is calorie-dense, so a square or two is plenty to enjoy the benefit.",
    descriptionKa: "ინტენსიური, მომწარო-მოტკბო და დნება პირში, შავი შოკოლადი ნამდვილი სარგებლის მქონე განებივრებაა. ის ფლავონოიდური ანტიოქსიდანტების ერთ-ერთი უმდიდრესი წყაროა და შეიცავს რკინასა და მაგნიუმს. ის კალორიულია, ამიტომ ერთი-ორი ნაჭერი საკმარისია სარგებლის მისაღებად.",
    serving: '100g'
  },
  {
    id: 'kiwi', name: 'Kiwi', nameKa: "კივი", emoji: '🥝', color: '#4d7c0f', calories: 61,
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
    description: "Sweet and tangy with a tropical, almost berry-like flavor, kiwi hides a vivid green interior flecked with edible black seeds. Gram for gram it holds more vitamin C than an orange, and compounds in it may help improve sleep quality. The fuzzy skin is edible too, and it adds a fiber boost.",
    serving: '100g'
  },
  {
    id: 'quinoa', name: 'Quinoa', nameKa: "კინოა", emoji: '🌾', color: '#d4c5a0', calories: 368,
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
    description: "Nutty and fluffy with a tiny satisfying pop, quinoa cooks up light and adaptable. It is one of the few plant foods that is a complete protein, with all nine essential amino acids, and it is naturally gluten-free. Technically quinoa is a seed, not a grain, related to spinach and beets.",
    descriptionKa: "კაკლისებური და ფუმფულა, კინოა მსუბუქი და მრავალმხრივია. ის იმ მცირერიცხოვან მცენარეულ საკვებთა შორისაა, რომელიც სრულყოფილი ცილაა, ცხრავე აუცილებელი ამინომჟავით, და ბუნებრივად უგლუტენოა. ტექნიკურად კინოა თესლია და არა მარცვალი, ისპანახისა და ჭარხლის ნათესავი.",
    serving: '100g'
  },
  {
    id: 'ginger', name: 'Ginger', nameKa: "კოჭა", emoji: '🫚', color: '#c8a96e', calories: 80,
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
    description: "Warming, zingy, and a little spicy, ginger adds brightness and heat to sweet and savory dishes alike. Its active compound gingerol is a potent anti-inflammatory and a proven remedy for nausea. Ginger is not a root but an underground stem called a rhizome.",
    serving: '100g'
  },
  {
    id: 'whiterice', name: 'White Rice', nameKa: "თეთრი ბრინჯი", emoji: '🍚', color: '#f5f5f0', calories: 130,
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
    description: "Soft, fluffy, and clean-tasting, white rice is the easygoing staple that pairs with everything. It digests quickly and offers fast, accessible energy, which makes it a favorite before and after hard training. Rice feeds more than half the world's population every single day.",
    serving: '100g'
  },
  {
    id: 'brownrice', name: 'Brown Rice', nameKa: "ყავისფერი ბრინჯი", emoji: '🍚', color: '#b08d57', calories: 111,
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
    description: "Nutty, chewy, and a little more rustic, brown rice is white rice with its wholesome layers left on. Keeping the bran and germ gives it far more fiber and minerals like magnesium, plus steadier energy. It is simply the same grain with only the inedible hull removed.",
    serving: '100g'
  },
  {
    id: 'wholewheatbread', name: 'Whole Wheat Bread', nameKa: "მთლიანი ხორბლის პური", emoji: '🍞', color: '#b5793a', calories: 247,
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
    description: "Hearty and robust with a satisfying chew, whole wheat bread is everyday bread with more to offer. Made from the whole grain, it brings far more fiber and B vitamins than refined white bread. The intact bran and germ are exactly what give it that deeper color and nuttier flavor.",
    serving: '100g'
  },
  {
    id: 'pasta', name: 'Pasta', nameKa: "მაკარონი", emoji: '🍝', color: '#e8cd6d', calories: 158,
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
    description: "Comforting, satisfying, and endlessly adaptable, pasta is the dish almost everyone comes home to. It is a reliable source of energy and surprisingly high in selenium, an antioxidant mineral. There are more than 350 recognized pasta shapes, each designed to hold sauce a little differently.",
    serving: '100g'
  },
  {
    id: 'corn', name: 'Corn', nameKa: "სიმინდი", emoji: '🌽', color: '#f5c542', calories: 86,
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
    description: "Sweet, juicy, and tender, fresh corn pops with summer flavor straight off the cob. It supplies fiber along with lutein and zeaxanthin, two antioxidants that help protect your eyes. Corn is a grass, and a single ear carries roughly 800 kernels arranged in 16 rows.",
    serving: '100g'
  },
  {
    id: 'lentils', name: 'Lentils', nameKa: "ოსპი", emoji: '🫘', color: '#6b8e23', calories: 116,
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
    description: "Earthy, hearty, and comforting, lentils turn soups and stews into a meal. They are an excellent plant protein and one of the best legume sources of fiber and plant iron. Unlike dried beans, lentils need no soaking and cook in about 20 minutes.",
    descriptionKa: "მიწიერი და მაძღრობელი, ოსპი სუპებსა და ჩაშუშულებს სრულ კერძად აქცევს. ის შესანიშნავი მცენარეული ცილაა და ბოჭკოსა და რკინის ერთ-ერთი საუკეთესო წყარო პარკოსნებს შორის. მშრალი ლობიოსგან განსხვავებით, ოსპი დაზელვას არ საჭიროებს და დაახლოებით 20 წუთში იხარშება.",
    serving: '100g'
  },
  {
    id: 'blackbeans', name: 'Black Beans', nameKa: "შავი ლობიო", emoji: '🫘', color: '#2a2a2e', calories: 132,
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
    description: "Rich, creamy, and mildly sweet, black beans are a satisfying staple across the Americas. They pair nearly 9g of protein with almost 9g of fiber per 100g, a combination that keeps blood sugar steady. Their glossy dark skin is full of anthocyanins, the same antioxidants found in blueberries.",
    serving: '100g'
  },
  {
    id: 'chickpeas', name: 'Chickpeas', nameKa: "ნუტი", emoji: '🫛', color: '#e3c79a', calories: 164,
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
    description: "Nutty, buttery, and pleasantly firm, chickpeas are as happy roasted crunchy as they are blended smooth. They deliver a solid combination of plant protein and fiber that keeps you full for hours. Mashed with tahini and lemon, they become hummus, a dish eaten for well over a thousand years.",
    serving: '100g'
  },
  {
    id: 'corntortilla', name: 'Corn Tortilla', nameKa: "სიმინდის ტორტილა", emoji: '🫓', color: '#ecd9a0', calories: 218,
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
    description: "Light, soft, and lightly toasty, the corn tortilla is a naturally gluten-free staple built for folding and filling. A traditional process called nixtamalization makes its calcium more available to your body. That same ancient technique, soaking corn in an alkaline solution, also unlocks more of its B vitamins.",
    serving: '100g'
  },
  {
    id: 'buckwheat', name: 'Buckwheat', nameKa: "წიწიბურა", emoji: '🌾', color: '#a8825a', calories: 92,
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
    description: "Earthy and robust with a hearty, toasty flavor, buckwheat eats like a grain but breaks the rules. It is a complete plant protein, naturally gluten-free, and rich in rutin, an antioxidant that supports circulation. Despite the name, buckwheat is not wheat at all, it is related to rhubarb.",
    serving: '100g'
  },
  {
    id: 'millet', name: 'Millet', nameKa: "ფეტვი", emoji: '🌾', color: '#e6cf6a', calories: 119,
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
    description: "Mild, fluffy, and slightly sweet, millet is a tiny ancient grain that cooks up tender and light. It is gluten-free, gentle on digestion, and one of the few grains that is mildly alkaline-forming. Millet has fed civilizations for thousands of years and still sustains millions across Africa and Asia.",
    serving: '100g'
  },
  {
    id: 'barley', name: 'Barley', nameKa: "ქერი", emoji: '🌾', color: '#d8c89a', calories: 123,
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
    description: "Chewy and nutty with a pleasantly hearty texture, barley adds satisfying body to soups and grain bowls. Like oats, it is rich in beta-glucan fiber that actively helps lower cholesterol. Barley is one of the first grains humans ever farmed, cultivated for over 10,000 years.",
    serving: '100g'
  },
  {
    id: 'tuna', name: 'Tuna', nameKa: "ტუნა", emoji: '🐟', color: '#c8554d', calories: 116,
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
    description: "Clean, meaty, and satisfying, tuna delivers serious protein with almost no fat. At 26g of protein per 100g plus a big hit of selenium and B12, it is a lean-eating favorite. Tuna are warm-blooded ocean athletes that can swim faster than 40 miles per hour.",
    serving: '100g'
  },
  {
    id: 'turkey', name: 'Turkey Breast', nameKa: "ინდაურის მკერდი", emoji: '🦃', color: '#e8c4a0', calories: 135,
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
    description: "Mild, lean, and lightly savory, turkey breast is a feel-good protein for any day, not just holidays. It is one of the leanest high-protein meats and contains tryptophan, an amino acid your body uses to make mood and sleep chemicals. The tryptophan is real, though that post-dinner drowsiness owes more to the size of the meal.",
    serving: '100g'
  },
  {
    id: 'cottagecheese', name: 'Cottage Cheese', nameKa: "კოტეჯ ყველი", emoji: '🧀', color: '#f5f3ee', calories: 98,
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
    description: "Mild, milky, and pleasantly creamy with soft curds, cottage cheese is quietly one of the best high-protein snacks. It is especially rich in casein, a slow-digesting protein that drip-feeds your muscles overnight. That makes a bowl before bed a genuine recovery tool.",
    serving: '100g'
  },
  {
    id: 'beef', name: 'Beef', nameKa: "საქონლის ხორცი", emoji: '🥩', color: '#8b3a2f', calories: 250,
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
    description: "Deeply savory and satisfying, beef is rich, hearty, and full of flavor. It is a complete protein and one of the best everyday sources of vitamin B12, zinc, and easily absorbed iron. The heme iron in red meat is taken up far more efficiently than the iron in plants.",
    serving: '100g'
  },
  {
    id: 'pork', name: 'Pork Tenderloin', nameKa: "ღორის ფილე", emoji: '🥓', color: '#e0a99a', calories: 143,
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
    description: "Tender, mild, and lean, pork tenderloin is the most delicate cut of the pig. It rivals chicken breast for leanness while delivering the highest thiamine of any meat, a B vitamin key to turning food into energy. The tenderloin is a muscle that does almost no work, which is why it stays so soft.",
    serving: '100g'
  },
  {
    id: 'shrimp', name: 'Shrimp', nameKa: "კრევეტი", emoji: '🦐', color: '#f08070', calories: 99,
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
    description: "Sweet, delicate, and lightly briny, shrimp cook in minutes and please almost everyone. They pack 24g of protein per 100g with barely any fat, plus iodine to support thyroid function. Shrimp turn from gray to pink as they cook, thanks to a pigment released by the heat.",
    serving: '100g'
  },
  {
    id: 'whey', name: 'Whey Protein', nameKa: "შრატის ცილა", emoji: '🥛', color: '#f0ede6', calories: 400,
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
    description: "Clean and neutral with a smooth, milky finish, whey protein is the fitness world's go-to powder. It is the fastest-absorbing protein available and exceptionally high in leucine, the amino acid that flips the switch on muscle growth. Whey is the liquid left over from cheesemaking, once discarded and now prized.",
    serving: '100g'
  },
  {
    id: 'edamame', name: 'Edamame', nameKa: "ედამამე", emoji: '🫛', color: '#7cb342', calories: 121,
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
    description: "Fresh, nutty, and faintly sweet, edamame are young soybeans you pop straight from the pod. They are a complete plant protein and remarkably high in folate, a nutrient especially important during pregnancy. The name simply means immature soybeans, harvested while still green and tender.",
    serving: '100g'
  },
  {
    id: 'sardines', name: 'Sardines', nameKa: "სარდინი", emoji: '🐠', color: '#c0c4cc', calories: 208,
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
    description: "Bold, savory, and richly oily, sardines bring big flavor in a small package. Eaten whole with their soft bones, they are an outstanding source of calcium and vitamin D plus B12 and omega-3s. Because they are small and short-lived, sardines are also among the lowest-mercury fish you can choose.",
    serving: '100g'
  },
  {
    id: 'tempeh', name: 'Tempeh', nameKa: "ტემპე", emoji: '🧆', color: '#b08850', calories: 193,
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
    description: "Firm, chewy, and nutty with a savory, earthy depth, tempeh holds up to grilling, slicing, and searing. Fermenting whole soybeans makes it a complete protein that is easier to digest and rich in gut-friendly probiotics. It originated in Indonesia, where it has been made by hand for centuries.",
    serving: '100g'
  },
  {
    id: 'lamb', name: 'Lamb', nameKa: "ბატკნის ხორცი", emoji: '🐑', color: '#9b3b30', calories: 294,
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
    description: "Rich, distinctive, and pleasantly gamey, lamb is a red meat with real character. It is high in B12 and zinc and naturally contains CLA, a fatty acid studied for its health benefits. Grass-fed lamb tends to carry even more of those beneficial omega-3 and CLA fats.",
    serving: '100g'
  },
  {
    id: 'cannedsalmon', name: 'Canned Salmon', nameKa: "დაკონსერვებული ორაგული", emoji: '🥫', color: '#f08a5d', calories: 139,
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
    description: "Convenient and richly savory, canned salmon brings the buttery taste of salmon straight from the pantry. It is exceptionally high in vitamin D and B12, with soft edible bones that add a calcium boost. Ounce for ounce it can rival fresh fillets for omega-3 at a fraction of the cost.",
    serving: '100g'
  },
  {
    id: 'tofu', name: 'Tofu', nameKa: "ტოფუ", emoji: '🧈', color: '#f5f2e8', calories: 144,
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
    description: "Mild and neutral with a tender, custardy bite, tofu soaks up whatever flavors you give it. It is a complete plant protein and, when set with calcium, one of the best plant sources of that mineral. Tofu has been made from curdled soy milk for more than 2,000 years.",
    serving: '100g'
  },
  {
    id: 'octopus', name: 'Octopus', nameKa: "რვაფეხა", emoji: '🐙', color: '#c97a8e', calories: 164,
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
    description: "Tender when cooked well, meaty, and subtly sweet, octopus is a prized delicacy worldwide. It is a very lean protein with an extraordinary amount of vitamin B12 and copper, which support the nerves and brain. Octopuses are famously intelligent, with three hearts and blue, copper-based blood.",
    serving: '100g'
  },
  {
    id: 'duck', name: 'Duck Breast', nameKa: "იხვის მკერდი", emoji: '🦆', color: '#8a4a3a', calories: 201,
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
    description: "Rich, indulgent, and deeply flavorful with a satisfying layer of fat, duck breast eats more like red meat than poultry. It is a good source of heme iron and immune-supporting zinc. Cooked well, the rendered fat crisps the skin while keeping the meat tender.",
    serving: '100g'
  },
  {
    id: 'hempseeds', name: 'Hemp Seeds', nameKa: "კანაფის თესლი", emoji: '🌱', color: '#b5b08a', calories: 553,
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
    description: "Soft, nutty, and mild, hemp seeds scatter a gentle crunch over almost anything. They are a complete plant protein with a near-ideal balance of omega-3 to omega-6 fats. Despite coming from the cannabis plant, hemp seeds contain virtually no THC.",
    serving: '100g'
  },
  {
    id: 'pumpkinseeds', name: 'Pumpkin Seeds', nameKa: "გოგრის თესლი", emoji: '🎃', color: '#c5d18a', calories: 559,
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
    description: "Crunchy, earthy, and nutty, pumpkin seeds are a satisfying handful with real staying power. They are among the richest food sources of magnesium, a mineral most people fall short on, plus plenty of zinc and iron. Roasting deepens their flavor, but raw seeds keep the most magnesium intact.",
    serving: '100g'
  },
  {
    id: 'beefliver', name: 'Beef Liver', nameKa: "საქონლის ღვიძლი", emoji: '🫀', color: '#6b3528', calories: 175,
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
    description: "Intense, rich, and minerally, beef liver is a bold, old-fashioned superfood. It is among the most nutrient-dense foods on earth, with staggering vitamin B12, copper, and vitamin A in a single serving. A small portion goes a long way, in flavor and in nutrition alike.",
    serving: '100g'
  },
  {
    id: 'mussels', name: 'Mussels', nameKa: "მიდია", emoji: '🦪', color: '#3a4a6b', calories: 172,
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
    description: "Briny, sweet, and tender, mussels taste of the sea and cook in the time it takes to steam them open. They are loaded with vitamin B12 and selenium and offer high protein for very few calories. Farmed mussels are also one of the most sustainable animal proteins, needing no feed at all.",
    serving: '100g'
  },
  {
    id: 'spirulina', name: 'Spirulina', nameKa: "სპირულინა", emoji: '🌀', color: '#1a6b5a', calories: 290,
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
    description: "Bold, earthy, and intensely savory, spirulina is a deep blue-green powder with serious nutritional density. It has the highest protein density of any food, around 57g per 100g, with a complete amino acid profile. Spirulina is not a plant at all but a microscopic cyanobacteria, one of the oldest life forms on earth.",
    serving: '100g'
  },
  {
    id: 'mango', name: 'Mango', nameKa: "მანგო", emoji: '🥭', color: '#f5a623', calories: 60,
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
    description: "Lush, fragrant, and dripping with tropical sweetness, ripe mango tastes like sunshine. It pairs high vitamin C with vitamin A and natural enzymes that aid digestion. Mango is the most widely eaten fruit on earth and has been cultivated for over 4,000 years.",
    serving: '100g'
  },
  {
    id: 'pineapple', name: 'Pineapple', nameKa: "ანანასი", emoji: '🍍', color: '#e8c84a', calories: 50,
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
    description: "Bright, tangy, and tropical with a sweetness that tingles, pineapple is impossible to ignore. It is rich in vitamin C and bromelain, an enzyme that breaks down protein and may ease inflammation. That same enzyme is why fresh pineapple makes your tongue tingle, it is gently digesting you back.",
    serving: '100g'
  },
  {
    id: 'strawberry', name: 'Strawberry', nameKa: "მარწყვი", emoji: '🍓', color: '#e63946', calories: 32,
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
    description: "Sweet, fragrant, and lightly tart, sun-ripe strawberries are one of summer's great pleasures. Ounce for ounce they are among the richest vitamin C sources of any fruit, with about 88mg per 100g. They are also the only fruit that wears its seeds on the outside, roughly 200 of them each.",
    descriptionKa: "ტკბილი, სურნელოვანი და ოდნავ მჟავე, მზეზე მომწიფებული მარწყვი ზაფხულის ერთ-ერთი სიამოვნებაა. ის C ვიტამინის ერთ-ერთი უმდიდრესი წყაროა ხილს შორის, 100 გრამზე დაახლოებით 88 მგ. ეს ერთადერთი ხილია, რომელსაც თესლი გარეთ აქვს, თითო ცალზე დაახლოებით 200.",
    serving: '100g'
  },
  {
    id: 'watermelon', name: 'Watermelon', nameKa: "საზამთრო", emoji: '🍉', color: '#f0506a', calories: 30,
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
    description: "Crisp, cooling, and dripping with refreshment, watermelon is the taste of a hot day. At roughly 92% water it hydrates beautifully while still delivering heart-friendly lycopene. It is both a fruit and a vegetable, and a relative of the cucumber.",
    serving: '100g'
  },
  {
    id: 'grapes', name: 'Grapes', nameKa: "ყურძენი", emoji: '🍇', color: '#6b3fa0', calories: 69,
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
    description: "Juicy and bite-sized with a sweet, slightly tart pop, grapes are effortless snacking. Their skins supply resveratrol, an antioxidant studied for heart and brain protection. Grapes are one of the oldest cultivated fruits on earth, grown for wine for more than 8,000 years.",
    serving: '100g'
  },
  {
    id: 'peach', name: 'Peach', nameKa: "ატამი", emoji: '🍑', color: '#f5b08a', calories: 39,
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
    description: "Soft, fragrant, and floral with sweet juice that runs down your chin, a ripe peach is pure summer. It is light in calories yet supplies vitamins C and A to support glowing skin. Peaches belong to the rose family, alongside apples, cherries, and almonds.",
    serving: '100g'
  },
  {
    id: 'pear', name: 'Pear', nameKa: "მსხალი", emoji: '🍐', color: '#c8d44a', calories: 57,
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
    description: "Delicately sweet with a tender, slightly grainy bite, pears are gentle and easy to enjoy. They are especially high in pectin, a soluble fiber that supports smooth digestion and gut health. Pears ripen from the inside out, which is why they can feel firm outside while perfectly ready within.",
    serving: '100g'
  },
  {
    id: 'orange', name: 'Orange', nameKa: "ფორთოხალი", emoji: '🍊', color: '#f5921e', calories: 47,
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
    description: "Bright, sweet, and classically citrusy, the orange is the fruit people reach for at the first sign of a cold. One delivers about 79mg of vitamin C to fuel the immune system, plus folate and fiber. Oranges are technically a type of berry, and most turn sweeter after a cool night.",
    descriptionKa: "კაშკაშა, ტკბილი და კლასიკურად ციტრუსოვანი, ფორთოხალი პირველი არჩევანია გაციების დროს. ერთი ფორთოხალი დაახლოებით 79 მგ C ვიტამინს იძლევა იმუნიტეტისთვის, ასევე ფოლიუმის მჟავასა და ბოჭკოს. ბოტანიკურად ფორთოხალი კენკრის სახეობაა.",
    serving: '100g'
  },
  {
    id: 'pomegranate', name: 'Pomegranate', nameKa: "ბროწეული", emoji: '🔴', color: '#b71c2b', calories: 83,
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
    description: "Sweet-tart and jewel-like, pomegranate arils burst with crisp juice and a satisfying crunch. They are loaded with punicalagins, among the most powerful antioxidants found in any food. A single fruit can hold more than 600 of these ruby seeds.",
    serving: '100g'
  },
  {
    id: 'cherry', name: 'Cherry', nameKa: "ბალი", emoji: '🍒', color: '#9b1c31', calories: 63,
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
    description: "Deeply sweet with a hint of tartness, cherries are small, glossy, and hard to stop eating. They are one of the few natural sources of melatonin, the hormone that helps regulate sleep, alongside anti-inflammatory anthocyanins. Sweet and sour cherries are actually different species, bred for snacking or for baking.",
    serving: '100g'
  },
  {
    id: 'papaya', name: 'Papaya', nameKa: "პაპაია", emoji: '🟠', color: '#f5832a', calories: 43,
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
    description: "Soft, buttery, and tropical with a mellow musky sweetness, papaya melts in the mouth. It carries the enzyme papain, which helps break down protein, plus a full day's worth of vitamin C. Papaya plants can fruit within a year of planting, unusually fast for a tropical fruit.",
    serving: '100g'
  },
  {
    id: 'fig', name: 'Fig', nameKa: "ლეღვი", emoji: '🟣', color: '#7a4a8c', calories: 74,
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
    description: "Honey-sweet and jammy with a soft, seedy crunch, fresh figs taste almost like dessert. They are a good source of fiber and minerals that support bone health. Figs are one of the oldest cultivated fruits, grown around the Mediterranean for thousands of years.",
    serving: '100g'
  },
  {
    id: 'raspberries', name: 'Raspberries', nameKa: "ჟოლო", emoji: '🔴', color: '#d11e4a', calories: 52,
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
    description: "Intensely flavored, sweet, and tart with a tender, hollow center, raspberries feel like a small luxury. They are one of the highest-fiber fruits you can eat, with 6.5g per 100g, yet they stay low in sugar. Each berry is actually a cluster of tiny fruitlets called drupelets.",
    serving: '100g'
  },
  {
    id: 'blackberries', name: 'Blackberries', nameKa: "მაყვალი", emoji: '⚫', color: '#2e1a3a', calories: 43,
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
    description: "Dark, plump, and richly sweet with an earthy tartness, blackberries stain your fingers and your memory. They deliver plenty of fiber along with vitamin K for bone health and anthocyanins for the brain. Blackberries are not true berries botanically, they are aggregates of many tiny drupelets.",
    serving: '100g'
  },
  {
    id: 'apricot', name: 'Apricot', nameKa: "გარგარი", emoji: '🟧', color: '#f0a04a', calories: 48,
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
    description: "Velvety-skinned and gently sweet with a soft, floral tartness, apricots are a delicate late-summer treat. They are exceptionally rich in beta-carotene, which the body turns into vision-supporting vitamin A. Apricots are kin to peaches and plums, and their kernels lend amaretto its almond flavor.",
    serving: '100g'
  },
  {
    id: 'plum', name: 'Plum', nameKa: "ქლიავი", emoji: '🟪', color: '#5e2a6b', calories: 46,
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
    description: "Juicy and richly sweet with a tart skin that snaps as you bite, plums are refreshing and a little bold. They contain sorbitol, a natural compound that gently supports digestion, plus bone-friendly vitamin K. Dried into prunes, the very same fruit becomes a classic remedy for regularity.",
    serving: '100g'
  },
  {
    id: 'lychee', name: 'Lychee', nameKa: "ლიჩი", emoji: '🌸', color: '#f06a8a', calories: 66,
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
    description: "Floral and perfumed with a sweet, grape-like juiciness, lychee is a fragrant gem beneath a bumpy red shell. It is remarkably high in vitamin C, offering more in a serving than an orange provides. Lychee has been prized in China for over 2,000 years, once rushed to emperors by horseback.",
    serving: '100g'
  },
  {
    id: 'passionfruit', name: 'Passion Fruit', nameKa: "გრენადილა", emoji: '🟣', color: '#6b2a8c', calories: 97,
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
    description: "Intensely tart and aromatic with crunchy edible seeds, passion fruit packs a tropical punch in a small shell. It is one of the highest-fiber fruits around, at over 10g per 100g, and contains compounds with calming, sleep-supporting effects. The fruit grows on a dramatic flowering vine whose blooms can open and close in a single day.",
    serving: '100g'
  },
  {
    id: 'coconut', name: 'Coconut', nameKa: "ქოქოსი", emoji: '🥥', color: '#d8c8a8', calories: 354,
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
    description: "Rich, nutty, and subtly sweet, fresh coconut is creamy and satisfying. It is high in fiber and supplies MCT fats, which the body can quickly turn into energy. Botanically a coconut is a drupe, not a nut, and a single one can float across oceans to take root on a new shore.",
    serving: '100g'
  },
  {
    id: 'dragonfruit', name: 'Dragon Fruit', nameKa: "დრაკონის ხილი", emoji: '🐉', color: '#e84a8c', calories: 60,
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
    description: "Mildly sweet and refreshing with a texture like soft kiwi, dragon fruit is as gentle on the palate as it is striking to look at. Its tiny black seeds add prebiotic fiber for gut health, while betalain pigments fight inflammation. It grows on a climbing cactus whose flowers bloom only at night.",
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
  const existingUser = db
    ? await dbFindUserByEmail(emailNorm)
    : readJSON(USERS_FILE).find(u => u.email.toLowerCase() === emailNorm);
  if (existingUser) {
    return res.status(409).json({ error: 'An account with this email already exists', code: 'EMAIL_EXISTS' });
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
  if (!pending) return res.status(400).json({ error: 'No pending verification — please start again.', code: 'NO_PENDING' });
  if (Date.now() > pending.expiresAt) {
    pendingVerifications.delete(emailNorm);
    return res.status(400).json({ error: 'Code expired — please request a new one.', code: 'CODE_EXPIRED' });
  }
  if (String(code).trim() !== pending.code) return res.status(400).json({ error: 'Incorrect code — please try again.', code: 'CODE_INCORRECT' });

  const existingCheck = db
    ? await dbFindUserByEmail(emailNorm)
    : readJSON(USERS_FILE).find(u => u.email.toLowerCase() === emailNorm);
  if (existingCheck) {
    pendingVerifications.delete(emailNorm);
    return res.status(409).json({ error: 'An account with this email already exists', code: 'EMAIL_EXISTS' });
  }
  const user = {
    id: uuidv4(), email: emailNorm, password: pending.passwordHash, name: pending.name,
    age: null, weight: null, height: null, gender: null, goal: 'maintain',
    emailVerified: true, plan: 'free', createdAt: new Date().toISOString(),
  };
  if (db) await dbInsertUser(user);
  const users = readJSON(USERS_FILE);
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

  const emailNorm = String(email).trim().toLowerCase();
  const existingUser = db
    ? await dbFindUserByEmail(emailNorm)
    : readJSON(USERS_FILE).find(u => u.email.toLowerCase() === emailNorm);
  if (existingUser) {
    return res.status(409).json({ error: 'An account with this email already exists', code: 'EMAIL_EXISTS' });
  }
  const user = {
    id: uuidv4(),
    email: emailNorm,
    password: await bcrypt.hash(String(password), 10),
    name: String(name).trim(),
    age: age ? Number(age) : null,
    weight: weight ? Number(weight) : null,
    height: null,
    gender: null,
    goal: goal || 'maintain',
    createdAt: new Date().toISOString(),
  };
  if (db) await dbInsertUser(user);
  const users = readJSON(USERS_FILE);
  users.push(user);
  writeJSON(USERS_FILE, users);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required', code: 'VALIDATION_ERROR' });
  const emailLower = String(email).trim().toLowerCase();
  const user = db
    ? await dbFindUserByEmail(emailLower)
    : readJSON(USERS_FILE).find(u => u.email.toLowerCase() === emailLower);
  const passwordMatch = user ? await bcrypt.compare(String(password), user.password) : false;
  if (!user || !passwordMatch) {
    return res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: publicUser(user) });
});

// i18n: detect a sensible default language from the Accept-Language header
// (used by the client on first visit when no preference is stored yet).
app.get('/api/i18n/detect', (req, res) => {
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  const prefersKa = al.split(',').some(part => part.trim().startsWith('ka'));
  res.json({ lang: prefersKa ? 'ka' : 'en', acceptLanguage: al || null });
});

app.get('/api/profile', auth, (req, res) => {
  res.json({ user: publicUser(req.user), calories: calcCalories(req.user) });
});

app.put('/api/profile', auth, async (req, res) => {
  const { name, age, weight, currentWeight, targetWeight, height, gender, goal, timeline, activityLevel, language } = req.body || {};
  const u = Object.assign({}, req.user);
  delete u._id; delete u.__v;
  if (name != null) u.name = String(name).trim();
  if (language != null && ['en', 'ka'].includes(String(language))) u.language = String(language);
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
  if (db) await dbUpdateUser(req.userId, u);
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u2 => u2.id === req.userId);
  if (idx !== -1) { users[idx] = u; writeJSON(USERS_FILE, users); }
  res.json({ user: publicUser(u), calories: calcCalories(u) });
});

// ─── PROFILE STATS ────────────────────────────────────────────────────────
app.get('/api/profile/stats', auth, (req, res) => {
  const user = req.user;
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

  return `You are NutriAI, the nutrition education assistant inside NutriFell — an educational platform for healthy adults aged 18 and over.
Give specific, accurate, encouraging guidance grounded ONLY in the data below.

CRITICAL SAFETY RULES (non-negotiable):
1. You are an EDUCATIONAL nutrition assistant ONLY. Never provide clinical or medical advice.
2. Use ONLY the numbers provided here. NEVER invent or estimate calories, macros, or nutrient values you were not given. If a food's data is not below, say you don't have verified data for it.
3. If a profile field you need is missing, ask the user for it instead of guessing. Currently missing: ${missing.length ? missing.join(', ') : 'none'}.
4. Suggest meals FRIDGE-FIRST. You may add 1-2 catalog items to complete a meal, but label them "to buy".
5. Attach calories and macros (and gram portions) to every meal you suggest, and keep the day within the calorie target.
6. If the user mentions ANY medical condition, disease, medication, eating disorder, pregnancy, or surgery: immediately recommend they consult a doctor or registered dietitian. Do not provide tailored advice for medical conditions.
7. Never recommend stopping or changing medications. Never suggest specific treatments for medical conditions.
8. If the user seems distressed about food, eating, or body image, respond with empathy and recommend professional support.
9. Always add a brief disclaimer when discussing medical topics: remind the user this is educational information, not medical advice.
10. Be concise and practical: short paragraphs or tight bullet lists.

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

app.get('/api/recipes', async (req, res) => {
  const recipes = await sGetAllRecipes();
  const reactions = await sGetRecipeReactions();
  const comments = await sGetRecipeComments();
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

app.get('/api/recipes/:id', async (req, res) => {
  const r = await sGetRecipeById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  const decorated = decorateRecipe(r, await sGetRecipeReactions(), await sGetRecipeComments());
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
      await sInsertRecipe(recipe);
      res.status(201).json(recipe);
    } catch (err) {
      console.error('Recipe create error:', err.message);
      res.status(500).json({ error: 'Could not save recipe. Please try again.' });
    }
  });
});

app.put('/api/recipes/:id', auth, async (req, res) => {
  const r = await sGetRecipeById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  if (r.userId !== req.userId) return res.status(403).json({ error: 'Not your recipe' });
  const b = req.body || {};
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
  await sUpdateRecipe(r.id, r);
  res.json(r);
});

app.delete('/api/recipes/:id', auth, async (req, res) => {
  const r = await sGetRecipeById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  if (r.userId !== req.userId) return res.status(403).json({ error: 'Not your recipe' });
  await sDeleteRecipe(req.params.id); // cascades comments/reactions/bookmarks (db + JSON)
  // remove this recipe's photo files (best-effort)
  (r.photos || []).forEach(p => { try { fs.unlinkSync(path.join(__dirname, 'public', p)); } catch {} });
  res.json({ success: true });
});

// Toggle a reaction (one emoji per user per recipe; re-posting the same emoji removes it)
app.post('/api/recipes/:id/react', auth, async (req, res) => {
  const emoji = (req.body && req.body.emoji) || '';
  if (!REACTION_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction' });
  const next = await sToggleRecipeReaction(req.params.id, req.userId, emoji);
  const counts = {}; REACTION_EMOJIS.forEach(e => counts[e] = 0);
  next.filter(x => x.recipeId === req.params.id).forEach(x => { if (counts[x.emoji] != null) counts[x.emoji]++; });
  const myReaction = next.find(x => x.recipeId === req.params.id && x.userId === req.userId);
  res.json({ counts, total: Object.values(counts).reduce((a, c) => a + c, 0), mine: myReaction ? myReaction.emoji : null });
});

app.post('/api/recipes/:id/rate', auth, async (req, res) => {
  const value = Math.round(Number(req.body && req.body.value));
  if (!(value >= 1 && value <= 5)) return res.status(400).json({ error: 'Rating must be 1–5' });
  const r = await sGetRecipeById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  r.ratings = r.ratings || [];
  const mine = r.ratings.find(x => x.userId === req.userId);
  if (mine) mine.value = value; else r.ratings.push({ userId: req.userId, value });
  await sUpdateRecipe(r.id, r);
  const avg = +(r.ratings.reduce((s, x) => s + x.value, 0) / r.ratings.length).toFixed(1);
  res.json({ avgRating: avg, ratingCount: r.ratings.length, mine: value });
});

app.post('/api/recipes/:id/bookmark', auth, async (req, res) => {
  const bookmarked = await sToggleBookmark(req.userId, req.params.id);
  res.json({ bookmarked });
});

app.get('/api/bookmarks', auth, async (req, res) => {
  const ids = (await sGetBookmarks(b => b.userId === req.userId)).map(b => b.recipeId);
  res.json(ids);
});

app.post('/api/recipes/:id/report', auth, async (req, res) => {
  await sInsertRecipeReport({ id: uuidv4(), recipeId: req.params.id, userId: req.userId,
    reason: (req.body && String(req.body.reason || '').slice(0, 500)) || 'Unspecified', at: new Date().toISOString() });
  res.json({ success: true, message: 'Thanks — our team will review this recipe.' });
});

// ── Comments (threaded one level) ──
async function shapeComments(recipeId) {
  const all = (await sGetRecipeComments()).filter(c => c.recipeId === recipeId);
  const roots = all.filter(c => !c.parentId).sort((a, b) => b.at.localeCompare(a.at));
  return roots.map(c => ({
    ...c, likeCount: (c.likes || []).length,
    replies: all.filter(r => r.parentId === c.id).sort((a, b) => a.at.localeCompare(b.at))
      .map(r => ({ ...r, likeCount: (r.likes || []).length })),
  }));
}

app.get('/api/recipes/:id/comments', async (req, res) => res.json(await shapeComments(req.params.id)));

app.post('/api/recipes/:id/comments', auth, async (req, res) => {
  const text = req.body && String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const comment = { id: uuidv4(), recipeId: req.params.id, userId: req.userId,
    authorName: (user && user.name) || 'NutriFell User', text: text.slice(0, 2000),
    parentId: null, likes: [], at: new Date().toISOString() };
  await sInsertRecipeComment(comment);
  res.status(201).json(comment);
});

app.post('/api/recipes/:id/comments/:cid/reply', auth, async (req, res) => {
  const text = req.body && String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Reply cannot be empty' });
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const parent = await sGetRecipeCommentById(req.params.cid);
  if (!parent) return res.status(404).json({ error: 'Comment not found' });
  const reply = { id: uuidv4(), recipeId: req.params.id, userId: req.userId,
    authorName: (user && user.name) || 'NutriFell User', text: text.slice(0, 2000),
    parentId: parent.parentId || parent.id, likes: [], at: new Date().toISOString() };
  await sInsertRecipeComment(reply);
  res.status(201).json(reply);
});

app.post('/api/recipes/:id/comments/:cid/like', auth, async (req, res) => {
  const out = await sToggleRecipeCommentLike(req.params.cid, req.userId);
  if (!out) return res.status(404).json({ error: 'Comment not found' });
  res.json(out);
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
  const r = await sGetRecipeById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recipe not found' });
  if (r.aiAnalysis) return res.json(r.aiAnalysis); // cached

  const persist = (analysis) => {
    r.aiAnalysis = analysis;
    sUpdateRecipe(r.id, r).catch(e => console.error('ai-analysis persist:', e.message));
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
// ─── Phase 2a: Posts helpers (MySQL with JSON fallback) ──────────────────────
// Safely parse a value that may be a JSON string or an already-parsed object.
const parseJ = (s, def) => {
  if (s === null || s === undefined) return def;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return def; }
};

// Build a canonical post object from a MySQL JOIN row.
// MySQL schema uses different column names (mediaUrls, viewCount, etc.) than the
// JSON files (photos, views, etc.). rowToPost maps them back so all downstream
// code (decoratePost, rankings, API responses) continues to work unchanged.
function rowToPost(r) {
  let authorUsername = '@nutrifell';
  if (r._username) {
    authorUsername = '@' + String(r._username).replace(/^@/, '');
  } else {
    const base = (r._name || (r._email || '').split('@')[0] || 'user')
      .toLowerCase().replace(/[^a-z0-9]+/g, '');
    authorUsername = '@' + (base || 'user');
  }
  return {
    id: r.id, userId: r.userId,
    authorName: r._name || 'NutriFell User',
    authorUsername,
    authorAvatar: r._avatar || null,
    type: r.type || 'text',
    caption: r.caption || '',
    photos: parseJ(r.mediaUrls, []),
    video: r.videoUrl || null,
    videoThumb: r.videoThumb || null,
    recipe: parseJ(r.recipe, null),
    hashtags: parseJ(r.hashtags, []),
    foodTags: parseJ(r.taggedFoods, []),
    location: r.location || '',
    views: r.viewCount || 0,
    createdAt: r.createdAt || new Date().toISOString(),
  };
}

// The SELECT used for all post reads — joins users so author fields are fresh.
const POST_SELECT_SQL = `
  SELECT p.id, p.userId, p.type, p.caption, p.mediaUrls, p.videoUrl, p.videoThumb,
         p.recipe, p.hashtags, p.taggedFoods, p.location, p.viewCount, p.score, p.createdAt,
         u.name AS _name, u.username AS _username, u.email AS _email, u.avatar AS _avatar
  FROM \`posts\` p
  LEFT JOIN \`users\` u ON u.id = p.userId
`;

async function sGetAllPosts() {
  if (!db) return readJSON(POSTS_FILE);
  const [rows] = await db.execute(POST_SELECT_SQL + ' ORDER BY p.createdAt DESC');
  return rows.map(rowToPost);
}

async function sGetPostById(id) {
  if (!db) return readJSON(POSTS_FILE).find(p => p.id === id) || null;
  const [rows] = await db.execute(POST_SELECT_SQL + ' WHERE p.id = ?', [id]);
  return rows[0] ? rowToPost(rows[0]) : null;
}

async function sInsertPost(post) {
  if (db) {
    await db.execute(
      'INSERT INTO `posts` (`id`,`userId`,`type`,`caption`,`mediaUrls`,`videoUrl`,`videoThumb`,`recipe`,`hashtags`,`taggedFoods`,`location`,`viewCount`,`createdAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [post.id, post.userId, post.type || 'text', post.caption || null,
       JSON.stringify(post.photos || []), post.video || null, post.videoThumb || null,
       post.recipe ? JSON.stringify(post.recipe) : null,
       JSON.stringify(post.hashtags || []), JSON.stringify(post.foodTags || []),
       post.location || null, post.views || 0,
       post.createdAt || new Date().toISOString()]
    );
  }
  // Dual-write: keep JSON file in sync for non-migrated endpoints (delete, view, react…)
  const all = readJSON(POSTS_FILE);
  all.unshift(post);
  writeJSON(POSTS_FILE, all);
}

// ─── Phase 2b: Reactions & Comments helpers (MySQL with JSON dual-write) ─────
// Convert a MySQL post_comments row (with user JOIN) to the JSON-compatible shape.
function rowToComment(r) {
  return {
    id: r.id, postId: r.postId, userId: r.userId,
    authorName: r._name || 'NutriFell User',
    authorAvatar: r._avatar || null,
    text: r.text || '',
    parentId: r.parentId || null,
    likes: parseJ(r.likes, []),
    at: r.createdAt || new Date().toISOString(),
  };
}

// Read comments for a post, shaped into roots+replies (MySQL → falls back to JSON).
async function sGetPostCommentsShaped(postId) {
  if (!db) return shapePostComments(postId);
  const [rows] = await db.execute(`
    SELECT c.id, c.postId, c.userId, c.parentId, c.text, c.likes, c.createdAt,
           u.name AS _name, u.avatar AS _avatar
    FROM \`post_comments\` c
    LEFT JOIN \`users\` u ON u.id = c.userId
    WHERE c.postId = ?
    ORDER BY c.createdAt ASC
  `, [postId]);
  const all = rows.map(rowToComment);
  const roots = all.filter(c => !c.parentId).sort((a, b) => b.at.localeCompare(a.at));
  return roots.map(c => ({
    ...c, likeCount: c.likes.length,
    replies: all.filter(r => r.parentId === c.id)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(r => ({ ...r, likeCount: r.likes.length })),
  }));
}

// Fetch a single comment by id (MySQL → JSON fallback).
async function sGetCommentById(id) {
  if (!db) return readJSON(POST_COMMENTS_FILE).find(c => c.id === id) || null;
  const [rows] = await db.execute(
    'SELECT c.*, u.name AS _name, u.avatar AS _avatar FROM `post_comments` c LEFT JOIN `users` u ON u.id = c.userId WHERE c.id = ?',
    [id]
  );
  return rows[0] ? rowToComment(rows[0]) : null;
}

// Insert a comment into MySQL and dual-write to the JSON file.
async function sInsertComment(comment) {
  if (db) {
    await db.execute(
      'INSERT INTO `post_comments` (`id`,`postId`,`userId`,`parentId`,`text`,`likes`,`createdAt`) VALUES (?,?,?,?,?,?,?)',
      [comment.id, comment.postId, comment.userId, comment.parentId || null,
       comment.text, JSON.stringify(comment.likes || []), comment.at || new Date().toISOString()]
    );
  }
  const all = readJSON(POST_COMMENTS_FILE);
  all.push(comment);
  writeJSON(POST_COMMENTS_FILE, all);
}

// Toggle a like on a comment; dual-writes JSON; returns { likeCount, liked }.
async function sToggleCommentLike(id, userId) {
  if (db) {
    const [rows] = await db.execute('SELECT `likes` FROM `post_comments` WHERE `id` = ?', [id]);
    if (!rows[0]) return null;
    const likes = parseJ(rows[0].likes, []);
    const i = likes.indexOf(userId);
    if (i === -1) likes.push(userId); else likes.splice(i, 1);
    await db.execute('UPDATE `post_comments` SET `likes` = ? WHERE `id` = ?', [JSON.stringify(likes), id]);
    const all = readJSON(POST_COMMENTS_FILE);
    const c = all.find(x => x.id === id);
    if (c) { c.likes = likes; writeJSON(POST_COMMENTS_FILE, all); }
    return { likeCount: likes.length, liked: i === -1 };
  }
  const all = readJSON(POST_COMMENTS_FILE);
  const c = all.find(x => x.id === id);
  if (!c) return null;
  c.likes = c.likes || [];
  const i = c.likes.indexOf(userId);
  if (i === -1) c.likes.push(userId); else c.likes.splice(i, 1);
  writeJSON(POST_COMMENTS_FILE, all);
  return { likeCount: c.likes.length, liked: i === -1 };
}

// Count all comments (including replies) for a post.
async function sCountPostComments(postId) {
  if (!db) return readJSON(POST_COMMENTS_FILE).filter(c => c.postId === postId).length;
  const [[{ cnt }]] = await db.execute('SELECT COUNT(*) AS cnt FROM `post_comments` WHERE `postId` = ?', [postId]);
  return cnt;
}

// ─── Phase 2c: Follows helpers (MySQL with JSON dual-write) ──────────────────
// Toggle follow in MySQL + dual-write JSON. Returns { following, followerCount }.
async function sToggleFollow(followerId, followingId) {
  let following;
  if (db) {
    const [ex] = await db.execute(
      'SELECT `id` FROM `follows` WHERE `followerId` = ? AND `followingId` = ?', [followerId, followingId]
    );
    if (ex[0]) {
      await db.execute('DELETE FROM `follows` WHERE `followerId` = ? AND `followingId` = ?', [followerId, followingId]);
      following = false;
    } else {
      await db.execute(
        'INSERT INTO `follows` (`id`,`followerId`,`followingId`) VALUES (?,?,?)', [uuidv4(), followerId, followingId]
      );
      following = true;
    }
  }
  // Dual-write JSON
  const all = readJSON(FOLLOWS_FILE);
  const mine = all.find(f => f.followerId === followerId && f.followingId === followingId);
  let next = all;
  if (mine) { next = all.filter(f => f !== mine); following = false; }
  else { next.push({ followerId, followingId, at: new Date().toISOString() }); following = true; }
  writeJSON(FOLLOWS_FILE, next);
  let followerCount;
  if (db) {
    const [[{ cnt }]] = await db.execute('SELECT COUNT(*) AS cnt FROM `follows` WHERE `followingId` = ?', [followingId]);
    followerCount = cnt;
  } else {
    followerCount = next.filter(f => f.followingId === followingId).length;
  }
  return { following, followerCount };
}

// Get all follows from MySQL (or JSON), applying an in-memory filter function.
async function sGetFollows(filter) {
  if (!db) return readJSON(FOLLOWS_FILE).filter(filter);
  const [rows] = await db.execute('SELECT `followerId`, `followingId`, `createdAt` AS at FROM `follows`');
  return rows.filter(filter);
}

// ─── Phase 2c: Notifications helpers (MySQL with JSON dual-write) ─────────────
// Convert a MySQL notifications row back to the JSON-compatible shape.
function rowToNotification(r) {
  return {
    id: r.id, type: r.type,
    toUserId: r.userId,
    fromUserId: r.actorId || null,
    postId: r.postId || null,
    text: r.text || '',
    read: !!r.read,
    at: r.createdAt || new Date().toISOString(),
    fromName: null, fromAvatar: null,
  };
}

// Read paginated notifications for a user from MySQL (or JSON fallback).
async function sGetNotifications(userId, filter, page, perPage) {
  if (!db) {
    let list = readJSON(NOTIFICATIONS_FILE).filter(n => n.toUserId === userId);
    const unread = list.filter(n => !n.read).length;
    if (filter && NOTIF_GROUPS[filter]) list = list.filter(n => NOTIF_GROUPS[filter].includes(n.type));
    const total = list.length;
    const start = (page - 1) * perPage;
    return { items: list.slice(start, start + perPage), total, unread };
  }
  let sql = 'SELECT * FROM `notifications` WHERE `userId` = ?';
  const params = [userId];
  if (filter && NOTIF_GROUPS[filter]) {
    sql += ' AND `type` IN (' + NOTIF_GROUPS[filter].map(() => '?').join(',') + ')';
    params.push(...NOTIF_GROUPS[filter]);
  }
  const [[{ total }]] = await db.execute(
    'SELECT COUNT(*) AS total FROM `notifications` WHERE `userId` = ?', [userId]
  );
  const [[{ unread }]] = await db.execute(
    'SELECT COUNT(*) AS unread FROM `notifications` WHERE `userId` = ? AND `read` = 0', [userId]
  );
  sql += ' ORDER BY `createdAt` DESC LIMIT ? OFFSET ?';
  params.push(perPage, (page - 1) * perPage);
  const [rows] = await db.execute(sql, params);
  return { items: rows.map(rowToNotification), total, unread };
}

// Count unread notifications for a user.
async function sCountUnreadNotifications(userId) {
  if (!db) return readJSON(NOTIFICATIONS_FILE).filter(n => n.toUserId === userId && !n.read).length;
  const [[{ cnt }]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM `notifications` WHERE `userId` = ? AND `read` = 0', [userId]
  );
  return cnt;
}

// Mark all notifications read for a user in MySQL + dual-write JSON.
async function sMarkAllNotificationsRead(userId) {
  if (db) {
    await db.execute('UPDATE `notifications` SET `read` = 1 WHERE `userId` = ?', [userId]);
  }
  const all = readJSON(NOTIFICATIONS_FILE);
  all.forEach(n => { if (n.toUserId === userId) n.read = true; });
  writeJSON(NOTIFICATIONS_FILE, all);
}

// ─── Phase 2d: Conversations & Messages helpers ───────────────────────────────
function rowToConvo(r) {
  return {
    id: r.id,
    participants: [r.participant1, r.participant2],
    participant1: r.participant1, participant2: r.participant2,
    lastMessage: parseJ(r.lastMessage, null),
    lastMessageAt: r.lastMessageAt || r.createdAt,
    createdAt: r.createdAt,
  };
}

function rowToMessage(r) {
  return {
    id: r.id, conversationId: r.conversationId,
    fromUserId: r.senderId, toUserId: r.receiverId,
    text: r.text || '', attachment: null,
    read: !!r.read, at: r.createdAt,
  };
}

// Find an existing 1:1 conversation by participant pair (order-independent).
async function sGetConversation(userId1, userId2) {
  const [p1, p2] = [userId1, userId2].sort();
  if (!db) return findConversation(readJSON(CONVERSATIONS_FILE), userId1, userId2) || null;
  const [rows] = await db.execute(
    'SELECT * FROM `conversations` WHERE `participant1`=? AND `participant2`=?', [p1, p2]
  );
  return rows[0] ? rowToConvo(rows[0]) : null;
}

// Find-or-create a 1:1 conversation, dual-writing JSON.
async function sGetOrCreateConversation(userId1, userId2) {
  const [p1, p2] = [userId1, userId2].sort();
  const now = new Date().toISOString();
  if (db) {
    const [rows] = await db.execute(
      'SELECT * FROM `conversations` WHERE `participant1`=? AND `participant2`=?', [p1, p2]
    );
    if (rows[0]) return rowToConvo(rows[0]);
    const id = uuidv4();
    await db.execute(
      'INSERT INTO `conversations` (`id`,`participant1`,`participant2`,`createdAt`) VALUES (?,?,?,?)',
      [id, p1, p2, now]
    );
    const all = readJSON(CONVERSATIONS_FILE);
    if (!findConversation(all, userId1, userId2)) {
      all.unshift({ id, participants: [userId1, userId2], createdAt: now, lastMessageAt: now, lastMessage: null });
      writeJSON(CONVERSATIONS_FILE, all);
    }
    return { id, participants: [userId1, userId2], participant1: p1, participant2: p2, lastMessage: null, lastMessageAt: now, createdAt: now };
  }
  const all = readJSON(CONVERSATIONS_FILE);
  let convo = findConversation(all, userId1, userId2);
  if (!convo) {
    convo = { id: uuidv4(), participants: [userId1, userId2], createdAt: now, lastMessageAt: now, lastMessage: null };
    all.unshift(convo);
    writeJSON(CONVERSATIONS_FILE, all);
  }
  return convo;
}

// List all conversations for a user with unread counts.
async function sGetUserConversations(userId) {
  if (!db) {
    const convos = readJSON(CONVERSATIONS_FILE).filter(c => c.participants.includes(userId));
    const messages = readJSON(MESSAGES_FILE);
    return convos.map(c => ({
      ...c, unreadCount: messages.filter(m => m.conversationId === c.id && m.fromUserId !== userId && !m.read).length,
    }));
  }
  const [rows] = await db.execute(
    'SELECT * FROM `conversations` WHERE `participant1`=? OR `participant2`=? ORDER BY `lastMessageAt` DESC',
    [userId, userId]
  );
  if (!rows.length) return [];
  const convoIds = rows.map(r => r.id);
  const [unreadRows] = await db.execute(
    `SELECT \`conversationId\`, COUNT(*) AS cnt FROM \`messages\` WHERE \`conversationId\` IN (${convoIds.map(() => '?').join(',')}) AND \`receiverId\`=? AND \`read\`=0 GROUP BY \`conversationId\``,
    [...convoIds, userId]
  );
  const unreadMap = Object.fromEntries(unreadRows.map(r => [r.conversationId, r.cnt]));
  return rows.map(r => ({ ...rowToConvo(r), unreadCount: unreadMap[r.id] || 0 }));
}

// Paginated messages for a conversation (last N, oldest-first within that page).
async function sGetConversationMessages(convoId, before, perPage) {
  if (!db) {
    let msgs = readJSON(MESSAGES_FILE).filter(m => m.conversationId === convoId);
    msgs.sort((a, b) => a.at.localeCompare(b.at));
    if (before) msgs = msgs.filter(m => m.at < before);
    return { messages: msgs.slice(-perPage), total: msgs.length };
  }
  let sql = 'SELECT * FROM `messages` WHERE `conversationId`=?';
  const params = [convoId];
  if (before) { sql += ' AND `createdAt` < ?'; params.push(before); }
  sql += ' ORDER BY `createdAt` ASC';
  const [rows] = await db.execute(sql, params);
  const all = rows.map(rowToMessage);
  return { messages: all.slice(-perPage), total: all.length };
}

// Send a message: MySQL insert + update conversation + dual-write JSON + RT push.
async function sSendMessage(convo, senderId, receiverId, text, attachment) {
  const clean = String(text || '').trim().slice(0, 2000);
  let att = null;
  if (attachment && (attachment.kind === 'post' || attachment.kind === 'reel') && attachment.postId) {
    att = { kind: attachment.kind, postId: String(attachment.postId) };
  }
  if (!clean && !att) throw new Error('Write a message.');
  const now = new Date().toISOString();
  const msgId = uuidv4();
  if (db) {
    await db.execute(
      'INSERT INTO `messages` (`id`,`conversationId`,`senderId`,`receiverId`,`text`,`read`,`createdAt`) VALUES (?,?,?,?,?,?,?)',
      [msgId, convo.id, senderId, receiverId, clean, 0, now]
    );
    await db.execute('UPDATE `conversations` SET `lastMessage`=?, `lastMessageAt`=? WHERE `id`=?',
      [clean, now, convo.id]);
  }
  // Dual-write JSON (keeps /api/conversations endpoints in sync)
  const msg = { id: msgId, conversationId: convo.id, fromUserId: senderId, text: clean, attachment: att, read: false, at: now };
  const messages = readJSON(MESSAGES_FILE);
  messages.push(msg);
  writeJSON(MESSAGES_FILE, messages);
  const convos = readJSON(CONVERSATIONS_FILE);
  const c = convos.find(x => x.id === convo.id);
  if (c) { c.lastMessage = { text: clean || 'Shared a post', fromUserId: senderId, at: now }; c.lastMessageAt = now; writeJSON(CONVERSATIONS_FILE, convos); }
  const enriched = enrichMessageAttachment(msg, readJSON(POSTS_FILE));
  RT.toUser(receiverId, 'dm:receive', { conversationId: convo.id, from: senderId, message: enriched });
  return enriched;
}

// Mark messages from other party as read in MySQL + dual-write JSON.
async function sMarkConversationRead(convoId, readerId) {
  const now = new Date().toISOString();
  if (db) {
    await db.execute(
      'UPDATE `messages` SET `read`=1, `readAt`=? WHERE `conversationId`=? AND `receiverId`=? AND `read`=0',
      [now, convoId, readerId]
    );
  }
  const messages = readJSON(MESSAGES_FILE);
  let changed = false;
  messages.forEach(m => { if (m.conversationId === convoId && m.fromUserId !== readerId && !m.read) { m.read = true; changed = true; } });
  if (changed) writeJSON(MESSAGES_FILE, messages);
}

// Total unread DMs for a user (the nav badge).
async function sGetUnreadMessageCount(userId) {
  if (!db) {
    const convoIds = new Set(readJSON(CONVERSATIONS_FILE).filter(c => c.participants.includes(userId)).map(c => c.id));
    return readJSON(MESSAGES_FILE).filter(m => convoIds.has(m.conversationId) && m.fromUserId !== userId && !m.read).length;
  }
  const [[{ cnt }]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM `messages` WHERE `receiverId`=? AND `read`=0', [userId]
  );
  return cnt;
}

// ─── Phase 2d: Stories helpers ────────────────────────────────────────────────
// Convert a MySQL stories row to the JSON-compatible shape.
function rowToStory(r) {
  return {
    id: r.id, userId: r.userId,
    type: r.mediaType === 'video' ? 'video' : 'image',
    media: r.mediaUrl,
    caption: r.caption || '',
    viewers: parseJ(r.viewers, []),
    createdAt: r.createdAt || new Date().toISOString(),
    expiresAt: r.expiresAt || new Date().toISOString(),
  };
}

// ─── Phase 2e helpers: recipes + recipe comments/reactions/reports, bookmarks,
//     post_saves, post_reports, hashtag_follows. Each is "MySQL if db, else JSON"
//     and dual-writes JSON on mutation so direct-JSON readers stay in sync. ─────

// Convert a MySQL recipes row (JSON columns) back to the app's recipe object.
function rowToRecipe(r) {
  return {
    id: r.id, userId: r.userId, authorName: r.authorName || 'NutriFell Chef',
    name: r.name, category: r.category, description: r.description || '',
    prepTime: r.prepTime || 0, cookTime: r.cookTime || 0,
    servings: r.servings || 1, difficulty: r.difficulty || 'Easy',
    photos: parseJ(r.photos, []), ingredients: parseJ(r.ingredients, []),
    steps: parseJ(r.steps, []), opinion: r.opinion || '', tips: r.tips || '',
    tags: parseJ(r.tags, []), nutrition: parseJ(r.nutrition, null),
    ratings: parseJ(r.ratings, []), aiAnalysis: parseJ(r.aiAnalysis, null),
    createdAt: r.createdAt || new Date().toISOString(),
  };
}

async function sGetAllRecipes() {
  if (!db) return readJSON(RECIPES_FILE);
  const [rows] = await db.execute('SELECT * FROM `recipes` ORDER BY `createdAt` DESC');
  return rows.map(rowToRecipe);
}
async function sGetRecipeById(id) {
  if (!db) return readJSON(RECIPES_FILE).find(r => r.id === id) || null;
  const [rows] = await db.execute('SELECT * FROM `recipes` WHERE `id` = ?', [id]);
  return rows[0] ? rowToRecipe(rows[0]) : null;
}
async function sInsertRecipe(recipe) {
  if (db) {
    await db.execute(
      'INSERT INTO `recipes` (`id`,`userId`,`authorName`,`name`,`category`,`description`,`prepTime`,`cookTime`,`servings`,`difficulty`,`photos`,`ingredients`,`steps`,`opinion`,`tips`,`tags`,`nutrition`,`ratings`,`aiAnalysis`,`createdAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [recipe.id, recipe.userId, recipe.authorName || null, recipe.name, recipe.category || null,
       recipe.description || '', recipe.prepTime || 0, recipe.cookTime || 0, recipe.servings || 1,
       recipe.difficulty || 'Easy', JSON.stringify(recipe.photos || []),
       JSON.stringify(recipe.ingredients || []), JSON.stringify(recipe.steps || []),
       recipe.opinion || '', recipe.tips || '', JSON.stringify(recipe.tags || []),
       recipe.nutrition ? JSON.stringify(recipe.nutrition) : null,
       JSON.stringify(recipe.ratings || []),
       recipe.aiAnalysis ? JSON.stringify(recipe.aiAnalysis) : null,
       recipe.createdAt || new Date().toISOString()]
    );
  }
  const all = readJSON(RECIPES_FILE);
  all.push(recipe);
  writeJSON(RECIPES_FILE, all);
}
// Persist the full recipe object (used by edit, rate, ai-analysis).
async function sUpdateRecipe(id, recipe) {
  if (db) {
    await db.execute(
      'UPDATE `recipes` SET `name`=?,`category`=?,`description`=?,`prepTime`=?,`cookTime`=?,`servings`=?,`difficulty`=?,`photos`=?,`ingredients`=?,`steps`=?,`opinion`=?,`tips`=?,`tags`=?,`nutrition`=?,`ratings`=?,`aiAnalysis`=? WHERE `id`=?',
      [recipe.name, recipe.category || null, recipe.description || '', recipe.prepTime || 0,
       recipe.cookTime || 0, recipe.servings || 1, recipe.difficulty || 'Easy',
       JSON.stringify(recipe.photos || []), JSON.stringify(recipe.ingredients || []),
       JSON.stringify(recipe.steps || []), recipe.opinion || '', recipe.tips || '',
       JSON.stringify(recipe.tags || []),
       recipe.nutrition ? JSON.stringify(recipe.nutrition) : null,
       JSON.stringify(recipe.ratings || []),
       recipe.aiAnalysis ? JSON.stringify(recipe.aiAnalysis) : null, id]
    );
  }
  const all = readJSON(RECIPES_FILE);
  const i = all.findIndex(x => x.id === id);
  if (i !== -1) { all[i] = recipe; writeJSON(RECIPES_FILE, all); }
}
async function sDeleteRecipe(id) {
  if (db) {
    await db.execute('DELETE FROM `recipes` WHERE `id`=?', [id]);
    await db.execute('DELETE FROM `recipe_comments` WHERE `recipeId`=?', [id]);
    await db.execute('DELETE FROM `recipe_reactions` WHERE `recipeId`=?', [id]);
    await db.execute('DELETE FROM `bookmarks` WHERE `recipeId`=?', [id]);
  }
  writeJSON(RECIPES_FILE, readJSON(RECIPES_FILE).filter(x => x.id !== id));
  writeJSON(COMMENTS_FILE, readJSON(COMMENTS_FILE).filter(c => c.recipeId !== id));
  writeJSON(REACTIONS_FILE, readJSON(REACTIONS_FILE).filter(x => x.recipeId !== id));
  writeJSON(BOOKMARKS_FILE, readJSON(BOOKMARKS_FILE).filter(x => x.recipeId !== id));
}

// Recipe reactions (one emoji per user per recipe).
async function sGetRecipeReactions() {
  if (!db) return readJSON(REACTIONS_FILE);
  const [rows] = await db.execute('SELECT `id`,`recipeId`,`userId`,`emoji`,`createdAt` AS at FROM `recipe_reactions`');
  return rows;
}
async function sToggleRecipeReaction(recipeId, userId, emoji) {
  if (db) {
    const [ex] = await db.execute('SELECT `emoji` FROM `recipe_reactions` WHERE `recipeId`=? AND `userId`=?', [recipeId, userId]);
    const cur = ex[0];
    if (cur && cur.emoji === emoji) await db.execute('DELETE FROM `recipe_reactions` WHERE `recipeId`=? AND `userId`=?', [recipeId, userId]);
    else if (cur) await db.execute('UPDATE `recipe_reactions` SET `emoji`=? WHERE `recipeId`=? AND `userId`=?', [emoji, recipeId, userId]);
    else await db.execute('INSERT INTO `recipe_reactions` (`id`,`recipeId`,`userId`,`emoji`) VALUES (?,?,?,?)', [uuidv4(), recipeId, userId, emoji]);
  }
  const all = readJSON(REACTIONS_FILE);
  const mine = all.find(x => x.recipeId === recipeId && x.userId === userId);
  let next = all;
  if (mine && mine.emoji === emoji) next = all.filter(x => x !== mine);
  else if (mine) { mine.emoji = emoji; mine.at = new Date().toISOString(); }
  else next.push({ id: uuidv4(), recipeId, userId, emoji, at: new Date().toISOString() });
  writeJSON(REACTIONS_FILE, next);
  return next;
}

// Recipe comments (threaded one level).
async function sGetRecipeComments() {
  if (!db) return readJSON(COMMENTS_FILE);
  const [rows] = await db.execute('SELECT `id`,`recipeId`,`userId`,`authorName`,`text`,`parentId`,`likes`,`createdAt` AS at FROM `recipe_comments`');
  return rows.map(c => ({ ...c, likes: parseJ(c.likes, []) }));
}
async function sInsertRecipeComment(c) {
  if (db) {
    await db.execute(
      'INSERT INTO `recipe_comments` (`id`,`recipeId`,`userId`,`authorName`,`text`,`parentId`,`likes`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)',
      [c.id, c.recipeId, c.userId, c.authorName || null, c.text, c.parentId || null, JSON.stringify(c.likes || []), c.at]
    );
  }
  const all = readJSON(COMMENTS_FILE);
  all.push(c);
  writeJSON(COMMENTS_FILE, all);
}
async function sGetRecipeCommentById(id) {
  if (!db) return readJSON(COMMENTS_FILE).find(c => c.id === id) || null;
  const [rows] = await db.execute('SELECT `id`,`recipeId`,`userId`,`authorName`,`text`,`parentId`,`likes`,`createdAt` AS at FROM `recipe_comments` WHERE `id`=?', [id]);
  return rows[0] ? { ...rows[0], likes: parseJ(rows[0].likes, []) } : null;
}
async function sToggleRecipeCommentLike(id, userId) {
  if (db) {
    const [rows] = await db.execute('SELECT `likes` FROM `recipe_comments` WHERE `id`=?', [id]);
    if (!rows[0]) return null;
    const likes = parseJ(rows[0].likes, []);
    const i = likes.indexOf(userId);
    if (i === -1) likes.push(userId); else likes.splice(i, 1);
    await db.execute('UPDATE `recipe_comments` SET `likes`=? WHERE `id`=?', [JSON.stringify(likes), id]);
    const all = readJSON(COMMENTS_FILE);
    const c = all.find(x => x.id === id);
    if (c) { c.likes = likes; writeJSON(COMMENTS_FILE, all); }
    return { liked: i === -1, likeCount: likes.length };
  }
  const all = readJSON(COMMENTS_FILE);
  const c = all.find(x => x.id === id);
  if (!c) return null;
  c.likes = c.likes || [];
  const i = c.likes.indexOf(userId);
  if (i === -1) c.likes.push(userId); else c.likes.splice(i, 1);
  writeJSON(COMMENTS_FILE, all);
  return { liked: i === -1, likeCount: c.likes.length };
}

// Recipe reports.
async function sInsertRecipeReport(rep) {
  if (db) {
    await db.execute('INSERT INTO `recipe_reports` (`id`,`recipeId`,`userId`,`reason`,`createdAt`) VALUES (?,?,?,?,?)',
      [rep.id, rep.recipeId, rep.userId, rep.reason || null, rep.at]);
  }
  const all = readJSON(REPORTS_FILE);
  all.push(rep);
  writeJSON(REPORTS_FILE, all);
}

// Bookmarks (recipe saves).
async function sGetBookmarks(filter) {
  if (!db) return readJSON(BOOKMARKS_FILE).filter(filter);
  const [rows] = await db.execute('SELECT `userId`,`recipeId`,`postId`,`createdAt` AS at FROM `bookmarks`');
  return rows.filter(filter);
}
async function sToggleBookmark(userId, recipeId) {
  let bookmarked;
  if (db) {
    const [ex] = await db.execute('SELECT `id` FROM `bookmarks` WHERE `userId`=? AND `recipeId`=?', [userId, recipeId]);
    if (ex[0]) { await db.execute('DELETE FROM `bookmarks` WHERE `userId`=? AND `recipeId`=?', [userId, recipeId]); bookmarked = false; }
    else { await db.execute('INSERT INTO `bookmarks` (`id`,`userId`,`recipeId`) VALUES (?,?,?)', [uuidv4(), userId, recipeId]); bookmarked = true; }
  }
  const all = readJSON(BOOKMARKS_FILE);
  const mine = all.find(x => x.recipeId === recipeId && x.userId === userId);
  let next = all;
  if (mine) { next = all.filter(x => x !== mine); bookmarked = false; }
  else { next.push({ userId, recipeId, at: new Date().toISOString() }); bookmarked = true; }
  writeJSON(BOOKMARKS_FILE, next);
  return bookmarked;
}

// Post saves (one save per user per post).
async function sToggleSave(userId, postId) {
  let saved;
  if (db) {
    const [ex] = await db.execute('SELECT `id` FROM `post_saves` WHERE `userId`=? AND `postId`=?', [userId, postId]);
    if (ex[0]) { await db.execute('DELETE FROM `post_saves` WHERE `userId`=? AND `postId`=?', [userId, postId]); saved = false; }
    else { await db.execute('INSERT INTO `post_saves` (`id`,`userId`,`postId`) VALUES (?,?,?)', [uuidv4(), userId, postId]); saved = true; }
  }
  const all = readJSON(POST_SAVES_FILE);
  const mine = all.find(x => x.postId === postId && x.userId === userId);
  let next = all;
  if (mine) { next = all.filter(x => x !== mine); saved = false; }
  else { next.push({ userId, postId, at: new Date().toISOString() }); saved = true; }
  writeJSON(POST_SAVES_FILE, next);
  return saved;
}

// Post reports.
async function sInsertPostReport(rep) {
  if (db) {
    await db.execute('INSERT INTO `post_reports` (`id`,`postId`,`userId`,`reason`,`createdAt`) VALUES (?,?,?,?,?)',
      [rep.id, rep.postId, rep.userId, rep.reason || null, rep.at]);
  }
  const all = readJSON(POST_REPORTS_FILE);
  all.push(rep);
  writeJSON(POST_REPORTS_FILE, all);
}

// Hashtag follows.
async function sToggleHashtagFollow(userId, tag) {
  let following;
  if (db) {
    const [ex] = await db.execute('SELECT `id` FROM `hashtag_follows` WHERE `userId`=? AND `tag`=?', [userId, tag]);
    if (ex[0]) { await db.execute('DELETE FROM `hashtag_follows` WHERE `userId`=? AND `tag`=?', [userId, tag]); following = false; }
    else { await db.execute('INSERT INTO `hashtag_follows` (`id`,`userId`,`tag`) VALUES (?,?,?)', [uuidv4(), userId, tag]); following = true; }
  }
  const all = readJSON(HASHTAG_FOLLOWS_FILE);
  const mine = all.find(f => f.userId === userId && f.tag === tag);
  let next = all;
  if (mine) { next = all.filter(f => f !== mine); following = false; }
  else { next.push({ userId, tag, at: new Date().toISOString() }); following = true; }
  writeJSON(HASHTAG_FOLLOWS_FILE, next);
  return following;
}
async function sIsFollowingHashtag(userId, tag) {
  if (!userId) return false;
  if (!db) return readJSON(HASHTAG_FOLLOWS_FILE).some(f => f.userId === userId && f.tag === tag);
  const [rows] = await db.execute('SELECT `id` FROM `hashtag_follows` WHERE `userId`=? AND `tag`=?', [userId, tag]);
  return !!rows[0];
}

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

// Store a notification (best-effort; never notify yourself). Phase 2c: MySQL
// fire-and-forget + JSON dual-write so all callers remain synchronous.
function pushNotification(type, { toUserId, fromUserId, postId, text }) {
  if (!toUserId || toUserId === fromUserId) return;
  const from = readJSON(USERS_FILE).find(u => u.id === fromUserId);
  const notif = {
    id: uuidv4(), type, toUserId, fromUserId,
    fromName: (from && from.name) || 'Someone', fromAvatar: (from && from.avatar) || null,
    postId: postId || null, text: text || '', read: false, at: new Date().toISOString(),
  };
  // MySQL fire-and-forget (callers don't await pushNotification)
  if (db) {
    db.execute(
      'INSERT INTO `notifications` (`id`,`userId`,`type`,`actorId`,`postId`,`text`,`read`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)',
      [notif.id, toUserId, type, fromUserId || null, postId || null, notif.text, 0, notif.at]
    ).catch(e => console.error('notif insert:', e.message));
  }
  // Dual-write JSON so non-migrated single-notif endpoints stay in sync.
  const all = readJSON(NOTIFICATIONS_FILE);
  all.unshift(notif);
  writeJSON(NOTIFICATIONS_FILE, all.slice(0, 500));
  // Push live to recipient's bell (if connected).
  const post = postId ? readJSON(POSTS_FILE).find(p => p.id === postId) : null;
  RT.toUser(toUserId, 'notification:new', {
    id: notif.id, type, text: notif.text, at: notif.at,
    actor: { id: fromUserId, name: notif.fromName, avatar: notif.fromAvatar, username: userHandle(from) },
    post: post ? { id: post.id, thumbnail: notifThumb(post), type: post.type } : null,
    link: type === 'follow' ? `/profile-social.html?id=${fromUserId}` : (postId ? `/feed.html?post=${postId}` : '#'),
  });
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

// ── Feed ranking (Phase 4D) ──────────────────────────────────────────────
// Three modes: 'following' (reverse-chron from people you follow), 'latest'
// (reverse-chron, everyone), 'foryou' (personalized score below; cold-start
// for logged-out users falls back to popularity + recency). The For You score
// replaces the old linear-decay formula with bounded exponential decay plus
// per-viewer affinity / interest / seen signals. Weights are explainable and
// contain no engagement dark patterns.
const RANKING_MODES = ['foryou', 'following', 'latest'];

// Precompute the viewer's affinity profile once per request: the hashtags/food
// tags they've engaged with (high-signal interest) and the posts they've
// already engaged with (a proxy for "seen", since post views aren't per-user).
function buildRankingContext(viewerId, reactions, saves, comments, followingSet, allPosts) {
  const ctx = { viewerId, followingSet, interestTags: new Set(), engagedPostIds: new Set() };
  if (!viewerId) return ctx;
  const byId = new Map((allPosts || readJSON(POSTS_FILE)).map(p => [p.id, p]));
  const harvest = (pid) => {
    ctx.engagedPostIds.add(pid);
    const p = byId.get(pid); if (!p) return;
    (p.hashtags || []).forEach(t => ctx.interestTags.add(String(t).toLowerCase()));
    (p.foodTags || []).forEach(t => ctx.interestTags.add(String(t).toLowerCase()));
  };
  reactions.forEach(r => { if (r.userId === viewerId) harvest(r.postId); });
  saves.forEach(s => { if (s.userId === viewerId) harvest(s.postId); });
  comments.forEach(c => { if (c.userId === viewerId) ctx.engagedPostIds.add(c.postId); });
  return ctx;
}

function forYouScore(p, ctx) {
  const engagement = p.totalReactions * 3 + p.commentCount * 5 + p.saveCount * 4 + (p.views || 0) * 0.1;
  const hours = (Date.now() - new Date(p.createdAt).getTime()) / 3600000;
  // Hacker-News-style gravity: bounded, always positive, freshness-aware. The
  // +1 keeps brand-new zero-engagement posts ranked by recency.
  let score = (engagement + 1) / Math.pow(Math.max(0, hours) + 2, 1.5);
  if (ctx.viewerId) {
    if (ctx.followingSet.has(p.userId)) score *= 1.6;                 // affinity boost
    const tags = [...(p.hashtags || []), ...(p.foodTags || [])].map(t => String(t).toLowerCase());
    const matches = tags.filter(t => ctx.interestTags.has(t)).length;
    if (matches) score *= 1 + Math.min(matches, 4) * 0.15;            // interest match (capped)
    if (ctx.engagedPostIds.has(p.id)) score *= 0.3;                   // seen/engaged penalty
    if (p.userId === ctx.viewerId) score *= 0.6;                      // your own posts rank lower
  }
  return score;
}

// Reorder a scored list so no author appears more than twice in a row.
function diversifyByAuthor(sorted) {
  const pool = sorted.slice();
  const out = [];
  while (pool.length) {
    let idx = 0;
    const a = out.length >= 1 ? out[out.length - 1].userId : null;
    const b = out.length >= 2 ? out[out.length - 2].userId : null;
    if (a && a === b) {
      const alt = pool.findIndex(p => p.userId !== a);
      if (alt !== -1) idx = alt;
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

// ── Feed (paginated, scored, works logged-out) ──
app.get('/api/feed', async (req, res) => {
  try {
    const viewerId = optionalAuth(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 20;
    const reactions = readJSON(POST_REACTIONS_FILE);
    const comments = readJSON(POST_COMMENTS_FILE);
    const saves = readJSON(POST_SAVES_FILE);
    const ranking = RANKING_MODES.includes(req.query.ranking) ? req.query.ranking : 'foryou';
    // Phase 2a: read posts from MySQL (falls back to JSON when db is null)
    const allPosts = await sGetAllPosts();
    let list = allPosts.map(p => decoratePost(p, reactions, comments, saves, viewerId));
    const { type, tag, userId } = req.query;
    if (type && POST_TYPES.includes(type)) list = list.filter(p => p.type === type);
    if (tag) list = list.filter(p => (p.hashtags || []).includes(String(tag).toLowerCase()));
    if (userId) list = list.filter(p => p.userId === userId);

    let followingSet = new Set();
    if (viewerId) followingSet = new Set(readJSON(FOLLOWS_FILE).filter(f => f.followerId === viewerId).map(f => f.followingId));

    if (ranking === 'latest') {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else if (ranking === 'following') {
      if (viewerId) list = list.filter(p => followingSet.has(p.userId) || p.userId === viewerId);
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } else {
      // For You — personalized score + author diversity pass.
      const ctx = buildRankingContext(viewerId, reactions, saves, comments, followingSet, allPosts);
      list.forEach(p => { p.score = forYouScore(p, ctx); });
      list.sort((a, b) => b.score - a.score);
      list = diversifyByAuthor(list);
    }

    const total = list.length;
    const start = (page - 1) * perPage;
    const pageItems = list.slice(start, start + perPage);
    pageItems.forEach(p => { p.isFollowingAuthor = followingSet.has(p.userId); p.isOwn = p.userId === viewerId; });
    res.json({ posts: pageItems, page, perPage, total, ranking, hasMore: start + perPage < total });
  } catch (e) {
    console.error('Feed error:', e.message);
    res.status(500).json({ error: 'Could not load feed.' });
  }
});

// ── Reels feed (Phase 4C) — paginated, ranked video posts for the
//    full-screen TikTok-style viewer. Same scoring + enrichment as the feed,
//    filtered to type:'video'. ──
app.get('/api/reels', (req, res) => {
  const viewerId = optionalAuth(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 5;
  const reactions = readJSON(POST_REACTIONS_FILE);
  const comments = readJSON(POST_COMMENTS_FILE);
  const saves = readJSON(POST_SAVES_FILE);
  let list = readJSON(POSTS_FILE)
    .filter(p => p.type === 'video' && p.video)
    .map(p => decoratePost(p, reactions, comments, saves, viewerId));
  list.sort((a, b) => b.score - a.score);
  const total = list.length;
  const start = (page - 1) * perPage;
  const pageItems = list.slice(start, start + perPage);
  let followingSet = new Set();
  if (viewerId) followingSet = new Set(readJSON(FOLLOWS_FILE).filter(f => f.followerId === viewerId).map(f => f.followingId));
  pageItems.forEach(p => { p.isFollowingAuthor = followingSet.has(p.userId); p.isOwn = p.userId === viewerId; });
  res.json({ reels: pageItems, page, perPage, total, hasMore: start + perPage < total });
});

// ── Create a post ──
app.post('/api/posts', auth, (req, res) => {
  postUpload.array('media', 10)(req, res, async (uErr) => {
    if (uErr) return res.status(400).json({ error: uErr.message });
    try {
      const b = req.body || {};
      const type = POST_TYPES.includes(b.type) ? b.type : 'text';
      const caption = String(b.caption || '').trim().slice(0, 500);
      const { photos, video: rawVideo } = await savePostMedia(req.files);
      // Phase 5: a reel can supply a pre-transcoded video (from /api/upload/video)
      // instead of a raw multipart upload. Only accept paths inside /uploads/videos.
      let video = rawVideo;
      let videoThumb = null;
      if (!video && b.videoUrl && /^\/uploads\/videos\/[\w.-]+\.mp4$/.test(b.videoUrl)
          && fs.existsSync(path.join(__dirname, 'public', b.videoUrl))) {
        video = b.videoUrl;
        if (b.videoThumb && /^\/uploads\/videos\/thumbs\/[\w.-]+\.webp$/.test(b.videoThumb)) videoThumb = b.videoThumb;
      }
      if (type === 'photo' && photos.length === 0) return res.status(400).json({ error: 'Add at least one photo.' });
      if (type === 'video' && !video) return res.status(400).json({ error: 'Add a video to post a reel.' });
      if (type === 'text' && !caption) return res.status(400).json({ error: 'Write something to share.' });
      let recipeRef = null;
      if (type === 'recipe') {
        const recipe = await sGetRecipeById(b.recipeId);
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
        type, caption, photos, video, videoThumb, recipe: recipeRef,
        hashtags: extractHashtags(`${caption} ${b.hashtags || ''}`),
        foodTags, location: b.location ? String(b.location).trim().slice(0, 80) : '',
        views: 0, createdAt: new Date().toISOString(),
      };
      // Phase 2a: write to MySQL + dual-write JSON for non-migrated endpoints
      await sInsertPost(post);
      notifyMentions(caption, req.userId, post.id, 'mentioned you in a post');
      // Phase 5: live feed nudge ("N new posts" banner) for everyone.
      RT.broadcast('feed:new_post', { postId: post.id, type: post.type, author: { id: post.userId, name: post.authorName, avatar: post.authorAvatar } });
      res.status(201).json(post);
    } catch (err) {
      console.error('Post create error:', err.message);
      res.status(500).json({ error: 'Could not publish your post. Please try again.' });
    }
  });
});

// ── Single post ──
app.get('/api/posts/:id', async (req, res) => {
  try {
    const viewerId = optionalAuth(req);
    // Phase 2a: read from MySQL (falls back to JSON when db is null)
    const p = await sGetPostById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Post not found' });
    const d = decoratePost(p, readJSON(POST_REACTIONS_FILE), readJSON(POST_COMMENTS_FILE), readJSON(POST_SAVES_FILE), viewerId);
    d.isOwn = p.userId === viewerId;
    res.json(d);
  } catch (e) {
    console.error('Get post error:', e.message);
    res.status(500).json({ error: 'Could not load post.' });
  }
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

// ── React (toggle one emoji per user per post) — Phase 2b: MySQL + dual-write ──
async function applyReaction(postId, userId, emoji) {
  if (db) {
    const [ex] = await db.execute(
      'SELECT `emoji` FROM `post_reactions` WHERE `postId` = ? AND `userId` = ?', [postId, userId]
    );
    const cur = ex[0];
    if (cur && cur.emoji === emoji) {
      await db.execute('DELETE FROM `post_reactions` WHERE `postId` = ? AND `userId` = ?', [postId, userId]);
    } else if (cur) {
      await db.execute('UPDATE `post_reactions` SET `emoji` = ? WHERE `postId` = ? AND `userId` = ?', [emoji, postId, userId]);
    } else {
      await db.execute('INSERT INTO `post_reactions` (`id`,`postId`,`userId`,`emoji`) VALUES (?,?,?,?)', [uuidv4(), postId, userId, emoji]);
    }
  }
  // Dual-write: keep JSON in sync so decoratePost in the feed still works.
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

app.post('/api/posts/:id/react', auth, async (req, res) => {
  try {
    const emoji = (req.body && req.body.emoji) || '';
    if (!POST_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction' });
    const post = await sGetPostById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const out = await applyReaction(req.params.id, req.userId, emoji);
    if (out.mine) pushNotification('reaction', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: `reacted ${emoji} to your post` });
    RT.broadcast('post:reaction', { postId: post.id, total: out.total, counts: out.counts });
    res.json(out);
  } catch (e) { console.error('React error:', e.message); res.status(500).json({ error: 'Could not apply reaction.' }); }
});

// Convenience: double-tap "like" toggles the ❤️ reaction.
app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const post = await sGetPostById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const out = await applyReaction(req.params.id, req.userId, '❤️');
    if (out.mine) pushNotification('like', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: 'liked your post' });
    RT.broadcast('post:reaction', { postId: post.id, total: out.total, counts: out.counts });
    res.json({ ...out, liked: out.mine === '❤️' });
  } catch (e) { console.error('Like error:', e.message); res.status(500).json({ error: 'Could not apply like.' }); }
});

// ── Save / unsave ──
app.post('/api/posts/:id/save', auth, async (req, res) => {
  const saved = await sToggleSave(req.userId, req.params.id);
  if (saved) {
    const post = readJSON(POSTS_FILE).find(p => p.id === req.params.id);
    if (post) pushNotification('save', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: 'saved your post' });
  }
  res.json({ saved });
});

// ── Report ──
app.post('/api/posts/:id/report', auth, async (req, res) => {
  await sInsertPostReport({ id: uuidv4(), postId: req.params.id, userId: req.userId,
    reason: (req.body && String(req.body.reason || '').slice(0, 500)) || 'Unspecified', at: new Date().toISOString() });
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
// JSON-only version kept as fallback for sGetPostCommentsShaped.
function shapePostComments(postId) {
  const all = readJSON(POST_COMMENTS_FILE).filter(c => c.postId === postId);
  const roots = all.filter(c => !c.parentId).sort((a, b) => b.at.localeCompare(a.at));
  return roots.map(c => ({
    ...c, likeCount: (c.likes || []).length,
    replies: all.filter(r => r.parentId === c.id).sort((a, b) => a.at.localeCompare(b.at))
      .map(r => ({ ...r, likeCount: (r.likes || []).length })),
  }));
}

app.get('/api/posts/:id/comments', async (req, res) => {
  try { res.json(await sGetPostCommentsShaped(req.params.id)); }
  catch (e) { console.error('Comments error:', e.message); res.status(500).json({ error: 'Could not load comments.' }); }
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const text = req.body && String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
    const post = await sGetPostById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const user = db ? await dbFindUserById(req.userId) : readJSON(USERS_FILE).find(u => u.id === req.userId);
    const comment = { id: uuidv4(), postId: req.params.id, userId: req.userId,
      authorName: (user && user.name) || 'NutriFell User', authorAvatar: (user && user.avatar) || null,
      text: text.slice(0, 2000), parentId: null, likes: [], at: new Date().toISOString() };
    await sInsertComment(comment);
    pushNotification('comment', { toUserId: post.userId, fromUserId: req.userId, postId: post.id, text: 'commented on your post' });
    notifyMentions(text, req.userId, post.id, 'mentioned you in a comment');
    RT.toPost(post.id, 'comment:new', { postId: post.id, comment: { ...comment, likeCount: 0, replies: [] } });
    const cCount = await sCountPostComments(post.id);
    RT.broadcast('post:comment', { postId: post.id, total: cCount });
    res.status(201).json(comment);
  } catch (e) { console.error('Comment create error:', e.message); res.status(500).json({ error: 'Could not post comment.' }); }
});

app.post('/api/posts/:id/comments/:cid/reply', auth, async (req, res) => {
  try {
    const text = req.body && String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Reply cannot be empty' });
    const user = db ? await dbFindUserById(req.userId) : readJSON(USERS_FILE).find(u => u.id === req.userId);
    const parent = await sGetCommentById(req.params.cid);
    if (!parent) return res.status(404).json({ error: 'Comment not found' });
    const reply = { id: uuidv4(), postId: req.params.id, userId: req.userId,
      authorName: (user && user.name) || 'NutriFell User', authorAvatar: (user && user.avatar) || null,
      text: text.slice(0, 2000), parentId: parent.parentId || parent.id, likes: [], at: new Date().toISOString() };
    await sInsertComment(reply);
    pushNotification('reply', { toUserId: parent.userId, fromUserId: req.userId, postId: req.params.id, text: 'replied to your comment' });
    notifyMentions(text, req.userId, req.params.id, 'mentioned you in a comment');
    res.status(201).json(reply);
  } catch (e) { console.error('Reply error:', e.message); res.status(500).json({ error: 'Could not post reply.' }); }
});

app.post('/api/posts/:id/comments/:cid/like', auth, async (req, res) => {
  try {
    const result = await sToggleCommentLike(req.params.cid, req.userId);
    if (!result) return res.status(404).json({ error: 'Comment not found' });
    res.json(result);
  } catch (e) { console.error('Comment like error:', e.message); res.status(500).json({ error: 'Could not like comment.' }); }
});

// ── Follow system ──
app.get('/api/users/suggested', async (req, res) => {
  try {
    const viewerId = optionalAuth(req);
    const follows = await sGetFollows(() => true);
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
  } catch (e) { console.error('Suggested error:', e.message); res.status(500).json({ error: 'Could not load suggestions.' }); }
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

app.post('/api/users/:id/follow', auth, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.userId) return res.status(400).json({ error: "You can't follow yourself" });
    const target = readJSON(USERS_FILE).find(u => u.id === targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { following, followerCount } = await sToggleFollow(req.userId, targetId);
    if (following) pushNotification('follow', { toUserId: targetId, fromUserId: req.userId, text: 'started following you' });
    res.json({ following, followers: followerCount });
  } catch (e) { console.error('Follow error:', e.message); res.status(500).json({ error: 'Could not toggle follow.' }); }
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
  return async (req, res) => {
    try {
      const viewerId = optionalAuth(req);
      const follows = await sGetFollows(() => true);
      const byId = new Map(readJSON(USERS_FILE).map(u => [u.id, u]));
      const viewerFollowing = new Set(follows.filter(f => f.followerId === viewerId).map(f => f.followingId));
      const list = follows.filter(f => f[targetField] === req.params.id)
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .map(f => byId.get(f[idField])).filter(Boolean)
        .map(u => userMini(u, viewerId, viewerFollowing));
      res.json(list);
    } catch (e) { console.error('Follow list error:', e.message); res.status(500).json({ error: 'Could not load list.' }); }
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

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 20;
    const filter = req.query.type;
    const { items, total, unread } = await sGetNotifications(req.userId, filter, page, perPage);
    const posts = readJSON(POSTS_FILE);
    const users = readJSON(USERS_FILE);
    const decorated = items.map(n => decorateNotification(n, posts, users));
    res.json({ notifications: decorated, page, perPage, total, unread, hasMore: (page - 1) * perPage + perPage < total });
  } catch (e) { console.error('Notifications error:', e.message); res.status(500).json({ error: 'Could not load notifications.' }); }
});
app.get('/api/notifications/count', auth, async (req, res) => {
  try { res.json({ count: await sCountUnreadNotifications(req.userId) }); }
  catch (e) { console.error('Notif count error:', e.message); res.status(500).json({ error: 'Could not get count.' }); }
});
app.put('/api/notifications/read', auth, async (req, res) => {
  try { await sMarkAllNotificationsRead(req.userId); res.json({ success: true }); }
  catch (e) { console.error('Notif read error:', e.message); res.status(500).json({ error: 'Could not mark read.' }); }
});
app.put('/api/notifications/:id/read', auth, (req, res) => {
  const all = readJSON(NOTIFICATIONS_FILE);
  const n = all.find(x => x.id === req.params.id && x.toUserId === req.userId);
  if (!n) return res.status(404).json({ error: 'Notification not found' });
  n.read = true;
  writeJSON(NOTIFICATIONS_FILE, all);
  res.json({ success: true });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 4A · Direct Messages (1:1, open to everyone)
// Realtime is polling-based to match the notif bell; no websockets in stack.
// DMs deliberately do NOT write notifications.json rows — unread is surfaced
// via the dedicated /api/messages/unread-count badge to avoid feed noise.
// ═════════════════════════════════════════════════════════════════════════

// The conversation between two users (order-independent), or null.
function findConversation(convos, a, b) {
  return convos.find(c => c.participants.includes(a) && c.participants.includes(b)) || null;
}

// Public-safe shape of the *other* participant in a 1:1 conversation.
function otherParticipant(convo, viewerId, users) {
  const otherId = convo.participants.find(id => id !== viewerId) || convo.participants[0];
  const u = users.find(x => x.id === otherId);
  return { id: otherId, name: (u && u.name) || 'NutriFell User', username: userHandle(u), avatar: (u && u.avatar) || null };
}

// Attach a lightweight post preview to a shared-post/reel message attachment.
function enrichMessageAttachment(m, posts) {
  if (!m.attachment || !m.attachment.postId) return m;
  const p = posts.find(x => x.id === m.attachment.postId);
  if (!p) return m;
  const thumb = (p.photos || [])[0] || p.video || (p.recipe && p.recipe.cover) || null;
  return { ...m, attachment: { ...m.attachment, preview: { id: p.id, type: p.type, caption: (p.caption || '').slice(0, 80), thumb, authorName: p.authorName } } };
}

// Guard: load a conversation the viewer participates in, or respond 403/404.
function loadOwnConversation(req, res) {
  const convo = readJSON(CONVERSATIONS_FILE).find(c => c.id === req.params.id);
  if (!convo) { res.status(404).json({ error: 'Conversation not found.' }); return null; }
  if (!convo.participants.includes(req.userId)) { res.status(403).json({ error: 'Not your conversation.' }); return null; }
  return convo;
}

// List the viewer's threads, newest activity first, with per-thread unread counts.
app.get('/api/conversations', auth, (req, res) => {
  const convos = readJSON(CONVERSATIONS_FILE).filter(c => c.participants.includes(req.userId));
  const messages = readJSON(MESSAGES_FILE);
  const users = readJSON(USERS_FILE);
  const list = convos.map(c => ({
    id: c.id,
    user: otherParticipant(c, req.userId, users),
    lastMessage: c.lastMessage || null,
    lastMessageAt: c.lastMessageAt || c.createdAt,
    unreadCount: messages.filter(m => m.conversationId === c.id && m.fromUserId !== req.userId && !m.read).length,
  }));
  list.sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
  res.json({ conversations: list });
});

// Find-or-create a 1:1 thread with { userId }.
app.post('/api/conversations', auth, (req, res) => {
  const otherId = String((req.body && req.body.userId) || '').trim();
  if (!otherId) return res.status(400).json({ error: 'Recipient required.' });
  if (otherId === req.userId) return res.status(400).json({ error: 'You cannot message yourself.' });
  const users = readJSON(USERS_FILE);
  if (!users.find(u => u.id === otherId)) return res.status(404).json({ error: 'User not found.' });
  const convos = readJSON(CONVERSATIONS_FILE);
  let convo = findConversation(convos, req.userId, otherId);
  if (!convo) {
    const now = new Date().toISOString();
    convo = { id: uuidv4(), participants: [req.userId, otherId], createdAt: now, lastMessageAt: now, lastMessage: null };
    convos.unshift(convo);
    writeJSON(CONVERSATIONS_FILE, convos);
  }
  res.status(201).json({ id: convo.id, user: otherParticipant(convo, req.userId, users), lastMessage: convo.lastMessage, lastMessageAt: convo.lastMessageAt, unreadCount: 0 });
});

// Paginated messages for a thread (oldest→newest within the returned page).
app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const convo = loadOwnConversation(req, res); if (!convo) return;
  const perPage = 30;
  let msgs = readJSON(MESSAGES_FILE).filter(m => m.conversationId === convo.id);
  msgs.sort((a, b) => a.at.localeCompare(b.at));
  if (req.query.before) msgs = msgs.filter(m => m.at < req.query.before);
  const total = msgs.length;
  const posts = readJSON(POSTS_FILE);
  const users = readJSON(USERS_FILE);
  const page = msgs.slice(Math.max(0, total - perPage)).map(m => enrichMessageAttachment(m, posts));
  res.json({ messages: page, hasMore: total > perPage, user: otherParticipant(convo, req.userId, users) });
});

// Send a message. Attachment is an optional shared post/reel ({ kind, postId }).
// Shared persistence used by both the REST endpoint and the socket `dm:send`
// handler. Validates, saves, updates the conversation summary, and pushes the
// enriched message live to the recipient. Returns the enriched message.
function persistMessage(convo, fromUserId, { text, attachment }) {
  const clean = String(text || '').trim().slice(0, 2000);
  let att = null;
  if (attachment && (attachment.kind === 'post' || attachment.kind === 'reel') && attachment.postId) {
    att = { kind: attachment.kind, postId: String(attachment.postId) };
  }
  if (!clean && !att) throw new Error('Write a message.');
  const msg = { id: uuidv4(), conversationId: convo.id, fromUserId, text: clean, attachment: att, read: false, at: new Date().toISOString() };
  const messages = readJSON(MESSAGES_FILE);
  messages.push(msg);
  writeJSON(MESSAGES_FILE, messages);
  const convos = readJSON(CONVERSATIONS_FILE);
  const c = convos.find(x => x.id === convo.id);
  if (c) { c.lastMessage = { text: clean || 'Shared a post', fromUserId, at: msg.at }; c.lastMessageAt = msg.at; writeJSON(CONVERSATIONS_FILE, convos); }
  const enriched = enrichMessageAttachment(msg, readJSON(POSTS_FILE));
  // Deliver live to the other participant.
  const toUserId = convo.participants.find(id => id !== fromUserId);
  RT.toUser(toUserId, 'dm:receive', { conversationId: convo.id, from: fromUserId, message: enriched });
  return enriched;
}

app.post('/api/conversations/:id/messages', auth, (req, res) => {
  const convo = loadOwnConversation(req, res); if (!convo) return;
  const a = req.body && req.body.attachment;
  try {
    const enriched = persistMessage(convo, req.userId, { text: (req.body && req.body.text) || '', attachment: a });
    res.status(201).json(enriched);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Write a message.' });
  }
});

// Mark the other party's messages in a thread as read.
app.put('/api/conversations/:id/read', auth, (req, res) => {
  const convo = loadOwnConversation(req, res); if (!convo) return;
  const messages = readJSON(MESSAGES_FILE);
  let changed = false;
  messages.forEach(m => { if (m.conversationId === convo.id && m.fromUserId !== req.userId && !m.read) { m.read = true; changed = true; } });
  if (changed) writeJSON(MESSAGES_FILE, messages);
  // Tell the sender their messages were read (blue ticks).
  const otherId = convo.participants.find(id => id !== req.userId);
  RT.toUser(otherId, 'dm:read', { conversationId: convo.id, by: req.userId, at: new Date().toISOString() });
  res.json({ success: true });
});

// Total unread across all of the viewer's threads (powers the nav DM badge).
app.get('/api/messages/unread-count', auth, async (req, res) => {
  try { res.json({ count: await sGetUnreadMessageCount(req.userId) }); }
  catch (e) { console.error('Unread count error:', e.message); res.status(500).json({ error: 'Could not get count.' }); }
});

// ─── Phase 2d: /api/messages user-centric routes (MySQL-backed) ───────────────
// List all conversations for the viewer, newest first.
app.get('/api/messages', auth, async (req, res) => {
  try {
    const convos = await sGetUserConversations(req.userId);
    const users = readJSON(USERS_FILE);
    const list = convos
      .map(c => ({ id: c.id, user: otherParticipant(c, req.userId, users), lastMessage: c.lastMessage || null, lastMessageAt: c.lastMessageAt, unreadCount: c.unreadCount || 0 }))
      .sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
    res.json({ conversations: list });
  } catch (e) { console.error('Messages list error:', e.message); res.status(500).json({ error: 'Could not load messages.' }); }
});

// Get messages between the viewer and :userId.
app.get('/api/messages/:userId', auth, async (req, res) => {
  try {
    const convo = await sGetConversation(req.userId, req.params.userId);
    if (!convo) return res.json({ messages: [], hasMore: false });
    const { messages, total } = await sGetConversationMessages(convo.id, req.query.before, 30);
    const posts = readJSON(POSTS_FILE);
    const users = readJSON(USERS_FILE);
    const u = users.find(x => x.id === req.params.userId);
    res.json({
      messages: messages.map(m => enrichMessageAttachment(m, posts)),
      hasMore: total > 30,
      user: { id: req.params.userId, name: (u && u.name) || 'NutriFell User', username: userHandle(u), avatar: (u && u.avatar) || null },
    });
  } catch (e) { console.error('Messages get error:', e.message); res.status(500).json({ error: 'Could not load messages.' }); }
});

// Send a message to :userId (find-or-create conversation).
app.post('/api/messages/:userId', auth, async (req, res) => {
  try {
    const otherId = req.params.userId;
    if (otherId === req.userId) return res.status(400).json({ error: 'You cannot message yourself.' });
    const users = readJSON(USERS_FILE);
    if (!users.find(u => u.id === otherId)) return res.status(404).json({ error: 'User not found.' });
    const convo = await sGetOrCreateConversation(req.userId, otherId);
    const enriched = await sSendMessage(convo, req.userId, otherId, (req.body && req.body.text) || '', req.body && req.body.attachment);
    res.status(201).json(enriched);
  } catch (e) {
    const code = e.message === 'Write a message.' ? 400 : 500;
    console.error('Message send error:', e.message);
    res.status(code).json({ error: e.message || 'Could not send message.' });
  }
});

// Mark all messages from :userId as read in this conversation.
app.put('/api/messages/:userId/read', auth, async (req, res) => {
  try {
    const convo = await sGetConversation(req.userId, req.params.userId);
    if (convo) {
      await sMarkConversationRead(convo.id, req.userId);
      RT.toUser(req.params.userId, 'dm:read', { conversationId: convo.id, by: req.userId, at: new Date().toISOString() });
    }
    res.json({ success: true });
  } catch (e) { console.error('Mark read error:', e.message); res.status(500).json({ error: 'Could not mark as read.' }); }
});

// Presence snapshot for a user (online + last-seen). Live updates flow over the
// socket via user:online / user:offline.
app.get('/api/presence/:id', auth, (req, res) => {
  res.json({ id: req.params.id, online: RT.isOnline(req.params.id), lastSeen: RT.lastSeen(req.params.id) });
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 4B · Stories (24h disappearing content, visible to followers + self)
// ═════════════════════════════════════════════════════════════════════════
const STORY_TTL = 24 * 3600 * 1000;

// One image OR one short video per story. 80MB covers a ~15s clip.
const storyUpload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 80 * 1024 * 1024, files: 1 },
      fileFilter: (req, file, cb) => {
        const ok = /^image\/(jpe?g|png|webp)$/.test(file.mimetype)
          || /^video\/(mp4|webm|quicktime)$/.test(file.mimetype);
        cb(ok ? null : new Error('Only JPG/PNG/WebP images or MP4/WebM/MOV video allowed'), ok);
      },
    })
  : { single: () => (req, res, next) => next() };

async function saveStoryMedia(file) {
  const base = `${Date.now()}-${uuidv4().slice(0, 8)}`;
  if (/^image\//.test(file.mimetype)) {
    if (sharp) {
      const name = `${base}.webp`;
      await sharp(file.buffer).rotate().resize({ width: 1080, height: 1920, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 }).toFile(path.join(STORIES_UPLOAD_DIR, name));
      return { type: 'image', media: `/uploads/stories/${name}` };
    }
    const ext = (file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const name = `${base}.${ext}`;
    fs.writeFileSync(path.join(STORIES_UPLOAD_DIR, name), file.buffer);
    return { type: 'image', media: `/uploads/stories/${name}` };
  }
  const ext = file.mimetype === 'video/quicktime' ? 'mov' : (file.mimetype.split('/')[1] || 'mp4');
  const name = `${base}.${ext}`;
  fs.writeFileSync(path.join(STORIES_UPLOAD_DIR, name), file.buffer);
  return { type: 'video', media: `/uploads/stories/${name}` };
}

const isActiveStory = (s) => new Date(s.expiresAt).getTime() > Date.now();

// Remove expired stories + their views, and delete the orphaned media files.
function sweepExpiredStories() {
  // MySQL sweep (fire-and-forget; table may not exist yet on first startup call)
  if (db) db.execute('DELETE FROM `stories` WHERE `expiresAt` < NOW()').catch(() => {});
  try {
    const all = readJSON(STORIES_FILE);
    const expired = all.filter(s => !isActiveStory(s));
    if (!expired.length) return;
    const live = all.filter(isActiveStory);
    writeJSON(STORIES_FILE, live);
    const liveIds = new Set(live.map(s => s.id));
    writeJSON(STORY_VIEWS_FILE, readJSON(STORY_VIEWS_FILE).filter(v => liveIds.has(v.storyId)));
    expired.forEach(s => {
      const fp = path.join(__dirname, 'public', s.media || '');
      try { if (s.media && fp.startsWith(STORIES_UPLOAD_DIR) && fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
    });
  } catch (e) { console.error('Story sweep error:', e.message); }
}
sweepExpiredStories();
setInterval(sweepExpiredStories, 3600 * 1000);

// Create a story (multipart: field "media" + optional caption).
app.post('/api/stories', auth, (req, res) => {
  storyUpload.single('media')(req, res, async (uErr) => {
    if (uErr) return res.status(400).json({ error: uErr.message });
    if (!req.file) return res.status(400).json({ error: 'Add a photo or video.' });
    try {
      const { type, media } = await saveStoryMedia(req.file);
      const now = Date.now();
      const story = {
        id: uuidv4(), userId: req.userId, type, media,
        caption: String((req.body && req.body.caption) || '').trim().slice(0, 200),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + STORY_TTL).toISOString(),
      };
      if (db) {
        const mediaType = type === 'video' ? 'video' : 'photo';
        await db.execute(
          'INSERT INTO `stories` (`id`,`userId`,`mediaUrl`,`mediaType`,`caption`,`viewers`,`expiresAt`,`createdAt`) VALUES (?,?,?,?,?,?,?,?)',
          [story.id, story.userId, story.media, mediaType, story.caption, JSON.stringify([]), story.expiresAt, story.createdAt]
        );
      }
      // Dual-write JSON
      const all = readJSON(STORIES_FILE);
      all.unshift(story);
      writeJSON(STORIES_FILE, all);
      res.status(201).json(story);
    } catch (e) {
      console.error('Story create error:', e.message);
      res.status(500).json({ error: 'Could not save your story.' });
    }
  });
});

// Active story tray — your own + people you follow, grouped by author.
// Order: self first, then unseen (most recent first), then fully-seen.
app.get('/api/stories', auth, async (req, res) => {
  try {
    const followingIds = new Set(readJSON(FOLLOWS_FILE).filter(f => f.followerId === req.userId).map(f => f.followingId));
    followingIds.add(req.userId);
    let stories, seen;
    if (db) {
      const ids = [...followingIds];
      const [rows] = await db.execute(
        `SELECT * FROM \`stories\` WHERE \`userId\` IN (${ids.map(() => '?').join(',')}) AND \`expiresAt\` > NOW() ORDER BY \`createdAt\` ASC`,
        ids
      );
      stories = rows.map(rowToStory);
      seen = new Set();
      rows.forEach(r => { const v = parseJ(r.viewers, []); if (v.includes(req.userId)) seen.add(r.id); });
    } else {
      stories = readJSON(STORIES_FILE).filter(s => isActiveStory(s) && followingIds.has(s.userId));
      const views = readJSON(STORY_VIEWS_FILE);
      seen = new Set(views.filter(v => v.userId === req.userId).map(v => v.storyId));
    }
    const users = readJSON(USERS_FILE);
    const groups = {};
    stories.forEach(s => {
      if (!groups[s.userId]) {
        const u = users.find(x => x.id === s.userId);
        groups[s.userId] = {
          user: { id: s.userId, name: (u && u.name) || 'NutriFell User', username: userHandle(u), avatar: (u && u.avatar) || null },
          isOwn: s.userId === req.userId, stories: [], hasUnseen: false, latestAt: s.createdAt,
        };
      }
      const g = groups[s.userId];
      g.stories.push({ id: s.id, type: s.type, media: s.media, caption: s.caption, createdAt: s.createdAt, expiresAt: s.expiresAt, viewed: seen.has(s.id) });
      if (!seen.has(s.id)) g.hasUnseen = true;
      if (s.createdAt > g.latestAt) g.latestAt = s.createdAt;
    });
    const list = Object.values(groups);
    list.forEach(g => g.stories.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    list.sort((a, b) => {
      if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
      return b.latestAt.localeCompare(a.latestAt);
    });
    res.json({ groups: list });
  } catch (e) { console.error('Stories error:', e.message); res.status(500).json({ error: 'Could not load stories.' }); }
});

// Record that the viewer saw a story (idempotent).
app.post('/api/stories/:id/view', auth, async (req, res) => {
  try {
    let story;
    if (db) {
      const [rows] = await db.execute('SELECT * FROM `stories` WHERE `id`=?', [req.params.id]);
      story = rows[0] ? rowToStory(rows[0]) : null;
    } else {
      story = readJSON(STORIES_FILE).find(s => s.id === req.params.id) || null;
    }
    if (!story || !isActiveStory(story)) return res.status(404).json({ error: 'Story not found.' });
    const isOwner = story.userId === req.userId;
    const alreadyViewed = (story.viewers || []).includes(req.userId);
    if (!isOwner && !alreadyViewed) {
      if (db) {
        const viewers = [...(story.viewers || []), req.userId];
        await db.execute('UPDATE `stories` SET `viewers`=? WHERE `id`=?', [JSON.stringify(viewers), story.id]);
      }
      // Dual-write STORY_VIEWS_FILE (used by GET /api/stories/:id/viewers)
      const views = readJSON(STORY_VIEWS_FILE);
      if (!views.some(v => v.storyId === story.id && v.userId === req.userId)) {
        views.push({ storyId: story.id, userId: req.userId, at: new Date().toISOString() });
        writeJSON(STORY_VIEWS_FILE, views);
      }
      const me = readJSON(USERS_FILE).find(u => u.id === req.userId);
      RT.toUser(story.userId, 'story:viewed', { storyId: story.id, viewer: { id: req.userId, name: (me && me.name) || 'Someone', avatar: (me && me.avatar) || null } });
    }
    res.json({ success: true });
  } catch (e) { console.error('Story view error:', e.message); res.status(500).json({ error: 'Could not record view.' }); }
});

// Who viewed a story — owner only.
app.get('/api/stories/:id/viewers', auth, (req, res) => {
  const story = readJSON(STORIES_FILE).find(s => s.id === req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found.' });
  if (story.userId !== req.userId) return res.status(403).json({ error: 'Not your story.' });
  const users = readJSON(USERS_FILE);
  const viewers = readJSON(STORY_VIEWS_FILE)
    .filter(v => v.storyId === story.id)
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(v => { const u = users.find(x => x.id === v.userId); return { id: v.userId, name: (u && u.name) || 'NutriFell User', username: userHandle(u), avatar: (u && u.avatar) || null, at: v.at }; });
  res.json({ viewers, count: viewers.length });
});

// Delete your own story.
app.delete('/api/stories/:id', auth, async (req, res) => {
  try {
    let story;
    if (db) {
      const [rows] = await db.execute('SELECT * FROM `stories` WHERE `id`=?', [req.params.id]);
      story = rows[0] ? rowToStory(rows[0]) : null;
    } else {
      story = readJSON(STORIES_FILE).find(s => s.id === req.params.id) || null;
    }
    if (!story) return res.status(404).json({ error: 'Story not found.' });
    if (story.userId !== req.userId) return res.status(403).json({ error: 'Not your story.' });
    if (db) await db.execute('DELETE FROM `stories` WHERE `id`=?', [story.id]);
    writeJSON(STORIES_FILE, readJSON(STORIES_FILE).filter(s => s.id !== story.id));
    writeJSON(STORY_VIEWS_FILE, readJSON(STORY_VIEWS_FILE).filter(v => v.storyId !== story.id));
    const fp = path.join(__dirname, 'public', story.media || '');
    try { if (story.media && fp.startsWith(STORIES_UPLOAD_DIR) && fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
    res.json({ success: true });
  } catch (e) { console.error('Story delete error:', e.message); res.status(500).json({ error: 'Could not delete story.' }); }
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 5 · Video transcoding pipeline (ffmpeg)
// Upload → ffprobe duration guard (≤3 min) → transcode to web-optimized
// H.264/AAC mp4 (+faststart) → 400² WebP poster. Runs in the background; the
// client polls /api/upload/video/:jobId/status. Progress + results live in an
// in-memory Map that is garbage-collected after a TTL.
// ═════════════════════════════════════════════════════════════════════════
const MAX_VIDEO_SECONDS = 180;
const uploadProgress = new Map();   // jobId -> { status, progress, videoUrl, thumbnailUrl, error, userId, at }
const JOB_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of uploadProgress) if (now - (job.at || 0) > JOB_TTL) uploadProgress.delete(id);
}, 5 * 60 * 1000);

const videoUpload = (multer && ffmpeg)
  ? multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, VIDEO_TMP_DIR),
        filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname) || '.mp4'}`),
      }),
      limits: { fileSize: 180 * 1024 * 1024, files: 1 },
      fileFilter: (req, file, cb) => {
        const ok = /^video\/(mp4|quicktime|webm|x-msvideo|avi)$/.test(file.mimetype)
          || /\.(mp4|mov|webm|avi)$/i.test(file.originalname || '');
        cb(ok ? null : new Error('Unsupported video format. Use MP4, MOV, WebM or AVI.'), ok);
      },
    })
  : null;

function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, meta) => {
      if (err) return reject(new Error('Could not read the video file.'));
      resolve((meta && meta.format && meta.format.duration) || 0);
    });
  });
}

// Run a transcode job in the background, updating uploadProgress as it goes.
async function runVideoJob(jobId, inputPath) {
  const set = (patch) => uploadProgress.set(jobId, { ...(uploadProgress.get(jobId) || {}), ...patch, at: Date.now() });
  const outBase = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(VIDEOS_UPLOAD_DIR, `${outBase}.mp4`);
  const thumbName = `${outBase}.webp`;
  try {
    set({ status: 'processing', progress: 1 });
    const duration = await probeDuration(inputPath);
    if (duration > MAX_VIDEO_SECONDS) throw new Error(`Video is too long (${Math.round(duration)}s). The limit is 3 minutes.`);
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264').audioCodec('aac')
        .videoBitrate('2000k').audioBitrate('128k')
        .size('?x1080')
        .outputOptions(['-movflags +faststart', '-preset fast', '-crf 23', '-pix_fmt yuv420p'])
        .on('progress', p => set({ progress: Math.max(1, Math.min(99, Math.round(p.percent || 0))) }))
        .on('end', resolve).on('error', reject)
        .save(outPath);
    });
    await new Promise((resolve, reject) => {
      ffmpeg(outPath)
        .on('end', resolve).on('error', reject)
        .screenshots({ timestamps: ['00:00:01'], filename: thumbName, folder: VIDEO_THUMBS_DIR, size: '400x400' });
    });
    set({ status: 'complete', progress: 100, videoUrl: `/uploads/videos/${outBase}.mp4`, thumbnailUrl: `/uploads/videos/thumbs/${thumbName}`, durationSec: Math.round(duration) });
  } catch (e) {
    set({ status: 'failed', error: e.message || 'Transcoding failed.' });
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch { /* ignore */ }
  }
}

// Kick off a transcode; returns a jobId immediately.
app.post('/api/upload/video', auth, (req, res) => {
  if (!ffmpeg || !videoUpload) return res.status(503).json({ error: 'Video processing is unavailable right now.' });
  videoUpload.single('video')(req, res, (uErr) => {
    if (uErr) return res.status(400).json({ error: uErr.message });
    if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });
    const jobId = uuidv4();
    uploadProgress.set(jobId, { status: 'processing', progress: 0, userId: req.userId, at: Date.now() });
    runVideoJob(jobId, req.file.path); // background — not awaited
    res.status(202).json({ jobId, status: 'processing' });
  });
});

// Poll transcode progress / result.
app.get('/api/upload/video/:jobId/status', auth, (req, res) => {
  const job = uploadProgress.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  if (job.userId && job.userId !== req.userId) return res.status(403).json({ error: 'Not your upload.' });
  res.json({
    progress: job.progress || 0, status: job.status,
    videoUrl: job.videoUrl || null, thumbnailUrl: job.thumbnailUrl || null,
    durationSec: job.durationSec || null, error: job.error || null,
  });
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

app.get('/api/hashtags/:tag', async (req, res) => {
  const viewerId = optionalAuth(req);
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '');
  const posts = readJSON(POSTS_FILE).filter(p => (p.hashtags || []).includes(tag));
  const since = Date.now() - 7 * 864e5;
  const recentCount = posts.filter(p => new Date(p.createdAt).getTime() >= since).length;
  const rel = {};
  posts.forEach(p => (p.hashtags || []).forEach(t => { if (t !== tag) rel[t] = (rel[t] || 0) + 1; }));
  const related = Object.entries(rel).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, c]) => ({ tag: t, count: c }));
  const isFollowing = await sIsFollowingHashtag(viewerId, tag);
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

app.post('/api/hashtags/:tag/follow', auth, async (req, res) => {
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '');
  const following = await sToggleHashtagFollow(req.userId, tag);
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

// ... but a request for a missing FILE (has an extension) must 404 — never the
// SPA shell. Returning index.html with 200 for a missing .js/.css/.glb makes the
// browser try to parse HTML as a script/stylesheet/model. Only extensionless
// routes fall through to the SPA shell for client-side routing.
app.get('*', (req, res) => {
  const hasExtension = /\.[a-z0-9]+$/i.test(req.path);
  if (hasExtension && req.path !== '/index.html') {
    // Navigation requests (or explicit .html) get the branded page; bare asset
    // fetches (js/css/glb/png/…) get a minimal, correctly-typed 404.
    const wantsHTML = /\.html$/.test(req.path) || (req.headers.accept || '').includes('text/html');
    if (wantsHTML) {
      return res.status(404).send(errorPage({
        code: 404, title: 'Page not found',
        message: "That page doesn't exist or has moved. Let's get you back on track.",
      }));
    }
    return res.status(404).type('txt').send('Not found');
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

// ═════════════════════════════════════════════════════════════════════════
// Phase 5 · Real-time server (socket.io)
// The HTTP server wraps the Express app so socket.io can share the port. If
// socket.io is unavailable we fall back to a plain app.listen (REST still works;
// the client gracefully degrades to polling).
// ═════════════════════════════════════════════════════════════════════════
const ONLINE_MAX = 50000; // safety cap on the in-memory presence map

if (SocketServer) {
  const http = require('http');
  const httpServer = http.createServer(app);
  io = new SocketServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
  });

  // JWT auth on the handshake; reject anonymous sockets.
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.id;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    socket.join(`user:${userId}`);
    if (onlineUsers.size < ONLINE_MAX) onlineUsers.set(userId, { socketId: socket.id, lastSeen: Date.now() });
    // Tell everyone this user is online, and send the newcomer the current roster.
    io.emit('user:online', userId);
    socket.emit('presence:list', Array.from(onlineUsers.keys()));

    // Live comments: subscribe/unsubscribe to a post's room.
    socket.on('post:subscribe', (postId) => { if (postId) socket.join(`post:${postId}`); });
    socket.on('post:unsubscribe', (postId) => { if (postId) socket.leave(`post:${postId}`); });

    // Typing indicators (ephemeral — not persisted).
    socket.on('dm:typing', ({ toUserId } = {}) => { if (toUserId) io.to(`user:${toUserId}`).emit('dm:typing', { fromUserId: userId }); });
    socket.on('dm:stop_typing', ({ toUserId } = {}) => { if (toUserId) io.to(`user:${toUserId}`).emit('dm:stop_typing', { fromUserId: userId }); });

    // Optional socket send path (REST remains the primary, attachment-capable
    // path). Persists + delivers via the same helper, then confirms to sender.
    socket.on('dm:send', ({ conversationId, text, attachment } = {}, ack) => {
      try {
        const convo = readJSON(CONVERSATIONS_FILE).find(c => c.id === conversationId);
        if (!convo || !convo.participants.includes(userId)) throw new Error('Not your conversation.');
        const msg = persistMessage(convo, userId, { text, attachment });
        socket.emit('dm:sent', { tempId: (attachment && attachment.tempId) || null, message: msg });
        if (typeof ack === 'function') ack({ ok: true, message: msg });
      } catch (e) {
        socket.emit('dm:error', { error: e.message });
        if (typeof ack === 'function') ack({ ok: false, error: e.message });
      }
    });

    socket.on('disconnect', () => {
      // Only drop presence if this was the user's last open socket.
      const room = io.sockets.adapter.rooms.get(`user:${userId}`);
      if (!room || room.size === 0) {
        onlineUsers.set(userId, { socketId: null, lastSeen: Date.now() });
        onlineUsers.delete(userId);
        io.emit('user:offline', userId);
      }
    });
  });

  httpServer.listen(PORT, () => console.log(`NutriFell running at http://localhost:${PORT} (real-time on)`));
} else {
  app.listen(PORT, () => console.log(`NutriFell running at http://localhost:${PORT} (real-time off)`));
}
