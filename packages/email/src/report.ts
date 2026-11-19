import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card";

export type ReportEmailInput = {
  id: string;
  type: string;
  message: string;
  surface: string;
  contact?: string | null;
  /** true/false when the sender answered; null when not asked. */
  followUpOk?: boolean | null;
  workspace?: string | null;
  userId?: string | null;
  command?: string | null;
  cliVersion?: string | null;
  hasAttachment?: boolean;
  webOrigin?: string;
};

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Operator notification for a feedback/diagnostic report (`uploads report`, MCP `report`/`feedback`). */
export function renderReportEmail(input: ReportEmailInput): RenderedEmail {
  const origin = (input.webOrigin || "https://uploads.sh").replace(/\/$/, "");
  const type = input.type.trim() || "other";
  const from = input.workspace?.trim() ? `workspace ${input.workspace.trim()}` : input.surface;

  const details = [
    `Report ID: ${input.id}`,
    `Surface: ${input.surface}`,
    input.workspace ? `Workspace: ${input.workspace}` : null,
    input.userId ? `User: ${input.userId}` : null,
    input.command ? `Command/tool: ${input.command}` : null,
    input.cliVersion ? `Version: ${input.cliVersion}` : null,
    `Contact: ${input.contact?.trim() || "(none)"}`,
    input.followUpOk == null ? null : `OK to follow up: ${input.followUpOk ? "yes" : "no"}`,
    input.hasAttachment ? "Log attached (R2 _internal/uploads-cli-reports/)" : null,
  ].filter((line): line is string => line !== null);

  const bodyHtml = [
    `New ${strong(type)} report from ${strong(from)}.`,
    `<br><br>${escapeHtml(input.message).replace(/\n/g, "<br>")}`,
    `<br><br><span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;color:#8a8a83;">`,
    details.map(escapeHtml).join(" · "),
    `</span>`,
  ].join("");

  return renderEmailCard({
    subject: `[report] ${type}: ${truncate(input.message, 60)}`,
    preheader: truncate(input.message, 120),
    eyebrow: "Feedback report",
    title: `New ${type} report`,
    bodyHtml,
    text: [`New ${type} report from ${from}.`, "", input.message, "", ...details].join("\n"),
    footNoteHtml: `Internal notification · ${escapeHtml(origin)}`,
    webOrigin: origin,
  });
}
