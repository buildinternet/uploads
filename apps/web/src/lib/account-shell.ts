/**
 * Client helpers for /account/* and /admin/* shells: sign-out, session gate,
 * and page scripts that wait for the layout gate without racing it.
 */
import { getSession, signOut, type SessionResponse, type SessionUser } from "./auth-client";

const SESSION_EVENT = "uploads:session";

type SessionWindow = Window & {
  __uploadsSessionUser?: SessionUser;
};

/** Wire `#sign-out-btn` to end the session and return to /login. */
export function initSignOut(authOrigin: string): void {
  const button = document.querySelector<HTMLButtonElement>("#sign-out-btn");
  if (!button) return;
  button.addEventListener("click", () => {
    void signOut(authOrigin).then(() => {
      location.href = "/login";
    });
  });
}

export type SessionGateOptions = {
  authOrigin: string;
  checking: HTMLElement;
  denied: HTMLElement;
  app: HTMLElement;
  who?: HTMLElement | null;
  /** When set, only accept sessions with this `user.role` (e.g. `"admin"`). */
  requireRole?: string;
};

/**
 * Toggle checking / denied / app shells from the session. On success, stores
 * the user and fires `uploads:session` so page scripts can use `onSession`.
 */
export async function resolveSessionGate(
  options: SessionGateOptions,
): Promise<SessionResponse | null> {
  const result = await getSession(options.authOrigin);
  options.checking.hidden = true;
  if (!result || (options.requireRole && result.user.role !== options.requireRole)) {
    options.denied.hidden = false;
    return null;
  }
  if (options.who) options.who.textContent = result.user.email;
  options.app.hidden = false;
  const win = window as SessionWindow;
  win.__uploadsSessionUser = result.user;
  window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: { user: result.user } }));
  return result;
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
