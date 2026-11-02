import { describe, expect, it } from "vitest";
import { BANNED_ACCOUNT_MESSAGE } from "./auth-client";
import { authErrorPageLogLine, oauthErrorCopy } from "./oauth-error-page";

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

  it("maps an expired magic-link token", () => {
    expect(oauthErrorCopy("INVALID_TOKEN")).toEqual({
      title: "Sign-in link expired",
      message: "That sign-in link is no longer valid. Request a new one from the sign-in page.",
      reference: "INVALID_TOKEN",
    });
  });

  it("keeps an unknown safe code as a reference on the generic message", () => {
    const copy = oauthErrorCopy("some_new_code");
    expect(copy.title).toBe("Sign-in didn’t complete");
    expect(copy.message).toBe(
      "Something went wrong while signing in. Try again from the sign-in page.",
    );
    expect(copy.reference).toBe("some_new_code");
    expect(copy.message).not.toContain("some_new_code");
  });

  it("reads a ban phrase from error_description without echoing it", () => {
    const copy = oauthErrorCopy(
      "access_denied",
      "You have been banned. Visit https://evil.example",
    );
    expect(copy).toMatchObject({
      title: "Account deactivated",
      message: BANNED_ACCOUNT_MESSAGE,
      reference: "access_denied",
    });
    expect(copy.message).not.toContain("evil");
    expect(copy.message).not.toContain("banned");
  });

  it("logs only an allowlisted code", () => {
    expect(authErrorPageLogLine("INVALID_TOKEN")).toBe("auth_error_page code=INVALID_TOKEN");
    expect(authErrorPageLogLine("please_click_https://evil.example")).toBe(
      "auth_error_page code=rejected",
    );
    expect(authErrorPageLogLine(null)).toBe("auth_error_page code=rejected");
  });
});
