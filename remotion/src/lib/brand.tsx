import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";

export const { fontFamily } = loadFont();

// ── Brand tokens (shared with PromoVideo) ─────────────────────────────────
export const BG = "#080c14";
export const GREEN = "#22c55e";
export const GREEN_LT = "#4ade80";
export const GREEN_DK = "#16a34a";
export const GOLD = "#f59e0b";
export const BLUE = "#3b82f6";
export const BLUE_LT = "#60a5fa";
export const RED = "#ef4444";
export const TEXT = "#f8fafc";
export const TEXT_2 = "#94a3b8";

// vmin unit — both 1080x1920 and 1920x1080 share a 1080px min dimension, so
// sizing in `u` gives identical proportions across orientations.
export const useUnit = () => {
  const { width, height } = useVideoConfig();
  return Math.min(width, height) / 100;
};

// Spring entrance helper (0 → 1)
export const useEnter = (
  delay = 0,
  config: object = { damping: 14, stiffness: 120 }
) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config });
};

// Count-up driven by frame range (tabular for steady width).
export const useCountUp = (to: number, from = 0, start = 10, end = 70) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [start, end], [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

// Fade a clip in at its start and out at its end (uses the comp duration).
export const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(
    frame,
    [0, 12, durationInFrames - 14, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <AbsoluteFill
      style={{
        opacity,
        justifyContent: "center",
        alignItems: "center",
        padding: "0 6vmin",
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const eyebrow = (u: number): React.CSSProperties => ({
  fontFamily,
  fontWeight: 600,
  fontSize: 2.4 * u,
  letterSpacing: 0.4 * u,
  textTransform: "uppercase",
  color: GREEN,
});

// Bold section headline. Pass an accent word to color it green.
export const Headline: React.FC<{
  pre?: string;
  accent?: string;
  post?: string;
  delay?: number;
  size?: number;
}> = ({ pre = "", accent = "", post = "", delay = 2, size = 7 }) => {
  const u = useUnit();
  const e = useEnter(delay, { damping: 16 });
  return (
    <div
      style={{
        fontFamily,
        fontWeight: 700,
        fontSize: size * u,
        color: TEXT,
        textAlign: "center",
        lineHeight: 1.08,
        opacity: e,
        transform: `translateY(${(1 - e) * 3 * u}px)`,
      }}
    >
      {pre}
      {accent && <span style={{ color: GREEN }}>{accent}</span>}
      {post}
    </div>
  );
};

// ── Drifting particle field (deterministic, render-safe) ──────────────────
export const Particles: React.FC<{ color?: string }> = ({ color = GREEN }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = useUnit();
  const dots = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < 42; i++) {
      arr.push({
        x: ((i * 71) % 100) / 100,
        baseY: ((i * 37) % 100) / 100,
        size: 0.25 + ((i * 13) % 7) / 10,
        speed: 0.12 + ((i * 17) % 10) / 60,
        amp: 1 + ((i * 11) % 6),
      });
    }
    return arr;
  }, []);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {dots.map((d, i) => {
        const y = (((d.baseY - (frame * d.speed) / 100) % 1) + 1) % 1;
        const drift = Math.sin((frame + i * 20) / 26) * d.amp * u;
        const op = 0.16 + Math.sin((frame + i * 14) / 30) * 0.12;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: d.x * width + drift,
              top: y * height,
              width: d.size * u,
              height: d.size * u,
              borderRadius: "50%",
              background: color,
              opacity: Math.max(0, op),
              boxShadow: `0 0 ${d.size * u * 3}px ${color}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

// Full-bleed brand backdrop: dark base + dual radial wash + particles.
export const Backdrop: React.FC<{
  accent?: string;
  particleColor?: string;
  children: React.ReactNode;
}> = ({ accent = GREEN, particleColor, children }) => (
  <AbsoluteFill style={{ backgroundColor: BG }}>
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 80% at 50% 0%, ${accent}1f, transparent 55%), radial-gradient(100% 70% at 50% 100%, ${BLUE}12, transparent 55%)`,
      }}
    />
    <Particles color={particleColor ?? accent} />
    {children}
  </AbsoluteFill>
);

// Small wordmark watermark, pinned bottom-centre on every clip.
export const Wordmark: React.FC = () => {
  const u = useUnit();
  const e = useEnter(8, { damping: 18 });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 5 * u,
        left: 0,
        right: 0,
        textAlign: "center",
        opacity: e * 0.9,
        fontFamily,
        fontWeight: 700,
        fontSize: 3 * u,
        letterSpacing: 0.05 * u,
      }}
    >
      <span style={{ color: TEXT }}>Nutri</span>
      <span style={{ color: GREEN }}>Fell</span>
    </div>
  );
};

// Caption banner that animates up near the end of a clip (the "Text:" line).
export const Caption: React.FC<{ delay: number; children: React.ReactNode }> = ({
  delay,
  children,
}) => {
  const u = useUnit();
  const e = useEnter(delay, { damping: 14, stiffness: 90 });
  return (
    <div
      style={{
        marginTop: 6 * u,
        opacity: e,
        transform: `translateY(${(1 - e) * 4 * u}px) scale(${0.94 + e * 0.06})`,
        fontFamily,
        fontWeight: 700,
        fontSize: 4.4 * u,
        textAlign: "center",
        color: TEXT,
        lineHeight: 1.12,
      }}
    >
      {children}
    </div>
  );
};
