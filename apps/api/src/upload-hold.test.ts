import { describe, expect, it } from "vitest";
import {
  clientCanApprove,
  formatHoldArea,
  HOLD_MIN_CLI_VERSION,
  padHoldArea,
  parseHoldArea,
} from "./upload-hold";

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

describe("hold area", () => {
  it("pads a model box, clamps it to the image, and round-trips the stored row", () => {
    const area = padHoldArea({ top: 0.01, bottom: 0.5, left: 0.2, right: 0.99 });
    expect(area).toEqual({ top: 0, bottom: 0.53, left: 0.17, right: 1 });
    const row = formatHoldArea(area!);
    expect(row).toBe("0.000,0.530,0.170,1.000");
    expect(parseHoldArea(row)).toEqual(area);
  });

  it("rejects a missing, inverted, or malformed box", () => {
    expect(padHoldArea(undefined)).toBeUndefined();
    expect(padHoldArea({ top: 0.5, bottom: 0.2, left: 0, right: 1 })).toBeUndefined();
    expect(padHoldArea({ top: 0.1, bottom: 0.2, left: 0 })).toBeUndefined();
    expect(parseHoldArea("0.1,0.2,0.3")).toBeUndefined();
    expect(parseHoldArea("0.1,0.2,0.3,nope")).toBeUndefined();
    expect(parseHoldArea("0.1,1.2,0.3,0.4")).toBeUndefined();
    expect(parseHoldArea(undefined)).toBeUndefined();
  });
});
