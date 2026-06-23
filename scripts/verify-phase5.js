/* Phase 5 end-to-end verification (real-time).
   Simulates two browser tabs (Alice + Bob) over socket.io + REST:
   1. Bob likes Alice's post   → Alice's tab gets notification:new instantly
   2. Alice sends Bob a DM      → Bob's tab gets dm:receive instantly
   3. Alice typing              → Bob's tab gets dm:typing
   4. Bob opens/reads thread    → Alice's tab gets dm:read (blue ticks)
   Run with the server already up on PORT (default 3000). */
'use strict';
const { io } = require('socket.io-client');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const log = (ok, msg) => console.log(`${ok ? '✅' : '❌'} ${msg}`);
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; log(ok, msg); };

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function makeUser(tag) {
  const email = `p5_${tag}_${Date.now()}@test.local`;
  // Legacy direct register avoids the email round-trip; returns { token, user }.
  const out = await api('/api/register', { method: 'POST', body: { email, name: tag, password: 'pw123456' } });
  return { token: out.token, id: (out.user && out.user.id) || out.id, name: tag };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket', 'polling'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}
const waitFor = (sock, event, ms = 6000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
  sock.once(event, (payload) => { clearTimeout(t); resolve(payload); });
});

(async () => {
  console.log('— Phase 5 real-time verification —');
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  log(true, `registered alice(${alice.id.slice(0,8)}) + bob(${bob.id.slice(0,8)})`);

  const aSock = await connect(alice.token);
  const bSock = await connect(bob.token);
  log(true, 'both sockets connected (handshake JWT auth OK)');

  // Presence: each should learn the other is online.
  const onlineSeen = await waitFor(aSock, 'user:online').then(() => true).catch(() => false);
  check(onlineSeen, 'presence: alice received a user:online event');

  // Alice creates a post (REST).
  const post = await api('/api/posts', { method: 'POST', token: alice.token, body: { type: 'text', caption: 'Phase 5 test post' } });
  check(!!post.id, `alice created a post (${post.id ? post.id.slice(0,8) : 'FAIL'})`);

  // 1) Bob likes it → Alice should get notification:new live.
  const notifP = waitFor(aSock, 'notification:new');
  await api(`/api/posts/${post.id}/like`, { method: 'POST', token: bob.token });
  const notif = await notifP.catch(() => null);
  check(notif && notif.type === 'like', `notification:new arrived at alice live (${notif ? notif.type : 'none'})`);

  // 2) Alice DMs Bob → Bob should get dm:receive live.
  const convo = await api('/api/conversations', { method: 'POST', token: alice.token, body: { userId: bob.id } });
  const dmP = waitFor(bSock, 'dm:receive');
  await api(`/api/conversations/${convo.id}/messages`, { method: 'POST', token: alice.token, body: { text: 'hey bob 👋' } });
  const dm = await dmP.catch(() => null);
  check(dm && dm.message && dm.message.text === 'hey bob 👋', `dm:receive arrived at bob live ("${dm && dm.message ? dm.message.text : 'none'}")`);

  // 3) Typing indicator: alice types → bob gets dm:typing.
  const typingP = waitFor(bSock, 'dm:typing');
  aSock.emit('dm:typing', { toUserId: bob.id });
  const typing = await typingP.catch(() => null);
  check(typing && typing.fromUserId === alice.id, 'dm:typing relayed alice → bob');

  // 4) Bob reads the thread → alice gets dm:read (blue ticks).
  const readP = waitFor(aSock, 'dm:read');
  await api(`/api/conversations/${convo.id}/read`, { method: 'PUT', token: bob.token });
  const read = await readP.catch(() => null);
  check(read && read.conversationId === convo.id, 'dm:read arrived at alice (read receipt)');

  // 5) socket dm:send path (alternative to REST) with ack.
  const ackP = new Promise((resolve) => aSock.emit('dm:send', { conversationId: convo.id, text: 'via socket' }, resolve));
  const recvP = waitFor(bSock, 'dm:receive');
  const ack = await ackP;
  const recv = await recvP.catch(() => null);
  check(ack && ack.ok && recv && recv.message.text === 'via socket', 'socket dm:send persisted + delivered + acked');

  aSock.close(); bSock.close();
  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ ALL real-time checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
