/* Phase 5 video pipeline verification.
   Registers a user, uploads a real clip to /api/upload/video, polls the job to
   completion, then posts a reel using the transcoded videoUrl + thumb. */
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const CLIP = path.join(__dirname, 'tmp', 'test-clip.mp4');
const log = (ok, m) => console.log(`${ok ? '✅' : '❌'} ${m}`);
let failures = 0; const check = (ok, m) => { if (!ok) failures++; log(ok, m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jpost(p, token, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p} → ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

(async () => {
  console.log('— Phase 5 video pipeline verification —');
  const reg = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `p5_vid_${Date.now()}@test.local`, name: 'vid', password: 'pw123456' }) });
  const { token } = await reg.json();
  log(true, 'registered uploader');

  // Upload (multipart) → jobId.
  const buf = fs.readFileSync(CLIP);
  const fd = new FormData();
  fd.append('video', new Blob([buf], { type: 'video/mp4' }), 'test-clip.mp4');
  const upRes = await fetch(BASE + '/api/upload/video', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const up = await upRes.json().catch(() => null);
  check(upRes.status === 202 && up && up.jobId, `upload accepted (202, jobId=${up && up.jobId ? up.jobId.slice(0,8) : 'none'})`);
  if (!up || !up.jobId) { process.exit(1); }

  // Poll every 2s until complete/failed.
  let status = null, tries = 0;
  while (tries++ < 30) {
    await sleep(2000);
    const sRes = await fetch(BASE + `/api/upload/video/${up.jobId}/status`, { headers: { Authorization: 'Bearer ' + token } });
    status = await sRes.json();
    process.stdout.write(`   poll ${tries}: ${status.status} ${status.progress || 0}%\n`);
    if (status.status === 'complete' || status.status === 'failed') break;
  }
  check(status && status.status === 'complete', `transcode completed (${status && status.status})`);
  check(status && /^\/uploads\/videos\/.+\.mp4$/.test(status.videoUrl || ''), `videoUrl produced (${status && status.videoUrl})`);
  check(status && !!status.thumbnailUrl, `thumbnail produced (${status && status.thumbnailUrl})`);

  // Transcoded file is actually served.
  if (status && status.videoUrl) {
    const vRes = await fetch(BASE + status.videoUrl);
    check(vRes.ok, `transcoded video served (HTTP ${vRes.status})`);
  }

  // Post a reel referencing the transcoded path.
  if (status && status.videoUrl) {
    const post = await jpost('/api/posts', token, { type: 'video', caption: 'phase5 reel', videoUrl: status.videoUrl, videoThumb: status.thumbnailUrl });
    check(post && post.type === 'video' && post.video === status.videoUrl, `reel posted with transcoded video (${post && post.id ? post.id.slice(0,8) : 'fail'})`);
  }

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ ALL video-pipeline checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
