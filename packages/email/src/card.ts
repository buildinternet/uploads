export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

export type EmailCardInput = {
  subject: string;
  preheader: string;
  title: string;
  /** May include pre-escaped markup (e.g. from `strong()`). Escape user values first. */
  bodyHtml: string;
  text: string;
  cta?: { url: string; label: string };
  noteHtml?: string;
  footNoteHtml?: string;
  webOrigin?: string;
};

const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";
const DEFAULT_WEB_ORIGIN = "https://uploads.sh";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

/** Escaped emphasis span for bodyHtml. */
export function strong(value: string): string {
  return `<strong style="color:#f2edfb;">${escapeHtml(value)}</strong>`;
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

/** Dark-card shell shared by invite and membership emails (API + auth). */
export function renderEmailCard(input: EmailCardInput): RenderedEmail {
  const webOrigin = webOriginOf(input);
  const title = escapeHtml(input.title);
  const preheader = escapeHtml(input.preheader);
  const cta = input.cta
    ? `<tr><td>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background-color:#b794ff;border-radius:8px;">
              <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:13px 26px;font-family:${MONO};font-size:15px;font-weight:700;color:#171128;text-decoration:none;">${escapeHtml(input.cta.label)}</a>
            </td>
          </tr></table>
        </td></tr>`
    : "";
  const note = input.noteHtml
    ? `<tr><td style="font-family:${MONO};font-size:12px;line-height:1.6;color:#8e86a5;padding-top:14px;">${input.noteHtml}</td></tr>`
    : "";
  const foot = input.footNoteHtml
    ? `<tr><td style="padding-top:26px;"><div style="border-top:1px solid #2b1f46;"></div></td></tr>
        <tr><td style="font-family:${MONO};font-size:12px;line-height:1.7;color:#8e86a5;padding-top:18px;">${input.footNoteHtml}</td></tr>`
    : "";
  const terms = escapeHtml(`${webOrigin}/terms`);
  const privacy = escapeHtml(`${webOrigin}/privacy`);

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background-color:#0b0813;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0813;">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
    <tr><td style="font-family:${MONO};font-size:13px;letter-spacing:.08em;color:#b794ff;padding:0 4px 14px;">&#9650; uploads.sh</td></tr>
    <tr><td style="background-color:#151024;border:1px solid #2b1f46;border-radius:12px;padding:36px 34px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:${MONO};font-size:24px;line-height:1.3;font-weight:700;color:#f2edfb;padding-bottom:12px;">${title}</td></tr>
        <tr><td style="font-family:${MONO};font-size:14px;line-height:1.7;color:#b9b0cf;padding-bottom:26px;">${input.bodyHtml}</td></tr>
        ${cta}
        ${note}
        ${foot}
      </table>
    </td></tr>
    <tr><td align="center" style="font-family:${MONO};font-size:11px;line-height:1.8;color:#6f6787;padding:22px 4px 0;">
      uploads.sh &middot; a <a href="https://buildinternet.com" style="color:#8e86a5;text-decoration:underline;">Build Internet</a> project<br>
      <a href="${terms}" style="color:#8e86a5;text-decoration:underline;">Terms</a> &nbsp;&middot;&nbsp; <a href="${privacy}" style="color:#8e86a5;text-decoration:underline;">Privacy</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: input.subject, text: input.text, html };
}
