import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_KEY_PREFIX,
  isApiKeyToken,
  normalizeApiKeyPrefix,
  resolveApiKeyPrefix,
} from "./api-key-prefix";

describe("normalizeApiKeyPrefix", () => {
  it("accepts the hosted default", () => {
    expect(normalizeApiKeyPrefix("upl_sk_")).toEqual({ ok: true, prefix: "upl_sk_" });
  });

  it("lowercases and appends a trailing underscore", () => {
    expect(normalizeApiKeyPrefix("AcmeSK")).toEqual({ ok: true, prefix: "acmesk_" });
  });

  it("rejects a prefix that would collide with up_<workspace>_ tokens", () => {
    expect(normalizeApiKeyPrefix("up_")).toEqual({
      ok: false,
      reason: "collides_with_workspace_token",
    });
    expect(normalizeApiKeyPrefix("up_sk")).toEqual({
      ok: false,
      reason: "collides_with_workspace_token",
    });
  });

  it("rejects empty, symbols, and over-long values", () => {
    expect(normalizeApiKeyPrefix("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeApiKeyPrefix("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeApiKeyPrefix("!!!")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeApiKeyPrefix(`x${"a".repeat(40)}_`)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("resolveApiKeyPrefix", () => {
  it("uses the hosted default when unset", () => {
    expect(resolveApiKeyPrefix(undefined)).toBe(DEFAULT_API_KEY_PREFIX);
    expect(resolveApiKeyPrefix("")).toBe(DEFAULT_API_KEY_PREFIX);
  });

  it("returns a valid override", () => {
    expect(resolveApiKeyPrefix("acme_sk")).toBe("acme_sk_");
  });

  it("falls back to the default when the override is invalid", () => {
    expect(resolveApiKeyPrefix("up_sk")).toBe(DEFAULT_API_KEY_PREFIX);
  });
});

describe("isApiKeyToken", () => {
  it("matches only the configured prefix", () => {
    expect(isApiKeyToken("upl_sk_abc", "upl_sk_")).toBe(true);
    expect(isApiKeyToken("up_acme_abc", "upl_sk_")).toBe(false);
    expect(isApiKeyToken("acme_sk_abc", "upl_sk_")).toBe(false);
  });
});
