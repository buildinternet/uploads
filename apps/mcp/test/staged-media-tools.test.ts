import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";
import type { WorkspaceRecord } from "@uploads/api/workspace";
import { stagedMediaReadTools } from "../src/staged-media-tools";
import {
  stagedPreviewUrl,
  type StagedMediaPage,
  type StagedScopePage,
} from "../src/staged-media-response";

class PreviewBucket extends FakeR2Bucket {
  privateKeys = new Set<string>();
  override async head(key: string) {
    const head = await super.head(key);
    return (
      head && {
        ...head,
        customMetadata: this.privateKeys.has(key) ? { visibility: "private" } : {},
      }
    );
  }
}

const databases: SqliteD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(workspaceName = "test-ws") {
  const sqlite = new SqliteD1(["migrations/20260713210559_file_metadata.sql"]);
  databases.push(sqlite);
  const bucket = new PreviewBucket();
  const workspace: WorkspaceRecord = {
    provider: "r2",
    binding: "UPLOADS",
    bucket: "test",
    tokenHash: "unused",
    publicBaseUrl: "https://storage.uploads.sh/test-ws",
  };
  const env = { DB: sqlite, UPLOADS: bucket } as unknown as Env;
  const requireScope = vi.fn();
  const toolsFor = (name = workspaceName) =>
    stagedMediaReadTools({ env, workspace, workspaceName: name, requireScope });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    scopedWorkspace = workspaceName,
  ) =>
    toolsFor(scopedWorkspace)
      .find((tool) => tool.name === name)!
      .handler(args);
  async function add(
    key: string,
    opts: {
      workspace?: string;
      repo?: string;
      branch?: string;
      status?: string;
      kind?: string;
      missing?: boolean;
      private?: boolean;
      held?: boolean;
      contentType?: string;
    } = {},
  ) {
    const metadata = {
      "gh.repo": opts.repo ?? "acme/widgets",
      "gh.branch": opts.branch ?? "feature/settings",
      "gh.kind": opts.kind ?? "branch",
      "gh.status": opts.status ?? "staged",
      "gh.staged-at": "2026-10-25T12:00:00Z",
      path: "/settings",
      state: "after",
      ...(opts.held ? { "ai.hold": "pending" } : {}),
    };
    const insert = sqlite.db.prepare(
      "INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [name, value] of Object.entries(metadata))
      insert.run(opts.workspace ?? workspaceName, key, name, value, "2026-10-25T12:00:00Z");
    if (!opts.missing)
      await bucket.put(key, "fixture", {
        httpMetadata: { contentType: opts.contentType ?? "image/png" },
      });
    if (opts.private) bucket.privateKeys.add(key);
  }
  return { call, add, requireScope, workspace, toolsFor, sqlite };
}

const scope = { repo: "acme/widgets", branch: "feature/settings" };

