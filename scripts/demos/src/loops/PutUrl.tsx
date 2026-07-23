import React from "react";
import { useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { rise } from "../kit/helpers";
import { Cmd, Out, TerminalFrame } from "../kit/Terminal";
import { Scene } from "../kit/Scene";
import { Loop } from "../kit/Loop";
import { Shot } from "../kit/Shot";

/*
 * Loop 1 — the hook (~7s), captionless: `uploads put` → ready-to-paste
 * markdown → the image itself, hosted. Show, don't tell.
 */
export const PutUrl: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Scene>
      <Loop>
        <TerminalFrame width={1000} branch="feat/checkout">
          <Cmd text="uploads put screenshot.png" start={15} caretUntil={48} />
          <Out start={50} color={T.green}>
            ✓ uploaded
          </Out>
          <Out start={60} color={T.accent}>
            ![screenshot](storage.uploads.sh/zach/screenshot.png)
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
