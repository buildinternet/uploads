import { renderEmailCard, type RenderedEmail } from "./card";

const IGNORE = "If you didn't request this, you can safely ignore this email.";

/** Passwordless sign-in link (Better Auth magic link → 15 minute expiry). */
export function renderMagicLinkEmail(ctx: { url: string; webOrigin?: string }): RenderedEmail {
  return renderEmailCard({
    subject: "Sign in to uploads.sh",
    preheader: "Your sign-in link — it expires in 15 minutes.",
    eyebrow: "Sign in",
    title: "Sign in to uploads.sh",
    bodyHtml: "Use the button below to sign in. The link expires in 15 minutes.",
    text: [
      "Sign in to uploads.sh by opening this link (expires in 15 minutes):",
      "",
      ctx.url,
      "",
      IGNORE,
      "",
      "—",
      "uploads.sh · a Build Internet project",
    ].join("\n"),
    cta: { url: ctx.url, label: "Sign in →" },
    footNoteHtml: IGNORE,
    webOrigin: ctx.webOrigin,
  });
}
