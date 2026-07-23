import { Easing, interpolate } from "remotion";

export const EASE = Easing.bezier(0.16, 1, 0.3, 1);

/** 0→1 over [start, start+dur], clamped both sides, brand easing. */
export const rise = (frame: number, start: number, dur = 12) =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

/** 1→0 over [start, start+dur] — used to reset dynamic content for the loop seam. */
export const fall = (frame: number, start: number, dur = 12) =>
  interpolate(frame, [start, start + dur], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

/** Characters visible for a line that starts typing at `start`. */
export const typed = (text: string, frame: number, start: number, cpf = 1.3) =>
  text.slice(0, Math.max(0, Math.floor((frame - start) * cpf)));

/** Frame at which typing that starts at `start` finishes. */
export const typedEnd = (text: string, start: number, cpf = 1.3) =>
  start + Math.ceil(text.length / cpf);
