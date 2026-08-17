import { afterEach, describe, expect, it, vi } from "vitest";
import { inferWorkspaceFromCredential } from "../src/infer-workspace.js";
import type { ResolvedConfig } from "../src/config.js";

function config(partial: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiUrl: "https://api.uploads.sh",
    workspace: "default",
    token: "upl_sk_dev",
    workspaceSource: "default",
    configPath: "/tmp/config",
    configExists: false,
    ...partial,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inferWorkspaceFromCredential", () => {
  it("leaves an explicit workspace alone", async () => {
    const input = config({ workspace: "acme", workspaceSource: "env" });
    await expect(inferWorkspaceFromCredential(input)).resolves.toBe(input);
  });

  it("leaves a workspace token alone", async () => {
    const input = config({ token: "up_acme_secret", workspaceSource: "default" });
    await expect(inferWorkspaceFromCredential(input)).resolves.toBe(input);
  });

  it("picks the only membership for an API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspaces: [{ workspace: "acme", role: "owner" }] })),
    );
    const out = await inferWorkspaceFromCredential(config());
    expect(out.workspace).toBe("acme");
    expect(out.workspaceSource).toBe("account");
  });

  it("errors when the key can see several workspaces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          workspaces: [
            { workspace: "acme", role: "owner" },
            { workspace: "other", role: "member" },
          ],
        }),
      ),
    );
    await expect(inferWorkspaceFromCredential(config())).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("--workspace acme"),
    });
  });
});
