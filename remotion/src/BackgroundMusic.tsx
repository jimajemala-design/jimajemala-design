import React from "react";
import { Audio, interpolate, staticFile, useVideoConfig } from "remotion";

/**
 * Shared background-music layer for every composition.
 *
 * - Streams public/music.wav (an original, royalty-free 124-BPM loop).
 * - `loop` tiles the 15.5s track across longer comps (e.g. the 30s promo) and
 *   it gets trimmed cleanly on the 6s loops.
 * - The `volume` callback fades in at the start and out at the end, sized from
 *   each composition's own fps/duration so it works for both the 6s loops and
 *   the 30s promo without per-comp tuning.
 *
 * Swap the soundtrack by replacing public/music.wav (or pass `src="music.mp3"`
 * after dropping in your own file) — no other code changes needed.
 */
export const BackgroundMusic: React.FC<{ volume?: number; src?: string }> = ({
  volume = 0.6,
  src = "music.wav",
}) => {
  const { durationInFrames, fps } = useVideoConfig();
  const fadeIn = Math.min(Math.round(fps * 0.5), Math.floor(durationInFrames / 4));
  const fadeOut = Math.min(Math.round(fps * 1.2), Math.floor(durationInFrames / 3));

  return (
    <Audio
      src={staticFile(src)}
      loop
      volume={(f) =>
        Math.max(
          0,
          interpolate(
            f,
            [0, fadeIn, durationInFrames - fadeOut, durationInFrames - 1],
            [0, volume, volume, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          )
        )
      }
    />
  );
};
