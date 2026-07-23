import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { rise } from "./helpers";

/** Page ground + safe-area column + persistent uploads.sh tag. */
export const Scene: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: T.bg }}>
    <AbsoluteFill
      style={{
        padding: "100px 80px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 44,
      }}
    >
      {children}
    </AbsoluteFill>
    <div
      style={{
        position: "absolute",
        bottom: 42,
        right: 48,
        fontFamily: T.pixel,
        fontSize: 30,
        color: T.muted,
      }}
    >
      uploads.sh
    </div>
  </AbsoluteFill>
);

/** Headline slot. Swaps text when a `swap` entry's frame is reached. */
export const Caption: React.FC<{
  text: string;
  start?: number;
  swap?: { at: number; text: string };
  accentWord?: string;
}> = ({ text, start = 0, swap }) => {
  const frame = useCurrentFrame();
  const active = swap && frame >= swap.at ? swap.text : text;
  const key = swap && frame >= swap.at ? swap.at : start;
  return (
    <div
      style={{
        fontFamily: T.sans,
        fontWeight: 560,
        fontSize: 56,
        letterSpacing: "-0.02em",
        color: T.fg,
        textAlign: "center",
        whiteSpace: "nowrap",
        opacity: rise(frame, key, 10),
        translate: `0px ${(1 - rise(frame, key, 10)) * 10}px`,
        minHeight: 70,
      }}
    >
      {active}
    </div>
  );
};
