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
  // Move focus to the shown panel's first heading so keyboard/screen-reader
  // users land somewhere sensible after a panel switch — but only on actual
  // switches, not the initial render (which would steal focus on page load).
  const focusPanelHeading = (panel: HTMLElement) => {
    const heading = panel.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: false });
  };
  const show = (name: string, moveFocus: boolean) => {
    const target = panels.some((p) => p.dataset.panelBody === name) ? name : defaultPanel;
    let shownPanel: HTMLElement | null = null;
    for (const p of panels) {
      p.hidden = p.dataset.panelBody !== target;
      if (!p.hidden) shownPanel = p;
    }
    for (const l of navLinks) l.setAttribute("aria-current", String(l.dataset.panel === target));
    if (moveFocus && shownPanel) focusPanelHeading(shownPanel);
  };
  window.addEventListener("hashchange", () => show(location.hash.slice(1), true));
  show(location.hash.slice(1), false);
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
