import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAppGrant } from "./auth-client";
import {
  connectedAppWorkspaceLabel,
  loadConnectedAppsPageData,
  renderConnectedAppsHtml,
} from "./connected-apps-ui";

afterEach(() => {
  vi.unstubAllGlobals();
});

function grant(overrides: Partial<ConnectedAppGrant> = {}): ConnectedAppGrant {
  return {
    id: "consent-1",
    clientId: "client-1",
    clientName: "Acme Client",
    clientIcon: null,
    clientUri: null,
    scopes: ["files:read"],
    referenceId: null,
    activeTokenCount: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("connectedAppWorkspaceLabel", () => {
  it("strips the ws: prefix", () => {
    expect(connectedAppWorkspaceLabel("ws:acme")).toBe("acme");
  });

  it("falls back to account-level wording for null or non-ws referenceIds", () => {
    expect(connectedAppWorkspaceLabel(null)).toBe("All workspaces");
    expect(connectedAppWorkspaceLabel("something-else")).toBe("All workspaces");
  });
});

describe("renderConnectedAppsHtml", () => {
  it("returns an empty string for the empty-grants edge case", () => {
    expect(renderConnectedAppsHtml([])).toBe("");
  });

  it("renders name, workspace, scopes, and a revoke button", () => {
    const html = renderConnectedAppsHtml([
      grant({ referenceId: "ws:acme", scopes: ["files:read", "files:write"] }),
    ]);
    expect(html).toMatch(/Acme Client/);
    expect(html).toMatch(/detail-meta">acme/);
    expect(html).toMatch(/files:read/);
    expect(html).toMatch(/files:write/);
    expect(html).toMatch(/data-revoke="consent-1"/);
    expect(html).toMatch(/ul-badge--ok">Active/);
  });

  it("falls back to clientId when clientName is null and flags zero active tokens", () => {
    const html = renderConnectedAppsHtml([
      grant({ clientName: null, clientId: "raw-client-id", activeTokenCount: 0 }),
    ]);
    expect(html).toMatch(/raw-client-id/);
    expect(html).toMatch(/No active tokens/);
  });

  it("escapes attacker-controlled client fields", () => {
    const html = renderConnectedAppsHtml([grant({ clientName: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toMatch(/&lt;img/);
  });

  it("orders grants most-recently-granted first", () => {
    const html = renderConnectedAppsHtml([
      grant({ id: "older", clientName: "Older", createdAt: "2026-01-01T00:00:00.000Z" }),
      grant({ id: "newer", clientName: "Newer", createdAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(html.indexOf("Newer")).toBeLessThan(html.indexOf("Older"));
  });
});

describe("loadConnectedAppsPageData", () => {
  it("short-circuits to grants: null for an empty cookie", async () => {
    const data = await loadConnectedAppsPageData("https://auth.uploads.sh", "");
    expect(data).toEqual({ grants: null });
  });

  it("fetches connected apps when a cookie is present", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ grants: [grant()] })));
    vi.stubGlobal("fetch", fetcher);
    const data = await loadConnectedAppsPageData("https://auth.uploads.sh", "cookie=1");
    expect(data.grants).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("routes through a caller-supplied fetchImpl (SSR binding transport)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ grants: [] })));
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const data = await loadConnectedAppsPageData("https://auth.uploads.sh", "cookie=1", fetchImpl);
    expect(data.grants).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("returns null on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const data = await loadConnectedAppsPageData("https://auth.uploads.sh", "cookie=1");
    expect(data).toEqual({ grants: null });
  });
});
