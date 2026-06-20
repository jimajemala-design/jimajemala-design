/**
 * generate-music.js — synthesizes an ORIGINAL, royalty-free background track
 * for the NutriFell promo/loop videos. 100% generated here (no samples, no
 * downloads) so there are zero licensing concerns. Output is a seamless
 * 8-bar / 124-BPM loop that <Audio loop> tiles across any composition length.
 *
 * Energetic "fitness" vibe: four-on-the-floor kick, backbeat clap, offbeat
 * hats, a driving square bass, plucky chord stabs and a sparkly arp, over an
 * uplifting Am–F–C–G progression.
 *
 *   node scripts/generate-music.js
 *   → remotion/public/music.wav   (44.1kHz · 16-bit · stereo)
 *
 * Want a different track? Replace public/music.wav (or music.mp3) with your own
 * file and the videos pick it up with no code change.
 */
const fs = require("fs");
const path = require("path");

const SR = 44100;
const BPM = 124;
const BEATS = 32;                       // 8 bars of 4/4
const SPB = 60 / BPM;                   // seconds per beat
const N = Math.round(BEATS * SPB * SR); // total samples (seamless loop length)

const L = new Float32Array(N);
const R = new Float32Array(N);

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;

// Deterministic PRNG so the track is identical on every run.
let _seed = 1337;
const rand = () => {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
};

// Add one voice into the stereo buffers.
//   startSec, durSec — placement / length
//   freq            — Hz (ignored for noise)
//   amp             — peak gain
//   wave            — 'sine' | 'saw' | 'square' | 'tri' | 'noise'
//   attackSec, decaySec — AD envelope (exp decay after attack)
//   pan             — -1 (L) .. 0 (C) .. 1 (R)
//   sweepTo         — optional end freq for a pitch sweep (kick)
function voice(startSec, durSec, freq, amp, wave, attackSec, decaySec, pan = 0, sweepTo = null) {
  const start = Math.round(startSec * SR);
  const len = Math.round(durSec * SR);
  const atk = Math.max(1, Math.round(attackSec * SR));
  const dec = Math.max(1, decaySec * SR);
  const gl = Math.cos((pan + 1) * Math.PI / 4); // equal-power pan
  const gr = Math.sin((pan + 1) * Math.PI / 4);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= N || idx < 0) continue;
    const f = sweepTo == null ? freq : freq + (sweepTo - freq) * (i / len);
    phase += (TAU * f) / SR;
    let s;
    switch (wave) {
      case "saw":    s = ((phase / TAU) % 1) * 2 - 1; break;
      case "square": s = Math.sin(phase) >= 0 ? 1 : -1; break;
      case "tri":    s = Math.asin(Math.sin(phase)) * (2 / Math.PI); break;
      case "noise":  s = rand() * 2 - 1; break;
      default:       s = Math.sin(phase);
    }
    // AD envelope: linear attack, exponential decay.
    const e = i < atk ? i / atk : Math.exp(-(i - atk) / dec);
    const v = s * amp * e;
    L[idx] += v * gl;
    R[idx] += v * gr;
  }
}

// ── Drums ──────────────────────────────────────────────────────────────────
const kick = (b)  => voice(b * SPB, 0.22, 150, 0.95, "sine", 0.002, 0.10 * SR, 0, 48);
const clap = (b)  => { for (let k = 0; k < 3; k++) voice(b * SPB + k * 0.008, 0.14, 0, 0.32, "noise", 0.001, 0.05 * SR, 0); };
const hat  = (b, a, pan) => voice(b * SPB, 0.05, 0, a, "noise", 0.001, 0.012 * SR, pan);

// ── Harmony: Am – F – C – G (each chord = 2 bars = 8 beats) ─────────────────
const CHORDS = [
  { root: 45, tones: [57, 60, 64] }, // Am  (A2 ; A3 C4 E4)
  { root: 41, tones: [53, 57, 60] }, // F   (F2 ; F3 A3 C4)
  { root: 48, tones: [60, 64, 67] }, // C   (C3 ; C4 E4 G4)
  { root: 43, tones: [55, 59, 62] }, // G   (G2 ; G3 B3 D4)
];
const chordAt = (b) => CHORDS[Math.floor(b / 8) % CHORDS.length];

for (let b = 0; b < BEATS; b++) {
  const c = chordAt(b);

  kick(b);
  if (b % 2 === 1) clap(b);                         // backbeat on beats 2 & 4
  hat(b, 0.10, -0.15);                              // downbeat hat (quiet)
  hat(b + 0.5, 0.20, 0.15);                         // offbeat hat (accent)

  // Square bass — two eighths per beat, an octave below the chord root.
  voice(b * SPB,        0.46 * SPB, midi(c.root), 0.30, "square", 0.004, 0.14 * SR, 0);
  voice((b + 0.5) * SPB, 0.46 * SPB, midi(c.root), 0.26, "square", 0.004, 0.10 * SR, 0);

  // Plucky chord stab on every beat (saw triad, short decay).
  c.tones.forEach((m, j) =>
    voice(b * SPB, 0.5, midi(m), 0.085, "saw", 0.003, 0.16 * SR, (j - 1) * 0.35)
  );

  // Sparkle arp — four sixteenths per beat, chord tones up an octave.
  const arp = [c.tones[0], c.tones[1], c.tones[2], c.tones[1]];
  for (let s = 0; s < 4; s++) {
    voice((b + s / 4) * SPB, 0.22, midi(arp[s] + 12), 0.07, "tri", 0.002, 0.06 * SR,
          (s % 2 ? 0.4 : -0.4));
  }
}

// ── Normalize + soft limit, then write 16-bit stereo WAV ────────────────────
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = 0.9 / (peak || 1);

const data = Buffer.alloc(N * 4); // 2 ch × 16-bit
for (let i = 0; i < N; i++) {
  const sl = Math.tanh(L[i] * norm);   // tanh = gentle limiting on transients
  const sr = Math.tanh(R[i] * norm);
  data.writeInt16LE(Math.round(sl * 32767), i * 4);
  data.writeInt16LE(Math.round(sr * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);          // PCM
header.writeUInt16LE(2, 22);          // stereo
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);     // byte rate
header.writeUInt16LE(4, 32);          // block align
header.writeUInt16LE(16, 34);         // bits/sample
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

const outDir = path.join(__dirname, "..", "public");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "music.wav");
fs.writeFileSync(outPath, Buffer.concat([header, data]));

const secs = (N / SR).toFixed(2);
console.log(`✅ Wrote ${outPath}`);
console.log(`   ${secs}s seamless loop · ${BPM} BPM · 44.1kHz/16-bit stereo · ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB`);
