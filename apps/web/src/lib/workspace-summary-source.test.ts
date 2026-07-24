import { beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaceSummary, resetInFlightSummaries } from "./workspace-summary-source";
import type { WorkspaceSummaryResult } from "./api-client";

function successResult(workspace = "buildinternet"): WorkspaceSummaryResult {
  return {
    kind: "success",
    workspace: {
      workspace,
      organization: { id: "org_1", slug: workspace, name: "BuildInternet" },
      role: "owner",
      hasPublicUrl: false,
    },
    usage: null,
  };
}

/** A fetcher that never settles until `release` is called. */
function deferredFetcher() {
  let release!: (value: WorkspaceSummaryResult) => void;
  const promise = new Promise<WorkspaceSummaryResult>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    fetcher: () => {
      calls += 1;
      return promise;
    },
    release,
    calls: () => calls,
  };
}

beforeEach(() => {
  resetInFlightSummaries();
});

describe("loadWorkspaceSummary", () => {
  it("issues one request when two callers ask while it is still in flight", async () => {
    const d = deferredFetcher();
    const a = loadWorkspaceSummary("https://api.test", "buildinternet", d.fetcher);
    const b = loadWorkspaceSummary("https://api.test", "buildinternet", d.fetcher);
    expect(d.calls()).toBe(1);
    d.release(successResult());
    expect(await a).toEqual(await b);
  });

  it("does not share a request between different workspaces", async () => {
    let calls = 0;
    const fetcher = async (_o: string, w: string) => {
      calls += 1;
      return successResult(w);
    };
    await Promise.all([
      loadWorkspaceSummary("https://api.test", "one", fetcher),
      loadWorkspaceSummary("https://api.test", "two", fetcher),
    ]);
    expect(calls).toBe(2);
  });

  it("refetches once the previous request has settled", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return successResult();
    };
    await loadWorkspaceSummary("https://api.test", "buildinternet", fetcher);
    await loadWorkspaceSummary("https://api.test", "buildinternet", fetcher);
    expect(calls).toBe(2);
  });

  it("clears the in-flight entry when the request rejects, so a retry can run", async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("network");
    };
    await expect(
      loadWorkspaceSummary("https://api.test", "buildinternet", failing),
    ).rejects.toThrow("network");
    await expect(
      loadWorkspaceSummary("https://api.test", "buildinternet", failing),
    ).rejects.toThrow("network");
    expect(calls).toBe(2);
  });

  it("passes an unavailable result straight through", async () => {
    const fetcher = async (): Promise<WorkspaceSummaryResult> => ({
      kind: "unavailable",
      reason: "not_found",
    });
    const result = await loadWorkspaceSummary("https://api.test", "gone", fetcher);
    expect(result).toEqual({ kind: "unavailable", reason: "not_found" });
  });
});
