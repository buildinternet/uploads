import React from "react";
import { useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { fall, rise } from "../kit/helpers";
import { Cmd, Out, TerminalFrame } from "../kit/Terminal";
import { Caption, Scene } from "../kit/Scene";
import { Loop } from "../kit/Loop";
import { Shot } from "../kit/Shot";
import { Comment } from "../kit/Comment";

/*
 * Loop 2 — the signature flow (~10s).
 * Screenshots save onto the branch as the agent works — including revising
 * one it already saved — then `gh pr create` promotes everything into one
 * attachments comment.
 */
const EVENTS = [
  { file: "cart.png", cmd: 15, out: 46, thumb: 54, update: false },
  { file: "checkout.png", cmd: 85, out: 116, thumb: 124, update: false },
  { file: "cart.png", cmd: 155, out: 186, thumb: 194, update: true },
] as const;

const RAIL = [
  { file: "cart.png", variant: 0, thumb: 54, updatedAt: 194 },
  { file: "checkout.png", variant: 1, thumb: 124 },
] as const;

export const StagedLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const phaseA = fall(frame, 242, 12);
  const phaseB = rise(frame, 252, 12);
  return (
    <Scene>
      <Loop>
        <Caption text="Save as you go" swaps={[{ at: 256, text: "Ready when the PR opens" }]} />
        <div style={{ position: "relative", width: 920, height: 640 }}>
          {/* Phase A: branch rail + terminal */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              gap: 36,
              alignItems: "flex-start",
              justifyContent: "center",
              opacity: phaseA,
              scale: String(0.97 + phaseA * 0.03),
            }}
          >
            <div
              style={{
                width: 230,
                display: "flex",
                flexDirection: "column",
                gap: 18,
                paddingTop: 4,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 21,
                  color: T.muted,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ color: T.accent }}>⎇</span> feat/checkout
              </div>
              <div
                style={{
                  borderLeft: `2px solid ${T.line}`,
                  paddingLeft: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                {RAIL.map((s) => {
                  const updated = "updatedAt" in s && frame >= s.updatedAt;
                  const pulse =
                    "updatedAt" in s
                      ? Math.min(rise(frame, s.updatedAt, 6), fall(frame, s.updatedAt + 22, 12))
                      : 0;
                  return (
                    <div
                      key={s.file}
                      style={{
                        opacity: rise(frame, s.thumb, 10),
                        translate: `${(1 - rise(frame, s.thumb, 10)) * -14}px 0px`,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      <div
                        style={{
                          borderRadius: T.radiusMd,
                          boxShadow: pulse > 0 ? `0 0 0 2.5px ${T.accent}` : undefined,
                          opacity: pulse > 0 ? undefined : 1,
                        }}
                      >
                        <Shot
                          variant={s.variant}
                          width={168}
                          height={104}
                          sparse={"updatedAt" in s && !updated}
                        />
                      </div>
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 17,
                          color: updated ? T.accent : T.green,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {updated ? "↻" : "✓"} {s.file}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <TerminalFrame width={620}>
              {EVENTS.map((e, i) => (
                <React.Fragment key={i}>
                  <Cmd text={`uploads put ${e.file}`} start={e.cmd} caretUntil={e.out} />
                  <Out start={e.out} color={T.muted}>
                    {e.update ? "updated on feat/checkout" : "saved on feat/checkout"}
                  </Out>
                </React.Fragment>
              ))}
              <Cmd text="gh pr create" start={216} caretUntil={244} />
            </TerminalFrame>
          </div>
          {/* Phase B: the assembled attachments comment */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: phaseB,
              translate: `0px ${(1 - phaseB) * 30}px`,
            }}
          >
            <Comment width={860} meta="attachments · 2 files">
              <div style={{ display: "flex", gap: 24, justifyContent: "center" }}>
                {RAIL.map((s, i) => (
                  <div
                    key={s.file}
                    style={{
                      opacity: rise(frame, 262 + i * 7, 9),
                      scale: String(0.92 + rise(frame, 262 + i * 7, 9) * 0.08),
                    }}
                  >
                    <Shot variant={s.variant} width={290} height={182} label={s.file} />
                  </div>
                ))}
              </div>
            </Comment>
          </div>
        </div>
      </Loop>
    </Scene>
  );
};
