/**
 * Auth email module (plan D8 seam: keep outbound send in one narrow-interface
 * module so a future webhooks/notifications service can absorb it without
 * touching src/auth.ts). Modeled on
 * `~/Code/room-configurator/apps/api/src/betterauth/email.ts` and the invite
 * email rendering in `apps/api/src/routes/admin.ts`.
 *
 * Sender is fixed at noreply@uploads.sh (D7) — must stay in
 * `send_email.allowed_sender_addresses` in wrangler.jsonc.
 */

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;

/** Minimal shape of the `send_email` binding this module needs. */
export type EmailBinding = {
  send: (message: {
    to: string;
    from: { name: string; email: string };
    subject: string;
    text?: string;
    html?: string;
  }) => Promise<unknown>;
};

export type SendAuthEmailEnv = {
  EMAIL?: EmailBinding;
  ENVIRONMENT?: string;
};

export type MagicLinkContext = { url: string };

export type SendAuthEmailArgs = { to: string; template: "magic-link"; context: MagicLinkContext };

function isDev(env: SendAuthEmailEnv): boolean {
  return env.ENVIRONMENT !== "production";
}

function renderMagicLink(context: MagicLinkContext): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Sign in to uploads.sh";
  const text = `Sign in to uploads.sh by opening this link (expires in 15 minutes):\n\n${context.url}\n\nIf you didn't request this, you can ignore this email.`;
  const html = `<p>Sign in to uploads.sh by clicking the link below. It expires in 15 minutes.</p><p><a href="${context.url}">Sign in to uploads.sh</a></p><p>If you didn't request this, you can ignore this email.</p>`;
  return { subject, text, html };
}

function render(args: SendAuthEmailArgs): { subject: string; text: string; html: string } {
  switch (args.template) {
    case "magic-link":
      return renderMagicLink(args.context);
  }
}

/**
 * Send an auth email. Never throws: a missing `EMAIL` binding (local dev) or
 * a send failure both degrade to a logged message rather than surfacing as an
 * unhandled rejection inside Better Auth's flow — Better Auth's `sendMagicLink`
 * callback expects fire-and-forget semantics here, not error propagation.
 *
 * In dev (no EMAIL binding), logs the link instead of sending — this is the
 * "email captured via local binding stub/log" acceptance criterion for Phase 1.
 */
export async function sendAuthEmail(env: SendAuthEmailEnv, args: SendAuthEmailArgs): Promise<void> {
  const { subject, text, html } = render(args);

  if (!env.EMAIL) {
    // Only log the magic-link URL in dev — logging it in production would
    // leak a live sign-in link to anywhere console output ends up.
    const linkNote =
      isDev(env) && args.template === "magic-link" ? ` Link: ${args.context.url}` : "";
    console.warn(
      `[auth email] no EMAIL binding — not sent. To: ${args.to}. "${subject}".${linkNote}`,
    );
    return;
  }

  try {
    await env.EMAIL.send({ to: args.to, from: FROM, subject, text, html });
    if (isDev(env)) {
      const linkNote = args.template === "magic-link" ? ` Link: ${args.context.url}` : "";
      console.log(`[auth email] sent "${subject}" to ${args.to}.${linkNote}`);
    } else {
      console.log(`[auth email] sent "${subject}" to ${args.to}`);
    }
  } catch (err) {
    console.error(
      `[auth email] send failed for "${subject}" to ${args.to}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
