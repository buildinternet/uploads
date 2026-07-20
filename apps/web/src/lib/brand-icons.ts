/**
 * Brand marks used on plain (non-React) account/auth surfaces.
 *
 * Lucide intentionally dropped brand logos, so we don't invent paths here —
 * these are the same official marks sibling apps already ship (e.g. releases
 * `AccountIcon` for GitHub).
 */

/** Official GitHub mark path (viewBox 0 0 24 24), fill with currentColor. */
export const GITHUB_MARK_PATH =
  "M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z";

/** Inline SVG for script-built HTML (account profile list rows, etc.). */
export function githubMarkSvg(opts?: { size?: number; className?: string }): string {
  const size = opts?.size ?? 14;
  const className = opts?.className ? ` class="${opts.className}"` : "";
  return `<svg${className} viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${GITHUB_MARK_PATH}"/></svg>`;
}

/**
 * Official GitHub octicons (viewBox 0 0 16 16, fill with currentColor) that
 * stand in for the kind label: the branch glyph reads "pull request", the
 * circled dot reads "issue". Wherever we show a `gh.*` ref, the icon carries
 * the kind so we don't repeat the word next to it.
 */
export const GH_KIND_PATH: Record<"pull" | "issue", string> = {
  pull: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  issue:
    "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm9 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM8 4a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 4Z",
};

const GH_KIND_LABEL: Record<"pull" | "issue", string> = {
  pull: "pull request",
  issue: "issue",
};

/**
 * Inline SVG for the PR/issue octicon in script-built HTML. Titled with the
 * kind so the glyph is announced to assistive tech and shown on hover.
 */
export function githubKindSvg(kind: "pull" | "issue", opts?: { className?: string }): string {
  const className = opts?.className ? ` class="${opts.className}"` : "";
  const label = GH_KIND_LABEL[kind];
  return `<svg${className} viewBox="0 0 16 16" width="14" height="14" role="img" aria-label="${label}"><title>${label}</title><path fill="currentColor" d="${GH_KIND_PATH[kind]}"/></svg>`;
}
