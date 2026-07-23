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
 * Three puts stage onto the branch as work progresses; `gh pr create`
 * promotes everything into one attachments comment.
 */
const SHOTS = [
  { file: "shot-1.png", cmd: 15, out: 42, thumb: 50 },
  { file: "shot-2.png", cmd: 75, out: 102, thumb: 110 },
  { file: "shot-3.png", cmd: 135, out: 162, thumb: 170 },
] as const;

export const StagedLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const phaseA = fall(frame, 216, 12);
  const phaseB = rise(frame, 226, 12);
  return (
    <Scene>
      <Loop>
        <Caption
          text="Staged while the agent works."
          swap={{ at: 230, text: "The PR opens already furnished." }}
        />
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
                <span style={{ color: T.accent }}>⎇</span> feat/gallery
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
                {SHOTS.map((s, i) => (
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
                    <Shot variant={(i % 3) as 0 | 1 | 2} width={168} height={104} />
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 17,
                        color: T.green,
                        whiteSpace: "nowrap",
                      }}
                    >
                      ✓ {s.file}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <TerminalFrame width={620}>
              {SHOTS.map((s) => (
                <React.Fragment key={s.file}>
                  <Cmd text={`uploads put ${s.file}`} start={s.cmd} caretUntil={s.out} />
                  <Out start={s.out} color={T.muted}>
                    staged → feat/gallery
                  </Out>
                </React.Fragment>
              ))}
              <Cmd text="gh pr create" start={192} caretUntil={218} />
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
            <Comment width={860} meta="attachments · 3 files">
              <div style={{ display: "flex", gap: 20, justifyContent: "center" }}>
                {SHOTS.map((s, i) => (
                  <div
                    key={s.file}
                    style={{
                      opacity: rise(frame, 236 + i * 7, 9),
                      scale: String(0.92 + rise(frame, 236 + i * 7, 9) * 0.08),
                    }}
                  >
                    <Shot variant={(i % 3) as 0 | 1 | 2} width={244} height={158} label={s.file} />
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
