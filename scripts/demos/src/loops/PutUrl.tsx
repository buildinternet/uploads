import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { EASE, rise } from "../kit/helpers";
import { Cmd, Out, TerminalFrame } from "../kit/Terminal";
import { Caption, Scene } from "../kit/Scene";
import { Loop } from "../kit/Loop";
import { CheckoutShot } from "../kit/Shot";

/*
 * Loop 1 — the hook (~7.6s): `uploads put` → ready-to-paste markdown → the
 * page itself, hosted. Branch-scoped storage shows up in the URL path.
 * Scenes: Command 0–78 / Upload 78–132 / Payoff 132–228.
 */
export const PutUrl: React.FC = () => {
  const frame = useCurrentFrame();
  const shot = interpolate(frame, [135, 153], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return (
    <Scene>
      <Loop>
        <Caption text="uploads cli for agents" start={8} />
        <TerminalFrame width={1000} branch="feat/checkout">
          <Cmd text="uploads put checkout.png" start={32} caretUntil={78} />
          <Out start={82} color={T.green}>
            ✓ uploaded
          </Out>
          <Out start={95} fontSize={25}>
            {"![checkout](storage.uploads.sh/zach/"}
            <span style={{ color: T.accent, fontWeight: 600 }}>feat-checkout</span>
            {"/checkout.png)"}
          </Out>
        </TerminalFrame>
        <div
          style={{
            opacity: shot,
            translate: `0px ${(1 - shot) * 26}px`,
            scale: String(0.96 + shot * 0.04),
          }}
        >
          <CheckoutShot label="checkout.png" labelOpacity={rise(frame, 149, 12)} />
        </div>
      </Loop>
    </Scene>
  );
};
