import { describe, expect, it } from "vitest";
import { authInternalHeaders } from "./auth-internal";

describe("authInternalHeaders", () => {
  it("sends the legacy flag and the shared key", () => {
    const headers = authInternalHeaders(
      { AUTH_INTERNAL_KEY: "local-internal-key" },
      { "content-type": "application/json" },
    );
    expect(headers.get("x-uploads-internal")).toBe("1");
    expect(headers.get("x-uploads-internal-key")).toBe("local-internal-key");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("keeps the legacy flag and omits the key when the secret is unset or empty", () => {
    for (const env of [{}, { AUTH_INTERNAL_KEY: "" }, { AUTH_INTERNAL_KEY: undefined }]) {
      const headers = authInternalHeaders(env);
      expect(headers.get("x-uploads-internal")).toBe("1");
      expect(headers.get("x-uploads-internal-key")).toBeNull();
    }
  });

  it("does not let caller headers replace the internal flag or the key", () => {
    const headers = authInternalHeaders(
      { AUTH_INTERNAL_KEY: "local-internal-key" },
      { "x-uploads-internal": "no", "x-uploads-internal-key": "other" },
    );
    expect(headers.get("x-uploads-internal")).toBe("1");
    expect(headers.get("x-uploads-internal-key")).toBe("local-internal-key");
  });
});
