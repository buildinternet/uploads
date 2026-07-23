import React from "react";
import { T } from "../tokens";

/*
 * A fake "screenshot" — an abstract app UI (title + list rows + status
 * pills) so the loops need no real assets. `sparse` renders the same page
 * half-finished: muted title, one row, dashed placeholders — the "before"
 * or early-draft state.
 */
export const Shot: React.FC<{
  variant?: 0 | 1 | 2;
  width?: number;
  height?: number;
  label?: string;
  dim?: boolean;
  sparse?: boolean;
}> = ({ variant = 0, width = 300, height = 200, label, dim = false, sparse = false }) => {
  const accent = variant === 1 ? T.green : T.accent;
  const hl = variant % 3;
  const chrome = Math.max(20, height * 0.16);
  const rowH = Math.max(10, Math.min(16, height * 0.09));
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
            height: chrome,
            flexShrink: 0,
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
            gap: 9,
            overflow: "hidden",
          }}
        >
          {/* Page title */}
          <div
            style={{
              width: "46%",
              height: rowH,
              borderRadius: 4,
              background: sparse ? T.line : accent,
            }}
          />
          {/* List rows */}
          {[0, 1, 2].map((i) =>
            sparse && i > 0 ? (
              <div
                key={i}
                style={{
                  height: rowH + 4,
                  borderRadius: 4,
                  border: `1.5px dashed ${T.line}`,
                }}
              />
            ) : (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: rowH + 2,
                    height: rowH + 2,
                    borderRadius: 4,
                    background: T.line,
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    flex: 1,
                    height: Math.max(7, rowH - 5),
                    borderRadius: 4,
                    background: T.line,
                  }}
                />
                <div
                  style={{
                    width: width * 0.13,
                    height: rowH - 1,
                    borderRadius: 999,
                    background: !sparse && i === hl ? accent : T.line,
                    flexShrink: 0,
                  }}
                />
              </div>
            ),
          )}
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
