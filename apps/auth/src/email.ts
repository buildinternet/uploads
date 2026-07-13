/**
 * Auth outbound mail. Templates for invites/notifies live in `@uploads/email`;
 * this module only sends (and owns the magic-link template). Sender is always
 * noreply@uploads.sh (must stay in wrangler send_email allowed addresses).
 */

import {
  escapeHtml,
  renderMemberJoinedEmail,
  renderOrgInvitationEmail,
  type RenderedEmail,
} from "@uploads/email";

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;

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
  WEB_ORIGIN?: string;
};

export type SendAuthEmailArgs =
  | { to: string; template: "magic-link"; context: { url: string } }
  | {
      to: string;
      template: "invitation";
      context: { url: string; organizationName: string; inviterEmail: string };
    }
  | {
      to: string;
      template: "member-joined";
      context: { organizationName: string; memberEmail: string };
    };

function render(args: SendAuthEmailArgs, webOrigin: string): RenderedEmail {
  switch (args.template) {
    case "magic-link": {
      const { url } = args.context;
      return {
        subject: "Sign in to uploads.sh",
        text: `Sign in to uploads.sh by opening this link (expires in 15 minutes):\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>Sign in to uploads.sh by clicking the link below. It expires in 15 minutes.</p><p><a href="${escapeHtml(url)}">Sign in to uploads.sh</a></p><p>If you didn't request this, you can ignore this email.</p>`,
      };
    }
    case "invitation":
      return renderOrgInvitationEmail({ ...args.context, webOrigin });
    case "member-joined":
      return renderMemberJoinedEmail({ ...args.context, webOrigin });
  }
}

/**
 * Never throws — missing EMAIL (local) or send failures only log, so Better
 * Auth hooks/callbacks stay fire-and-forget.
 */
export async function sendAuthEmail(env: SendAuthEmailEnv, args: SendAuthEmailArgs): Promise<void> {
  const webOrigin = env.WEB_ORIGIN || "https://uploads.sh";
  const { subject, text, html } = render(args, webOrigin);
  const isDev = env.ENVIRONMENT !== "production";
  const magicLink = args.template === "magic-link" && isDev ? ` Link: ${args.context.url}` : "";

  if (!env.EMAIL) {
    console.warn(
      `[auth email] no EMAIL binding — not sent. To: ${args.to}. "${subject}".${magicLink}`,
    );
    return;
  }

  try {
    await env.EMAIL.send({ to: args.to, from: FROM, subject, text, html });
    console.log(`[auth email] sent "${subject}" to ${args.to}${magicLink}`);
  } catch (err) {
    console.error(
      `[auth email] send failed for "${subject}" to ${args.to}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
