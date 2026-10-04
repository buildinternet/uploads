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
const SAFE_HREF_RE = /^(?:https?:\/\/|\/(?!\/))/i;

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
