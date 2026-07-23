import React from "react";
import { useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { fall, rise } from "../kit/helpers";
import { Cmd, Out, TerminalFrame } from "../kit/Terminal";
import { Caption, Scene } from "../kit/Scene";
import { Loop } from "../kit/Loop";
import { Shot } from "../kit/Shot";

/*
 * Loop 4 — problem framing (~9s).
 * An agent's PR arrives all text, no visuals. Collecting screenshots today
 * is an end-of-task scramble (checking out main just to capture a before);
 * `uploads put` lets the agent show its work instead.
 */
export const Why: React.FC = () => {
  const frame = useCurrentFrame();
  const placeholder = Math.min(rise(frame, 30, 10), fall(frame, 196, 8));
  const termUp = rise(frame, 56, 14);
  const scramble = Math.min(termUp, fall(frame, 140, 10));
  const fix = rise(frame, 148, 10);
  const markdown = rise(frame, 200, 10);
  const rendered = rise(frame, 214, 12);
  return (
    <Scene>
      <Loop>
        <Caption
          text="Agent PRs: no screenshots."
          swaps={[
            { at: 70, text: "Collecting them is a scramble." },
            { at: 150, text: "Now agents can show their work." },
          ]}
        />
        {/* The agent's PR — all text, no visuals */}
        <div
          style={{
            width: 880,
            background: T.panel,
            border: `1px solid ${T.line}`,
            borderRadius: T.radiusLg,
            padding: 24,
            boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              marginBottom: 18,
            }}
          >
            <span
              style={{
                fontFamily: T.sans,
                fontSize: 27,
                fontWeight: 600,
                color: T.fg,
              }}
            >
              Fix onboarding flow
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 22, color: T.muted }}>#214</span>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 17,
                color: T.green,
                border: `1px solid ${T.green}`,
                borderRadius: 999,
                padding: "3px 13px",
              }}
            >
              Open
            </span>
          </div>
          {/* Description skeleton — the words are there, the proof isn't */}
          <div style={{ display: "flex", flexDirection: "column", gap: 13, marginBottom: 16 }}>
            {[0.92, 0.78, 0.55].map((w, i) => (
              <div
                key={i}
                style={{
                  width: `${w * 100}%`,
                  height: 12,
                  borderRadius: 4,
                  background: T.line,
                  opacity: rise(frame, 6 + i * 6, 8),
                }}
              />
            ))}
          </div>
          <div
            style={{
              minHeight: 190,
              border: `1.5px dashed ${T.line}`,
              borderRadius: T.radiusMd,
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              alignItems: rendered > 0 ? "flex-start" : "center",
              justifyContent: rendered > 0 ? "flex-start" : "center",
            }}
          >
            {rendered > 0 ? (
              <>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 21,
                    color: T.accent,
                    opacity: markdown,
                  }}
                >
                  ![onboarding](storage.uploads.sh/zach/onboarding.webp)
                </div>
                <div style={{ opacity: rendered, scale: String(0.95 + rendered * 0.05) }}>
                  <Shot variant={0} width={330} height={128} />
                </div>
              </>
            ) : (
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 25,
                  color: T.muted,
                  opacity: placeholder,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 28 }}>▦</span> no screenshots
              </div>
            )}
          </div>
        </div>
        {/* Terminal: the scramble, then the fix */}
        <div style={{ position: "relative", width: 880, height: 314 }}>
          <div
            style={{
              position: "absolute",
              inset: "0 0 auto 0",
              opacity: scramble,
              translate: `0px ${(1 - termUp) * 40}px`,
            }}
          >
            <TerminalFrame width={880} branch="fix/onboarding">
              <Cmd text="git checkout main" start={64} caretUntil={84} cpf={2.6} />
              <Cmd text="playwright screenshot before.png" start={84} caretUntil={110} cpf={2.6} />
              <Cmd text="git checkout fix/onboarding" start={110} caretUntil={140} cpf={2.6} />
            </TerminalFrame>
          </div>
          <div
            style={{
              position: "absolute",
              inset: "0 0 auto 0",
              opacity: fix,
              translate: `0px ${(1 - fix) * 24}px`,
            }}
          >
            <TerminalFrame width={880} branch="fix/onboarding">
              <Cmd text="uploads put onboarding.png" start={152} caretUntil={184} />
              <Out start={186} color={T.accent}>
                storage.uploads.sh/zach/onboarding.webp
              </Out>
            </TerminalFrame>
          </div>
        </div>
      </Loop>
    </Scene>
  );
};
