import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card";

const CTA = "Accept invitation →";
const IGNORE = "If you weren't expecting this, you can ignore this email.";
const PITCH =
  "an easy way to include screenshots and media in your GitHub pull requests, straight from the terminal";

/** Org membership invite (admin panel → /accept-invitation/:id). */
export function renderOrgInvitationEmail(ctx: {
  url: string;
  organizationName: string;
  inviterEmail: string;
  webOrigin?: string;
}): RenderedEmail {
  const lead = `${ctx.inviterEmail} invited you to join ${ctx.organizationName} on uploads.sh.`;
  return renderEmailCard({
    subject: `You're invited to ${ctx.organizationName} on uploads.sh`,
    preheader: lead,
    title: "You're invited",
    bodyHtml: `${strong(ctx.inviterEmail)} invited you to join ${strong(ctx.organizationName)} on uploads.sh.`,
    text: [
      lead,
      "",
      "Accept the invitation:",
      ctx.url,
      "",
      IGNORE,
      "",
      "—",
      "uploads.sh · a Build Internet project",
    ].join("\n"),
    cta: { url: ctx.url, label: CTA },
    footNoteHtml: IGNORE,
    webOrigin: ctx.webOrigin,
  });
}

/**
 * Token enrollment invite (console / CLI → /invite#code).
 * "default" is framed as access to uploads.sh itself.
 */
export function renderEnrollmentInvitationEmail(ctx: {
  workspaceName: string;
  link: string;
  expiresAt: string;
}): RenderedEmail {
  const expires = new Date(ctx.expiresAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  const isDefault = ctx.workspaceName === "default";
  const invitedTo = isDefault
    ? "You've been given access to uploads.sh"
    : `You've been invited to the ${ctx.workspaceName} workspace on uploads.sh`;
  let webOrigin = "https://uploads.sh";
  try {
    webOrigin = new URL(ctx.link).origin;
  } catch {
    /* keep default */
  }

  return renderEmailCard({
    subject: isDefault
      ? "You've been given access to uploads.sh"
      : `You're invited to ${ctx.workspaceName} on uploads.sh`,
    preheader: `${invitedTo} — one click to accept, link expires ${expires}.`,
    title: "You're invited",
    bodyHtml: isDefault
      ? `You've been given access to ${strong("uploads.sh")} &mdash; ${PITCH}.`
      : `You've been invited to the ${strong(ctx.workspaceName)} workspace on uploads.sh &mdash; ${PITCH}.`,
    text: [
      `${invitedTo} — ${PITCH}.`,
      "",
      "Accept your invitation (you'll need to do this from your laptop, not your phone):",
      ctx.link,
      "",
      `This link works once and expires ${expires}. If you weren't expecting it,`,
      "you can safely ignore this email.",
      "",
      "—",
      "uploads.sh · a Build Internet project",
      `Terms: ${webOrigin}/terms · Privacy: ${webOrigin}/privacy`,
    ].join("\n"),
    cta: { url: ctx.link, label: CTA },
    noteHtml: "You'll need to do this from your laptop, not your phone.",
    footNoteHtml: `This link works once and expires <span style="color:#b9b0cf;">${escapeHtml(expires)}</span>. If you weren't expecting it, you can safely ignore this email.`,
  });
}

/** Inviter notify when an org invite is accepted. */
export function renderMemberJoinedEmail(ctx: {
  organizationName: string;
  memberEmail: string;
  webOrigin?: string;
}): RenderedEmail {
  const lead = `${ctx.memberEmail} accepted your invitation and joined ${ctx.organizationName} on uploads.sh.`;
  return renderEmailCard({
    subject: `${ctx.memberEmail} joined ${ctx.organizationName} on uploads.sh`,
    preheader: `${ctx.memberEmail} joined ${ctx.organizationName}.`,
    title: "Someone joined",
    bodyHtml: `${strong(ctx.memberEmail)} accepted your invitation and joined ${strong(ctx.organizationName)} on uploads.sh.`,
    text: [lead, "", "—", "uploads.sh · a Build Internet project"].join("\n"),
    footNoteHtml: "You received this because you invited them to this workspace.",
    webOrigin: ctx.webOrigin,
  });
}
