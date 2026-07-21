/**
 * Canonical metadata derived from a screenshot capture, where the CLI knows
 * the inputs exactly. Pure: no I/O, no throwing — an unparseable URL simply
 * yields fewer keys.
 *
 * Design: .context/2026-07-21-upload-metadata-vocabulary-design.md
 */
import { dropUnsafeMetaValues } from "./metadata.js";
import { formatViewport } from "./metadata-vocab.js";
import { classifyTarget, type ScreenshotTarget, type ScreenshotViewport } from "./screenshot.js";

export interface CaptureFactsInput {
  target: ScreenshotTarget;
  viewport: ScreenshotViewport;
  /** Only set when the caller forced a scheme (`--dark` / `--light`). */
  colorScheme?: "dark" | "light";
}

/**
 * Derive `url`/`path`/`env`/`theme`/`viewport` from a capture. `env` is only
 * ever `local`: inferring `prod` from "not localhost" would mislabel every
 * staging and preview URL, and wrong metadata is worse than absent metadata.
 */
export function captureFacts(input: CaptureFactsInput): Record<string, string> {
  const facts: Record<string, string> = {};

  facts.viewport = formatViewport(
    input.viewport.width,
    input.viewport.height,
    input.viewport.deviceScaleFactor,
  );

  if (input.colorScheme) facts.theme = input.colorScheme;

  if (input.target.kind === "url") {
    facts.url = input.target.url;
    try {
      facts.path = new URL(input.target.url).pathname || "/";
    } catch {
      // classifyTarget already validated this, but never let a URL parse
      // failure cost us the other facts.
    }
    if (input.target.localOnly) facts.env = "local";
  }

  // A long query string can exceed the 512-char value cap; drop rather than
  // let a derived value fail the upload.
  return dropUnsafeMetaValues(facts);
}

/**
 * `captureFacts` for a raw target string, never at the cost of the capture
 * itself: an unclassifiable target yields no facts rather than an error.
 * Shared by the CLI and MCP screenshot paths.
 */
export function safeCaptureFacts(
  target: string,
  viewport: ScreenshotViewport,
  colorScheme: "dark" | "light" | undefined,
): Record<string, string> {
  try {
    return captureFacts({ target: classifyTarget(target), viewport, colorScheme });
  } catch {
    return {}; // derived metadata must never fail a capture
  }
}
