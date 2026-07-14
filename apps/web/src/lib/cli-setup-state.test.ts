import { describe, expect, it } from "vitest";
import { resolveCliSetupState } from "./cli-setup-state";

const CLI_UA = "@buildinternet/uploads/1.0.0 (device-token)";
const BROWSER_UA = "Mozilla/5.0 Chrome/120";

describe("resolveCliSetupState", () => {
  it("stays checking until sessions are loaded", () => {
    expect(resolveCliSetupState({ sessions: null, loaded: false }).kind).toBe("checking");
  });

  it("is ready when an active CLI session exists", () => {
    const state = resolveCliSetupState({
      loaded: true,
      sessions: [{ userAgent: CLI_UA }, { userAgent: BROWSER_UA }],
    });
    expect(state).toMatchObject({ kind: "ready", statusState: "ready" });
  });

  it("reconnects when onboarded but no active CLI session", () => {
    const state = resolveCliSetupState({
      loaded: true,
      sessions: [{ userAgent: BROWSER_UA }],
      cliOnboardedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(state.kind).toBe("reconnect");
  });

  it("nudges install when list-sessions fails and user never onboarded", () => {
    const state = resolveCliSetupState({
      loaded: true,
      sessions: null,
      cliOnboardedAt: null,
    });
    expect(state.kind).toBe("setup");
    expect(state.statusText.toLowerCase()).not.toMatch(/couldn.?t/);
  });

  it("prefers reconnect when list fails but onboarded flag is set", () => {
    expect(
      resolveCliSetupState({
        loaded: true,
        sessions: null,
        cliOnboardedAt: new Date("2026-06-01"),
      }).kind,
    ).toBe("reconnect");
  });

  it("shows setup when loaded with no CLI and never onboarded", () => {
    expect(
      resolveCliSetupState({
        loaded: true,
        sessions: [{ userAgent: BROWSER_UA }],
      }).kind,
    ).toBe("setup");
  });
});
