import { escapeHtml, renderEmailCard, resolveWebOrigin, strong, type RenderedEmail } from "./card";

export const CLI_INSTALL_COMMAND = "npm install -g @buildinternet/uploads@latest";

/**
 * Product update: you're on an older CLI. Sent only by an operator-run
 * campaign (apps/api/src/cli-upgrade-campaign.ts) to people who left product
 * updates on, never automatically.
 */
export function renderCliUpgradeEmail(ctx: {
  /** Newest CLI version we saw from this person, or null for a CLI older than 0.57.0. */
  currentVersion: string | null;
  /** The campaign's cutoff: everyone below it gets this email. */
  minimumVersion: string;
  /** One-click unsubscribe from product updates. */
  unsubscribeUrl: string;
  webOrigin?: string;
}): RenderedEmail {
  const origin = resolveWebOrigin(ctx.webOrigin);
  const changelogUrl = `${origin}/changelog`;
  const settingsUrl = `${origin}/account/profile`;
  const current = ctx.currentVersion ? `version ${ctx.currentVersion}` : "an older version";
  const lead = `You're using ${current} of the uploads CLI. Please update to ${ctx.minimumVersion} or newer.`;
  return renderEmailCard({
    subject: `Update your uploads CLI to ${ctx.minimumVersion}`,
    preheader: `You're on ${current}.`,
    eyebrow: "Product update",
    title: "Time to update the CLI",
    bodyHtml: [
      `You're using ${ctx.currentVersion ? strong(`version ${ctx.currentVersion}`) : "an older version"} of the uploads CLI.`,
      `Please update to ${strong(ctx.minimumVersion)} or newer.`,
    ].join(" "),
    text: [
      lead,
      "",
      `Update: ${CLI_INSTALL_COMMAND}`,
      `What's new: ${changelogUrl}`,
      "",
      "—",
      "uploads.sh · a Build Internet project",
      `Unsubscribe from product updates: ${ctx.unsubscribeUrl}`,
    ].join("\n"),
    cta: { url: changelogUrl, label: "See what's new →" },
    noteHtml: `Update with <code>${escapeHtml(CLI_INSTALL_COMMAND)}</code>`,
    footNoteHtml: `You're getting this because product updates are on for your account. <a href="${escapeHtml(ctx.unsubscribeUrl)}" style="color:#b9b0cf;">Unsubscribe</a> or <a href="${escapeHtml(settingsUrl)}" style="color:#b9b0cf;">manage notifications</a>.`,
    webOrigin: ctx.webOrigin,
  });
}
