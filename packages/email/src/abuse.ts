import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card";

export type AbuseReportEmailInput = {
  id: string;
  reason: string;
  message?: string | null;
  contact?: string | null;
  pageUrl: string;
  workspace?: string | null;
  objectKey?: string | null;
  surface?: string | null;
  createdAt?: string | null;
  webOrigin?: string;
};

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Operator notification for a public content report. CTA opens the reported page. */
export function renderAbuseReportEmail(input: AbuseReportEmailInput): RenderedEmail {
  const origin = (input.webOrigin || "https://uploads.sh").replace(/\/$/, "");
  const reason = input.reason.trim() || "other";
  const pageUrl = input.pageUrl.trim();
  const message = input.message?.trim() || "";
  const contact = input.contact?.trim() || "(none)";
  const workspace = input.workspace?.trim() || "";
  const objectKey = input.objectKey?.trim() || "";
  const when = input.createdAt?.trim() || new Date().toISOString();
  const asset = workspace && objectKey ? `${workspace}/${objectKey}` : pageUrl;

  const lines = [
    `A visitor reported ${asset} as ${reason}.`,
    "",
    message ? `Details:\n${message}\n` : null,
    `Report ID: ${input.id}`,
    `Page: ${pageUrl}`,
    workspace ? `Workspace: ${workspace}` : null,
    objectKey ? `Key: ${objectKey}` : null,
    `Contact: ${contact}`,
    `Surface: ${input.surface?.trim() || "web"}`,
    `When: ${when}`,
  ].filter((line): line is string => line !== null);

  const bodyHtml = [
    `A visitor reported ${strong(asset)} as ${strong(reason)}.`,
    message ? `<br><br>${escapeHtml(message).replace(/\n/g, "<br>")}` : "",
    `<br><br><span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;color:#8a8a83;">`,
    `ID ${escapeHtml(input.id)} · contact ${escapeHtml(contact)} · ${escapeHtml(when)}`,
    `</span>`,
  ].join("");

  return renderEmailCard({
    subject: `[abuse] ${reason}: ${truncate(asset, 60)}`,
    preheader: `Content report (${reason}) — ${truncate(asset, 80)}`,
    eyebrow: "Abuse report",
    title: `Reported: ${reason}`,
    bodyHtml,
    text: lines.join("\n"),
    cta: pageUrl.startsWith("http") ? { url: pageUrl, label: "Open reported page →" } : undefined,
    footNoteHtml: `Internal notification — reply path abuse@uploads.sh · ${escapeHtml(origin)}/terms`,
    webOrigin: origin,
  });
}
