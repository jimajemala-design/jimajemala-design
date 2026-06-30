import React from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/SpaceGrotesk";
import { BackgroundMusic } from "../BackgroundMusic";
import { Voiceover } from "../Voiceover";

const { fontFamily } = loadFont();

// ── Brand tokens ─────────────────────────────────────────────────────────
const BG = "#080c14";
const GREEN = "#22c55e";
const GREEN_LT = "#4ade80";
const GOLD = "#f59e0b";
const BLUE = "#3b82f6";
const TEXT = "#f8fafc";
const TEXT_2 = "#94a3b8";

// vmin unit — both 1080x1920 and 1920x1080 share a 1080px min dimension,
// so sizing in `u` gives identical proportions across orientations.
const useUnit = () => {
  const { width, height } = useVideoConfig();
  return Math.min(width, height) / 100;
};

// Spring entrance helper (0 → 1)
const useEnter = (delay = 0, config: object = { damping: 14, stiffness: 120 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config });
};

// Fade a scene in at its start and out at its end (uses the Sequence duration).
const SceneWrap: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(
    frame,
    [0, 10, durationInFrames - 12, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <AbsoluteFill style={{ opacity, justifyContent: "center", alignItems: "center" }}>
      {children}
    </AbsoluteFill>
  );
};

// ── Drifting green particle field (deterministic, render-safe) ───────────
const Particles: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = useUnit();
  const dots = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < 46; i++) {
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
        const y = ((d.baseY - (frame * d.speed) / 100) % 1 + 1) % 1;
        const drift = Math.sin((frame + i * 20) / 26) * d.amp * u;
        const op = 0.18 + Math.sin((frame + i * 14) / 30) * 0.12;
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
              background: GREEN,
              opacity: Math.max(0, op),
              boxShadow: `0 0 ${d.size * u * 3}px ${GREEN}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const eyebrow = (u: number): React.CSSProperties => ({
  fontFamily,
  fontWeight: 600,
  fontSize: 2.1 * u,
  letterSpacing: 0.42 * u,
  textTransform: "uppercase",
  color: GREEN,
});

// ── Scene 1: Logo reveal ─────────────────────────────────────────────────
const Scene1Logo: React.FC = () => {
  const u = useUnit();
  const pop = useEnter(4, { damping: 11, stiffness: 90 });
  const tagline = useEnter(26, { damping: 16 });
  const glow = useEnter(2, { damping: 30, stiffness: 40 });
  return (
    <SceneWrap>
      <div
        style={{
          position: "absolute",
          width: 70 * u,
          height: 70 * u,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${GREEN}33, transparent 60%)`,
          opacity: glow,
        }}
      />
      <div
        style={{
          transform: `scale(${pop})`,
          fontFamily,
          fontWeight: 700,
          fontSize: 13 * u,
          letterSpacing: -0.3 * u,
          display: "flex",
        }}
      >
        <span style={{ color: "transparent", WebkitTextStroke: `${0.25 * u}px ${TEXT}` }}>Nutri</span>
        <span
          style={{
            background: `linear-gradient(135deg, ${GREEN}, ${GREEN_LT})`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          Fell
        </span>
      </div>
      <div
        style={{
          marginTop: 3 * u,
          transform: `translateY(${(1 - tagline) * 4 * u}px)`,
          opacity: tagline,
          fontFamily,
          fontWeight: 500,
          fontSize: 3.4 * u,
          letterSpacing: 0.15 * u,
          color: TEXT_2,
        }}
      >
        Fuel Your Best Self
      </div>
    </SceneWrap>
  );
};

