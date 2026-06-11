/**
 * GradientWave — animated color blobs + layered SVG wave paths.
 *
 * Three colour spheres (green, cream, gold) drift in slow Lissajous loops
 * while SVG wave paths add structured texture on top.
 * All position/opacity/colour values come from interpolate().
 */

import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a filled wave SVG path from the bottom of the canvas up to a sine curve.
 * Two harmonics create the organic look.
 */
function wavePath(
  W: number,
  H: number,
  midY: number,
  amp1: number,
  amp2: number,
  freq1: number,
  freq2: number,
  phase: number
): string {
  const step = 18;
  let d = `M 0 ${H}`;

  for (let x = 0; x <= W; x += step) {
    const n = x / W;
    const y =
      midY +
      Math.sin(n * Math.PI * 2 * freq1 + phase) * amp1 +
      Math.sin(n * Math.PI * 2 * freq2 + phase * 1.37) * amp2;
    d += ` L ${x.toFixed(1)} ${y.toFixed(2)}`;
  }

  // Close right edge + bottom fill
  const nEnd = 1;
  const yEnd =
    midY +
    Math.sin(nEnd * Math.PI * 2 * freq1 + phase) * amp1 +
    Math.sin(nEnd * Math.PI * 2 * freq2 + phase * 1.37) * amp2;
  d += ` L ${W} ${yEnd.toFixed(2)} L ${W} ${H} Z`;
  return d;
}

/** Lerps a single channel, returns integer 0-255. */
const ch = (a: number, b: number, t: number) =>
  Math.round(interpolate(t, [0, 1], [a, b]));

// ─── Palette ─────────────────────────────────────────────────────────────────
const NAVY  = { r: 26,  g: 31,  b: 58  }; // #1a1f3a
const GREEN = { r: 45,  g: 122, b: 74  }; // #2d7a4a
const CREAM = { r: 245, g: 243, b: 240 }; // #f5f3f0
const GOLD  = { r: 212, g: 165, b: 116 }; // #d4a574

