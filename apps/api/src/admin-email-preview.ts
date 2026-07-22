/**
 * Operator self-send for transactional email templates (/admin/email).
 * Placeholder tokens only — links do not complete a real auth/invite flow.
 */
import {
  renderEnrollmentInvitationEmail,
  renderMagicLinkEmail,
  renderMemberJoinedEmail,
  renderOrgInvitationEmail,
} from "@uploads/email";
import { ServiceUnavailableError, ValidationError } from "@uploads/errors";

export const EMAIL_PREVIEW_TYPES = [
  { id: "magic-link", label: "Magic sign-in link", category: "Auth" },
  { id: "org-invitation", label: "Workspace invitation", category: "Auth" },
  { id: "member-joined", label: "Member joined notify", category: "Auth" },
  { id: "enrollment-invitation", label: "Enrollment invitation", category: "Invites" },
] as const;

export type EmailPreviewType = (typeof EMAIL_PREVIEW_TYPES)[number]["id"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;
const INVITE_FROM = { name: "uploads.sh", email: "invites@uploads.sh" } as const;

export function isEmailPreviewType(value: unknown): value is EmailPreviewType {
  return typeof value === "string" && EMAIL_PREVIEW_TYPES.some((t) => t.id === value);
}

/** Prefer body `to`, else the signed-in admin's email. */
export function resolvePreviewRecipient(sessionEmail: string | undefined, bodyTo: unknown): string {
  const override = typeof bodyTo === "string" ? bodyTo.trim() : "";
  const candidate = override || sessionEmail?.trim() || "";
  if (!EMAIL_RE.test(candidate)) {
    throw new ValidationError(
      override ? "invalid recipient email" : "signed-in account has no deliverable email",
      { code: override ? "invalid_email" : "no_deliverable_email" },
    );
  }
  return candidate;
}

function webOrigin(env: Env): string {
  return (env.WEB_ORIGIN || "https://uploads.sh").replace(/\/$/, "");
}

function renderPreview(type: EmailPreviewType, origin: string) {
  switch (type) {
    case "magic-link":
      return {
        from: AUTH_FROM,
        ...renderMagicLinkEmail({
          url: `${origin}/api/auth/magic-link/verify?token=preview-example`,
          webOrigin: origin,
        }),
      };
    case "org-invitation":
      return {
        from: AUTH_FROM,
        ...renderOrgInvitationEmail({
          url: `${origin}/accept-invitation/preview-example`,
          organizationName: "preview-workspace",
          inviterEmail: "operator@uploads.sh",
          webOrigin: origin,
        }),
      };
    case "member-joined":
      return {
        from: AUTH_FROM,
        ...renderMemberJoinedEmail({
          organizationName: "preview-workspace",
          memberEmail: "new-member@example.com",
          webOrigin: origin,
        }),
      };
    case "enrollment-invitation":
      return {
        from: INVITE_FROM,
        ...renderEnrollmentInvitationEmail({
          workspaceName: "preview-workspace",
          link: `${origin}/invite?id=upi_preview#code=preview-example`,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      };
  }
}

/** Send a sample product email. Throws when Email Sending is missing or fails. */
export async function sendEmailPreview(
  env: Env,
  type: EmailPreviewType,
  to: string,
): Promise<{ subject: string }> {
  if (!env.EMAIL) {
    throw new ServiceUnavailableError("email sending is not configured", {
      code: "email_not_configured",
    });
  }

  const { from, subject, text, html } = renderPreview(type, webOrigin(env));
  try {
    await env.EMAIL.send({ to, from, subject, text, html });
  } catch (err) {
    throw new ServiceUnavailableError("failed to send preview email", {
      code: "email_send_failed",
      cause: err,
    });
  }
  console.log(`[admin email preview] sent "${subject}" (${type}) to ${to}`);
  return { subject };
}
