import { describe, expect, it } from "vitest";
import { checkRunContent, checksDeniedKey, syncUploadsCheck } from "./github-check-run";
import type { GithubAppConfig } from "./github-app";
import { FakeKv } from "../test/fake-kv";

const CFG: GithubAppConfig = { appId: "12345", privateKey: "unused", homeInstallationId: "777" };
const TARGET = { repo: "acme/web", kind: "pull" as const, num: 12 };
const COMMENT = "https://github.com/acme/web/pull/12#issuecomment-1";

describe("checkRunContent", () => {
  it("reports attached files as success", () => {
    expect(checkRunContent({ count: 3, heldCount: 0 }, COMMENT)).toMatchObject({
      conclusion: "success",
      title: "3 files attached",
    });
    expect(checkRunContent({ count: 1, heldCount: 0 }, null).title).toBe("1 file attached");
  });

  it("reports held files as neutral, never blocking", () => {
    expect(checkRunContent({ count: 4, heldCount: 1 }, COMMENT)).toMatchObject({
      conclusion: "neutral",
      title: "1 of 4 files held for review",
    });
  });

  it("says when UI files changed with nothing attached", () => {
    const content = checkRunContent(
      { count: 0, heldCount: 0, uiFiles: ["apps/web/a.astro", "b.css"] },
      COMMENT,
    );
    expect(content).toMatchObject({
      conclusion: "neutral",
      title: "UI changed, no visuals attached",
    });
    expect(content.summary).toContain("- `apps/web/a.astro`\n- `b.css`");
  });

  it("links the how-to docs when there's no comment to point at", () => {
    const content = checkRunContent({ count: 0, heldCount: 0, uiFiles: ["b.css"] }, null);
    expect(content.summary).toContain("https://uploads.sh/docs/require-screenshots");
  });

  describe("required uploads", () => {
    const req = { required: true, uiFiles: ["a.astro"] };
    const requirement = (
      checklist: { label: string; met: boolean }[],
      skipLabel: string | null = null,
    ) => ({ checklist, skipLabel, skipHint: "uploads:skip-verify" });
    const unmet = [
      { label: "Uploads", met: true },
      { label: "Mobile", met: false },
    ];

    it("fails when UI files changed with nothing attached", () => {
      const content = checkRunContent(
        {
          ...req,
          count: 0,
          heldCount: 0,
          requirement: requirement([{ label: "Uploads", met: false }]),
        },
        null,
      );
      expect(content).toMatchObject({
        conclusion: "failure",
        title: "UI changed, no visuals attached",
      });
      expect(content.summary).toContain("add the `uploads:skip-verify` label");
      expect(content.summary).toContain("**Required:** ⬜ Uploads");
    });

    it("names the unmet requirements", () => {
      expect(
        checkRunContent({ ...req, count: 2, heldCount: 0, requirement: requirement(unmet) }, null),
      ).toMatchObject({ conclusion: "failure", title: "Missing: mobile" });
    });

    it("passes when every requirement is met", () => {
      const content = checkRunContent(
        {
          ...req,
          count: 2,
          heldCount: 0,
          requirement: requirement([{ label: "Uploads", met: true }]),
        },
        null,
      );
      expect(content).toMatchObject({
        conclusion: "success",
        title: "2 files attached",
      });
    });

    it("names the met requirements beyond uploads in a passing title", () => {
      const content = checkRunContent(
        {
          ...req,
          count: 4,
          heldCount: 0,
          requirement: requirement([
            { label: "Uploads", met: true },
            { label: "Before and after", met: true },
            { label: "Desktop", met: true },
            { label: "Mobile", met: true },
          ]),
        },
        null,
      );
      expect(content.title).toBe("4 files attached · before and after, desktop, mobile");
    });

    it("goes neutral for a skip label", () => {
      const content = checkRunContent(
        { ...req, count: 0, heldCount: 0, requirement: requirement([], "Uploads:Skip-Verify") },
        null,
      );
      expect(content).toMatchObject({
        conclusion: "neutral",
        title: "Skipped by the Uploads:Skip-Verify label",
      });
      expect(content.summary).toContain("`Uploads:Skip-Verify`");
    });

    it("never fails while a file is held", () => {
      expect(
        checkRunContent({ ...req, count: 2, heldCount: 1, requirement: requirement(unmet) }, null)
          .conclusion,
      ).toBe("neutral");
    });

    it("passes on screenshots attached on GitHub, suggesting the import when it's off", () => {
      const content = checkRunContent(
        {
          ...req,
          count: 0,
          heldCount: 0,
          githubAttachments: 2,
          importsAttachments: false,
          requirement: requirement([{ label: "Uploads", met: true }]),
        },
        null,
      );
      expect(content).toMatchObject({
        conclusion: "success",
        title: "2 files attached on GitHub",
      });
      expect(content.summary).toContain("turn on importing GitHub attachments");
    });

    it("names what screenshots attached on GitHub leave missing", () => {
      const content = checkRunContent(
        {
          ...req,
          count: 0,
          heldCount: 0,
          githubAttachments: 1,
          importsAttachments: true,
          requirement: requirement(unmet),
        },
        null,
      );
      expect(content).toMatchObject({ conclusion: "failure", title: "Missing: mobile" });
      expect(content.summary.startsWith("1 file attached on GitHub.\n\n")).toBe(true);
    });

    it("passes a PR that changes no UI files", () => {
      expect(
        checkRunContent({ required: true, count: 0, heldCount: 0, uiFiles: [] }, null),
      ).toMatchObject({ conclusion: "success", title: "No UI changes" });
    });
  });

  it("reports screenshots attached on GitHub as success", () => {
    expect(
      checkRunContent(
        {
          count: 0,
          heldCount: 0,
          uiFiles: ["a.astro"],
          githubAttachments: 1,
          importsAttachments: true,
        },
        null,
      ),
    ).toEqual({
      conclusion: "success",
      title: "1 file attached on GitHub",
      summary: "1 file attached on GitHub.",
    });
  });

  it("goes neutral when nothing is attached", () => {
    expect(checkRunContent({ count: 0, heldCount: 0 }, null)).toMatchObject({
      conclusion: "neutral",
      title: "Nothing attached",
    });
  });
});

