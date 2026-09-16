/**
 * Storage settings presentation helpers — the hosted-lane SVG/XML chip
 * (issue #929) and its tooltip copy. The BYO lane cards keep their own
 * "SVG & XML" kv row; this is only the quiet chrome on the hosted view.
 */
import { escapeHtml } from "./workspace-ui";

const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>';

const ALERT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>';

/**
 * Hover/accessible detail for the hosted SVG/XML status. The timestamp and
 * reason stay here so they never become the Storage subhead.
 */
export function hostedActiveContentDetail(
  verifiedAtLabel: string | undefined,
  reasonLabel?: string,
): string {
  if (verifiedAtLabel) {
    return (
      `SVG and XML verified ${verifiedAtLabel}. ` +
      `Hosted storage serves them behind a sandboxing Content-Security-Policy.`
    );
  }
  return reasonLabel ? `SVG and XML not verified — ${reasonLabel}.` : "SVG and XML not verified.";
}

/** Icon button + tooltip for the Storage heading. Visible label is the icon only. */
export function renderHostedActiveContentStatusHtml(opts: { ok: boolean; detail: string }): string {
  const state = opts.ok ? "ok" : "warn";
  const icon = opts.ok ? CHECK_ICON : ALERT_ICON;
  const safe = escapeHtml(opts.detail);
  return (
    `<button type="button" class="storage-ac__btn" data-state="${state}" ` +
    `aria-label="${safe}" aria-describedby="storage-ac-tip">${icon}</button>` +
    `<span id="storage-ac-tip" role="tooltip" class="storage-ac__tip">${safe}</span>`
  );
}
