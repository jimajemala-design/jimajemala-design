/**
 * ParticleFlow — dots drift upward on sinusoidal paths.
 *
 * Each particle has its own cycle time (a divisor of 360) so every particle
 * completes an integer number of cycles per composition → perfect seamless loop.
 *
 * All position and opacity values are computed via interpolate().
 */

import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { BackgroundMusic } from "../BackgroundMusic";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Particle {
  startX: number;    // base horizontal position (px)
  frameOffset: number; // frame at which this particle starts its cycle
  cycleFrames: number; // duration of one full up-drift cycle
  waveAmp: number;   // horizontal sinusoidal amplitude (px)
  waveFreq: number;  // number of horizontal oscillations per screen height
  wavePhase: number; // horizontal phase offset (radians)
  r: number;         // dot radius (px)
  baseOpacity: number;
  color: string;
  isGlow: boolean;   // larger particles get an SVG glow filter
}

// ─── Palette ──────────────────────────────────────────────────────────────────
const COLORS = [
  "#2d7a4a", // green
  "#d4a574", // gold
  "#f5f3f0", // cream
  "#a8c4b4", // sage
  "#e8d4b8", // warm cream
];

// ─── Divisors of 360 used as cycle lengths ────────────────────────────────────
// Ensures every particle completes integer cycles within the 360-frame comp.
const CYCLE_OPTIONS = [360, 180, 120, 90, 72];

// ─── Generate stable particle data (module-level constant) ───────────────────
const NUM_PARTICLES = 80;

function buildParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    // Evenly space base X positions with golden-ratio variation
    const rawX = (i / count) * 1920 + Math.sin(i * 2.399) * 140;
    const startX = ((rawX % 1920) + 1920) % 1920;

    // Stagger entry: spread offset across the chosen cycle length
    const cycleFrames = CYCLE_OPTIONS[i % CYCLE_OPTIONS.length];
    const frameOffset = Math.round((i / count) * cycleFrames);

    return {
      startX,
      frameOffset,
      cycleFrames,
      waveAmp:   20 + (i % 9) * 13,                      // 20 – 124 px
      waveFreq:  1.5 + (i % 5) * 0.6,                    // 1.5 – 3.9 cycles/height
      wavePhase: (i * 2.399) % (Math.PI * 2),             // golden-ratio distribution
      r:         1.8 + (i % 6) * 1.1,                    // 1.8 – 7.3 px
      baseOpacity: 0.20 + (i % 7) * 0.07,                // 0.20 – 0.62
      color:     COLORS[i % COLORS.length],
      isGlow:    i % 8 === 0,                             // 10 glow particles
    };
  });
}

const PARTICLES = buildParticles(NUM_PARTICLES);

// ─── Component ────────────────────────────────────────────────────────────────
export const ParticleFlow: React.FC = () => {
  console.log('ParticleFlow rendering');
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: "#1a1f3a", overflow: "hidden" }}>
      <BackgroundMusic />

      {/* Subtle mid-screen radial glow — depth layer */}
      <div style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(ellipse 70% 50% at 50% 60%, rgba(45,122,74,0.07) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <svg width={W} height={H} style={{ position: "absolute", top: 0, left: 0 }}>
        <defs>
          {/* Soft glow filter applied to accent particles */}
          <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Stronger glow for the largest particles */}
          <filter id="glow-strong" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {PARTICLES.map((p, idx) => {
          // particleFrame: where this particle is in its own cycle
          const rawFrame = (frame + p.frameOffset) % p.cycleFrames;

          // particleT: 0 → 1 maps bottom-of-screen → above-screen
          const particleT = interpolate(rawFrame, [0, p.cycleFrames], [0, 1]);

          // ── Y position: drift upward across the full viewport ──────────
          const y = interpolate(particleT, [0, 1], [H + 20, -20]);

          // ── X position: sinusoidal horizontal wave ─────────────────────
          const xWave = Math.sin(particleT * Math.PI * 2 * p.waveFreq + p.wavePhase) * p.waveAmp;
          const x = p.startX + xWave;

          // ── Opacity: fade in near bottom, sustain, fade out near top ───
          const opacity = interpolate(
            particleT,
            [0, 0.07, 0.93, 1.0],
            [0, p.baseOpacity, p.baseOpacity, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );

          // ── Size pulse: particles breathe slightly as they rise ─────────
          const sizePulse = Math.sin(particleT * Math.PI * 2 * 2 + p.wavePhase);
          const r = interpolate(sizePulse, [-1, 1], [p.r * 0.88, p.r * 1.14]);

          // ── Visual style ───────────────────────────────────────────────
          const glowFilter = p.isGlow
            ? (p.r > 5 ? "url(#glow-strong)" : "url(#glow)")
            : undefined;

          return (
            <circle
              key={idx}
              cx={x}
              cy={y}
              r={r}
              fill={p.color}
              opacity={opacity}
              filter={glowFilter}
            />
          );
        })}

        {/* ── Connection lines between nearby large particles ─────────────── */}
        {/* Subtle lattice of faint lines between every 8th particle pair */}
        <LineConnections frame={frame} particles={PARTICLES} H={H} />
      </svg>

      {/* Vignette — pulls focus toward center */}
      <div style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 40%, rgba(10,13,28,0.62) 100%)",
        pointerEvents: "none",
      }} />

    </AbsoluteFill>
  );
};

// ─── Sub-component: connection lines ─────────────────────────────────────────
// Draws faint lines between large glow particles when they are close,
// adding an organic constellation feel.
const LineConnections: React.FC<{
  frame: number;
  particles: Particle[];
  H: number;
}> = ({ frame, particles, H }) => {
  const glowParticles = particles.filter((p) => p.isGlow);
  const lines: React.ReactNode[] = [];

  for (let i = 0; i < glowParticles.length - 1; i++) {
    const a = glowParticles[i];
    const b = glowParticles[i + 1];

    const tA = interpolate((frame + a.frameOffset) % a.cycleFrames, [0, a.cycleFrames], [0, 1]);
    const tB = interpolate((frame + b.frameOffset) % b.cycleFrames, [0, b.cycleFrames], [0, 1]);

    const ax = a.startX + Math.sin(tA * Math.PI * 2 * a.waveFreq + a.wavePhase) * a.waveAmp;
    const ay = interpolate(tA, [0, 1], [H + 20, -20]);
    const bx = b.startX + Math.sin(tB * Math.PI * 2 * b.waveFreq + b.wavePhase) * b.waveAmp;
    const by = interpolate(tB, [0, 1], [H + 20, -20]);

    const dist = Math.hypot(ax - bx, ay - by);
    if (dist > 350) continue; // only draw when particles are close

    const lineOpacity = interpolate(dist, [0, 350], [0.18, 0]);

    lines.push(
      <line
        key={`${i}`}
        x1={ax} y1={ay}
        x2={bx} y2={by}
        stroke="#2d7a4a"
        strokeWidth="0.8"
        opacity={lineOpacity}
      />
    );
  }

  return <>{lines}</>;
};