describe("staged media tools", () => {
  it("reads only the authenticated workspace's exact staged repository and branch", async () => {
    const f = fixture();
    await f.add("included.png");
    await f.add("foreign-workspace.png", { workspace: "other" });
    await f.add("foreign-repo.png", { repo: "other/app" });
    await f.add("foreign-branch.png", { branch: "feature/billing" });
    await f.add("promoted.png", { status: "promoted" });
    await f.add("unstaged.png", { status: "unstaged" });
    await f.add("pull.png", { kind: "pull" });
    const result = (await f.call("list_staged_media", {
      repo: "Acme/Widgets",
      branch: "Feature/Settings",
    })) as StagedMediaPage;
    expect(result).toMatchObject({ ...scope, cursor: null });
    expect(result.items.map((item) => item.key)).toEqual(["included.png"]);
    expect(result.items[0]).toMatchObject({
      status: "available",
      mediaType: "image",
      path: "/settings",
      state: "after",
    });
    expect(result.items[0]!.previewUrl).toMatch(/^https:\/\/(embed|storage)\.uploads\.sh\//);
    expect(f.requireScope).toHaveBeenCalledWith("files:read");
  });

  it("withholds private and held previews and represents missing or unsupported media", async () => {
    const f = fixture();
    await f.add("private.png", { private: true });
    await f.add("held.png", { held: true });
    await f.add("missing.png", { missing: true });
    await f.add("notes.txt", { contentType: "text/plain" });
    const result = (await f.call("list_staged_media", scope)) as StagedMediaPage;
    const byKey = new Map(result.items.map((item) => [item.key, item]));
    expect(byKey.get("private.png")).toMatchObject({
      status: "withheld",
      previewUrl: null,
      path: null,
      state: null,
    });
    expect(byKey.get("held.png")).toMatchObject({
      status: "withheld",
      previewUrl: null,
      stagedAt: null,
    });
    expect(byKey.get("missing.png")).toMatchObject({ status: "missing", previewUrl: null });
    expect(byKey.get("notes.txt")).toMatchObject({ status: "unsupported", previewUrl: null });
    f.workspace.publicBaseUrl = "https://customer.example.com";
    await f.add("public.png");
    const custom = (await f.call("list_staged_media", scope)) as StagedMediaPage;
    expect(custom.items.find((item) => item.key === "public.png")).toMatchObject({
      status: "unsupported",
      previewUrl: null,
    });
  });

  it("paginates without broadening a cursor to another branch or workspace", async () => {
    const f = fixture();
    await f.add("a.png");
    await f.add("b.png");
    await f.add("c.png");
    const first = (await f.call("list_staged_media", { ...scope, limit: 1 })) as StagedMediaPage;
    expect(first.items.map((item) => item.key)).toEqual(["a.png"]);
    expect(first.cursor).toBeTypeOf("string");
    const next = (await f.call("list_staged_media", {
      ...scope,
      limit: 2,
      cursor: first.cursor,
    })) as StagedMediaPage;
    expect(next.items.map((item) => item.key)).toEqual(["b.png", "c.png"]);
    expect(next.cursor).toBeNull();
    await expect(
      f.call("list_staged_media", { ...scope, branch: "other", cursor: first.cursor }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      f.call("list_staged_media", { ...scope, cursor: first.cursor }, "other"),
    ).rejects.toThrow(/cursor/i);
  });

  it("lists distinct staged branch pairs with workspace-bound continuation", async () => {
    const f = fixture();
    await f.add("a.png");
    await f.add("b.png");
    await f.add("c.png", { branch: "feature/z" });
    await f.add("foreign.png", { workspace: "other", repo: "private/repo" });
    await f.add("old.png", { branch: "old", status: "promoted" });
    await f.add("pull.png", { branch: "pull", kind: "pull" });
    const first = (await f.call("list_staged_scopes", { limit: 1 })) as StagedScopePage;
    expect(first.scopes).toEqual([scope]);
    expect(first.cursor).toBeTypeOf("string");
    const next = (await f.call("list_staged_scopes", { cursor: first.cursor })) as StagedScopePage;
    expect(next).toEqual({ scopes: [{ repo: "acme/widgets", branch: "feature/z" }], cursor: null });
    await expect(f.call("list_staged_scopes", { cursor: first.cursor }, "other")).rejects.toThrow(
      /cursor/i,
    );
  });

  it("rejects invalid scope and read permission before performing reads", async () => {
    const f = fixture();
    await expect(f.call("list_staged_media", {})).rejects.toThrow();
    await expect(f.call("list_staged_media", { ...scope, repo: "invalid" })).rejects.toThrow();
    await expect(f.call("list_staged_media", { ...scope, branch: "" })).rejects.toThrow();
    await expect(f.call("list_staged_media", { ...scope, branch: " x " })).rejects.toThrow();
    await expect(f.call("list_staged_media", { ...scope, branch: "x\ny" })).rejects.toThrow();
    await expect(f.call("list_staged_media", { ...scope, limit: 51 })).rejects.toThrow();
    await expect(f.call("list_staged_scopes", { limit: 201 })).rejects.toThrow();
    f.requireScope.mockImplementation(() => {
      throw new Error("files:read required");
    });
    await expect(f.call("list_staged_media", scope)).rejects.toThrow("files:read required");
    await expect(f.call("list_staged_scopes", {})).rejects.toThrow("files:read required");
  });

  it("never exposes an arbitrary preview origin", () => {
    for (const value of [
      "http://embed.uploads.sh/a.png",
      "https://evil.example/a.png",
      "https://embed.uploads.sh.evil.example/a.png",
      "https://user:pass@embed.uploads.sh/a.png",
      "https://embed.uploads.sh:444/a.png",
      "javascript:alert(1)",
    ]) {
      expect(stagedPreviewUrl(value)).toBeNull();
    }
    expect(stagedPreviewUrl("https://embed.uploads.sh/ws/a.png")).toBe(
      "https://embed.uploads.sh/ws/a.png",
    );
  });
});
