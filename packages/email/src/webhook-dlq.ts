import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card";

const REPLAY_COMMAND =
  "node --env-file=.env apps/api/scripts/replay-github-webhook-dlq.mjs events.json";

/**
 * Operator FYI when a GitHub webhook batch lands on the dead-letter queue.
 * The text body is a JSON array of compact events, which the replay script
 * accepts as-is.
 */
export function renderWebhookDlqAlertEmail(ctx: { events: readonly unknown[] }): RenderedEmail {
  const count = ctx.events.length;
  const subject =
    count === 1
      ? "[webhook] 1 GitHub event dead-lettered"
      : `[webhook] ${count} GitHub events dead-lettered`;
  const intro =
    count === 1
      ? "1 GitHub webhook event was dead-lettered."
      : `${count} GitHub webhook events were dead-lettered.`;
  const json = JSON.stringify(ctx.events, null, 2);
  const text = [
    intro,
    "",
    "Save the JSON below as events.json and replay it:",
    "",
    REPLAY_COMMAND,
    "",
    json,
  ].join("\n");
  return renderEmailCard({
    subject,
    preheader: subject,
    eyebrow: "Webhooks",
    title: count === 1 ? "Webhook event dead-lettered" : "Webhook events dead-lettered",
    bodyHtml: `${escapeHtml(intro)}<pre style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;">${escapeHtml(json)}</pre>`,
    text,
    footNoteHtml: "Internal FYI for the uploads.sh operator.",
    gmailAction: false,
  });
}
