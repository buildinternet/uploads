import { describe, expect, it } from "vitest";
import { clientCanApprove, HOLD_MIN_CLI_VERSION } from "./upload-hold";

describe("clientCanApprove", () => {
  const cli = (clientVersion: string | null, surface = "cli") => ({ surface, clientVersion });

  it("accepts the CLI or local MCP at the approve release or newer", () => {
    expect(clientCanApprove(cli(HOLD_MIN_CLI_VERSION))).toBe(true);
    expect(clientCanApprove(cli("0.59.1"))).toBe(true);
    expect(clientCanApprove(cli("1.0.0"))).toBe(true);
    expect(clientCanApprove(cli("0.60.0", "mcp-local"))).toBe(true);
  });

  it("rejects an older or versionless CLI, other surfaces, and no client", () => {
    expect(clientCanApprove(cli("0.58.0"))).toBe(false);
    expect(clientCanApprove(cli("0.9.99"))).toBe(false);
    expect(clientCanApprove(cli(null))).toBe(false);
    expect(clientCanApprove(cli("2.1.302", "mcp-remote"))).toBe(false);
    expect(clientCanApprove(null)).toBe(false);
  });
});
