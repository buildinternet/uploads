import { describe, expect, it } from "vitest";
import { resolveUploadedAtMeta, UPLOADED_AT_META_KEY } from "../src/files-core";

describe("resolveUploadedAtMeta", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("returns now when there is no prior object (create)", () => {
    expect(resolveUploadedAtMeta(null, now)).toBe(now.toISOString());
  });

  it("preserves a valid prior uploaded-at stamp", () => {
    const stamped = "2026-01-01T00:00:00.000Z";
    expect(
      resolveUploadedAtMeta(
        {
          lastModified: Date.parse("2026-06-01T00:00:00.000Z"),
          metadata: { [UPLOADED_AT_META_KEY]: stamped },
        },
        now,
      ),
    ).toBe(stamped);
  });

  it("seeds from prior lastModified when stamp is missing (legacy)", () => {
    const lm = Date.parse("2026-01-15T10:00:00.000Z");
    expect(resolveUploadedAtMeta({ lastModified: lm, metadata: {} }, now)).toBe(
      new Date(lm).toISOString(),
    );
  });

  it("falls back to now when prior stamp is invalid and lastModified is missing", () => {
    expect(resolveUploadedAtMeta({ metadata: { [UPLOADED_AT_META_KEY]: "not-a-date" } }, now)).toBe(
      now.toISOString(),
    );
  });

  it("ignores non-finite lastModified and falls back to now", () => {
    expect(resolveUploadedAtMeta({ lastModified: Number.NaN }, now)).toBe(now.toISOString());
  });
});
