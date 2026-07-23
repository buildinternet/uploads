import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { EASE, fall, rise } from "../kit/helpers";
import { Cmd, Out, TerminalFrame } from "../kit/Terminal";
import { Caption, Scene } from "../kit/Scene";
import { Loop } from "../kit/Loop";
import { Shot } from "../kit/Shot";

/*
 * Loop 3 — before/after pairing (~7s).
 * Two puts with matching stems magnetize into one paired card with a
 * sweeping divider.
 */
const W = 640;
const H = 330;

export const BeforeAfter: React.FC = () => {
  const frame = useCurrentFrame();
  const solo = fall(frame, 118, 12); // the two separate cards
  const pair = rise(frame, 126, 12); // the merged before/after card
  // Divider: settle at center, then one slow sweep right→left→center.
  const divider = interpolate(frame, [126, 138, 150, 178, 196], [0.5, 0.5, 0.78, 0.24, 0.5], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return (
    <Scene>
      <Loop>
        <Caption text="Automatic before / after." />
        <TerminalFrame branch="feat/settings">
          <Cmd text="uploads put settings-before.png" start={10} caretUntil={44} />
          <Out start={46} color={T.muted}>
            ✓ storage.uploads.sh/zach/settings-before.webp
          </Out>
          <Cmd text="uploads put settings-after.png" start={58} caretUntil={92} />
          <Out start={94} color={T.muted}>
            ✓ storage.uploads.sh/zach/settings-after.webp
          </Out>
        </TerminalFrame>
        <div style={{ position: "relative", width: W, height: H + 40 }}>
          {/* two separate cards */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              gap: 24,
              justifyContent: "center",
              opacity: solo,
            }}
          >
            <div
              style={{
                opacity: rise(frame, 50, 12),
                translate: `${(1 - solo) * 60}px ${(1 - rise(frame, 50, 12)) * 16}px`,
              }}
            >
              <Shot variant={0} width={300} height={H - 60} label="settings-before" dim sparse />
            </div>
            <div
              style={{
                opacity: rise(frame, 98, 12),
                translate: `${(1 - solo) * -60}px ${(1 - rise(frame, 98, 12)) * 16}px`,
              }}
            >
              <Shot variant={0} width={300} height={H - 60} label="settings-after" />
            </div>
          </div>
          {/* the paired card */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              justifyContent: "center",
              opacity: pair,
              scale: String(0.96 + pair * 0.04),
            }}
          >
            <div
              style={{
                position: "relative",
                width: W,
                height: H,
                borderRadius: T.radiusLg,
                overflow: "hidden",
                border: `1px solid ${T.line}`,
              }}
            >
              <div style={{ position: "absolute", inset: 0 }}>
                <Shot variant={0} width={W} height={H} dim sparse />
              </div>
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: `${(1 - divider) * 100}%`,
                  overflow: "hidden",
                  display: "flex",
                  justifyContent: "flex-end",
                }}
              >
                <div style={{ width: W, flexShrink: 0 }}>
                  <Shot variant={0} width={W} height={H} />
                </div>
              </div>
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${divider * 100}%`,
                  width: 3,
                  translate: "-1.5px 0px",
                  background: T.accent,
                }}
              />
              <PairChip side="left">before</PairChip>
              <PairChip side="right">after</PairChip>
            </div>
          </div>
        </div>
      </Loop>
    </Scene>
  );
};

const PairChip: React.FC<{ side: "left" | "right"; children: string }> = ({ side, children }) => (
  <div
    style={{
      position: "absolute",
      bottom: 14,
      [side]: 14,
      fontFamily: T.mono,
      fontSize: 18,
      color: T.fg,
      background: "rgba(10,10,11,0.75)",
      border: `1px solid ${T.line}`,
      borderRadius: 999,
      padding: "4px 14px",
    }}
  >
    {children}
  </div>
);
