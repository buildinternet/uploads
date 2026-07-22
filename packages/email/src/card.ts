/**
 * The shared uploads.sh email shell.
 *
 * Colors and radii track `packages/ui/src/tokens.css` — when a token moves there,
 * move it here too. Type follows the site's split: sans for headline and body,
 * mono reserved for the wordmark, eyebrow, button label, and metadata. Geist
 * itself can't load in a mail client, so the fallback stacks are the design.
 */

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

export type EmailCardInput = {
  subject: string;
  preheader: string;
  /** Short mono uppercase label above the title, e.g. "Invitation". */
  eyebrow: string;
  title: string;
  /** May include pre-escaped markup (e.g. from `strong()`). Escape user values first. */
  bodyHtml: string;
  text: string;
  cta?: { url: string; label: string };
  noteHtml?: string;
  footNoteHtml?: string;
  webOrigin?: string;
};

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif,'Apple Color Emoji','Segoe UI Emoji'";
const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";

/* tokens.css */
const BG = "#0a0a0b";
const PANEL = "#121214";
const LINE = "#232327";
const FG = "#ececea";
const BODY = "#b3b3ad";
const MUTED = "#8a8a83";
const ACCENT = "#c27eff";

const DEFAULT_WEB_ORIGIN = "https://uploads.sh";

/**
 * The brand mark from `packages/ui/src/Brand.tsx`, rasterized (SVG doesn't
 * render in Gmail or Outlook). Clients that block remote images fall back to
 * the mono wordmark beside it, which is why the wordmark is always drawn.
 *
 * Served from our own bucket so mail clients fetch brand assets from an
 * uploads.sh origin. Immutable: to change the mark, upload a new key rather
 * than overwriting this one.
 *
 *   wrangler r2 object put "uploads-default/_internal/brand/email-mark-256.png" \
 *     --remote --file mark.png --content-type image/png \
 *     --cache-control "public, max-age=31536000, immutable"
 */
const MARK_URL = "https://storage.uploads.sh/_internal/brand/email-mark-256.png";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

/** Escaped emphasis span for bodyHtml. */
export function strong(value: string): string {
  return `<strong style="color:${FG};font-weight:600;">${escapeHtml(value)}</strong>`;
}

function webOriginOf(input: EmailCardInput): string {
  if (input.webOrigin) return input.webOrigin.replace(/\/$/, "");
  if (input.cta?.url) {
    try {
      return new URL(input.cta.url).origin;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_WEB_ORIGIN;
}

/** Dark-card shell shared by every uploads.sh email. */
export function renderEmailCard(input: EmailCardInput): RenderedEmail {
  const webOrigin = webOriginOf(input);
  const title = escapeHtml(input.title);
  const eyebrow = escapeHtml(input.eyebrow);
  const preheader = escapeHtml(input.preheader);

  const cta = input.cta
    ? `<tr><td style="padding-bottom:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background-color:${ACCENT};border-radius:8px;">
              <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:12px 22px;font-family:${MONO};font-size:14px;font-weight:600;color:${BG};text-decoration:none;">${escapeHtml(input.cta.label)}</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="font-family:${MONO};font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">
          Or paste this link into your browser:<br>
          <a href="${escapeHtml(input.cta.url)}" style="color:${BODY};text-decoration:underline;">${escapeHtml(input.cta.url)}</a>
        </td></tr>`
    : "";

  const note = input.noteHtml
    ? `<tr><td style="font-family:${MONO};font-size:12px;line-height:1.6;color:${MUTED};padding-top:14px;">${input.noteHtml}</td></tr>`
    : "";

  const foot = input.footNoteHtml
    ? `<tr><td style="padding-top:26px;"><div style="border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</div></td></tr>
        <tr><td style="font-family:${MONO};font-size:12px;line-height:1.7;color:${MUTED};padding-top:18px;">${input.footNoteHtml}</td></tr>`
    : "";

  // Body only needs breathing room below it when something follows in the card.
  const bodyGap = input.cta || input.noteHtml ? 24 : 2;

  const terms = escapeHtml(`${webOrigin}/terms`);
  const privacy = escapeHtml(`${webOrigin}/privacy`);

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background-color:${BG};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
    <tr><td style="padding:0 2px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:9px;line-height:0;"><img src="${MARK_URL}" width="22" height="22" alt="" style="display:block;width:22px;height:22px;border:0;"></td>
        <td style="font-family:${MONO};font-size:14px;font-weight:600;letter-spacing:.01em;color:${FG};">uploads.sh</td>
      </tr></table>
    </td></tr>
    <tr><td style="background-color:${PANEL};border:1px solid ${LINE};border-radius:10px;padding:32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:${MONO};font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${ACCENT};padding-bottom:14px;">${eyebrow}</td></tr>
        <tr><td style="font-family:${SANS};font-size:22px;line-height:1.35;font-weight:600;letter-spacing:-.01em;color:${FG};padding-bottom:12px;">${title}</td></tr>
        <tr><td style="font-family:${SANS};font-size:15px;line-height:1.65;color:${BODY};padding-bottom:${bodyGap}px;">${input.bodyHtml}</td></tr>
        ${cta}
        ${note}
        ${foot}
      </table>
    </td></tr>
    <tr><td align="center" style="font-family:${MONO};font-size:11px;line-height:1.9;color:#6f6f69;padding:22px 4px 0;">
      uploads.sh &middot; a <a href="https://buildinternet.com" style="color:${MUTED};text-decoration:underline;">Build Internet</a> project<br>
      <a href="${terms}" style="color:${MUTED};text-decoration:underline;">Terms</a> &nbsp;&middot;&nbsp; <a href="${privacy}" style="color:${MUTED};text-decoration:underline;">Privacy</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: input.subject, text: input.text, html };
}
