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
