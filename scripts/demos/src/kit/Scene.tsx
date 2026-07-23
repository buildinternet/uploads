import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { rise } from "./helpers";

/** The uploads.sh pixel mark (favicon chevrons). */
const Mark: React.FC<{ size?: number }> = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" shapeRendering="crispEdges">
    <path d="M4 0H28V4H32V28H28V32H4V28H0V4H4Z" fill={T.panel} />
    <g fill={T.accent}>
      <path d="M14 4h4v4h-4z M10 6h4v4h-4z M18 6h4v4h-4z M6 8h4v4h-4z M22 8h4v4h-4z" />
      <path
        opacity=".55"
        d="M14 12h4v4h-4z M10 14h4v4h-4z M18 14h4v4h-4z M6 16h4v4h-4z M22 16h4v4h-4z"
      />
      <path
        opacity=".28"
        d="M14 20h4v4h-4z M10 22h4v4h-4z M18 22h4v4h-4z M6 24h4v4h-4z M22 24h4v4h-4z"
      />
    </g>
  </svg>
);

/** Page ground + safe-area column + persistent uploads.sh tag. */
export const Scene: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(100% 72% at 50% 30%, #111015 0%, ${T.bg} 68%)`,
    }}
  >
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
        display: "flex",
        alignItems: "center",
        gap: 13,
        fontFamily: T.pixel,
        fontSize: 30,
        color: T.muted,
      }}
    >
      <Mark size={34} />
      uploads.sh
    </div>
  </AbsoluteFill>
);

/** Headline slot. Swaps text as each `swaps` entry's frame is reached. */
export const Caption: React.FC<{
  text: string;
  start?: number;
  swaps?: { at: number; text: string }[];
}> = ({ text, start = 0, swaps = [] }) => {
  const frame = useCurrentFrame();
  let active = text;
  let key = start;
  for (const s of swaps) {
    if (frame >= s.at) {
      active = s.text;
      key = s.at;
    }
  }
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