// ── Scene 2: Food showcase ───────────────────────────────────────────────
const Scene2Food: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const head = useEnter(2, { damping: 16 });
  const foods = ["🍎", "🍌", "🐟"];
  const chips = [
    { t: "52 KCAL", c: GREEN, a: -1 },
    { t: "OMEGA-3", c: BLUE, a: 1 },
    { t: "PROTEIN 25g", c: GOLD, a: -1 },
    { t: "VITAMIN C", c: GREEN_LT, a: 1 },
  ];
  return (
    <SceneWrap>
      <div style={{ ...eyebrow(u), opacity: head, marginBottom: 2 * u }}>The Database</div>
      <div
        style={{
          fontFamily,
          fontWeight: 700,
          fontSize: 8 * u,
          color: TEXT,
          opacity: head,
          marginBottom: 6 * u,
          transform: `translateY(${(1 - head) * 3 * u}px)`,
        }}
      >
        74 Foods in <span style={{ color: GREEN }}>3D</span>
      </div>
      <div style={{ display: "flex", gap: 7 * u, position: "relative" }}>
        {foods.map((f, i) => {
          const s = useEnter(10 + i * 8, { damping: 10, stiffness: 90 });
          const rot = Math.sin((frame + i * 30) / 22) * 22;
          return (
            <div
              key={i}
              style={{
                width: 18 * u,
                height: 18 * u,
                borderRadius: 4 * u,
                background: "rgba(255,255,255,0.04)",
                border: `${0.12 * u}px solid rgba(255,255,255,0.10)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11 * u,
                transform: `scale(${s}) perspective(${60 * u}px) rotateY(${rot}deg)`,
                boxShadow: `0 ${1.2 * u}px ${4 * u}px rgba(0,0,0,0.4)`,
              }}
            >
              {f}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 2 * u, marginTop: 6 * u, flexWrap: "wrap", justifyContent: "center", maxWidth: 80 * u }}>
        {chips.map((c, i) => {
          const e = useEnter(28 + i * 7, { damping: 13 });
          return (
            <div
              key={i}
              style={{
                opacity: e,
                transform: `translateX(${(1 - e) * c.a * 6 * u}px)`,
                fontFamily,
                fontWeight: 600,
                fontSize: 2 * u,
                letterSpacing: 0.08 * u,
                color: c.c,
                padding: `${1 * u}px ${2.2 * u}px`,
                borderRadius: 999,
                background: "rgba(255,255,255,0.04)",
                border: `${0.1 * u}px solid ${c.c}55`,
              }}
            >
              {c.t}
            </div>
          );
        })}
      </div>
    </SceneWrap>
  );
};

// ── Scene 3: AI chat ─────────────────────────────────────────────────────
const Scene3Chat: React.FC = () => {
  const u = useUnit();
  const slide = useEnter(2, { damping: 16, stiffness: 80 });
  const bubbles = [
    { from: "user", t: "What can I cook tonight?" },
    { from: "ai", t: "Salmon + broccoli — 320 kcal, 34g protein. Want the recipe?" },
    { from: "user", t: "Yes please 🙌" },
  ];
  return (
    <SceneWrap>
      <div style={{ ...eyebrow(u), opacity: slide, marginBottom: 2.5 * u }}>NutriAI</div>
      <div
        style={{
          fontFamily,
          fontWeight: 700,
          fontSize: 6.4 * u,
          color: TEXT,
          opacity: slide,
          marginBottom: 4 * u,
        }}
      >
        AI Nutrition <span style={{ color: GREEN }}>Assistant</span>
      </div>
      <div
        style={{
          width: 46 * u,
          padding: 3 * u,
          borderRadius: 6 * u,
          background: "rgba(13,17,23,0.9)",
          border: `${0.18 * u}px solid rgba(34,197,94,0.25)`,
          boxShadow: `0 ${2 * u}px ${8 * u}px rgba(0,0,0,0.5)`,
          transform: `translateY(${(1 - slide) * 18 * u}px) scale(${0.9 + slide * 0.1})`,
          display: "flex",
          flexDirection: "column",
          gap: 2 * u,
        }}
      >
        {bubbles.map((b, i) => {
          const e = useEnter(16 + i * 16, { damping: 14 });
          const isAi = b.from === "ai";
          return (
            <div
              key={i}
              style={{
                alignSelf: isAi ? "flex-start" : "flex-end",
                maxWidth: "82%",
                opacity: e,
                transform: `translateY(${(1 - e) * 3 * u}px)`,
                fontFamily,
                fontWeight: 500,
                fontSize: 2.4 * u,
                lineHeight: 1.4,
                color: isAi ? TEXT : "#051008",
                padding: `${1.6 * u}px ${2.2 * u}px`,
                borderRadius: 3 * u,
                background: isAi ? "rgba(255,255,255,0.06)" : `linear-gradient(135deg, ${GREEN}, #16a34a)`,
                border: isAi ? `${0.1 * u}px solid rgba(255,255,255,0.08)` : "none",
              }}
            >
              {b.t}
            </div>
          );
        })}
      </div>
    </SceneWrap>
  );
};

