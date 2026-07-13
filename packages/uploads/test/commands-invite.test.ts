import { describe, expect, it } from "vitest";
import { resolveInviteWorkspace } from "../src/commands/invite.js";
import { UsageError } from "../src/cli-args.js";

describe("resolveInviteWorkspace", () => {
  it("picks the only adminable workspace", () => {
    expect(
      resolveInviteWorkspace(
        [
          { workspace: "acme", role: "owner" },
          { workspace: "other", role: "member" },
        ],
        undefined,
      ),
    ).toBe("acme");
  });

  it("honors --workspace when the user is admin there", () => {
    expect(
      resolveInviteWorkspace(
        [
          { workspace: "acme", role: "admin" },
          { workspace: "beta", role: "owner" },
        ],
        "beta",
      ),
    ).toBe("beta");
  });

  it("rejects member-only access", () => {
    expect(() => resolveInviteWorkspace([{ workspace: "acme", role: "member" }], "acme")).toThrow(
      UsageError,
    );
  });

  it("requires --workspace when multiple admin workspaces exist", () => {
    expect(() =>
      resolveInviteWorkspace(
        [
          { workspace: "acme", role: "admin" },
          { workspace: "beta", role: "owner" },
        ],
        undefined,
      ),
    ).toThrow(/pass --workspace/);
  });
});
