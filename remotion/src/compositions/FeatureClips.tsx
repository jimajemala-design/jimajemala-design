import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { BackgroundMusic } from "../BackgroundMusic";
import {
  Backdrop,
  Caption,
  Stage,
  Wordmark,
  eyebrow,
  fontFamily,
  useEnter,
  useUnit,
  BLUE,
  BLUE_LT,
  GOLD,
  GREEN,
  GREEN_DK,
  GREEN_LT,
  TEXT,
  TEXT_2,
} from "../lib/brand";

// Common chrome: backdrop + music + eyebrow + bottom wordmark.
const Clip: React.FC<{
  accent?: string;
  particleColor?: string;
  eyebrowText: string;
  children: React.ReactNode;
}> = ({ accent = GREEN, particleColor, eyebrowText, children }) => {
  const u = useUnit();
  const e = useEnter(2, { damping: 16 });
  return (
    <Backdrop accent={accent} particleColor={particleColor}>
      <BackgroundMusic volume={0.5} />
      <Stage>
        <div
          style={{
            ...eyebrow(u),
            color: accent,
            opacity: e,
            marginBottom: 3 * u,
            transform: `translateY(${(1 - e) * -2 * u}px)`,
          }}
        >
          {eyebrowText}
        </div>
        {children}
      </Stage>
      <Wordmark />
    </Backdrop>
  );
};

// ════════════════════════════════════════════════════════════════════════
// Clip 1 · 3D Food Explorer (15s / 450f)
// ════════════════════════════════════════════════════════════════════════
const FOODS = [
  { emoji: "🍎", name: "Apple", chips: [["52", "KCAL", GREEN], ["14g", "CARBS", GOLD], ["VIT C", "8%", GREEN_LT], ["FIBER", "2.4g", BLUE]] },
  { emoji: "🐟", name: "Salmon", chips: [["208", "KCAL", GREEN], ["20g", "PROTEIN", GOLD], ["OMEGA-3", "2.3g", BLUE], ["VIT D", "66%", GREEN_LT]] },
  { emoji: "🥦", name: "Broccoli", chips: [["34", "KCAL", GREEN], ["2.8g", "PROTEIN", GOLD], ["VIT K", "97%", GREEN_LT], ["VIT C", "89%", BLUE]] },
] as const;

const ChipsRing: React.FC<{ chips: readonly (readonly [string, string, string])[]; baseDelay: number }> = ({ chips, baseDelay }) => {
  const u = useUnit();
  // Four anchored positions around the hero model.
  const slots = [
    { top: "8%", left: "50%", tx: "-50%, 0" },
    { top: "50%", left: "90%", tx: "-50%, -50%" },
    { top: "92%", left: "50%", tx: "-50%, -100%" },
    { top: "50%", left: "10%", tx: "-50%, -50%" },
  ];
  return (
    <>
      {chips.map((c, i) => {
        const e = useEnter(baseDelay + i * 6, { damping: 12, stiffness: 100 });
        const s = slots[i];
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              top: s.top,
              left: s.left,
              transform: `translate(${s.tx}) scale(${e})`,
              opacity: e,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 0.2 * u,
              padding: `${1.4 * u}px ${2.4 * u}px`,
              borderRadius: 2.4 * u,
              background: "rgba(13,17,23,0.86)",
              border: `${0.14 * u}px solid ${c[2]}66`,
              boxShadow: `0 ${0.8 * u}px ${3 * u}px rgba(0,0,0,0.5)`,
            }}
          >
            <span style={{ fontFamily, fontWeight: 700, fontSize: 3 * u, color: c[2], fontVariantNumeric: "tabular-nums" }}>{c[0]}</span>
            <span style={{ fontFamily, fontWeight: 600, fontSize: 1.7 * u, letterSpacing: 0.06 * u, color: TEXT_2 }}>{c[1]}</span>
          </div>
        );
      })}
    </>
  );
};

