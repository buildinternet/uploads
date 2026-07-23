import React from "react";
import { useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { rise } from "../kit/helpers";
import { Cmd, Out, TerminalFrame } from "../kit/Terminal";
import { Caption, Scene } from "../kit/Scene";
import { Loop } from "../kit/Loop";
import { Shot } from "../kit/Shot";

/*
 * Loop 1 — the hook (~6s).
 * `uploads put after.png` → public URL → the image itself, hosted.
 */
export const PutUrl: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene>
      <Loop>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <Caption text="The missing upload command" />
          <div
            style={{
              fontFamily: T.sans,
              fontSize: 28,
              color: T.muted,
              height: 36,
            }}
          >
            for coding agents.
          </div>
        </div>
        <TerminalFrame>
          <Cmd text="uploads put screenshot.png" start={12} caretUntil={40} />
          <Out start={42} color={T.green}>
            ✓ uploaded
          </Out>
          <Out start={50} color={T.accent}>
            storage.uploads.sh/zach/screenshot.webp
          </Out>
        </TerminalFrame>
        <div
          style={{
            opacity: rise(frame, 64, 14),
            translate: `0px ${(1 - rise(frame, 64, 14)) * 24}px`,
            scale: String(0.96 + rise(frame, 64, 14) * 0.04),
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
          }}
        >
          <Shot variant={0} width={430} height={264} />
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 21,
              color: T.body,
              border: `1px solid ${T.line}`,
              background: T.panel,
              borderRadius: 999,
              padding: "8px 20px",
            }}
          >
            <span style={{ color: T.accent }}>↗</span> storage.uploads.sh/zach/screenshot.webp
          </div>
        </div>
      </Loop>
    </Scene>
  );
};
