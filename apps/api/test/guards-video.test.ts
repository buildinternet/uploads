import { describe, expect, it } from "vitest";
import { inspectUpload, resolveUploadPolicy } from "../src/guards";

// Minimal valid-looking WebM (EBML) and PNG headers for sniffing.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);

describe("per-type upload size", () => {
  it("allows a small image under maxUploadBytes", () => {
    const policy = resolveUploadPolicy({ maxUploadBytes: 100, maxVideoUploadBytes: 4 });
    expect(inspectUpload(PNG, policy).ok).toBe(true);
  });

  it("rejects video over maxVideoUploadBytes even if maxUploadBytes is higher", () => {
    const policy = resolveUploadPolicy({ maxUploadBytes: 1000, maxVideoUploadBytes: 4 });
    const result = inspectUpload(WEBM, policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error.code).toBe("upload_too_large");
      expect(result.error.details).toMatchObject({ kind: "video", maxBytes: 4 });
    }
  });

  it("uses maxUploadBytes for video when maxVideoUploadBytes is unset", () => {
    const policy = resolveUploadPolicy({ maxUploadBytes: 100 });
    expect(policy.maxVideoBytes).toBe(100);
    expect(inspectUpload(WEBM, policy).ok).toBe(true);
  });
});
