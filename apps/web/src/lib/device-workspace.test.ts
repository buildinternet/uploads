import { describe, expect, it } from "vitest";
import { resolveDeviceWorkspaceState } from "./device-workspace";

const acme = { slug: "acme", name: "Acme" };
const beta = { slug: "beta", name: "Beta" };

describe("resolveDeviceWorkspaceState", () => {
  it("blocks approval when the requested workspace isn't one of the caller's", () => {
    expect(
      resolveDeviceWorkspaceState({
        requested: "default",
        create: false,
        workspaces: [acme, beta],
      }),
    ).toEqual({ kind: "denied", requested: "default", options: [acme, beta] });
  });

  it("blocks with an empty option list when the caller has no workspaces at all", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: "default", create: false, workspaces: [] }),
    ).toEqual({ kind: "denied", requested: "default", options: [] });
  });

  it("never blocks a --create request: the workspace legitimately may not exist yet", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: "fresh", create: true, workspaces: [] }),
    ).toEqual({ kind: "provision", requested: "fresh" });
    expect(
      resolveDeviceWorkspaceState({ requested: "fresh", create: true, workspaces: [acme] }),
    ).toEqual({ kind: "provision", requested: "fresh" });
  });

  it("preselects the requested workspace when the caller is a member", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: "beta", create: false, workspaces: [acme, beta] }),
    ).toEqual({ kind: "choose", options: [acme, beta], selected: "beta" });
  });

  it("defaults to the oldest membership when nothing was requested", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: null, create: false, workspaces: [acme, beta] }),
    ).toEqual({ kind: "choose", options: [acme, beta], selected: "acme" });
  });

  it("still offers a choice for a single-workspace account", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: null, create: false, workspaces: [acme] }),
    ).toEqual({ kind: "choose", options: [acme], selected: "acme" });
  });

  it("routes a first-run account into creation", () => {
    expect(resolveDeviceWorkspaceState({ requested: null, create: false, workspaces: [] })).toEqual(
      {
        kind: "first_run",
      },
    );
  });
});
