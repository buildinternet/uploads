import { ForbiddenError, ValidationError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import { throwForInviteError } from "./invite-error";

/** The shape the auth worker's `POST /internal/invite` returns on failure. */
function authError(code: string, message: string) {
  return { error: { code, message } };
}

describe("throwForInviteError", () => {
  it("surfaces a member-cap denial as a 403 with the auth worker's copy", () => {
    const message = "Free workspaces include 3 members — upgrade to Pro for more.";
    // Guard against a vacuous pass if the mapping ever stops throwing.
    expect.assertions(3);
    try {
      throwForInviteError(403, authError("member_cap_reached", message));
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).message).toBe(message);
      expect((error as ForbiddenError & { code?: string }).code).toBe("member_cap_reached");
    }
  });

  it("still has something to say when the cap denial carries no message", () => {
    expect.assertions(1);
    try {
      throwForInviteError(403, { error: { code: "member_cap_reached" } });
    } catch (error) {
      expect((error as ForbiddenError).message).toBe(
        "This workspace has reached its member limit.",
      );
    }
  });

  it("keeps the pre-existing authorization 403 distinct from the cap denial", () => {
    expect.assertions(2);
    try {
      throwForInviteError(403, authError("inviter_not_authorized", "nope"));
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError & { code?: string }).code).toBe("inviter_not_authorized");
    }
  });

  it("treats any other status as a failed invitation", () => {
    for (const status of [400, 404, 500]) {
      expect(() => throwForInviteError(status, authError("whatever", "x"))).toThrow(
        ValidationError,
      );
    }
  });

  it("does not choke on a missing or non-JSON payload", () => {
    expect(() => throwForInviteError(403, null)).toThrow(ForbiddenError);
    expect(() => throwForInviteError(500, "not json")).toThrow(ValidationError);
  });
});
