require('dotenv').config();
const http = require('http');
const jwt  = require('jsonwebtoken');

const SECRET = (process.env.JWT_SECRET || 'nutrifell-georgia-secret-key-2035').trim();
const users  = require('./data/users.json');

const user = users.find(u => u.email === 'itoko@gmail.com') || users[1];
const TOKEN = jwt.sign({ id: user.id }, SECRET, { expiresIn: '1h' });

let pass = 0, fail = 0;

function req(method, path, body, auth = true) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = {};
    if (auth)  headers['Authorization'] = 'Bearer ' + TOKEN;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = http.request({ host: 'localhost', port: 3000, path, method, headers }, (rs) => {
      let d = '';
      rs.on('data', c => d += c);
      rs.on('end', () => resolve({ code: rs.statusCode, body: d }));
    });
    r.on('error', e => resolve({ code: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

function check(label, code, body, expectCode = 200, bodyCheck = null) {
  const codeOk = code === expectCode;
  const bodyOk = bodyCheck ? body.includes(bodyCheck) : true;
  const ok = codeOk && bodyOk;
  if (ok) { pass++; console.log(`  PASS  ${label} -> ${code}`); }
  else     { fail++; console.error(`  FAIL  ${label} -> ${code} (expected ${expectCode})${bodyCheck && !bodyOk ? ' | body missing: '+bodyCheck : ''}\n         ${body.slice(0,150)}`); }
  return ok;
}

(async () => {
  console.log(`\n=== NutriFell API Audit  user=${user.email} ===\n`);

  let r;

  // ── Foods ──────────────────────────────────────────────────────
  console.log('-- Foods --');
  r = await req('GET', '/api/foods', null, false);
  check('GET /api/foods', r.code, r.body, 200);
  let foodCount = 0;
  try { foodCount = JSON.parse(r.body).length; console.log(`   food count: ${foodCount}`); } catch(e) { console.error('   parse error:', e.message); }

  r = await req('GET', '/api/foods/apple', null, false);
  check('GET /api/foods/apple', r.code, r.body, 200, 'apple');

  r = await req('GET', '/api/foods/fish', null, false);  // salmon's id is 'fish'
  check('GET /api/foods/fish (salmon)', r.code, r.body, 200, 'Salmon');

  r = await req('GET', '/api/foods/apple', null, false);
  check('GET /api/foods/apple', r.code, r.body, 200, 'apple');

  r = await req('GET', '/api/foods/nonexistent999', null, false);
  check('GET /api/foods/nonexistent -> 404', r.code, r.body, 404);

  r = await req('GET', '/api/search?q=apple', null, false);
  check('GET /api/search?q=apple', r.code, r.body, 200);

  // ── Auth ───────────────────────────────────────────────────────
  console.log('\n-- Auth --');
  // Registration uses 2-step email-code flow: send-code -> verify-code
  // Direct /api/register also exists for legacy/testing
  const ts = Date.now();
  r = await req('POST', '/api/register', {
    name: 'AuditBot', email: `audit_${ts}@test.com`, password: 'Test1234!'
  }, false);
  check('POST /api/register', r.code, r.body, 201, 'token');

  r = await req('POST', '/api/auth/send-code', { name: 'Test', email: `sc_${ts}@test.com`, password: 'Test1234!' }, false);
  check('POST /api/auth/send-code', r.code, r.body, 200);

  r = await req('POST', '/api/login', { email: 'itoko@gmail.com', password: 'wrongpass' }, false);
  check('POST /api/login bad creds -> 401', r.code, r.body, 401);

  r = await req('POST', '/api/login', { email: 'nonexistent@x.com', password: 'pass' }, false);
  check('POST /api/login no user -> 401', r.code, r.body, 401);

  // ── No-token guard ─────────────────────────────────────────────
  console.log('\n-- Auth guard (no token -> 401) --');
  r = await req('GET', '/api/fridge', null, false);
  check('GET /api/fridge no token -> 401', r.code, r.body, 401);
  r = await req('GET', '/api/feed', null, false);
  check('GET /api/feed no token -> 200 (public feed)', r.code, r.body, 200);  // feed is intentionally public

  // ── Authenticated endpoints ────────────────────────────────────
  console.log('\n-- Authenticated --');
  r = await req('GET', '/api/fridge');
  check('GET /api/fridge', r.code, r.body, 200);

  r = await req('GET', '/api/feed');
  check('GET /api/feed', r.code, r.body, 200);

  r = await req('GET', '/api/water/today');
  check('GET /api/water/today', r.code, r.body, 200);

  r = await req('GET', '/api/smoking/stats');
  check('GET /api/smoking/stats', r.code, r.body, 200);

  r = await req('GET', '/api/notifications');
  check('GET /api/notifications', r.code, r.body, 200);

  r = await req('GET', '/api/profile');
  check('GET /api/profile', r.code, r.body, 200);

  r = await req('GET', '/api/conversations');   // correct route (not /api/messages/conversations)
  check('GET /api/conversations', r.code, r.body, 200);

  r = await req('GET', '/api/stories');
  check('GET /api/stories', r.code, r.body, 200);

  r = await req('GET', '/api/reels');
  check('GET /api/reels', r.code, r.body, 200);

  r = await req('GET', '/api/recipes');
  check('GET /api/recipes', r.code, r.body, 200);

  // ── Write + cleanup ────────────────────────────────────────────
  console.log('\n-- Write operations --');

  r = await req('POST', '/api/fridge', { name: 'audit_tomato', category: 'vegetables', quantity: '2', unit: 'pcs', expiry: '2026-07-01' });
  check('POST /api/fridge', r.code, r.body, 201);
  const fridgeId = (() => { try { return JSON.parse(r.body).id; } catch { return null; } })();
  if (fridgeId) {
    r = await req('DELETE', `/api/fridge/${fridgeId}`);
    check('DELETE /api/fridge/:id cleanup', r.code, r.body, 200);
  }

  r = await req('POST', '/api/posts', { type: 'text', caption: 'audit test post' });
  check('POST /api/posts', r.code, r.body, 201);
  const postId = (() => { try { const j = JSON.parse(r.body); return j.id || (j.post && j.post.id); } catch { return null; } })();
  if (postId) {
    r = await req('DELETE', `/api/posts/${postId}`);
    check('DELETE /api/posts/:id cleanup', r.code, r.body, 200);
  }

  r = await req('POST', '/api/water/add', { ml: 250 });   // correct route + payload
  check('POST /api/water/add', r.code, r.body, 201);  // creates entry -> 201

  r = await req('POST', '/api/ai/chat', { message: 'What is the protein content of chicken?' });
  check('POST /api/ai/chat', r.code, r.body, 200);

  // ── Static assets / 404 behaviour ─────────────────────────────
  console.log('\n-- Static assets --');
  r = await req('GET', '/js/scene.js', null, false);
  check('GET /js/scene.js -> 200', r.code, r.body, 200);

  r = await req('GET', '/js/i18n.js', null, false);
  check('GET /js/i18n.js -> 200', r.code, r.body, 200);

  r = await req('GET', '/models/apple.glb', null, false);
  check('GET /models/apple.glb -> 200', r.code, r.body, 200);

  r = await req('GET', '/models/banana.glb', null, false);
  check('GET /models/banana.glb -> 200', r.code, r.body, 200);

  r = await req('GET', '/js/nonexistent.js', null, false);
  check('GET /js/nonexistent.js -> 404', r.code, r.body, 404);

  r = await req('GET', '/models/corn.glb', null, false);
  check('GET /models/corn.glb -> 404 (skipped intentionally)', r.code, r.body, 404);

  // SPA routes still serve index.html with 200
  r = await req('GET', '/fridge', null, false);
  check('GET /fridge (SPA) -> 200 index.html', r.code, r.body, 200, '<!DOCTYPE');

  r = await req('GET', '/feed', null, false);
  check('GET /feed (SPA) -> 200 index.html', r.code, r.body, 200, '<!DOCTYPE');

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (foodCount && foodCount !== 74) console.warn(`WARNING: Expected 74 foods, got ${foodCount}`);
  process.exit(fail > 0 ? 1 : 0);
})();
