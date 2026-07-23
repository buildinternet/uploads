import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { fall, rise } from "./helpers";

/*
 * Seamless-loop seam: content blinks through the page ground at the boundary.
 * First and last frames are both near-invisible, so end→start cuts cleanly.
 */
export const Loop: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 44,
        width: "100%",
        opacity: Math.min(rise(frame, 0, 7), fall(frame, durationInFrames - 9, 7)),
      }}
    >
      {children}
    </div>
  );
};
