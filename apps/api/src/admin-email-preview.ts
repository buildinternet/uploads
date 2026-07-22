/**
 * Operator self-send for transactional email templates (admin /admin/email).
 * Uses placeholder tokens so links will not complete a real auth/invite flow.
 * Pattern mirrors either's admin-email-preview.
 */
import {
  renderEnrollmentInvitationEmail,
  renderMagicLinkEmail,
  renderMemberJoinedEmail,
  renderOrgInvitationEmail,
  type RenderedEmail,
} from "@uploads/email";
import { ServiceUnavailableError, ValidationError } from "@uploads/errors";

export const EMAIL_PREVIEW_TYPES = [
  { id: "magic-link", label: "Magic sign-in link", category: "Auth" },
  { id: "org-invitation", label: "Workspace invitation", category: "Auth" },
  { id: "member-joined", label: "Member joined notify", category: "Auth" },
  {
    id: "enrollment-invitation",
    label: "Enrollment invitation",
    category: "Invites",
  },
] as const;

export type EmailPreviewType = (typeof EMAIL_PREVIEW_TYPES)[number]["id"];

const PREVIEW_TYPE_IDS = new Set<string>(EMAIL_PREVIEW_TYPES.map((e) => e.id));

const AUTH_FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;
const INVITE_FROM = { name: "uploads.sh", email: "invites@uploads.sh" } as const;

export function isEmailPreviewType(value: unknown): value is EmailPreviewType {
  return typeof value === "string" && PREVIEW_TYPE_IDS.has(value);
}

function webOrigin(env: Env): string {
  const raw = typeof env.WEB_ORIGIN === "string" ? env.WEB_ORIGIN : "https://uploads.sh";
  return raw.replace(/\/$/, "") || "https://uploads.sh";
}

function renderPreview(
  type: EmailPreviewType,
  origin: string,
): {
  from: { name: string; email: string };
  rendered: RenderedEmail;
} {
  switch (type) {
    case "magic-link":
      return {
        from: AUTH_FROM,
        rendered: renderMagicLinkEmail({
          url: `${origin}/api/auth/magic-link/verify?token=preview-example`,
          webOrigin: origin,
        }),
      };
    case "org-invitation":
      return {
        from: AUTH_FROM,
        rendered: renderOrgInvitationEmail({
          url: `${origin}/accept-invitation/preview-example`,
          organizationName: "preview-workspace",
          inviterEmail: "operator@uploads.sh",
          webOrigin: origin,
        }),
      };
    case "member-joined":
      return {
        from: AUTH_FROM,
        rendered: renderMemberJoinedEmail({
          organizationName: "preview-workspace",
          memberEmail: "new-member@example.com",
          webOrigin: origin,
        }),
      };
    case "enrollment-invitation": {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      return {
        from: INVITE_FROM,
        rendered: renderEnrollmentInvitationEmail({
          workspaceName: "preview-workspace",
          link: `${origin}/invite?id=upi_preview#code=preview-example`,
          expiresAt,
        }),
      };
    }
  }
}

/**
 * Send a sample product email to `to`. Throws ValidationError for bad types
 * and ServiceUnavailableError when Email Sending is missing or fails.
 */
export async function sendEmailPreview(
  env: Env,
  type: EmailPreviewType,
  to: string,
): Promise<{ subject: string; from: string }> {
  if (!env.EMAIL) {
    throw new ServiceUnavailableError("email sending is not configured", {
      code: "email_not_configured",
    });
  }

  const origin = webOrigin(env);
  const { from, rendered } = renderPreview(type, origin);

  try {
    await env.EMAIL.send({
      to,
      from,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  } catch (err) {
    throw new ServiceUnavailableError("failed to send preview email", {
      code: "email_send_failed",
      cause: err,
    });
  }

  console.log(`[admin email preview] sent "${rendered.subject}" (${type}) to ${to}`);
  return { subject: rendered.subject, from: from.email };
}

/** Optional body `to` — must be a plausible address when provided. */
export function resolvePreviewRecipient(sessionEmail: string | undefined, bodyTo: unknown): string {
  if (typeof bodyTo === "string" && bodyTo.trim()) {
    const to = bodyTo.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new ValidationError("invalid recipient email", { code: "invalid_email" });
    }
    return to;
  }
  const fallback = sessionEmail?.trim();
  if (!fallback || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fallback)) {
    throw new ValidationError("signed-in account has no deliverable email", {
      code: "no_deliverable_email",
    });
  }
  return fallback;
}
