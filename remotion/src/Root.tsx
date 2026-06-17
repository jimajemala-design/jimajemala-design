import React from "react";
import { Composition } from "remotion";
import { FloatingFoods } from "./compositions/FloatingFoods";
import { GradientWave } from "./compositions/GradientWave";
import { ParticleFlow } from "./compositions/ParticleFlow";
import { PromoVideo } from "./compositions/PromoVideo";

const W = 1920;
const H = 1080;
const FPS = 60;
const DURATION = FPS * 6; // 360 frames — exactly 6 s

// Promo: 30 s @ 30fps = 900 frames, rendered in two aspect ratios.
const PROMO_FPS = 30;
const PROMO_FRAMES = PROMO_FPS * 30;

export const Root: React.FC = () => (
  <>
    {/* 30-second promo — vertical (TikTok / Reels / Shorts) */}
    <Composition
      id="PromoVertical"
      component={PromoVideo}
      width={1080}
      height={1920}
      fps={PROMO_FPS}
      durationInFrames={PROMO_FRAMES}
    />
    {/* 30-second promo — horizontal (YouTube / web) */}
    <Composition
      id="PromoHorizontal"
      component={PromoVideo}
      width={1920}
      height={1080}
      fps={PROMO_FPS}
      durationInFrames={PROMO_FRAMES}
    />
    <Composition
      id="FloatingFoods"
      component={FloatingFoods}
      width={W}
      height={H}
      fps={FPS}
      durationInFrames={DURATION}
    />
    <Composition
      id="GradientWave"
      component={GradientWave}
      width={W}
      height={H}
      fps={FPS}
      durationInFrames={DURATION}
    />
    <Composition
      id="ParticleFlow"
      component={ParticleFlow}
      width={W}
      height={H}
      fps={FPS}
      durationInFrames={DURATION}
    />
  </>
);