export const ClipFood: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const cycle = 150; // frames per food
  const idx = Math.floor(frame / cycle) % FOODS.length;
  const food = FOODS[idx];
  const local = frame % cycle;
  // Fade each food in/out within its window so the swap is clean.
  const swap = interpolate(local, [0, 16, cycle - 18, cycle], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const spin = local * 2.6; // continuous Y-rotation (CSS, render-safe)
  const float = Math.sin(frame / 20) * 1.2 * u;

  return (
    <Clip eyebrowText="3D Food Explorer">
      <div
        style={{
          position: "relative",
          width: 70 * u,
          height: 70 * u,
          marginTop: 2 * u,
        }}
      >
        {/* glow disc */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 44 * u,
            height: 44 * u,
            transform: "translate(-50%,-50%)",
            borderRadius: "50%",
            background: `radial-gradient(circle, ${GREEN}33, transparent 62%)`,
          }}
        />
        {/* hero model */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: `translate(-50%,-50%) translateY(${float}px)`,
            opacity: swap,
          }}
        >
          <div
            style={{
              width: 30 * u,
              height: 30 * u,
              borderRadius: 6 * u,
              background: "rgba(255,255,255,0.04)",
              border: `${0.16 * u}px solid rgba(255,255,255,0.10)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 19 * u,
              boxShadow: `0 ${2 * u}px ${7 * u}px rgba(0,0,0,0.5)`,
              transform: `perspective(${90 * u}px) rotateY(${spin}deg)`,
            }}
          >
            {food.emoji}
          </div>
        </div>
        <div style={{ opacity: swap }}>
          <ChipsRing key={idx} chips={food.chips} baseDelay={6} />
        </div>
      </div>
      <div
        style={{
          marginTop: 2 * u,
          fontFamily,
          fontWeight: 600,
          fontSize: 3 * u,
          color: TEXT_2,
          opacity: swap,
        }}
      >
        {food.name}
      </div>
      <Caption delay={30}>
        74 foods in <span style={{ color: GREEN }}>stunning 3D</span>
      </Caption>
    </Clip>
  );
};

// ════════════════════════════════════════════════════════════════════════
// Clip 2 · AI Nutrition Chat (20s / 600f)
// ════════════════════════════════════════════════════════════════════════
const PhoneFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const u = useUnit();
  const e = useEnter(4, { damping: 15, stiffness: 80 });
  return (
    <div
      style={{
        width: 52 * u,
        height: 104 * u,
        borderRadius: 8 * u,
        background: "#05080e",
        border: `${0.6 * u}px solid rgba(255,255,255,0.14)`,
        boxShadow: `0 ${3 * u}px ${12 * u}px rgba(0,0,0,0.6), inset 0 0 ${4 * u}px rgba(34,197,94,0.08)`,
        padding: 2.2 * u,
        opacity: e,
        transform: `translateY(${(1 - e) * 14 * u}px) scale(${0.92 + e * 0.08})`,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* notch */}
      <div
        style={{
          width: 14 * u,
          height: 1.4 * u,
          borderRadius: 999,
          background: "rgba(255,255,255,0.18)",
          alignSelf: "center",
          marginBottom: 1.6 * u,
        }}
      />
      {/* app header */}
      <div style={{ display: "flex", alignItems: "center", gap: 1.4 * u, paddingBottom: 1.6 * u, borderBottom: `${0.1 * u}px solid rgba(255,255,255,0.08)` }}>
        <div style={{ width: 5 * u, height: 5 * u, borderRadius: "50%", background: `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 2.6 * u }}>🤖</div>
        <div>
          <div style={{ fontFamily, fontWeight: 700, fontSize: 2.3 * u, color: TEXT }}>NutriAI</div>
          <div style={{ fontFamily, fontWeight: 500, fontSize: 1.5 * u, color: GREEN }}>● online</div>
        </div>
      </div>
      <div style={{ flex: 1, paddingTop: 2 * u, display: "flex", flexDirection: "column", gap: 1.6 * u }}>{children}</div>
    </div>
  );
};

