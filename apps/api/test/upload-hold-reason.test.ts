import { describe, expect, it } from "vitest";
import { holdReason } from "../src/upload-hold";

describe("holdReason", () => {
  it("holds a high-confidence identity document or card", () => {
    for (const pii of ["identity_document", "financial"]) {
      expect(holdReason({ "ai.pii": pii, "ai.pii.confidence": "high" })).toBe("pii");
    }
  });

  it("never holds pii of contact or other", () => {
    for (const pii of ["contact", "other"]) {
      expect(holdReason({ "ai.pii": pii, "ai.pii.confidence": "high" })).toBeUndefined();
    }
  });
});
