import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_KEY_PREFIX,
  isApiKeyToken,
  normalizeApiKeyPrefix,
  resolveApiKeyPrefix,
} from "./api-key-prefix";

describe("resolveApiKeyPrefix", () => {
  it("defaults to the hosted prefix and rejects workspace-token collisions", () => {
    expect(resolveApiKeyPrefix(undefined)).toBe(DEFAULT_API_KEY_PREFIX);
    expect(normalizeApiKeyPrefix("up_sk")).toEqual({
      ok: false,
      reason: "collides_with_workspace_token",
    });
    expect(isApiKeyToken("upl_sk_secret", DEFAULT_API_KEY_PREFIX)).toBe(true);
    expect(isApiKeyToken("up_acme_secret", DEFAULT_API_KEY_PREFIX)).toBe(false);
  });
});
