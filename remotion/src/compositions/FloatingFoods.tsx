/**
 * FloatingFoods — stylized food icons drifting in Lissajous-like paths.
 *
 * All motion is computed from `frame` using Remotion's interpolate().
 * Integer x/y frequencies guarantee a seamless loop at 360 frames.
 */

import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

// ─── Food item definitions ────────────────────────────────────────────────────
// bx/by: base position (px)   sz: font size (px)
// xA/yA: x/y amplitude        xF/yF: x/y frequency (must be integers for seamless loop)
// rA: rotation amplitude (°)  oMin/oMax: opacity range
// ph: phase offset (radians)
interface FoodItem {
  emoji: string;
  bx: number; by: number;
  sz: number;
  xA: number; yA: number;
  xF: number; yF: number;
  rA: number;
  oMin: number; oMax: number;
  ph: number;
}

const ITEMS: FoodItem[] = [
  // ── top band ──────────────────────────────────────────────────────────────
  { emoji: "🍎", bx: 180,  by: 250,  sz: 72, xA: 28, yA: 42, xF: 1, yF: 1, rA: 9,  oMin: 0.30, oMax: 0.85, ph: 0.00 },
  { emoji: "🐟", bx: 960,  by: 185,  sz: 68, xA: 22, yA: 50, xF: 2, yF: 1, rA: 7,  oMin: 0.20, oMax: 0.78, ph: 2.51 },
  { emoji: "🍗", bx: 1720, by: 270,  sz: 58, xA: 30, yA: 36, xF: 1, yF: 2, rA: 11, oMin: 0.28, oMax: 0.82, ph: 1.40 },
  // ── upper-mid ─────────────────────────────────────────────────────────────
  { emoji: "🍌", bx: 450,  by: 490,  sz: 80, xA: 24, yA: 46, xF: 1, yF: 1, rA: 10, oMin: 0.40, oMax: 0.92, ph: 1.26 },
  { emoji: "🥜", bx: 960,  by: 455,  sz: 54, xA: 20, yA: 34, xF: 2, yF: 2, rA: 15, oMin: 0.22, oMax: 0.72, ph: 3.14 },
  { emoji: "🍎", bx: 1410, by: 510,  sz: 62, xA: 26, yA: 44, xF: 1, yF: 1, rA: 8,  oMin: 0.30, oMax: 0.84, ph: 0.70 },
  // ── lower-mid ─────────────────────────────────────────────────────────────
  { emoji: "🍗", bx: 210,  by: 715,  sz: 74, xA: 18, yA: 40, xF: 1, yF: 1, rA: 9,  oMin: 0.35, oMax: 0.88, ph: 2.09 },
  { emoji: "🍌", bx: 760,  by: 675,  sz: 56, xA: 32, yA: 50, xF: 2, yF: 1, rA: 12, oMin: 0.25, oMax: 0.80, ph: 0.42 },
  { emoji: "🐟", bx: 1220, by: 755,  sz: 64, xA: 22, yA: 36, xF: 1, yF: 2, rA: 7,  oMin: 0.30, oMax: 0.86, ph: 1.88 },
  { emoji: "🥜", bx: 1760, by: 695,  sz: 52, xA: 27, yA: 44, xF: 1, yF: 1, rA: 14, oMin: 0.20, oMax: 0.74, ph: 0.94 },
  // ── bottom band ───────────────────────────────────────────────────────────
  { emoji: "🍎", bx: 500,  by: 940,  sz: 46, xA: 19, yA: 32, xF: 2, yF: 1, rA: 8,  oMin: 0.15, oMax: 0.65, ph: 3.56 },
  { emoji: "🐟", bx: 1060, by: 905,  sz: 60, xA: 25, yA: 48, xF: 1, yF: 2, rA: 10, oMin: 0.20, oMax: 0.75, ph: 2.83 },
  { emoji: "🥜", bx: 1610, by: 965,  sz: 48, xA: 21, yA: 30, xF: 2, yF: 2, rA: 13, oMin: 0.15, oMax: 0.68, ph: 1.57 },
  // ── edges ─────────────────────────────────────────────────────────────────
  { emoji: "🍌", bx: 1885, by: 138,  sz: 56, xA: 22, yA: 42, xF: 1, yF: 1, rA: 8,  oMin: 0.25, oMax: 0.79, ph: 1.68 },
  { emoji: "🍗", bx:  65,  by: 430,  sz: 68, xA: 20, yA: 46, xF: 1, yF: 2, rA: 10, oMin: 0.32, oMax: 0.87, ph: 0.31 },
];

// ─── Component ────────────────────────────────────────────────────────────────
export const FloatingFoods: React.FC = () => {
  console.log('FloatingFoods rendering');
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // t goes 0 → 2π over the full composition duration.
  // With integer xF/yF, sin(t·xF) completes integer cycles → seamless loop.
  const t = interpolate(frame, [0, durationInFrames], [0, Math.PI * 2]);

  return (
    <AbsoluteFill style={{ background: "#1a1f3a", overflow: "hidden" }}>
      {ITEMS.map((item, idx) => {
        // ── Position ──────────────────────────────────────────────────────
        const x = item.bx + Math.sin(t * item.xF + item.ph) * item.xA;
        const y = item.by + Math.cos(t * item.yF + item.ph) * item.yA;

        // ── Rotation ──────────────────────────────────────────────────────
        // Uses a slightly different frequency (0.7×) to avoid lockstep with position.
        const rotSin = Math.sin(t * 0.7 + item.ph);
        const rotation = interpolate(rotSin, [-1, 1], [-item.rA, item.rA]);

        // ── Scale breath ──────────────────────────────────────────────────
        const scaleSin = Math.cos(t + item.ph + 0.5);
        const scale = interpolate(scaleSin, [-1, 1], [0.93, 1.07]);

        // ── Opacity ───────────────────────────────────────────────────────
        // Staggered breathing: each item uses a different opacity phase.
        const opSin = Math.sin(t * 0.5 + item.ph * 0.8);
        const opacity = interpolate(opSin, [-1, 1], [item.oMin, item.oMax]);

        // ── Drop shadow depth (scales with size and opacity) ──────────────
        const shadowBlur = item.sz * 0.28;
        const shadowY    = item.sz * 0.10;
        const shadowA    = opacity * 0.55;

        return (
          <div
            key={idx}
            style={{
              position: "absolute",
              left: x,
              top: y,
              fontSize: item.sz,
              lineHeight: 1,
              opacity,
              transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`,
              filter: `drop-shadow(0 ${shadowY}px ${shadowBlur}px rgba(0,0,0,${shadowA}))`,
              userSelect: "none",
              willChange: "transform, opacity",
            }}
          >
            {item.emoji}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
