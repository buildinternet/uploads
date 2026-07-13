/**
 * Shared client wiring for the signed-in shell used by both /account and
 * /admin: hash-based panel switching and the sidebar sign-out button. The two
 * pages share the same DOM contract (`nav.side a[data-panel]`,
 * `[data-panel-body]`, `#sign-out-btn`); only the default panel differs.
 */
import { signOut } from "./auth-client";

/**
 * Wire the sidebar nav to show the `[data-panel-body]` panel matching the URL
 * hash (updating `aria-current` on the nav links), falling back to
 * `defaultPanel` for an unknown or empty hash. Applies once immediately, then
 * on every `hashchange`.
 */
export function initPanelSwitcher(defaultPanel: string): void {
  const navLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("nav.side a[data-panel]"),
  );
  const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-panel-body]"));
  const show = (name: string) => {
    const target = panels.some((p) => p.dataset.panelBody === name) ? name : defaultPanel;
    for (const p of panels) p.hidden = p.dataset.panelBody !== target;
    for (const l of navLinks) l.setAttribute("aria-current", String(l.dataset.panel === target));
  };
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
}

/** Wire the sidebar `#sign-out-btn` to end the session and return to /login. */
export function initSignOut(authOrigin: string): void {
  const button = document.querySelector<HTMLButtonElement>("#sign-out-btn");
  if (!button) return;
  // Keep the listener void-returning (no-misused-promises); `void` marks the
  // promise as intentionally fire-and-forget (no-floating-promises).
  button.addEventListener("click", () => {
    void signOut(authOrigin).then(() => {
      location.href = "/login";
    });
  });
}