// ── Scene 4: Features montage ────────────────────────────────────────────
const Scene4Features: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const head = useEnter(2, { damping: 16 });
  const waterFill = interpolate(frame, [14, 60], [0, 78], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const days = Math.floor(interpolate(frame, [20, 70], [0, 124], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const cards = [
    { icon: "💧", title: "Water Tracker", accent: BLUE },
    { icon: "🚭", title: "Quit Smoking", accent: GREEN },
    { icon: "📋", title: "Meal Plans", accent: GOLD },
  ];
  return (
    <SceneWrap>
      <div
        style={{
          fontFamily,
          fontWeight: 700,
          fontSize: 6.2 * u,
          color: TEXT,
          opacity: head,
          marginBottom: 6 * u,
          textAlign: "center",
        }}
      >
        Complete <span style={{ color: GREEN }}>Wellness</span> Platform
      </div>
      <div style={{ display: "flex", gap: 3 * u, flexWrap: "wrap", justifyContent: "center" }}>
        {cards.map((c, i) => {
          const e = useEnter(10 + i * 10, { damping: 12, stiffness: 90 });
          return (
            <div
              key={i}
              style={{
                width: 26 * u,
                height: 30 * u,
                borderRadius: 4 * u,
                padding: 3 * u,
                background: "rgba(255,255,255,0.03)",
                border: `${0.12 * u}px solid ${c.accent}44`,
                transform: `scale(${e}) translateY(${(1 - e) * 4 * u}px)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 1.4 * u,
              }}
            >
              <div style={{ fontSize: 7 * u }}>{c.icon}</div>
              <div style={{ fontFamily, fontWeight: 600, fontSize: 2.3 * u, color: TEXT }}>{c.title}</div>
              {i === 0 && (
                <div style={{ width: "70%", height: 1.4 * u, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                  <div style={{ width: `${waterFill}%`, height: "100%", background: `linear-gradient(90deg, ${BLUE}, #60a5fa)` }} />
                </div>
              )}
              {i === 1 && (
                <div style={{ fontFamily, fontWeight: 700, fontSize: 3.4 * u, color: GREEN_LT, fontVariantNumeric: "tabular-nums" }}>
                  {days} days free
                </div>
              )}
              {i === 2 && (
                <div style={{ display: "flex", gap: 0.8 * u, alignItems: "flex-end", height: 5 * u }}>
                  {[0.5, 0.8, 0.6, 1, 0.7].map((h, j) => {
                    const bar = interpolate(frame, [24 + j * 4, 50 + j * 4], [0, h], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                    return <div key={j} style={{ width: 1.6 * u, height: `${bar * 100}%`, borderRadius: 0.6 * u, background: GOLD }} />;
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SceneWrap>
  );
};

// ── Scene 5: Community ───────────────────────────────────────────────────
const Scene5Community: React.FC = () => {
  const u = useUnit();
  const head = useEnter(2, { damping: 16 });
  const recipes = [
    { emoji: "🥗", name: "Power Bowl", k: "420 kcal" },
    { emoji: "🍲", name: "Lentil Stew", k: "310 kcal" },
    { emoji: "🥑", name: "Avo Toast", k: "280 kcal" },
  ];
  const reacts = ["❤️", "🔥", "👏", "😋"];
  return (
    <SceneWrap>
      <div style={{ ...eyebrow(u), opacity: head, marginBottom: 2.5 * u }}>Community Recipes</div>
      <div
        style={{
          fontFamily,
          fontWeight: 700,
          fontSize: 6.6 * u,
          color: TEXT,
          opacity: head,
          marginBottom: 5 * u,
        }}
      >
        Join the <span style={{ color: GREEN }}>Community</span>
      </div>
      <div style={{ display: "flex", gap: 3 * u, marginBottom: 4 * u, flexWrap: "wrap", justifyContent: "center" }}>
        {recipes.map((r, i) => {
          const e = useEnter(10 + i * 9, { damping: 12, stiffness: 90 });
          return (
            <div
              key={i}
              style={{
                width: 24 * u,
                borderRadius: 3.5 * u,
                overflow: "hidden",
                background: "rgba(255,255,255,0.04)",
                border: `${0.12 * u}px solid rgba(255,255,255,0.08)`,
                transform: `scale(${e}) translateY(${(1 - e) * 5 * u}px)`,
              }}
            >
              <div style={{ height: 16 * u, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9 * u, background: "rgba(255,255,255,0.03)" }}>
                {r.emoji}
              </div>
              <div style={{ padding: 2 * u }}>
                <div style={{ fontFamily, fontWeight: 600, fontSize: 2.4 * u, color: TEXT }}>{r.name}</div>
                <div style={{ fontFamily, fontWeight: 500, fontSize: 1.9 * u, color: GREEN }}>{r.k}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 2 * u }}>
        {reacts.map((r, i) => {
          const e = useEnter(34 + i * 6, { damping: 9, stiffness: 110 });
          return (
            <div
              key={i}
              style={{
                fontSize: 4.6 * u,
                transform: `scale(${e})`,
                filter: `drop-shadow(0 0 ${1.5 * u}px rgba(34,197,94,0.4))`,
              }}
            >
              {r}
            </div>
          );
        })}
      </div>
    </SceneWrap>
  );
};

// ── Scene 6: CTA finale ──────────────────────────────────────────────────
const Scene6CTA: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const title = useEnter(4, { damping: 12, stiffness: 80 });
  const url = useEnter(20, { damping: 16 });
  const badge = useEnter(32, { damping: 13 });
  const pulse = 1 + Math.sin(frame / 9) * 0.04;
  const finale = interpolate(frame, [durationInFrames - 40, durationInFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <SceneWrap>
      <div
        style={{
          position: "absolute",
          width: 90 * u,
          height: 90 * u,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${GREEN}${Math.round(20 + finale * 30).toString(16)}, transparent 60%)`,
          transform: `scale(${pulse})`,
        }}
      />
      <div
        style={{
          fontFamily,
          fontWeight: 700,
          fontSize: 9.5 * u,
          color: TEXT,
          textAlign: "center",
          transform: `scale(${title})`,
          lineHeight: 1.05,
        }}
      >
        Start{" "}
        <span style={{ background: `linear-gradient(135deg, ${GREEN}, ${GREEN_LT})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
          Free
        </span>{" "}
        Today
      </div>
      <div
        style={{
          marginTop: 3 * u,
          opacity: url,
          fontFamily,
          fontWeight: 600,
          fontSize: 3.6 * u,
          letterSpacing: 0.1 * u,
          color: TEXT_2,
        }}
      >
        nutrifell.com
      </div>
      <div
        style={{
          marginTop: 4 * u,
          opacity: badge,
          transform: `translateY(${(1 - badge) * 3 * u}px)`,
          display: "flex",
          alignItems: "center",
          gap: 1.4 * u,
          padding: `${1.8 * u}px ${3.4 * u}px`,
          borderRadius: 999,
          background: `linear-gradient(135deg, ${GREEN}, #16a34a)`,
          color: "#051008",
          fontFamily,
          fontWeight: 700,
          fontSize: 2.8 * u,
        }}
      >
        📲 Install as an App · No store needed
      </div>
    </SceneWrap>
  );
};

// ── Root composition ─────────────────────────────────────────────────────
export const PromoVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {/* Music ducked under the narration so the voiceover stays intelligible */}
      <BackgroundMusic volume={0.28} />
      <Voiceover volume={1} />
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 90% at 50% 0%, rgba(34,197,94,0.08), transparent 55%), radial-gradient(100% 80% at 50% 100%, rgba(59,130,246,0.06), transparent 55%)`,
        }}
      />
      <Particles />
      <Sequence from={0} durationInFrames={90}><Scene1Logo /></Sequence>
      <Sequence from={90} durationInFrames={150}><Scene2Food /></Sequence>
      <Sequence from={240} durationInFrames={150}><Scene3Chat /></Sequence>
      <Sequence from={390} durationInFrames={150}><Scene4Features /></Sequence>
      <Sequence from={540} durationInFrames={150}><Scene5Community /></Sequence>
      <Sequence from={690} durationInFrames={210}><Scene6CTA /></Sequence>
    </AbsoluteFill>
  );
};
