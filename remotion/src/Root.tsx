import React from "react";
import { Composition } from "remotion";
import { FloatingFoods } from "./compositions/FloatingFoods";
import { GradientWave } from "./compositions/GradientWave";
import { ParticleFlow } from "./compositions/ParticleFlow";

const W = 1920;
const H = 1080;
const FPS = 60;
const DURATION = FPS * 6; // 360 frames — exactly 6 s

export const Root: React.FC = () => (
  <>
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
