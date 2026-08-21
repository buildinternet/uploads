import { describe, expect, it } from "vitest";
import { withInheritedCookie } from "./proxy-transport";

describe("withInheritedCookie", () => {
  it("fills the cookie header from the request when init carries none", () => {
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    const headers = withInheritedCookie(new Headers(), request);

    expect(headers.get("cookie")).toBe("better-auth.session_token=abc");
  });

  it("fills an empty cookie header when the request has none", () => {
    const request = new Request("https://uploads.sh/account/profile");

    const headers = withInheritedCookie(new Headers(), request);

    expect(headers.get("cookie")).toBe("");
  });

  it("does not overwrite a cookie header already present on the given headers", () => {
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=incoming" },
    });

    const headers = withInheritedCookie(
      new Headers({ cookie: "better-auth.session_token=caller-set" }),
      request,
    );

    expect(headers.get("cookie")).toBe("better-auth.session_token=caller-set");
  });

  it("mutates and returns the same Headers instance it was given", () => {
    const request = new Request("https://uploads.sh/account/profile", {
      headers: { cookie: "better-auth.session_token=abc" },
    });
    const headers = new Headers();

    expect(withInheritedCookie(headers, request)).toBe(headers);
  });
});