const Bubble: React.FC<{ ai?: boolean; delay: number; children: React.ReactNode }> = ({ ai, delay, children }) => {
  const u = useUnit();
  const e = useEnter(delay, { damping: 14 });
  return (
    <div
      style={{
        alignSelf: ai ? "flex-start" : "flex-end",
        maxWidth: "84%",
        opacity: e,
        transform: `translateY(${(1 - e) * 2.4 * u}px)`,
        fontFamily,
        fontWeight: 500,
        fontSize: 2.05 * u,
        lineHeight: 1.4,
        color: ai ? TEXT : "#051008",
        padding: `${1.4 * u}px ${1.9 * u}px`,
        borderRadius: 2.6 * u,
        background: ai ? "rgba(255,255,255,0.06)" : `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
        border: ai ? `${0.1 * u}px solid rgba(255,255,255,0.08)` : "none",
      }}
    >
      {children}
    </div>
  );
};

export const ClipAI: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  // Meal plan rows generate one by one after the chat.
  const meals = [
    ["🍳", "Breakfast", "Greek yogurt + berries", "320 kcal"],
    ["🥗", "Lunch", "Salmon power bowl", "480 kcal"],
    ["🍲", "Dinner", "Chicken + sweet potato", "540 kcal"],
  ];
  return (
    <Clip eyebrowText="NutriAI Assistant">
      <PhoneFrame>
        <Bubble delay={26}>Plan my meals for today 🙌</Bubble>
        <Bubble ai delay={48}>On it. Building a 1,340 kcal plan from your fridge…</Bubble>
        {/* generated meal plan card */}
        {(() => {
          const card = useEnter(72, { damping: 16 });
          return (
            <div
              style={{
                opacity: card,
                transform: `translateY(${(1 - card) * 4 * u}px)`,
                borderRadius: 2.6 * u,
                background: "rgba(34,197,94,0.06)",
                border: `${0.12 * u}px solid ${GREEN}44`,
                padding: 1.8 * u,
                display: "flex",
                flexDirection: "column",
                gap: 1.4 * u,
              }}
            >
              <div style={{ fontFamily, fontWeight: 700, fontSize: 1.9 * u, color: GREEN, letterSpacing: 0.05 * u }}>YOUR PLAN</div>
              {meals.map((m, i) => {
                const r = useEnter(88 + i * 16, { damping: 15 });
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 1.4 * u, opacity: r, transform: `translateX(${(1 - r) * 4 * u}px)` }}>
                    <span style={{ fontSize: 3 * u }}>{m[0]}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily, fontWeight: 600, fontSize: 1.75 * u, color: TEXT_2 }}>{m[1]}</div>
                      <div style={{ fontFamily, fontWeight: 600, fontSize: 1.9 * u, color: TEXT }}>{m[2]}</div>
                    </div>
                    <span style={{ fontFamily, fontWeight: 700, fontSize: 1.8 * u, color: GREEN, fontVariantNumeric: "tabular-nums" }}>{m[3]}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}
        {/* typing dots while generating */}
        {frame > 60 && frame < 90 && (
          <div style={{ alignSelf: "flex-start", display: "flex", gap: 0.8 * u, padding: `${1.4 * u}px ${1.9 * u}px`, borderRadius: 2.6 * u, background: "rgba(255,255,255,0.06)" }}>
            {[0, 1, 2].map((d) => {
              const o = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((frame - d * 4) / 3));
              return <div key={d} style={{ width: 1.4 * u, height: 1.4 * u, borderRadius: "50%", background: TEXT_2, opacity: o }} />;
            })}
          </div>
        )}
      </PhoneFrame>
      <Caption delay={150}>
        Your personal <span style={{ color: GREEN }}>AI nutritionist</span>
      </Caption>
    </Clip>
  );
};

// ════════════════════════════════════════════════════════════════════════
// Clip 3 · Smart Fridge (15s / 450f)
// ════════════════════════════════════════════════════════════════════════
export const ClipFridge: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const items = ["🥚 Eggs", "🐟 Salmon", "🥦 Broccoli", "🍠 Sweet potato", "🥑 Avocado", "🍅 Tomato"];
  const plans = [
    ["🍳", "Breakfast", "320 kcal"],
    ["🥗", "Lunch", "480 kcal"],
    ["🍲", "Dinner", "540 kcal"],
  ];
  const arrow = useEnter(120, { damping: 14 });
  return (
    <Clip eyebrowText="Smart Fridge" accent={GREEN}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 * u, marginTop: 2 * u }}>
        {/* fridge with items popping in */}
        <div
          style={{
            width: 64 * u,
            borderRadius: 4 * u,
            background: "rgba(255,255,255,0.03)",
            border: `${0.14 * u}px solid rgba(255,255,255,0.10)`,
            padding: 3 * u,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 1.4 * u, marginBottom: 2.4 * u }}>
            <span style={{ fontSize: 4 * u }}>🧊</span>
            <span style={{ fontFamily, fontWeight: 700, fontSize: 2.6 * u, color: TEXT }}>My Fridge</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 1.6 * u }}>
            {items.map((it, i) => {
              const e = useEnter(12 + i * 12, { damping: 11, stiffness: 110 });
              return (
                <div
                  key={i}
                  style={{
                    opacity: e,
                    transform: `scale(${e})`,
                    fontFamily,
                    fontWeight: 600,
                    fontSize: 2.2 * u,
                    color: TEXT,
                    padding: `${1.2 * u}px ${2 * u}px`,
                    borderRadius: 999,
                    background: "rgba(34,197,94,0.08)",
                    border: `${0.1 * u}px solid ${GREEN}44`,
                  }}
                >
                  {it}
                </div>
              );
            })}
          </div>
        </div>
        {/* arrow */}
        <div style={{ opacity: arrow, transform: `translateY(${(1 - arrow) * 2 * u}px)`, display: "flex", flexDirection: "column", alignItems: "center", gap: 0.6 * u }}>
          <span style={{ fontFamily, fontWeight: 700, fontSize: 2 * u, letterSpacing: 0.1 * u, color: GREEN }}>AUTO-GENERATE</span>
          <span style={{ fontSize: 4 * u, color: GREEN, lineHeight: 0.6 }}>↓</span>
        </div>
        {/* generated plan */}
        <div style={{ display: "flex", gap: 2.4 * u }}>
          {plans.map((p, i) => {
            const e = useEnter(132 + i * 14, { damping: 13, stiffness: 90 });
            return (
              <div
                key={i}
                style={{
                  opacity: e,
                  transform: `scale(${e}) translateY(${(1 - e) * 4 * u}px)`,
                  width: 19 * u,
                  borderRadius: 3 * u,
                  background: "rgba(255,255,255,0.04)",
                  border: `${0.12 * u}px solid ${GREEN}44`,
                  padding: 2.2 * u,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 1 * u,
                }}
              >
                <span style={{ fontSize: 5 * u }}>{p[0]}</span>
                <span style={{ fontFamily, fontWeight: 600, fontSize: 1.9 * u, color: TEXT_2 }}>{p[1]}</span>
                <span style={{ fontFamily, fontWeight: 700, fontSize: 2.2 * u, color: GREEN }}>{p[2]}</span>
              </div>
            );
          })}
        </div>
      </div>
      <Caption delay={50}>
        Meal plans <span style={{ color: GREEN }}>from your fridge</span>
      </Caption>
    </Clip>
  );
};

// ════════════════════════════════════════════════════════════════════════
// Clip 4 · Quit Smoking Tracker (20s / 600f)
// ════════════════════════════════════════════════════════════════════════
export const ClipQuit: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const days = Math.round(interpolate(frame, [16, 90], [0, 47], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const money = interpolate(frame, [16, 110], [0, 282], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cigs = Math.round(interpolate(frame, [16, 110], [0, 940], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const milestones = [
    ["🫀", "24 hours", 150],
    ["🌬️", "72 hours", 200],
    ["💪", "2 weeks", 250],
    ["🎉", "1 month", 300],
  ] as const;
  return (
    <Clip eyebrowText="Quit Smoking" accent={GREEN} particleColor={GREEN_LT}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3.4 * u, marginTop: 2 * u }}>
        {/* big day counter */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ fontFamily, fontWeight: 700, fontSize: 22 * u, lineHeight: 1, color: GREEN, fontVariantNumeric: "tabular-nums", textShadow: `0 0 ${4 * u}px ${GREEN}55` }}>
            {days}
          </div>
          <div style={{ fontFamily, fontWeight: 600, fontSize: 3 * u, letterSpacing: 0.1 * u, color: TEXT_2 }}>days smoke-free</div>
        </div>
        {/* stat row */}
        <div style={{ display: "flex", gap: 2.6 * u }}>
          {[
            ["💰", `$${money.toFixed(0)}`, "saved", GOLD],
            ["🚭", cigs.toLocaleString(), "not smoked", BLUE_LT],
            ["⏱️", `${(days * 3.5).toFixed(0)}h`, "life regained", GREEN_LT],
          ].map((s, i) => (
            <div key={i} style={{ width: 24 * u, borderRadius: 3 * u, background: "rgba(255,255,255,0.04)", border: `${0.12 * u}px solid rgba(255,255,255,0.10)`, padding: 2.2 * u, display: "flex", flexDirection: "column", alignItems: "center", gap: 0.6 * u }}>
              <span style={{ fontSize: 4 * u }}>{s[0]}</span>
              <span style={{ fontFamily, fontWeight: 700, fontSize: 3 * u, color: s[3] as string, fontVariantNumeric: "tabular-nums" }}>{s[1]}</span>
              <span style={{ fontFamily, fontWeight: 500, fontSize: 1.7 * u, color: TEXT_2 }}>{s[2]}</span>
            </div>
          ))}
        </div>
        {/* milestones unlocking */}
        <div style={{ display: "flex", gap: 2 * u }}>
          {milestones.map((m, i) => {
            const e = useEnter(m[2] as number, { damping: 11, stiffness: 110 });
            const unlocked = frame >= (m[2] as number);
            const pop = unlocked ? 1 : 0.5;
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.8 * u, opacity: 0.4 + 0.6 * e, transform: `scale(${0.85 + 0.15 * e})` }}>
                <div
                  style={{
                    width: 11 * u,
                    height: 11 * u,
                    borderRadius: "50%",
                    background: unlocked ? `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})` : "rgba(255,255,255,0.05)",
                    border: `${0.14 * u}px solid ${unlocked ? GREEN : "rgba(255,255,255,0.12)"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 5 * u,
                    filter: unlocked ? "none" : "grayscale(1) opacity(0.6)",
                    boxShadow: unlocked ? `0 0 ${2 * u}px ${GREEN}66` : "none",
                    transform: `scale(${pop})`,
                  }}
                >
                  {unlocked ? (m[0] as string) : "🔒"}
                </div>
                <span style={{ fontFamily, fontWeight: 600, fontSize: 1.7 * u, color: unlocked ? TEXT : TEXT_2 }}>{m[1]}</span>
              </div>
            );
          })}
        </div>
      </div>
      <Caption delay={150}>
        Your quit smoking <span style={{ color: GREEN }}>companion</span>
      </Caption>
    </Clip>
  );
};