// ─── Component ────────────────────────────────────────────────────────────────
export const GradientWave: React.FC = () => {
  console.log('GradientWave rendering');
  const frame = useCurrentFrame();
  const { durationInFrames, width: W, height: H } = useVideoConfig();

  // Master time: 0 → 2π  (integer-frequency functions loop perfectly)
  const t = interpolate(frame, [0, durationInFrames], [0, Math.PI * 2]);

  // ── Colour-blob positions ──────────────────────────────────────────────────
  // Each blob orbits in a slow Lissajous figure.  Using integer frequency
  // multiples ensures position at frame 0 == position at frame 360.

  const g1x = interpolate(Math.sin(t * 1), [-1, 1], [W * 0.05, W * 0.45]);
  const g1y = interpolate(Math.cos(t * 1), [-1, 1], [H * 0.30, H * 0.80]);

  const g2x = interpolate(Math.cos(t * 2), [-1, 1], [W * 0.40, W * 0.85]);
  const g2y = interpolate(Math.sin(t * 1), [-1, 1], [H * 0.10, H * 0.55]);

  const c1x = interpolate(Math.sin(t * 1 + 1), [-1, 1], [W * 0.55, W * 0.95]);
  const c1y = interpolate(Math.cos(t * 2),      [-1, 1], [H * 0.15, H * 0.65]);

  const d1x = interpolate(Math.cos(t * 1 + 2), [-1, 1], [W * 0.20, W * 0.70]);
  const d1y = interpolate(Math.sin(t * 2),      [-1, 1], [H * 0.50, H * 0.95]);

  // Gold accent blob — moves counter to the green blobs
  const goldX = interpolate(Math.sin(t * 2 + 0.5), [-1, 1], [W * 0.60, W * 0.90]);
  const goldY = interpolate(Math.cos(t * 1 + 1.5), [-1, 1], [H * 0.05, H * 0.40]);

  // ── Colour-morph for SVG waves ─────────────────────────────────────────────
  // Wave 1 slowly cycles from green toward navy and back.
  const w1MorphT = interpolate(Math.sin(t), [-1, 1], [0, 1]);
  const w1R = ch(GREEN.r, NAVY.r, w1MorphT);
  const w1G = ch(GREEN.g, NAVY.g, w1MorphT);
  const w1B = ch(GREEN.b, NAVY.b, w1MorphT);
  const w1Color = `rgb(${w1R},${w1G},${w1B})`;

  // Wave 2 pulses between cream and gold
  const w2MorphT = interpolate(Math.cos(t * 2), [-1, 1], [0, 1]);
  const w2R = ch(CREAM.r, GOLD.r, w2MorphT);
  const w2G = ch(CREAM.g, GOLD.g, w2MorphT);
  const w2B = ch(CREAM.b, GOLD.b, w2MorphT);
  const w2Color = `rgb(${w2R},${w2G},${w2B})`;

  // ── Wave shape parameters ──────────────────────────────────────────────────
  // Wave phase advances 2 integer cycles → seamless loop
  const wave1Phase = interpolate(frame, [0, durationInFrames], [0, Math.PI * 4]);
  const wave2Phase = interpolate(frame, [0, durationInFrames], [0, -Math.PI * 4]);

  const w1MidY = interpolate(Math.sin(t), [-1, 1], [H * 0.48, H * 0.62]);
  const w1Amp1 = interpolate(Math.cos(t * 2), [-1, 1], [55, 120]);
  const w1Amp2 = interpolate(Math.sin(t * 2), [-1, 1], [20, 50]);

  const w2MidY = interpolate(Math.cos(t), [-1, 1], [H * 0.28, H * 0.44]);
  const w2Amp1 = interpolate(Math.sin(t * 2 + 1), [-1, 1], [40, 90]);
  const w2Amp2 = interpolate(Math.cos(t * 2 + 1), [-1, 1], [15, 35]);

  // ── Wave opacity ──────────────────────────────────────────────────────────
  const w1Opacity = interpolate(Math.sin(t + 0.5), [-1, 1], [0.30, 0.55]);
  const w2Opacity = interpolate(Math.cos(t * 2),   [-1, 1], [0.08, 0.18]);

  // ── Blob size pulse ───────────────────────────────────────────────────────
  const blobScale1 = interpolate(Math.sin(t), [-1, 1], [700, 900]);
  const blobScale2 = interpolate(Math.cos(t * 2), [-1, 1], [500, 750]);
  const blobScaleC = interpolate(Math.sin(t + 1), [-1, 1], [600, 820]);
  const blobScaleG = interpolate(Math.cos(t * 2 + 0.5), [-1, 1], [400, 600]);

  // ── Vignette opacity ──────────────────────────────────────────────────────
  const vigOpacity = interpolate(Math.sin(t * 0.5), [-1, 1], [0.40, 0.56]);

  return (
    <AbsoluteFill style={{ background: "#1a1f3a", overflow: "hidden" }}>

      {/* ── Layer 1: animated colour blobs ─────────────────────────────── */}
      {/* Green blob A */}
      <div style={{
        position: "absolute",
        width: blobScale1, height: blobScale1,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(${GREEN.r},${GREEN.g},${GREEN.b},0.38) 0%, transparent 70%)`,
        left: g1x - blobScale1 / 2,
        top:  g1y - blobScale1 / 2,
      }} />

      {/* Green blob B — offset orbit */}
      <div style={{
        position: "absolute",
        width: blobScale2, height: blobScale2,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(${GREEN.r},${GREEN.g},${GREEN.b},0.28) 0%, transparent 70%)`,
        left: g2x - blobScale2 / 2,
        top:  g2y - blobScale2 / 2,
      }} />

      {/* Cream blob */}
      <div style={{
        position: "absolute",
        width: blobScaleC, height: blobScaleC,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(${CREAM.r},${CREAM.g},${CREAM.b},0.10) 0%, transparent 70%)`,
        left: c1x - blobScaleC / 2,
        top:  c1y - blobScaleC / 2,
      }} />

      {/* Dark navy depth blob */}
      <div style={{
        position: "absolute",
        width: blobScaleC, height: blobScaleC,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(12,15,32,0.55) 0%, transparent 70%)`,
        left: d1x - blobScaleC / 2,
        top:  d1y - blobScaleC / 2,
      }} />

      {/* Gold accent blob */}
      <div style={{
        position: "absolute",
        width: blobScaleG, height: blobScaleG,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(${GOLD.r},${GOLD.g},${GOLD.b},0.12) 0%, transparent 70%)`,
        left: goldX - blobScaleG / 2,
        top:  goldY - blobScaleG / 2,
      }} />

      {/* ── Layer 2: SVG wave paths ─────────────────────────────────────── */}
      <svg
        width={W}
        height={H}
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        <defs>
          {/* Wave 1: gradient from transparent at top to wave colour at bottom */}
          <linearGradient id="wg1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={w1Color} stopOpacity="0" />
            <stop offset="40%"  stopColor={w1Color} stopOpacity={w1Opacity * 0.4} />
            <stop offset="100%" stopColor={w1Color} stopOpacity={w1Opacity} />
          </linearGradient>

          {/* Wave 2: subtle cream/gold shimmer */}
          <linearGradient id="wg2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={w2Color} stopOpacity="0" />
            <stop offset="100%" stopColor={w2Color} stopOpacity={w2Opacity} />
          </linearGradient>
        </defs>

        {/* Lower, richer wave */}
        <path
          d={wavePath(W, H, w1MidY, w1Amp1, w1Amp2, 2, 4, wave1Phase)}
          fill="url(#wg1)"
        />

        {/* Upper, subtle wave */}
        <path
          d={wavePath(W, H, w2MidY, w2Amp1, w2Amp2, 3, 5, wave2Phase)}
          fill="url(#wg2)"
        />
      </svg>

      {/* ── Layer 3: radial vignette ────────────────────────────────────── */}
      <div style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(ellipse 85% 75% at 50% 50%, transparent 35%, rgba(10,13,28,${vigOpacity}) 100%)`,
        pointerEvents: "none",
      }} />

    </AbsoluteFill>
  );
};
