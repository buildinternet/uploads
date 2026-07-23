import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { T } from "../tokens";
import { EASE, fall, rise } from "../kit/helpers";
import { Cmd, Out, TerminalFrame } from "../kit/Terminal";
import { Caption, Scene } from "../kit/Scene";
import { Loop } from "../kit/Loop";
import { Shot } from "../kit/Shot";

/*
 * Loop 4 — problem framing (~8s).
 * A file dragged at GitHub's comment box bounces off; `uploads put` is the
 * step that actually gets the image in.
 */
export const Why: React.FC = () => {
  const frame = useCurrentFrame();
  // Drag: chip travels from its slot toward the box, then bounces back.
  const travel = interpolate(frame, [18, 58], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const bounce = interpolate(frame, [58, 74], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const reach = travel - bounce * 0.55; // falls back but not to the start
  const shake = frame >= 58 && frame < 74 ? Math.sin((frame - 58) * 1.6) * 7 * (1 - bounce) : 0;
  const denied = frame >= 58 && frame < 100;
  const chipGone = fall(frame, 82, 10);
  const markdown = rise(frame, 138, 10);
  const rendered = rise(frame, 156, 12);
  const termUp = rise(frame, 84, 14);
  return (
    <Scene>
      <Loop>
        <Caption
          text="Agents can’t drag-and-drop."
          swap={{ at: 132, text: "uploads is the missing step." }}
        />
        {/* GitHub-ish comment box */}
        <div
          style={{
            width: 880,
            background: T.panel,
            border: `1px solid ${denied ? T.red : T.line}`,
            borderRadius: T.radiusLg,
            padding: 22,
            translate: `${shake}px 0px`,
            boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 20,
              color: T.muted,
              marginBottom: 14,
            }}
          >
            Write a comment
          </div>
          <div
            style={{
              minHeight: 190,
              border: `1.5px dashed ${denied ? T.red : T.line}`,
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
                  ![proof](uploads.sh/zach/proof.png)
                </div>
                <div style={{ opacity: rendered, scale: String(0.95 + rendered * 0.05) }}>
                  <Shot variant={2} width={330} height={128} />
                </div>
              </>
            ) : (
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 25,
                  color: denied ? T.red : T.muted,
                }}
              >
                {denied
                  ? "Attaching files requires a browser session"
                  : "Attach files by dragging & dropping"}
              </div>
            )}
          </div>
        </div>
        {/* Terminal slides up for the fix */}
        <div
          style={{
            opacity: termUp,
            translate: `0px ${(1 - termUp) * 40}px`,
            width: "100%",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <TerminalFrame width={880}>
            <Cmd text="uploads put ./proof.png" start={94} caretUntil={126} />
            <Out start={128} color={T.accent}>
              https://uploads.sh/zach/proof.png
            </Out>
          </TerminalFrame>
        </div>
      </Loop>
      {/* Dragged file chip + cursor, above everything */}
      <div
        style={{
          position: "absolute",
          left: 140 + reach * 320,
          top: 800 - reach * 165,
          opacity: Math.min(rise(frame, 6, 8), chipGone),
          rotate: `${reach * -6}deg`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: T.mono,
            fontSize: 21,
            color: T.fg,
            background: T.panel,
            border: `1px solid ${T.line}`,
            borderRadius: T.radiusMd,
            padding: "10px 18px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
          }}
        >
          <span style={{ color: T.accent }}>▦</span> proof.png
        </div>
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          style={{ position: "absolute", right: -14, bottom: -16 }}
        >
          <path
            d="M5 2 L19 13 L12.5 13.8 L16 21 L13.2 22.2 L9.8 15.2 L5 19.5 Z"
            fill={T.fg}
            stroke={T.bg}
            strokeWidth="1.4"
          />
        </svg>
      </div>
    </Scene>
  );
};
