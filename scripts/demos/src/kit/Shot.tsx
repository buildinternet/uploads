import React from "react";
import { T } from "../tokens";

/*
 * A fake "screenshot" — an abstract mini-UI so the loops need no real assets.
 * Variants shuffle the block layout so multiple shots read as different pages.
 */
const PALETTES: string[][] = [
  [T.accent, T.line, T.line],
  [T.line, T.green, T.line],
  [T.line, T.line, T.accent],
];

export const Shot: React.FC<{
  variant?: 0 | 1 | 2;
  width?: number;
  height?: number;
  label?: string;
  dim?: boolean;
}> = ({ variant = 0, width = 300, height = 200, label, dim = false }) => {
  const pal = PALETTES[variant];
  const bar = (i: number) => 0.35 + ((variant * 7 + i * 3) % 5) * 0.13;
  return (
    <div
      style={{
        width,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "stretch",
      }}
    >
      <div
        style={{
          width,
          height,
          background: "#17171a",
          border: `1px solid ${T.line}`,
          borderRadius: T.radiusMd,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          filter: dim ? "brightness(0.75)" : undefined,
        }}
      >
        <div
          style={{
            height: height * 0.16,
            borderBottom: `1px solid ${T.line}`,
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "0 10px",
          }}
        >
          <div style={{ width: 7, height: 7, borderRadius: 4, background: T.line }} />
          <div style={{ width: 7, height: 7, borderRadius: 4, background: T.line }} />
          <div
            style={{
              marginLeft: 6,
              width: width * 0.34,
              height: 7,
              borderRadius: 4,
              background: T.line,
            }}
          />
        </div>
        <div
          style={{
            flex: 1,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              width: "52%",
              height: 12,
              borderRadius: 4,
              background: pal[0],
            }}
          />
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "flex-end",
              gap: 8,
            }}
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: `${bar(i) * 100}%`,
                  borderRadius: 3,
                  background:
                    i === (variant * 2) % 5
                      ? pal[variant === 1 ? 1 : variant === 2 ? 2 : 0]
                      : T.line,
                }}
              />
            ))}
          </div>
        </div>
      </div>
      {label ? (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 19,
            color: T.muted,
            textAlign: "center",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};
