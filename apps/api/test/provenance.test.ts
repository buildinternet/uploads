import { describe, expect, it } from "vitest";
import { contentSha256Hex, provenanceFromHeaders, sanitizeProvenance } from "../src/provenance";

describe("sanitizeProvenance", () => {
  it("keeps allowlisted keys and drops unknowns", () => {
    expect(
      sanitizeProvenance({
        client: "uploads-cli",
        "client-version": "0.3.0",
        secret: "nope",
        optimized: "1",
      }),
    ).toEqual({
      client: "uploads-cli",
      "client-version": "0.3.0",
      optimized: "1",
    });
  });

  it("rejects empty / overlong / non-ascii values", () => {
    expect(sanitizeProvenance({ client: "" })).toBeUndefined();
    expect(sanitizeProvenance({ client: "x".repeat(200) })).toBeUndefined();
    expect(sanitizeProvenance({ client: "café" })).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(sanitizeProvenance({})).toBeUndefined();
    expect(sanitizeProvenance(null)).toBeUndefined();
  });

  it("clientOnly drops content-sha256 from untrusted input", () => {
    expect(
      sanitizeProvenance(
        { client: "uploads-cli", "content-sha256": "a".repeat(64) },
        { clientOnly: true },
      ),
    ).toEqual({ client: "uploads-cli" });
  });
});

describe("provenanceFromHeaders", () => {
  it("reads X-Uploads-Meta-* headers but not content-sha256", () => {
    const headers: Record<string, string> = {
      "x-uploads-meta-client": "uploads-cli",
      "x-uploads-meta-frame": "phone",
      "x-uploads-meta-optimized": "1",
      "x-uploads-meta-content-sha256": "deadbeef",
    };
    expect(provenanceFromHeaders((n) => headers[n.toLowerCase()])).toEqual({
      client: "uploads-cli",
      frame: "phone",
      optimized: "1",
    });
  });
});

describe("contentSha256Hex", () => {
  it("hashes bytes", async () => {
    const hex = await contentSha256Hex(new TextEncoder().encode("hello"));
    expect(hex).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
