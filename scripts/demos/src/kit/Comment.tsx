import React from "react";
import { T } from "../tokens";

/** Stylized GitHub PR comment — GitHub-shaped, uploads-toned. */
export const Comment: React.FC<{
  width?: number;
  children: React.ReactNode;
  author?: string;
  meta?: string;
}> = ({ width = 880, children, author = "uploads", meta = "commented now" }) => (
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
        gap: 12,
        padding: "14px 20px",
        borderBottom: `1px solid ${T.line}`,
        background: "#161618",
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          background: T.bg,
          border: `1px solid ${T.line}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: T.pixel,
          fontSize: 20,
          color: T.accent,
        }}
      >
        u
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 22, color: T.fg }}>{author}</div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 16,
          color: T.muted,
          border: `1px solid ${T.line}`,
          borderRadius: 999,
          padding: "2px 10px",
        }}
      >
        bot
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 18, color: T.muted }}>{meta}</div>
    </div>
    <div style={{ padding: 24 }}>{children}</div>
  </div>
);
