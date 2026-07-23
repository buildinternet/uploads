/**
 * Shared translation of the auth worker's `POST /internal/invite` failures
 * into this worker's error types. Three routes call that endpoint — the
 * member-facing `/me` route, the governance-token route, and the operator
 * `/admin-ui` route — and all three must report a member-cap denial the same
 * way (issue #450), so the mapping lives here rather than being copy-pasted
 * a third time.
 */
import { ForbiddenError, ValidationError } from "@uploads/errors";

type InvitePayload = { error?: { code?: unknown; message?: unknown } } | null;

/**
 * Throws the error matching a non-ok invite response. Never returns.
 *
 * The two 403s are deliberately distinguished: `member_cap_reached` is a
 * plan limit the caller can act on (upgrade, or ask an operator to comp the
 * workspace), and it carries the auth worker's message verbatim because that
 * copy is built from the workspace's actually-resolved cap. Any other 403 is
 * the pre-existing authorization failure.
 */
export function throwForInviteError(status: number, payload: unknown): never {
  const error = (payload as InvitePayload)?.error;
  const code = typeof error?.code === "string" ? error.code : undefined;

  if (status === 403 && code === "member_cap_reached") {
    const message =
      typeof error?.message === "string" && error.message
        ? error.message
        : "This workspace has reached its member limit.";
    throw new ForbiddenError(message, { code: "member_cap_reached" });
  }
  if (status === 403) {
    throw new ForbiddenError("not authorized to invite to this workspace", {
      code: "inviter_not_authorized",
      details: payload,
    });
  }
  throw new ValidationError("failed to create invitation", { details: payload });
}