type Call = { url: string; method: string; body?: Record<string, unknown> };

function harness(
  opts: { existing?: (number | { id: number; name: string })[]; listStatus?: number } = {},
) {
  const kv = new FakeKv();
  kv.store.set("ghtok:42", { value: "tok" });
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/pulls/12")) return Response.json({ head: { sha: "abc123" } });
    if (url.includes("/check-runs?")) {
      if (opts.listStatus) return new Response("", { status: opts.listStatus });
      return Response.json({
        check_runs: (opts.existing ?? []).map((r) =>
          typeof r === "number" ? { id: r, name: "Check for visuals" } : r,
        ),
      });
    }
    return Response.json({ id: 9 }, { status: method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  const env = { GITHUB_CACHE: kv, WEB_ORIGIN: "https://uploads.test" } as unknown as Env;
  return { env, kv, calls, fetchImpl };
}

describe("syncUploadsCheck", () => {
  it("creates a completed run on the head commit", async () => {
    const h = harness();
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 2, heldCount: 0 },
      {
        commentUrl: COMMENT,
        fetchImpl: h.fetchImpl,
      },
    );
    const post = h.calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://api.github.com/repos/acme/web/check-runs");
    expect(post?.body).toMatchObject({
      name: "Check for visuals",
      head_sha: "abc123",
      status: "completed",
      conclusion: "success",
      details_url: COMMENT,
    });
    expect(h.calls[1]?.url).toContain("check-runs?app_id=12345");
  });

  it("patches the existing run and uses a known head sha", async () => {
    const h = harness({ existing: [77] });
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 0, heldCount: 0 },
      {
        headSha: "def456",
        fetchImpl: h.fetchImpl,
      },
    );
    expect(h.calls.some((c) => c.url.endsWith("/pulls/12"))).toBe(false);
    const patch = h.calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://api.github.com/repos/acme/web/check-runs/77");
    expect(patch?.body).toMatchObject({ conclusion: "neutral" });
  });

  it("renames a run still carrying the old name", async () => {
    const h = harness({ existing: [{ id: 5, name: "uploads.sh" }] });
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 1, heldCount: 0 },
      {
        fetchImpl: h.fetchImpl,
      },
    );
    const patch = h.calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://api.github.com/repos/acme/web/check-runs/5");
    expect(patch?.body).toMatchObject({ name: "Check for visuals" });
  });

  it("links details to the workspace's files page for the PR", async () => {
    const h = harness();
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 1, heldCount: 0 },
      {
        commentUrl: COMMENT,
        workspaceName: "acme",
        fetchImpl: h.fetchImpl,
      },
    );
    const post = h.calls.find((c) => c.method === "POST");
    expect(post?.body?.details_url).toBe(
      "https://uploads.test/account/workspaces/acme/files/acme/web/pull/12",
    );
  });

  it("never creates a run just to say empty", async () => {
    const h = harness();
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 0, heldCount: 0 },
      {
        headSha: "abc123",
        fetchImpl: h.fetchImpl,
      },
    );
    expect(h.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("creates a run for UI changes with nothing attached", async () => {
    const h = harness();
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 0, heldCount: 0, uiFiles: ["a.css"] },
      { headSha: "abc123", fetchImpl: h.fetchImpl },
    );
    const post = h.calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ conclusion: "neutral" });
  });

  it("creates a run on every PR when uploads are required", async () => {
    const h = harness();
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 0, heldCount: 0, required: true },
      { headSha: "abc123", fetchImpl: h.fetchImpl },
    );
    const post = h.calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ conclusion: "success" });
  });

  it("does nothing for issues", async () => {
    const h = harness();
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      { ...TARGET, kind: "issues" },
      { count: 1, heldCount: 0 },
      { fetchImpl: h.fetchImpl },
    );
    expect(h.calls).toEqual([]);
  });

  it("remembers an installation without Checks permission", async () => {
    const h = harness({ listStatus: 403 });
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 1, heldCount: 0 },
      {
        headSha: "abc123",
        fetchImpl: h.fetchImpl,
      },
    );
    expect(h.kv.store.get(checksDeniedKey(42))?.expirationTtl).toBe(3600);

    h.calls.length = 0;
    await syncUploadsCheck(
      h.env,
      CFG,
      42,
      TARGET,
      { count: 1, heldCount: 0 },
      {
        headSha: "abc123",
        fetchImpl: h.fetchImpl,
      },
    );
    expect(h.calls).toEqual([]);
  });

  it("swallows GitHub failures", async () => {
    const h = harness({ listStatus: 500 });
    await expect(
      syncUploadsCheck(
        h.env,
        CFG,
        42,
        TARGET,
        { count: 1, heldCount: 0 },
        {
          headSha: "abc123",
          fetchImpl: h.fetchImpl,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("webhook wiring", () => {
  it("carries the head sha into the promote event", async () => {
    const { extractWebhookEvent } = await import("./github-webhook");
    const ev = extractWebhookEvent("pull_request", {
      action: "synchronize",
      repository: { full_name: "acme/web" },
      pull_request: {
        number: 12,
        title: "t",
        state: "open",
        head: { ref: "feat", sha: "abc123", repo: { full_name: "acme/web" } },
      },
    });
    expect(ev?.promote).toEqual({ repo: "acme/web", num: 12, branch: "feat", sha: "abc123" });
  });

  it("re-checks on label changes", async () => {
    const { extractWebhookEvent } = await import("./github-webhook");
    const ev = extractWebhookEvent("pull_request", {
      action: "labeled",
      repository: { full_name: "acme/web" },
      pull_request: { number: 12, title: "t", state: "open" },
      label: { name: "uploads:skip-verify" },
    });
    expect(ev?.labels).toEqual({ repo: "acme/web", num: 12, label: "uploads:skip-verify" });
    expect(ev?.promote).toBeUndefined();
  });

  it("clears the denied marker on installation events", async () => {
    const { extractWebhookEvent } = await import("./github-webhook");
    const ev = extractWebhookEvent("installation", {
      action: "new_permissions_accepted",
      installation: { id: 42 },
    });
    expect(ev?.keys).toContain(checksDeniedKey(42));
  });
});
