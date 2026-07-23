import React from "react";
import { useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { rise, typed, typedEnd } from "./helpers";

/** Window chrome shared by every loop. Children are the terminal lines. */
export const TerminalFrame: React.FC<{
  width?: number;
  children: React.ReactNode;
  title?: string;
}> = ({ width = 880, children, title = "agent — zsh" }) => (
  <div
    style={{
      width,
      background: T.panel,
      border: `1px solid ${T.line}`,
      borderRadius: T.radiusLg,
      overflow: "hidden",
      boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "14px 18px",
        borderBottom: `1px solid ${T.line}`,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            background: T.line,
          }}
        />
      ))}
      <div
        style={{
          marginLeft: 10,
          fontFamily: T.mono,
          fontSize: 20,
          color: T.muted,
        }}
      >
        {title}
      </div>
    </div>
    <div
      style={{
        padding: "26px 30px",
        fontFamily: T.mono,
        fontSize: 29,
        lineHeight: 1.75,
        color: T.body,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </div>
  </div>
);

/** A `$ command` line that types itself starting at `start`. */
export const Cmd: React.FC<{
  text: string;
  start: number;
  caretUntil?: number;
}> = ({ text, start, caretUntil = Infinity }) => {
  const frame = useCurrentFrame();
  if (frame < start) {
    // Invisible placeholder keeps the terminal height stable pre-typing.
    return (
      <div style={{ whiteSpace: "pre", opacity: 0 }}>
        <span>$ </span>
        {text}
      </div>
    );
  }
  const visible = typed(text, frame, start);
  const done = frame >= typedEnd(text, start);
  const caretOn = frame < caretUntil && (!done || Math.floor(frame / 16) % 2 === 0);
  return (
    <div style={{ whiteSpace: "pre" }}>
      <span style={{ color: T.muted }}>$ </span>
      <span style={{ color: T.fg }}>{visible}</span>
      <Caret on={caretOn} />
    </div>
  );
};

/** Idle prompt with optional blinking caret. */
export const Prompt: React.FC<{ caret?: boolean }> = ({ caret = true }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ whiteSpace: "pre" }}>
      <span style={{ color: T.muted }}>$ </span>
      <Caret on={caret && Math.floor(frame / 16) % 2 === 0} />
    </div>
  );
};

const Caret: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    style={{
      display: "inline-block",
      width: 15,
      height: 32,
      verticalAlign: "text-bottom",
      background: T.accent,
      opacity: on ? 1 : 0,
    }}
  />
);

/** Output line fading in at `start`. */
export const Out: React.FC<{
  start: number;
  color?: string;
  children: React.ReactNode;
}> = ({ start, color = T.body, children }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        whiteSpace: "pre",
        color,
        opacity: rise(frame, start, 8),
        translate: `0px ${(1 - rise(frame, start, 8)) * 8}px`,
      }}
    >
      {children}
    </div>
  );
};
