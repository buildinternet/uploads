import { escapeHtml, renderEmailCard, resolveWebOrigin, strong, type RenderedEmail } from "./card";

/**
 * A held upload (apps/api/src/upload-hold.ts), for someone who turned on
 * hold emails. Names the file and the workspace, never the content.
 */
export function renderUploadHeldEmail(ctx: {
  workspaceName: string;
  fileName: string;
  reason: "secret" | "pii";
  /** The signed-in `/f/` page, where a member can check and approve it. */
  pageUrl: string;
  isUploader: boolean;
  webOrigin?: string;
}): RenderedEmail {
  const origin = resolveWebOrigin(ctx.webOrigin);
  const settingsUrl = `${origin}/account/profile`;
  const what = ctx.reason === "pii" ? "personal information" : "a credential";
  const lead = ctx.isUploader
    ? `Your upload ${ctx.fileName} in ${ctx.workspaceName} is held for review.`
    : `An upload in ${ctx.workspaceName}, ${ctx.fileName}, is held for review.`;
  const why = `It may show ${what}. While it's held, its public link is off and pull request comments leave it out.`;
  return renderEmailCard({
    subject: `Held for review: ${ctx.fileName}`,
    preheader: `It may show ${what}.`,
    eyebrow: "Held upload",
    title: "Held for your review",
    bodyHtml: [
      ctx.isUploader
        ? `Your upload ${strong(ctx.fileName)} in ${strong(ctx.workspaceName)} is held for review.`
        : `An upload in ${strong(ctx.workspaceName)}, ${strong(ctx.fileName)}, is held for review.`,
      escapeHtml(why),
    ].join(" "),
    text: [
      lead,
      why,
      "",
      `Check it and approve it: ${ctx.pageUrl}`,
      "",
      "—",
      "uploads.sh · a Build Internet project",
      `Turn these emails off in your account settings: ${settingsUrl}`,
    ].join("\n"),
    cta: { url: ctx.pageUrl, label: "Check the file →" },
    noteHtml: "If it does show a credential, rotate the credential before you approve it.",
    footNoteHtml: `You turned on emails for held uploads. <a href="${escapeHtml(settingsUrl)}" style="color:#b9b0cf;">Manage notifications</a> to turn this off.`,
    webOrigin: ctx.webOrigin,
  });
}
