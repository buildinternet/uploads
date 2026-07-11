import { describe, expect, it } from "vitest";
import { provenanceFromHeaders, sanitizeProvenance } from "../src/provenance";

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
});

describe("provenanceFromHeaders", () => {
  it("reads X-Uploads-Meta-* headers", () => {
    const headers: Record<string, string> = {
      "x-uploads-meta-client": "uploads-cli",
      "x-uploads-meta-frame": "phone",
      "x-uploads-meta-optimized": "1",
    };
    expect(provenanceFromHeaders((n) => headers[n.toLowerCase()])).toEqual({
      client: "uploads-cli",
      frame: "phone",
      optimized: "1",
    });
  });
});
