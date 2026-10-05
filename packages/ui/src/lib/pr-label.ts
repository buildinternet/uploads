/**
 * Pure label parts for a GitHub pull request or issue reference
 * (`owner/repo#123`). One function feeds every renderer: the React
 * `PrLabel` (components/pr-label.tsx), the HTML-string twin in apps/web
 * (lib/pr-label-html.ts, also behind PrLabel.astro), and the tests that pin
 * the copy.
 *
 * Free of React and the DOM, so apps/web's plain-vitest suite imports it
 * from source: the `@uploads/ui/lib/pr-label` export maps to this file, not
 * to dist/.
 */

export type PrState = "open" | "closed" | "merged";

export interface PrLabelInput {
  /** `owner/repo#123`, or a bare `#123` when the repo is unknown. */
  ghRef: string;
  /** Resolved PR/issue title. Null, undefined, or blank means "unknown". */
  title?: string | null;
  state?: PrState | null;
  /** Defaults to "pull". */
  kind?: "pull" | "issue";
}

export interface PrLabelParts {
  /** Display number with its hash, e.g. "#123". "" when `ghRef` has no number. */
  number: string;
  /** "owner/repo", or "" for a bare "#123" or an unparseable ref. */
  repo: string;
  /** Trimmed title, or null when unknown. */
  title: string | null;
  /** "#123 Title", or "owner/repo #123" when the title is unknown. */
  text: string;
  /** True when `text` is the no-title fallback. */
  fallback: boolean;
  state: PrState | null;
  /** Full accessible name, e.g. "Pull request #123 in owner/repo: Title (merged)". */
  ariaLabel: string;
}

const REF_RE = /^(?:([^\s#/]+\/[^\s#/]+))?#(\d+)$/;
const SAFE_HREF_RE = /^(?:https?:\/\/|\/(?![/\\]))/i;

/**
 * State icon for a PR or issue, GitHub's vocabulary: pull request, merge,
 * closed pull request, issue (circle-dot), closed issue (circle-x). An
 * unknown state keeps the kind's open shape and the renderer greys it.
 * Shapes are lucide's (24x24, stroke 2, round caps) inlined here so the
 * React and HTML-string renderers draw the same thing without lucide-react.
 */
export type PrIconName =
  | "pull-open"
  | "pull-merged"
  | "pull-closed"
  | "issue-open"
  | "issue-closed";

export type PrIconNode = [tag: "circle" | "path" | "line", attrs: Record<string, string>];

export const PR_ICON_NODES: Record<PrIconName, readonly PrIconNode[]> = {
  "pull-open": [
    ["circle", { cx: "18", cy: "18", r: "3" }],
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }],
    ["line", { x1: "6", x2: "6", y1: "9", y2: "21" }],
  ],
  "pull-merged": [
    ["circle", { cx: "18", cy: "18", r: "3" }],
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["path", { d: "M6 21V9a9 9 0 0 0 9 9" }],
  ],
  "pull-closed": [
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["path", { d: "M6 9v12" }],
    ["path", { d: "m21 3-6 6" }],
    ["path", { d: "m21 9-6-6" }],
    ["path", { d: "M18 11.5V15" }],
    ["circle", { cx: "18", cy: "18", r: "3" }],
  ],
  "issue-open": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["circle", { cx: "12", cy: "12", r: "1" }],
  ],
  "issue-closed": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m15 9-6 6" }],
    ["path", { d: "m9 9 6 6" }],
  ],
};

/** Shared `<svg>` attributes for `PR_ICON_NODES` shapes. */
export const PR_ICON_SVG_ATTRS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

export function prIconName(kind: "pull" | "issue" | undefined, state: PrState | null): PrIconName {
  if (kind === "issue") return state === "closed" ? "issue-closed" : "issue-open";
  if (state === "merged") return "pull-merged";
  if (state === "closed") return "pull-closed";
  return "pull-open";
}

/** Narrow an untyped state (e.g. `GithubTitleInfo.state`) to a PrState. */
export function asPrState(value: unknown): PrState | null {
  return value === "open" || value === "closed" || value === "merged" ? value : null;
}

/** Only http(s) and root-relative links become anchors; anything else renders as text. */
export function isSafePrHref(href: string): boolean {
  return SAFE_HREF_RE.test(href);
}

export function prLabelParts(input: PrLabelInput): PrLabelParts {
  const ghRef = input.ghRef.trim();
  const match = REF_RE.exec(ghRef);
  const repo = match?.[1] ?? "";
  const number = match ? `#${match[2]}` : "";
  const title = input.title?.trim() || null;
  const state = asPrState(input.state);

  let text: string;
  if (title) text = number ? `${number} ${title}` : title;
  else if (number) text = repo ? `${repo} ${number}` : number;
  else text = ghRef;

  const kindWord = input.kind === "issue" ? "Issue" : "Pull request";
  let subject: string;
  if (number) subject = repo ? `${kindWord} ${number} in ${repo}` : `${kindWord} ${number}`;
  else subject = ghRef ? `${kindWord} ${ghRef}` : kindWord;
  const ariaLabel = `${subject}${title ? `: ${title}` : ""}${state ? ` (${state})` : ""}`;

  return { number, repo, title, text, fallback: title === null, state, ariaLabel };
}

/**
 * Screen-reader text for a label rendered as a plain span (no anchor, so no
 * `aria-label`): the dot and visible text leave out PR vs issue, the state,
 * and (compact) the title. Full label when compact, otherwise
 * " (pull request, open)", " (issue, closed)", or " (pull request)" when the
 * state is unknown. Shared by the React and HTML renderers.
 */
export function prLabelSrText(input: PrLabelInput, compact = false): string {
  const parts = prLabelParts(input);
  if (compact) return ` (${parts.ariaLabel})`;
  const kindWord = input.kind === "issue" ? "issue" : "pull request";
  return ` (${kindWord}${parts.state ? `, ${parts.state}` : ""})`;
}
