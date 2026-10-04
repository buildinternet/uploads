import { describe, expect, it } from "vitest";
import { BANNED_ACCOUNT_MESSAGE } from "./auth-client";
import { oauthErrorCopy } from "./oauth-error-page";

describe("oauthErrorCopy", () => {
  it("maps a cancelled GitHub sign-in", () => {
    expect(oauthErrorCopy("access_denied")).toEqual({
      title: "Sign-in cancelled",
      message: "The sign-in was cancelled before it finished. You can try again.",
      reference: "access_denied",
    });
  });

  it("maps the built-in GitHub unverified-email refusal", () => {
    expect(oauthErrorCopy("account_not_linked")).toEqual({
      title: "Email isn’t verified",
      message:
        "That GitHub email isn’t verified, so it can’t be linked to an existing account. Use a verified address, or sign in with a magic link.",
      reference: "account_not_linked",
    });
  });

  it("maps an OAuth-provider authorize failure before the redirect is trusted", () => {
    const copy = oauthErrorCopy("invalid_redirect");
    expect(copy.title).toBe("Invalid app sign-in request");
    expect(copy.reference).toBe("invalid_redirect");
    expect(oauthErrorCopy("invalid_client").title).toBe(copy.title);
    expect(oauthErrorCopy("unsupported_response_type").message).toBe(copy.message);
  });

  it("uses the banned-account message for BANNED_USER", () => {
    expect(oauthErrorCopy("BANNED_USER")).toMatchObject({
      title: "Account deactivated",
      message: BANNED_ACCOUNT_MESSAGE,
      reference: "BANNED_USER",
    });
  });

  it("does not echo an unrecognized or unsafe code into the message", () => {
    const unknown = oauthErrorCopy("please_click_https://evil.example");
    expect(unknown.message).toBe(
      "Something went wrong while signing in. Try again from the sign-in page.",
    );
    expect(unknown.reference).toBeNull();
    expect(unknown.message).not.toContain("evil");
  });

  it("stays generic when the query is missing", () => {
    expect(oauthErrorCopy(null).reference).toBeNull();
    expect(oauthErrorCopy(undefined).title).toBe("Sign-in didn’t complete");
  });
});
