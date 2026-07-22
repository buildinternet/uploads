/**
 * Self-serve first-workspace welcome. Auth invite-accept uses sendAuthEmail.
 * Never throws — mail must not fail workspace creation.
 */
import { renderWelcomeEmail } from "@uploads/email";

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;

type Env = {
  EMAIL?: {
    send: (message: {
      to: string;
      from: { name: string; email: string };
      subject: string;
      text?: string;
      html?: string;
    }) => Promise<unknown>;
  };
  WEB_ORIGIN?: string;
};

export async function sendWelcomeEmail(
  env: Env,
  args: { to: string; workspaceName?: string },
): Promise<void> {
  const { subject, text, html } = renderWelcomeEmail({
    workspaceName: args.workspaceName,
    webOrigin: env.WEB_ORIGIN || "https://uploads.sh",
  });

  if (!env.EMAIL) {
    console.warn(`[api email] no EMAIL binding — welcome not sent. To: ${args.to}. "${subject}".`);
    return;
  }

  try {
    await env.EMAIL.send({ to: args.to, from: FROM, subject, text, html });
    console.log(`[api email] sent "${subject}" to ${args.to}`);
  } catch (err) {
    console.error(
      `[api email] welcome send failed for "${subject}" to ${args.to}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
