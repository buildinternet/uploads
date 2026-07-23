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
          <Cmd text="uploads put screenshot.png" start={15} caretUntil={48} />
          <Out start={50} color={T.green}>
            ✓ uploaded
          </Out>
          <Out start={60} color={T.accent}>
            storage.uploads.sh/zach/screenshot.png
          </Out>
        </TerminalFrame>
        <div
          style={{
            opacity: rise(frame, 78, 14),
            translate: `0px ${(1 - rise(frame, 78, 14)) * 24}px`,
            scale: String(0.96 + rise(frame, 78, 14) * 0.04),
          }}
        >
          <Shot variant={0} width={470} height={290} />
        </div>
      </Loop>
    </Scene>
  );
};
