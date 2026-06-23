/* Phase 5 live-feed verification — the server→client event contract consumed by
   Feed.onNewPost / onReaction / onComment / onCommentCount.
   Checks payload shapes AND room scoping (comment:new is post-room only). */
'use strict';
const { io } = require('socket.io-client');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const log = (ok, m) => console.log(`${ok ? '✅' : '❌'} ${m}`);
let failures = 0; const check = (ok, m) => { if (!ok) failures++; log(ok, m); };

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(d)}`);
  return d;
}
async function makeUser(tag) {
  const out = await api('/api/register', { method: 'POST', body: { email: `p5f_${tag}_${Date.now()}@test.local`, name: tag, password: 'pw123456' } });
  return { token: out.token, id: (out.user && out.user.id) || out.id, name: tag };
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket', 'polling'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}
const waitFor = (sock, event, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout: ${event}`)), ms);
  sock.once(event, (p) => { clearTimeout(t); resolve(p); });
});
const expectNone = (sock, event, ms = 1500) => new Promise((resolve) => {
  const onEv = () => { clearTimeout(t); resolve(false); };       // got it (bad)
  const t = setTimeout(() => { sock.off(event, onEv); resolve(true); }, ms);
  sock.once(event, onEv);
});

(async () => {
  console.log('— Phase 5 live-feed verification —');
  const alice = await makeUser('alice');   // poster
  const bob = await makeUser('bob');        // reactor/commenter
  const carol = await makeUser('carol');    // viewer with comment sheet OPEN (subscribed)
  const dave = await makeUser('dave');      // viewer with sheet CLOSED (not subscribed)
  const [aS, bS, cS, dS] = await Promise.all([connect(alice.token), connect(bob.token), connect(carol.token), connect(dave.token)]);
  log(true, 'four clients connected');

  // 1) feed:new_post broadcast → onNewPost
  const newP = waitFor(bS, 'feed:new_post');
  const post = await api('/api/posts', { method: 'POST', token: alice.token, body: { type: 'text', caption: 'live feed test' } });
  const np = await newP.catch(() => null);
  check(np && np.postId === post.id, `feed:new_post broadcast (postId match: ${np && np.postId === post.id})`);
  check(np && np.author && np.author.id === alice.id, 'feed:new_post carries author id (client filters own posts)');

  // 2) post:reaction broadcast → onReaction
  const reactP = waitFor(cS, 'post:reaction');
  await api(`/api/posts/${post.id}/like`, { method: 'POST', token: bob.token });
  const rp = await reactP.catch(() => null);
  check(rp && rp.postId === post.id && rp.total >= 1, `post:reaction has {postId,total} (total=${rp && rp.total})`);
  check(rp && rp.counts && typeof rp.counts === 'object', 'post:reaction has counts map (for summary emojis)');

  // 3) comment events: carol subscribes to the post room (sheet open); dave does not.
  cS.emit('post:subscribe', post.id);
  await new Promise(r => setTimeout(r, 300)); // let the join land

  const carolFull = waitFor(cS, 'comment:new');      // should arrive (subscribed)
  const carolCount = waitFor(cS, 'post:comment');    // should arrive (broadcast)
  const daveCount = waitFor(dS, 'post:comment');     // should arrive (broadcast)
  const daveNoFull = expectNone(dS, 'comment:new');  // should NOT arrive (not subscribed)

  const comment = await api(`/api/posts/${post.id}/comments`, { method: 'POST', token: bob.token, body: { text: 'nice one 🔥' } });

  const cFull = await carolFull.catch(() => null);
  check(cFull && cFull.comment && cFull.comment.text === 'nice one 🔥', `comment:new delivered to subscriber w/ full comment ("${cFull && cFull.comment ? cFull.comment.text : 'none'}")`);
  check(cFull && Array.isArray(cFull.comment.replies), 'comment:new comment is sheet-ready (has replies[])');
  const cCount = await carolCount.catch(() => null);
  check(cCount && cCount.postId === post.id && cCount.total >= 1, `post:comment count bump (total=${cCount && cCount.total})`);
  const dCount = await daveCount.catch(() => null);
  check(!!dCount, 'post:comment broadcast reaches non-subscriber (card count updates everywhere)');
  const daveClean = await daveNoFull;
  check(daveClean, 'comment:new is room-scoped (non-subscriber did NOT receive it)');

  [aS, bS, cS, dS].forEach(s => s.close());
  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ ALL live-feed checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
