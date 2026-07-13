import { AppError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import {
  META_KEY_RE,
  META_MAX_KEYS,
  META_MAX_TOTAL_BYTES,
  META_VALUE_MAX,
  validateMetadataEntries,
} from "../src/file-metadata";

describe("META_KEY_RE", () => {
  it("accepts lowercase, digit, dot, underscore, and dash keys starting with a letter", () => {
    for (const key of ["app", "gh.repo", "device_type", "resolution-2x", "a", "a".repeat(64)]) {
      expect(META_KEY_RE.test(key)).toBe(true);
    }
  });

  it("rejects keys that are empty, too long, uppercase, or start wrong", () => {
    for (const key of [
      "",
      "a".repeat(65),
      "Gh.repo",
      "1abc",
      "_abc",
      "-abc",
      "has space",
      "emoji😀",
    ]) {
      expect(META_KEY_RE.test(key)).toBe(false);
    }
  });
});

describe("validateMetadataEntries", () => {
  it("accepts a well-formed map", () => {
    expect(() => validateMetadataEntries({ app: "screenshots", "gh.repo": "a/b" })).not.toThrow();
  });

  it("throws AppError for an invalid key", () => {
    expect(() => validateMetadataEntries({ "Bad Key": "x" })).toThrow(AppError);
  });

  it("throws a reserved-key AppError for server-set provenance keys like content-sha256", () => {
    try {
      validateMetadataEntries({ "content-sha256": "0".repeat(64) });
      throw new Error("expected validateMetadataEntries to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError & { code?: string }).code).toBe("file_metadata_reserved_key");
    }
    // gh.* keys stay writable — system-managed by convention, not reserved.
    expect(() => validateMetadataEntries({ "gh.repo": "a/b" })).not.toThrow();
  });

  it("throws AppError for an empty value", () => {
    expect(() => validateMetadataEntries({ app: "" })).toThrow(AppError);
  });

  it("throws AppError for a value over META_VALUE_MAX", () => {
    expect(() => validateMetadataEntries({ app: "x".repeat(META_VALUE_MAX + 1) })).toThrow(
      AppError,
    );
    expect(() => validateMetadataEntries({ app: "x".repeat(META_VALUE_MAX) })).not.toThrow();
  });

  it("throws AppError for a non-printable value", () => {
    expect(() => validateMetadataEntries({ app: "café" })).toThrow(AppError);
    expect(() => validateMetadataEntries({ app: "line\nbreak" })).toThrow(AppError);
  });

  it("throws AppError when the map has more than META_MAX_KEYS entries", () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < META_MAX_KEYS + 1; i++) tooMany[`k${i}`] = "v";
    expect(() => validateMetadataEntries(tooMany)).toThrow(AppError);

    const atCap: Record<string, string> = {};
    for (let i = 0; i < META_MAX_KEYS; i++) atCap[`k${i}`] = "v";
    expect(() => validateMetadataEntries(atCap)).not.toThrow();
  });

  it("throws AppError when total key+value UTF-8 bytes exceed META_MAX_TOTAL_BYTES", () => {
    // One giant value alone should trip the total-bytes cap even though it's a
    // single key under META_MAX_KEYS and under META_VALUE_MAX.
    const many: Record<string, string> = {};
    let bytes = 0;
    for (let i = 0; i < META_MAX_KEYS && bytes <= META_MAX_TOTAL_BYTES; i++) {
      const key = `k${i}`;
      const value = "x".repeat(META_VALUE_MAX);
      many[key] = value;
      bytes += key.length + value.length;
    }
    expect(() => validateMetadataEntries(many)).toThrow(AppError);
  });

  it("is a validation-family AppError with the invalid-request status", () => {
    try {
      validateMetadataEntries({ "Bad Key": "x" });
      throw new Error("expected validateMetadataEntries to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).type).toBe("validation");
      expect((err as AppError).status).toBe(400);
    }
  });
});
