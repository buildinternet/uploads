import { describe, expect, it } from "vitest";
import { deriveHoldState, type HoldOverride } from "../src/upload-hold";

const SHA = "ab".repeat(32);
const OTHER = "cd".repeat(32);

function override(action: "release" | "hold", sha: string | null = SHA): HoldOverride {
  return {
    action,
    actor: action === "release" ? "Member" : "Member",
    contentSha256: sha,
    createdAt: "2026-10-28T12:00:00.000Z",
  };
}

describe("deriveHoldState", () => {
  it("treats a matching release as released and a matching hold as held", () => {
    expect(deriveHoldState({ "ai.hold": "pending" }, override("release"), SHA)).toEqual({
      hold: "approved",
      by: "Member",
      at: "2026-10-28T12:00:00.000Z",
    });
    expect(
      deriveHoldState(
        { "ai.hold": "approved", "ai.hold.by": "Old", "ai.hold.at": "2026-01-01T00:00:00.000Z" },
        override("hold"),
        SHA,
      ),
    ).toEqual({ hold: "pending", by: null, at: null });
  });

  it("ignores an override for different bytes", () => {
    expect(deriveHoldState({ "ai.hold": "pending" }, override("release", OTHER), SHA)).toEqual({
      hold: "pending",
      by: null,
      at: null,
    });
    expect(
      deriveHoldState(
        { "ai.hold": "approved", "ai.hold.by": "Member", "ai.hold.at": "2026-01-01T00:00:00.000Z" },
        override("hold", OTHER),
        SHA,
      ),
    ).toEqual({ hold: "approved", by: "Member", at: "2026-01-01T00:00:00.000Z" });
  });

  it("treats a legacy approved row as released when no override matches", () => {
    expect(
      deriveHoldState(
        { "ai.hold": "approved", "ai.hold.by": "Member", "ai.hold.at": "2026-01-01T00:00:00.000Z" },
        null,
        SHA,
      ),
    ).toEqual({ hold: "approved", by: "Member", at: "2026-01-01T00:00:00.000Z" });
    expect(deriveHoldState({ "ai.hold": "pending" }, null, SHA)).toEqual({
      hold: "pending",
      by: null,
      at: null,
    });
    expect(deriveHoldState({ "ai.secret": "api_key" }, override("release"), SHA)).toEqual({
      hold: null,
      by: null,
      at: null,
    });
  });
});
