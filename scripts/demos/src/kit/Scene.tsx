import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { CAPTION_CPF, typed, typedEnd } from "./helpers";

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
      background: `radial-gradient(110% 80% at 50% 24%, #16111f 0%, ${T.bg} 66%)`,
    }}
  >
    {/* Session frame — hairline inset that reads as a terminal session border. */}
    <div
      style={{
        position: "absolute",
        inset: 36,
        border: "1px solid rgba(194,126,255,.14)",
        borderRadius: 12,
      }}
    />
    <AbsoluteFill
      style={{
        padding: "160px 80px 110px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 48,
      }}
    >
      {children}
    </AbsoluteFill>
    <div
      style={{
        position: "absolute",
        bottom: 64,
        right: 78,
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

/*
 * Headline slot — a typed mono line with a block caret, pinned to the top of
 * the frame rather than flowing with the content column. Each `swaps` entry
 * retypes from scratch at its frame instead of cross-fading.
 */
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
  const visible = typed(active, frame, key, CAPTION_CPF);
  /*
   * Caret sells the typing, then gets out of the way — a cursor parked under a
   * static headline just pulls the eye off the terminal. It also stays hidden
   * before the first character lands: the untyped tail holds full width, so a
   * caret with nothing typed yet floats alone at the far right of the row.
   */
  const done = frame >= typedEnd(active, key, CAPTION_CPF);
  const caretOn = visible.length > 0 && !done;
  return (
    <div
      style={{
        position: "absolute",
        top: 72,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "baseline",
        gap: 16,
      }}
    >
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 44,
          letterSpacing: "0.04em",
          color: T.fg,
          whiteSpace: "pre",
        }}
      >
        {visible}
        {/* Untyped tail holds its width so the centered row never reflows. */}
        <span style={{ visibility: "hidden" }}>{active.slice(visible.length)}</span>
      </div>
      <div
        style={{
          width: 20,
          height: 38,
          background: T.accent,
          opacity: caretOn ? 1 : 0,
          transform: "translateY(4px)",
        }}
      />
    </div>
  );
};
