import { ValidationError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_PREFIXES,
  checkKeyPolicy,
  normalizeAllowedKeyPrefixes,
  normalizeKeyPrefix,
  resolveKeyPolicy,
} from "../src/key-policy";
import { finalizeUploadKey, governUploadKey } from "../src/files-core";

describe("normalizeKeyPrefix", () => {
  it("normalizes roots with or without trailing slash", () => {
    expect(normalizeKeyPrefix("screenshots")).toBe("screenshots/");
    expect(normalizeKeyPrefix("screenshots/")).toBe("screenshots/");
    expect(normalizeKeyPrefix("/gh/")).toBe("gh/");
  });

  it("rejects empty and path-escape segments", () => {
    expect(normalizeKeyPrefix("")).toBeNull();
    expect(normalizeKeyPrefix("..")).toBeNull();
    expect(normalizeKeyPrefix("a/../b")).toBeNull();
  });
});

describe("normalizeAllowedKeyPrefixes", () => {
  it("expands default sentinel to built-in destinations", () => {
    expect(normalizeAllowedKeyPrefixes(["default"])).toEqual([...DEFAULT_ALLOWED_PREFIXES].sort());
  });

  it("dedupes and sorts", () => {
    expect(normalizeAllowedKeyPrefixes(["gh", "f/", "f", "screenshots"])).toEqual([
      "f/",
      "gh/",
      "screenshots/",
    ]);
  });
});

describe("checkKeyPolicy", () => {
  const policy = resolveKeyPolicy({
    allowedKeyPrefixes: ["f", "screenshots", "gh"],
    maxKeyDepth: 6,
  });

  it("allows keys under permitted roots", () => {
    expect(checkKeyPolicy("screenshots/app/1/shot.png", policy)).toBeNull();
    expect(checkKeyPolicy("f/abc/shot.png", policy)).toBeNull();
    expect(checkKeyPolicy("gh/o/r/pull/1/a.png", policy)).toBeNull();
  });

  it("rejects disallowed roots", () => {
    expect(checkKeyPolicy("tmp/secret.png", policy)?.code).toBe("key_prefix_not_allowed");
  });

  it("rejects deep paths", () => {
    const v = checkKeyPolicy("screenshots/a/b/c/d/e/f.png", policy);
    expect(v?.code).toBe("key_too_deep");
    if (v?.code === "key_too_deep") {
      expect(v.depth).toBe(7);
      expect(v.maxKeyDepth).toBe(6);
    }
  });

  it("is a no-op when policy fields are unset", () => {
    expect(checkKeyPolicy("anything/goes/here.png", resolveKeyPolicy({}))).toBeNull();
  });
});

describe("finalizeUploadKey", () => {
  it("auto-prefixes bare keys under f/", () => {
    expect(finalizeUploadKey("shot.png", {})).toMatch(/^f\/[A-Za-z0-9_-]+\/shot\.png$/);
  });

  it("enforces allowed prefixes after governance", () => {
    expect(() => finalizeUploadKey("tmp/x.png", { allowedKeyPrefixes: ["screenshots"] })).toThrow(
      ValidationError,
    );
    try {
      finalizeUploadKey("tmp/x.png", { allowedKeyPrefixes: ["screenshots"] });
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("key_prefix_not_allowed");
    }
  });

  it("allows bare keys when f/ is in the allowlist", () => {
    expect(
      finalizeUploadKey("shot.png", { allowedKeyPrefixes: ["default"] }).startsWith("f/"),
    ).toBe(true);
  });

  it("leaves nested keys intact when under allowlist", () => {
    expect(
      finalizeUploadKey("screenshots/app/shot.png", { allowedKeyPrefixes: ["screenshots"] }),
    ).toBe("screenshots/app/shot.png");
  });
});

describe("governUploadKey (regression)", () => {
  it("still prefixes bare basenames", () => {
    expect(governUploadKey("shot.png")).toMatch(/^f\//);
  });
});
