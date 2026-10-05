/**
 * Copy live link (spec: "Copy live link flow"). Pure decision flow with
 * injected effects so every branch is testable:
 *  1. read privateCount (+ any existing live link) for the scope;
 *  2. confirm once per scope per page session when privateCount > 0
 *     (null, as on a cursor page, never asks);
 *  3. reuse an existing link (comment sync may have made one) or create;
 *  4. copy; a rejected clipboard write still hands the URL back.
 *
 * Clipboard timing: browsers (Safari above all) only allow a clipboard write
 * that starts inside a user gesture, and the URL is not known until after
 * network calls. So the write starts inside the LAST gesture (the Copy click
 * when no confirm is needed, the "Copy anyway" click when one is) with a
 * promise of the URL that resolves once the link exists. Unknown share info
 * means the Copy click cannot yet tell whether a confirm is coming, so it
 * writes optimistically and abandons that write if a confirm turns up.
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
  /** Only repo-wide links are capped; `limit` is the cap the API reported. */
  | { kind: "limit"; limit: number }
  | { kind: "error" };

export interface CopyLiveLinkDeps {
  loadShareInfo(scope: LiveLinkScope): Promise<ScopeShareInfo | null>;
  create(scope: LiveLinkScope): Promise<CreateLiveLinkResult>;
  confirmPrivate(count: number): Promise<boolean>;
  /**
   * Start a clipboard write now (the caller is inside a user gesture) with a
   * URL that may resolve later. Resolves false when the write failed or the
   * URL promise rejected; never rejects.
   */
  copyText(url: Promise<string>): Promise<boolean>;
}

export type CopyLiveLinkOutcome =
  | { kind: "copied"; url: string; id: string; created: boolean }
  | { kind: "clipboard-blocked"; url: string; id: string }
  | { kind: "cancelled" }
  | { kind: "limit"; limit: number }
  | { kind: "error" };

export interface ToastMessage {
  text: string;
  link?: { href: string; label: string; external?: boolean };
  /** Shows a Copy button (a fresh gesture) that copies this text. */
  copyText?: string;
  /** Stays open until dismissed. */
  sticky?: boolean;
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

/** Dialog subject: "acme/web #7" or "acme/web". */
export function liveLinkScopeLabel(scope: LiveLinkScope): string {
  return scope.pr ? `${scope.repo} #${scope.pr}` : scope.repo;
}

interface PendingWrite {
  reject(): void;
  resolve(url: string): void;
  done: Promise<boolean>;
}

function startWrite(deps: CopyLiveLinkDeps): PendingWrite {
  let resolve!: (url: string) => void;
  let reject!: (reason: Error) => void;
  const url = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The write consumes `url`; this keeps an abandoned one from surfacing as unhandled.
  url.catch(() => {});
  return {
    resolve,
    reject: () => reject(new Error("clipboard write abandoned")),
    done: deps.copyText(url),
  };
}

export async function runCopyLiveLink(
  deps: CopyLiveLinkDeps,
  scope: LiveLinkScope,
  opts: { known?: ScopeShareInfo | null; confirmed: Set<string> },
): Promise<CopyLiveLinkOutcome> {
  const key = liveLinkScopeKey(scope);
  /** Count to ask about, or null when no confirm is due. */
  const confirmCount = (info: ScopeShareInfo): number | null =>
    info.privateCount !== null && info.privateCount > 0 && !opts.confirmed.has(key)
      ? info.privateCount
      : null;

  // Everything up to the first await runs inside the Copy click.
  let pending: PendingWrite | null =
    opts.known && confirmCount(opts.known) !== null ? null : startWrite(deps);
  const abandon = () => {
    pending?.reject();
    pending = null;
  };

  try {
    const info = opts.known ?? (await deps.loadShareInfo(scope));
    if (!info) {
      abandon();
      return { kind: "error" };
    }

    const count = confirmCount(info);
    if (count !== null) {
      abandon();
      if (!(await deps.confirmPrivate(count))) return { kind: "cancelled" };
      // Resumes in the "Copy anyway" click: the last gesture.
      pending = startWrite(deps);
    }

    let link: { id: string; url: string };
    let created = false;
    if (info.liveLink) {
      link = info.liveLink;
    } else {
      const result = await deps.create(scope);
      if (result.kind !== "ok") {
        abandon();
        return result.kind === "limit" ? { kind: "limit", limit: result.limit } : { kind: "error" };
      }
      link = { id: result.id, url: result.url };
      created = true;
    }
    // Remember the answer only once the link exists, so a retry after a
    // limit or error asks again.
    if (count !== null) opts.confirmed.add(key);

    pending?.resolve(link.url);
    return (await pending?.done)
      ? { kind: "copied", url: link.url, id: link.id, created }
      : { kind: "clipboard-blocked", url: link.url, id: link.id };
  } catch {
    abandon();
    return { kind: "error" };
  }
}

interface ClipboardLike {
  write?(items: unknown[]): Promise<void>;
  writeText(text: string): Promise<void>;
}

/**
 * Write `url` to the clipboard, starting inside the current gesture. With
 * ClipboardItem the write begins now and takes a Blob promise; without it,
 * writeText runs once the URL resolves (best effort outside the gesture).
 * Never rejects.
 */
export async function writeClipboardUrl(
  clipboard: ClipboardLike | undefined,
  ClipboardItemCtor: (new (items: Record<string, Promise<Blob>>) => unknown) | undefined,
  url: Promise<string>,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    if (clipboard.write && ClipboardItemCtor) {
      const blob = url.then((text) => new Blob([text], { type: "text/plain" }));
      blob.catch(() => {});
      await clipboard.write([new ClipboardItemCtor({ "text/plain": blob })]);
    } else {
      await clipboard.writeText(await url);
    }
    return true;
  } catch {
    return false;
  }
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
        copyText: outcome.url,
        sticky: true,
      };
    case "limit":
      return {
        text: `This workspace has reached its limit of ${outcome.limit} repo live links. Revoke one to add another.`,
        link: { href: linksPageHref, label: "Manage live links" },
      };
    case "error":
      return { text: "Couldn't create the live link. Try again." };
    case "cancelled":
      return null;
  }
}
