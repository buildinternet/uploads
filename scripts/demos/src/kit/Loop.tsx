import React from "react";
import { useCurrentFrame } from "remotion";
import { rise } from "./helpers";

/*
 * Loop restart: the video ends on the full assembled frame (never blank —
 * players and thumbnails show real content), and each pass opens with a
 * quick fade-in, so the end→start cut reads as an intentional restart.
 */
export const Loop: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 44,
        width: "100%",
        opacity: rise(frame, 0, 7),
      }}
    >
      {children}
    </div>
  );
};
