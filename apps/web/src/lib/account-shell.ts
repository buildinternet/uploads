/**
 * Client helpers for /account/* and /admin/* shells: sign-out, session gate,
 * and page scripts that wait for the layout gate without racing it.
 *
 * Session gate UX: after a successful check we cache the user in sessionStorage.
 * On the next navigation the layout applies that cache synchronously (inline
 * script + here) so the chrome does not flash "Checking your session…", then
 * revalidates in the background. Cache is a UX affordance only — every API
 * call still enforces the real session server-side.
 */
import {
  getSession,
  signOut,
  startLocalDemoSession,
  type SessionResponse,
  type SessionUser,
} from "./auth-client";
import { markPageLoad } from "./page-visit";

export { getPageVisit, isCurrentPageVisit } from "./page-visit";

const SESSION_EVENT = "uploads:session";

/** sessionStorage key — keep in sync with the inline optimistic script in layouts. */
export const SESSION_CACHE_KEY = "uploads:sessionUser";

type SessionWindow = Window & {
  __uploadsSessionUser?: SessionUser;
};

export function readCachedSessionUser(requireRole?: string): SessionUser | null {
  try {
    const raw = sessionStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw) as SessionUser;
    if (!user?.email) return null;
    if (requireRole && user.role !== requireRole) return null;
    return user;
  } catch {
    return null;
  }
}

export function writeCachedSessionUser(user: SessionUser): void {
  try {
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(user));
  } catch {
    // Private mode / quota — gate still works without the cache.
  }
}

export function clearCachedSessionUser(): void {
  try {
    sessionStorage.removeItem(SESSION_CACHE_KEY);
    // Keep in sync with WORKSPACES_CACHE_KEY in workspaces-nav.ts
    // (avoid importing that module from here). Last-used workspace is
    // localStorage-only so it survives sign-out for the next login.
    sessionStorage.removeItem("uploads:myWorkspaces");
    sessionStorage.removeItem("uploads:activeWorkspace");
  } catch {
    // ignore
  }
  delete (window as SessionWindow).__uploadsSessionUser;
}

function publishSession(user: SessionUser, force = false): void {
  const win = window as SessionWindow;
  const already = win.__uploadsSessionUser;
  win.__uploadsSessionUser = user;
  // Avoid double-firing when the inline optimistic script already set the user
  // and page scripts already subscribed via onSession.
  if (!force && already?.id === user.id && already.email === user.email) return;
  window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { user } }));
}

function showApp(
  user: SessionUser,
  options: Pick<SessionGateOptions, "checking" | "denied" | "app" | "who">,
): void {
  options.checking.hidden = true;
  options.denied.hidden = true;
  options.app.hidden = false;
  if (options.who) options.who.textContent = user.email;
}

function showDenied(options: Pick<SessionGateOptions, "checking" | "denied" | "app">): void {
  options.checking.hidden = true;
  options.app.hidden = true;
  options.denied.hidden = false;
}

function showUnavailable(
  options: Pick<SessionGateOptions, "checking" | "denied" | "unavailable" | "app">,
): void {
  options.checking.hidden = true;
  options.denied.hidden = true;
  options.app.hidden = true;
  options.unavailable.hidden = false;
}

/** Wire `#sign-out-btn` to end the session and return to /login. */
export function initSignOut(authOrigin: string): void {
  const button = document.querySelector<HTMLButtonElement>("#sign-out-btn");
  if (!button || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  button.addEventListener("click", () => {
    clearCachedSessionUser();
    void signOut(authOrigin).then(() => {
      location.href = "/login";
    });
  });
}

let pageVisitTrackingInstalled = false;

/**
 * Run after every Astro ClientRouter navigation (and the initial load when
 * `<ClientRouter />` is present). Bundled module scripts only execute once per
 * session — page/layout boot that queries the DOM must register here so it
 * re-attaches after body swap.
 *
 * Also bumps the shared page-visit id (see `page-visit.ts`) once per event so
 * async handlers can drop stale results after the user navigates away.
 *
 * Prefer this over top-level side effects in account/admin page scripts.
 */
export function onAstroPageLoad(callback: () => void): void {
  if (!pageVisitTrackingInstalled) {
    pageVisitTrackingInstalled = true;
    // Register before page callbacks so they observe the bumped id.
    document.addEventListener("astro:page-load", () => {
      markPageLoad();
    });
  }
  document.addEventListener("astro:page-load", callback);
}

export type SessionGateOptions = {
  authOrigin: string;
  checking: HTMLElement;
  denied: HTMLElement;
  unavailable: HTMLElement;
  app: HTMLElement;
  who?: HTMLElement | null;
  /** When set, only accept sessions with this `user.role` (e.g. `"admin"`). */
  requireRole?: string;
};

/**
 * Toggle checking / denied / app shells from the session.
 *
 * If a valid cached user exists (same role requirement), the shell is shown
 * immediately and the network check runs in the background. On success the
 * cache is refreshed; on failure the shell flips to denied.
 */
export async function resolveSessionGate(
  options: SessionGateOptions,
): Promise<SessionResponse | null> {
  const cached = readCachedSessionUser(options.requireRole);
  if (cached) {
    showApp(cached, options);
    // Publish so page scripts (onSession) run even if the inline script did
    // not run (e.g. sessionStorage written mid-session without a full reload).
    publishSession(cached);
  }

  let result = await getSession(options.authOrigin);
  if (result.kind === "signed_out") {
    const demo = await startLocalDemoSession(options.authOrigin, location.origin);
    if (demo.kind === "unavailable") {
      showUnavailable(options);
      return null;
    }
    if (demo.kind === "started") result = await getSession(options.authOrigin);
  }

  if (result.kind === "unavailable") {
    showUnavailable(options);
    return null;
  }
  if (
    result.kind === "signed_out" ||
    (options.requireRole && result.session.user.role !== options.requireRole)
  ) {
    clearCachedSessionUser();
    showDenied(options);
    return null;
  }

  writeCachedSessionUser(result.session.user);
  showApp(result.session.user, options);
  // Force so email/role updates still reach listeners if the user object changed.
  publishSession(result.session.user, true);
  return result.session;
}

/** Run once the layout session gate succeeds (handles both ready and in-flight). */
export function onSession(callback: (user: SessionUser) => void): void {
  const existing = (window as SessionWindow).__uploadsSessionUser;
  if (existing) {
    callback(existing);
    return;
  }
  window.addEventListener(
    SESSION_EVENT,
    ((event: CustomEvent<{ user: SessionUser }>) => {
      callback(event.detail.user);
    }) as EventListener,
    { once: true },
  );
}

/** Query helper that throws with a page-specific message when a node is missing. */
export function requireElement<T extends Element>(selector: string, pageLabel: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`${pageLabel} is missing ${selector}`);
  return element as T;
}