// ════════════════════════════════════════════════════════════════════════
// Clip 5 · Water Tracker (15s / 450f)
// ════════════════════════════════════════════════════════════════════════
export const ClipWater: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const pct = interpolate(frame, [18, 120], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const litres = (pct / 100) * 2.6;
  const R = 28; // ring radius in u
  const C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;
  const ringE = useEnter(6, { damping: 16 });
  // water wave fill inside the ring
  const fillTop = interpolate(pct, [0, 100], [100, 8]); // % from top
  return (
    <Clip eyebrowText="Water Tracker" accent={BLUE} particleColor={BLUE_LT}>
      <div style={{ position: "relative", width: 70 * u, height: 70 * u, marginTop: 2 * u, opacity: ringE }}>
        {/* clipped water fill */}
        <div
          style={{
            position: "absolute",
            inset: 8 * u,
            borderRadius: "50%",
            overflow: "hidden",
            background: "rgba(59,130,246,0.06)",
          }}
        >
          <div style={{ position: "absolute", left: 0, right: 0, top: `${fillTop}%`, bottom: 0, background: `linear-gradient(180deg, ${BLUE_LT}, ${BLUE})`, opacity: 0.9 }}>
            {/* wave crest */}
            <svg viewBox="0 0 100 12" preserveAspectRatio="none" style={{ position: "absolute", top: -2.4 * u, left: 0, width: "100%", height: 3 * u }}>
              <path d={wavePath(frame)} fill={BLUE_LT} opacity={0.9} />
            </svg>
          </div>
        </div>
        {/* progress ring */}
        <svg width="100%" height="100%" viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
          <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={3.4} />
          <circle cx="50" cy="50" r={R} fill="none" stroke={BLUE_LT} strokeWidth={3.4} strokeLinecap="round" strokeDasharray={`${dash} ${C}`} style={{ filter: `drop-shadow(0 0 ${0.6 * u}px ${BLUE})` }} />
        </svg>
        {/* center readout */}
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 7 * u }}>💧</span>
          <span style={{ fontFamily, fontWeight: 700, fontSize: 8 * u, color: TEXT, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{Math.round(pct)}%</span>
          <span style={{ fontFamily, fontWeight: 600, fontSize: 2.6 * u, color: BLUE_LT, fontVariantNumeric: "tabular-nums" }}>{litres.toFixed(1)}L / 2.6L</span>
        </div>
      </div>
      <Caption delay={40}>
        Stay <span style={{ color: BLUE_LT }}>hydrated</span> every day
      </Caption>
    </Clip>
  );
};

