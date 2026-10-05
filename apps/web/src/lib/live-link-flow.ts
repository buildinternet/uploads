/**
 * Copy live link (spec: "Copy live link flow"). Pure decision flow with
 * injected effects so every branch is testable:
 *  1. read privateCount (+ any existing live link) for the scope;
 *  2. confirm once per scope per page session when privateCount > 0
 *     (null, as on a cursor page, never asks);
 *  3. reuse an existing link (comment sync may have made one) or create;
 *  4. copy; a rejected clipboard write still hands the URL back.
 */
export interface LiveLinkScope {
  /** Lowercased owner/repo. */
  repo: string;
  pr?: number;
}

export interface ScopeShareInfo {
  /** First-page count from the scope endpoint; null when it was not computed. */
  privateCount: number | null;
  liveLink: { id: string; url: string } | null;
}

export type CreateLiveLinkResult =
  | { kind: "ok"; id: string; url: string }
  | { kind: "limit" }
  | { kind: "error" };

export interface CopyLiveLinkDeps {
  loadShareInfo(scope: LiveLinkScope): Promise<ScopeShareInfo | null>;
  create(scope: LiveLinkScope): Promise<CreateLiveLinkResult>;
  confirmPrivate(count: number): Promise<boolean>;
  writeClipboard(text: string): Promise<boolean>;
}

export type CopyLiveLinkOutcome =
  | { kind: "copied"; url: string; id: string; created: boolean }
  | { kind: "clipboard-blocked"; url: string; id: string }
  | { kind: "cancelled" }
  | { kind: "limit" }
  | { kind: "error" };

export interface ToastMessage {
  text: string;
  link?: { href: string; label: string; external?: boolean };
}

export function liveLinkScopeKey(scope: LiveLinkScope): string {
  return scope.pr ? `${scope.repo}#${scope.pr}` : scope.repo;
}

/**
 * Spec copy: "N items are private and will show as hidden on the public
 * page". Only called with an exact, positive `privateCount` (null never
 * opens the confirm).
 */
export function privateConfirmText(count: number): string {
  return count === 1
    ? "1 item is private and will show as hidden on the public page"
    : `${count} items are private and will show as hidden on the public page`;
}

export async function runCopyLiveLink(
  deps: CopyLiveLinkDeps,
  scope: LiveLinkScope,
  opts: { known?: ScopeShareInfo | null; confirmed: Set<string> },
): Promise<CopyLiveLinkOutcome> {
  const info = opts.known ?? (await deps.loadShareInfo(scope));
  if (!info) return { kind: "error" };

  const key = liveLinkScopeKey(scope);
  if (info.privateCount !== null && info.privateCount > 0 && !opts.confirmed.has(key)) {
    if (!(await deps.confirmPrivate(info.privateCount))) return { kind: "cancelled" };
    opts.confirmed.add(key);
  }

  let link: { id: string; url: string };
  let created = false;
  if (info.liveLink) {
    link = info.liveLink;
  } else {
    const result = await deps.create(scope);
    if (result.kind === "limit") return { kind: "limit" };
    if (result.kind === "error") return { kind: "error" };
    link = { id: result.id, url: result.url };
    created = true;
  }

  return (await deps.writeClipboard(link.url))
    ? { kind: "copied", url: link.url, id: link.id, created }
    : { kind: "clipboard-blocked", url: link.url, id: link.id };
}

export function liveLinkToast(
  outcome: CopyLiveLinkOutcome,
  scope: LiveLinkScope,
  linksPageHref: string,
): ToastMessage | null {
  switch (outcome.kind) {
    case "copied":
      return {
        text: scope.pr
          ? "Copied. Anyone with the link sees this PR's files as they're pushed."
          : "Copied. Anyone with the link sees this repo's files as they're pushed.",
      };
    case "clipboard-blocked":
      return {
        text: "Couldn't copy automatically. Your live link:",
        link: { href: outcome.url, label: outcome.url, external: true },
      };
    case "limit":
      return {
        text: "This workspace has reached its live link limit.",
        link: { href: linksPageHref, label: "Manage live links" },
      };
    case "error":
      return { text: "Couldn't create the live link. Try again." };
    case "cancelled":
      return null;
  }
}
