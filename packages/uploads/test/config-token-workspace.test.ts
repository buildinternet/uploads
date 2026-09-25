import { describe, expect, it } from "vitest";
import { workspaceFromToken } from "../src/config.js";

describe("workspaceFromToken", () => {
  it("reads the workspace from personal and service tokens", () => {
    expect(workspaceFromToken("up_acme_secret")).toBe("acme");
    expect(workspaceFromToken("ups_acme_secret")).toBe("acme");
  });

  it("ignores other shapes", () => {
    expect(workspaceFromToken("upx_acme_secret")).toBeUndefined();
    expect(workspaceFromToken("secret")).toBeUndefined();
  });
});