// Deterministic sine wave path for the water crest.
function wavePath(frame: number): string {
  const pts: string[] = [];
  const phase = frame / 8;
  for (let x = 0; x <= 100; x += 5) {
    const y = 6 + Math.sin((x / 100) * Math.PI * 4 + phase) * 3;
    pts.push(`${x === 0 ? "M" : "L"}${x},${y.toFixed(2)}`);
  }
  return `${pts.join(" ")} L100,12 L0,12 Z`;
}

// ════════════════════════════════════════════════════════════════════════
// Clip 6 · Social Feed (20s / 600f)
// ════════════════════════════════════════════════════════════════════════
export const ClipFeed: React.FC = () => {
  const u = useUnit();
  const frame = useCurrentFrame();
  const posts = [
    { who: "@maya_eats", emoji: "🥗", cap: "Rainbow power bowl 🌈", color: GREEN },
    { who: "@fitdavid", emoji: "🍲", cap: "Meal-prep Sunday done", color: GOLD },
    { who: "@nina.green", emoji: "🥑", cap: "Avo toast, perfected", color: BLUE_LT },
  ];
  const reacts = ["❤️", "🔥", "👏", "😋", "💪"];
  return (
    <Clip eyebrowText="Community Feed" accent={GREEN}>
      <div style={{ position: "relative", width: 60 * u, marginTop: 1 * u, display: "flex", flexDirection: "column", gap: 2.6 * u }}>
        {posts.map((p, i) => {
          const e = useEnter(14 + i * 26, { damping: 14, stiffness: 90 });
          const likes = Math.round(interpolate(frame, [40 + i * 26, 120 + i * 26], [0, 128 + i * 57], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
          return (
            <div
              key={i}
              style={{
                opacity: e,
                transform: `translateY(${(1 - e) * 6 * u}px) scale(${0.96 + e * 0.04})`,
                borderRadius: 3.4 * u,
                background: "rgba(255,255,255,0.04)",
                border: `${0.12 * u}px solid rgba(255,255,255,0.08)`,
                padding: 2.4 * u,
                display: "flex",
                alignItems: "center",
                gap: 2.4 * u,
              }}
            >
              <div style={{ width: 14 * u, height: 14 * u, borderRadius: 2.6 * u, background: "rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8 * u, flexShrink: 0 }}>{p.emoji}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily, fontWeight: 700, fontSize: 2.4 * u, color: p.color }}>{p.who}</div>
                <div style={{ fontFamily, fontWeight: 500, fontSize: 2.3 * u, color: TEXT }}>{p.cap}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 1 * u, marginTop: 1 * u }}>
                  <span style={{ fontSize: 2.4 * u }}>❤️</span>
                  <span style={{ fontFamily, fontWeight: 600, fontSize: 2 * u, color: TEXT_2, fontVariantNumeric: "tabular-nums" }}>{likes.toLocaleString()}</span>
                </div>
              </div>
            </div>
          );
        })}
        {/* reactions flying up */}
        {reacts.map((r, i) => {
          const start = 150 + i * 12;
          const life = frame - start;
          if (life < 0 || life > 90) return null;
          const prog = life / 90;
          const rise = interpolate(prog, [0, 1], [0, -34 * u]);
          const op = interpolate(prog, [0, 0.15, 0.8, 1], [0, 1, 1, 0]);
          const sway = Math.sin((life + i * 18) / 12) * 3 * u;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                bottom: 6 * u,
                left: `${18 + i * 15}%`,
                transform: `translateY(${rise}px) translateX(${sway}px) scale(${0.8 + prog * 0.5})`,
                opacity: op,
                fontSize: 6 * u,
                filter: `drop-shadow(0 0 ${1.4 * u}px ${GREEN}66)`,
              }}
            >
              {r}
            </div>
          );
        })}
      </div>
      <Caption delay={40}>
        Join the <span style={{ color: GREEN }}>NutriFell community</span>
      </Caption>
    </Clip>
  );
};
