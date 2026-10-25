import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import { repoInstallationToken } from "../../api/src/github-app";
import { resolveMediaContext } from "../src/media-context";

vi.mock("../../api/src/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/src/github-app")>()),
  repoInstallationToken: vi.fn(async () => "fixture-token"),
}));

const databases: SqliteD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fixture(owner?: string) {
  const db = new SqliteD1(["migrations/20260720120000_github_repo_links.sql"]);
  databases.push(db);
  if (owner)
    db.db
      .prepare(
        "INSERT INTO github_repo_links (repo_full_name, workspace_name, source, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("acme/widgets", owner, "fixture", "2026-10-25T12:00:00Z");
  const fetchStub = vi.fn<typeof fetch>(async () => Response.json([{ number: 42 }]));
  vi.stubGlobal("fetch", fetchStub);
  return { env: { DB: db } as unknown as Env, fetchStub };
}

const scope = { repo: "Acme/Widgets", branch: "Feature/Settings" };
const normalized = { repo: "acme/widgets", branch: "feature/settings" };

describe("media context", () => {
  it("uses an explicit PR without GitHub access and validates its number", async () => {
    const { env, fetchStub } = fixture("other-workspace");
    expect(await resolveMediaContext(env, "test-ws", { ...scope, pr: 42 })).toEqual({
      ...normalized,
      pr: 42,
      prResolution: "explicit",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(repoInstallationToken).not.toHaveBeenCalled();
    for (const pr of [0, -1, 1.5, "42", Number.MAX_SAFE_INTEGER + 1])
      await expect(resolveMediaContext(env, "test-ws", { ...scope, pr })).rejects.toThrow();
  });

  it.each([undefined, "other-workspace"])(
    "does not query GitHub for a repository bound to %s",
    async (owner) => {
      const { env, fetchStub } = fixture(owner);
      expect(await resolveMediaContext(env, "test-ws", scope)).toEqual({
        ...normalized,
        pr: null,
        prResolution: "unavailable",
      });
      expect(fetchStub).not.toHaveBeenCalled();
      expect(repoInstallationToken).not.toHaveBeenCalled();
    },
  );

  it("resolves one open PR only through this workspace's repository binding", async () => {
    const { env, fetchStub } = fixture("test-ws");
    expect(await resolveMediaContext(env, "test-ws", scope)).toEqual({
      ...normalized,
      pr: 42,
      prResolution: "resolved",
    });
    const requested = new URL(String(fetchStub.mock.calls[0]![0]));
    expect(requested.pathname).toBe("/repos/acme/widgets/pulls");
    expect(requested.searchParams.get("head")).toBe("acme:Feature/Settings");
    expect(requested.searchParams.get("state")).toBe("open");
  });

  it.each([
    { pulls: [] },
    { pulls: [{ number: 42 }, { number: 43 }] },
    { pulls: [{ number: "42" }] },
  ])(
    "reports unavailable rather than choosing an ambiguous or invalid PR: %j",
    async ({ pulls }) => {
      const { env, fetchStub } = fixture("test-ws");
      fetchStub.mockImplementation(async () => Response.json(pulls));
      expect(await resolveMediaContext(env, "test-ws", scope)).toMatchObject({
        pr: null,
        prResolution: "unavailable",
      });
    },
  );

  it("reports GitHub failure as unavailable resolution, not an empty attached listing", async () => {
    const { env, fetchStub } = fixture("test-ws");
    fetchStub.mockRejectedValue(new Error("network unavailable"));
    expect(await resolveMediaContext(env, "test-ws", scope)).toEqual({
      ...normalized,
      pr: null,
      prResolution: "unavailable",
    });
  });
});
