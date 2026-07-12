import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalFlags } from "../src/cli-args.js";
import type {
  AddGalleryItemOptions,
  CreateGalleryOptions,
  LinkGalleryExternalReferenceOptions,
  UploadsClient,
} from "../src/client.js";
import type { UploadsClientConfig } from "../src/config.js";
import type { CommandRunner } from "../src/github-gh.js";
import { createMcpServer, type McpServer } from "../src/mcp/server.js";
import { createUploadsMcpTools } from "../src/mcp/tools.js";

/** Fake client factory capturing every resolved config and put()/delete() call. */
function fakeFactory() {
  const puts: Array<{ key?: string; filename: string; contentType?: string }> = [];
  const deletes: string[] = [];
  const configs: UploadsClientConfig[] = [];
  const list = async ({ prefix }: { prefix?: string } = {}) => ({
    items: puts
      .filter(({ key }) => (key ?? "").startsWith(prefix ?? ""))
      .map(({ key }) => ({ key: key!, url: `https://x.test/${key}` })),
    cursor: null,
  });
  const factory = (config: UploadsClientConfig): UploadsClient => {
    configs.push(config);
    return {
      put: async (
        body: Uint8Array,
        opts: { filename: string; key?: string; contentType?: string },
      ) => {
        // Record the effective key, so list()'s prefix filter (and key
        // assertions) see what a real client would have stored.
        const key = opts.key ?? "generated/key.png";
        puts.push({ key, filename: opts.filename, contentType: opts.contentType });
        return {
          workspace: config.workspace,
          key,
          url: `https://x.test/${key}`,
          size: body.length,
          contentType: opts.contentType ?? "image/png",
        };
      },
      list,
      listAll: async (opts: { prefix?: string } = {}) => (await list(opts)).items,
      findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
      getGallery: async () => ({ items: [] }),
      delete: async (key: string) => {
        deletes.push(key);
        return { key, deleted: true };
      },
      head: async () => {
        throw new Error("unexpected head");
      },
      health: async () => ({ ok: true }),
    } as unknown as UploadsClient;
  };
  return { factory, puts, deletes, configs };
}

/** In-memory gallery API contract used to exercise the MCP mutation workflow. */
function galleryFactory() {
  const configs: UploadsClientConfig[] = [];
  const calls: Array<{ method: string; expectedVersion?: number }> = [];
  const gallery = {
    id: "gal_stateful",
    url: "https://uploads.test/g/gal_stateful",
    workspace: "alpha",
    title: "Launch media",
    description: null,
    visibility: "public" as const,
    coverItemId: null,
    version: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    items: [],
  };
  const factory = (config: UploadsClientConfig): UploadsClient => {
    configs.push(config);
    return {
      createGallery: async ({ title, description }: CreateGalleryOptions) => ({
        ...gallery,
        title,
        description: description ?? null,
      }),
      getGallery: async () => ({ ...gallery }),
      addGalleryItem: async (_id: string, objectKey: string, opts: AddGalleryItemOptions) => {
        calls.push({ method: "add", expectedVersion: opts.expectedVersion });
        if (opts.expectedVersion !== gallery.version) throw new Error("stale gallery version");
        gallery.version++;
        return {
          id: "item_stateful",
          objectKey,
          position: 1000,
          caption: opts.caption ?? null,
          altText: opts.altText ?? null,
          createdAt: gallery.createdAt,
          status: "available" as const,
          url: "https://storage.uploads.sh/alpha/screenshots/launch.png",
          contentType: "image/png",
          size: 11,
        };
      },
      linkGalleryExternalReference: async (
        _id: string,
        opts: LinkGalleryExternalReferenceOptions,
      ) => {
        calls.push({ method: "link", expectedVersion: opts.expectedVersion });
        if (opts.expectedVersion !== gallery.version) throw new Error("stale gallery version");
        gallery.version++;
        return {
          id: "ref_stateful",
          provider: opts.provider,
          resourceType: "item",
          coordinate: opts.coordinate,
          canonicalUrl: "https://github.com/buildinternet/uploads/issues/57",
          createdAt: gallery.createdAt,
        };
      },
      findGalleriesByReference: async () => ({
        galleries: [{ ...gallery }],
        nextCursor: null,
      }),
    } as unknown as UploadsClient;
  };
  return { factory, configs, calls };
}

function ghRunner() {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "repo") return "buildinternet/uploads\n";
    if (args[0] === "pr" && args[1] === "view") return "123\n";
    if (args[1]?.includes("per_page=100")) return "[]";
    return JSON.stringify({ id: 9 });
  };
  return { run, calls };
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

function serverWith(overrides?: {
  globals?: GlobalFlags;
  runner?: CommandRunner;
  factory?: (config: UploadsClientConfig) => UploadsClient;
}) {
  const { factory, puts, deletes, configs } = fakeFactory();
  const server = createMcpServer({
    serverInfo: { name: "uploads", version: "0.0.0-test" },
    tools: createUploadsMcpTools({
      globals: overrides?.globals ?? { apiUrl: "https://x.test", token: "up_test_x" },
      runner: overrides?.runner ?? noRun,
      clientFactory: overrides?.factory ?? factory,
    }),
  });
  return { server, puts, deletes, configs };
}

async function rpc(
  server: McpServer,
  method: string,
  params?: unknown,
  id: number | string = 1,
  // oxlint-disable-next-line no-explicit-any
): Promise<any> {
  const raw = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return raw === undefined ? undefined : JSON.parse(raw);
}

const PNG_B64 = Buffer.from("png-bytes").toString("base64");

beforeEach(() => {
  // Keep the developer's real config file and env out of config resolution.
  vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-mcp-test-config");
  vi.stubEnv("UPLOADS_DEFAULT_PREFIX", "");
  vi.stubEnv("UPLOADS_WORKSPACE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createMcpServer protocol", () => {
  it("echoes a supported protocol version on initialize", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo).toEqual({ name: "uploads", version: "0.0.0-test" });
  });

  it("falls back to the latest supported version for unknown versions", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "initialize", { protocolVersion: "1999-01-01" });
    expect(res.result.protocolVersion).toBe("2025-06-18");
  });

  it("returns no response for notifications", async () => {
    const { server } = serverWith();
    const raw = await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(raw).toBeUndefined();
    expect(
      await server.handleLine(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }),
      ),
    ).toBeUndefined();
  });

  it("ignores responses sent by the client", async () => {
    const { server } = serverWith();
    expect(
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })),
    ).toBeUndefined();
  });

  it("answers ping with an empty result", async () => {
    const { server } = serverWith();
    expect((await rpc(server, "ping")).result).toEqual({});
  });

  it("rejects malformed JSON with -32700", async () => {
    const { server } = serverWith();
    const res = JSON.parse((await server.handleLine("{nope"))!);
    expect(res.error.code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it("rejects arrays (batching removed from MCP) with -32600", async () => {
    const { server } = serverWith();
    const res = JSON.parse((await server.handleLine("[]"))!);
    expect(res.error.code).toBe(-32600);
  });

  it("rejects unknown methods with -32601", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "resources/list");
    expect(res.error.code).toBe(-32601);
    expect(res.id).toBe(1);
  });

  it("rejects unknown tools with -32602", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "nope", arguments: {} });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("nope");
  });
});

describe("tools/list", () => {
  it("lists all CLI-mirroring tools with object schemas", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/list");
    // oxlint-disable-next-line no-explicit-any
    const tools = res.result.tools as Array<any>;
    expect(tools.map((t) => t.name)).toEqual([
      "gallery_create",
      "gallery_get",
      "gallery_add",
      "gallery_link",
      "gallery_find_by_reference",
      "put",
      "attach",
      "list",
      "delete",
      "usage",
      "reconcile",
      "purge_expired",
      "comment",
      "health",
      "doctor",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
  });
});

describe("gallery tool workflow", () => {
  it("creates, adds, links, and finds with current versions and canonical URLs", async () => {
    const state = galleryFactory();
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test" },
      tools: createUploadsMcpTools({
        globals: { apiUrl: "https://api.test", token: "up_alpha_test" },
        runner: noRun,
        clientFactory: state.factory,
      }),
    });

    const created = await rpc(server, "tools/call", {
      name: "gallery_create",
      arguments: { title: "Launch media", workspace: "alpha" },
    });
    const id = created.result.structuredContent.id as string;
    expect(created.result.structuredContent.url).toBe("https://uploads.test/g/gal_stateful");

    const added = await rpc(server, "tools/call", {
      name: "gallery_add",
      arguments: { galleryId: id, objectKey: "screenshots/launch.png", workspace: "alpha" },
    });
    expect(added.result.structuredContent).toMatchObject({
      objectKey: "screenshots/launch.png",
      url: "https://storage.uploads.sh/alpha/screenshots/launch.png",
    });

    const linked = await rpc(server, "tools/call", {
      name: "gallery_link",
      arguments: {
        galleryId: id,
        provider: "github",
        coordinate: "buildinternet/uploads#57",
        workspace: "alpha",
      },
    });
    expect(linked.result.structuredContent.canonicalUrl).toBe(
      "https://github.com/buildinternet/uploads/issues/57",
    );

    const found = await rpc(server, "tools/call", {
      name: "gallery_find_by_reference",
      arguments: {
        provider: "github",
        coordinate: "buildinternet/uploads#57",
        workspace: "alpha",
      },
    });
    expect(found.result.structuredContent).toMatchObject({
      galleries: [{ id, url: "https://uploads.test/g/gal_stateful", version: 3 }],
      nextCursor: null,
    });
    expect(state.calls).toEqual([
      { method: "add", expectedVersion: 1 },
      { method: "link", expectedVersion: 2 },
    ]);
    expect(state.configs.map((config) => config.workspace)).toEqual([
      "alpha",
      "alpha",
      "alpha",
      "alpha",
    ]);
  });
});

describe("tools/call put", () => {
  it("uploads contentBase64 with an explicit key and returns url + markdown", async () => {
    const { server, puts } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: {
        contentBase64: PNG_B64,
        filename: "shot.png",
        key: "screenshots/x/shot.png",
        contentType: "image/png",
        noGit: true,
      },
    });
    expect(res.result.isError).toBe(false);
    expect(puts).toEqual([
      { key: "screenshots/x/shot.png", filename: "shot.png", contentType: "image/png" },
    ]);
    expect(res.result.structuredContent.url).toBe("https://x.test/screenshots/x/shot.png");
    expect(res.result.structuredContent.markdown).toBe(
      "![shot.png](https://x.test/screenshots/x/shot.png)",
    );
    expect(res.result.content[0].text).toContain("https://x.test/screenshots/x/shot.png");
  });

  it("uses a stable pr key and syncs the managed comment", async () => {
    const { run, calls } = ghRunner();
    const { server, puts } = serverWith({ runner: run });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: {
        contentBase64: PNG_B64,
        filename: "after.png",
        pr: 123,
        repo: "o/r",
        comment: true,
      },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].key).toBe("gh/o/r/pull/123/after.png");
    expect(res.result.structuredContent.comment).toEqual({ action: "created", count: 1 });
    expect(calls.some((call) => call.includes("repos/o/r/issues/123/comments"))).toBe(true);
  });

  it("rejects pr together with issue as a tool error", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "a.png", pr: 1, issue: 2, repo: "o/r" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("mutually exclusive");
  });

  it("requires exactly one of file and contentBase64", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "put", arguments: {} });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("file or contentBase64");
  });
});

describe("tools/call attach", () => {
  it("infers the current PR and uploads stable keys with markdown", async () => {
    const { run, calls } = ghRunner();
    const { server, puts } = serverWith({ runner: run });
    // In-memory content isn't supported for attach; use a real temp file.
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const file = join(dir, "before.png");
    writeFileSync(file, "png");

    const res = await rpc(server, "tools/call", { name: "attach", arguments: { files: [file] } });
    expect(res.result.isError).toBe(false);
    expect(puts[0].key).toBe("gh/buildinternet/uploads/pull/123/before.png");
    expect(res.result.structuredContent.target).toEqual({
      repo: "buildinternet/uploads",
      kind: "pull",
      num: 123,
    });
    expect(res.result.structuredContent.uploads[0].markdown).toContain("before.png");
    expect(res.result.structuredContent.comment).toEqual({ action: "created", count: 1 });
    expect(calls.some((call) => call[1] === "pr" && call[2] === "view")).toBe(true);
  });

  it("rejects an empty files array", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "attach", arguments: { files: [] } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("files");
  });
});

describe("tools/call list, delete, comment", () => {
  it("lists a pr's attachments via the gh key prefix", async () => {
    const { server, puts } = serverWith();
    puts.push({ key: "gh/o/r/pull/9/shot.png", filename: "shot.png" });
    puts.push({ key: "other/key.png", filename: "key.png" });
    const res = await rpc(server, "tools/call", {
      name: "list",
      arguments: { pr: 9, repo: "o/r" },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.items).toEqual([
      { key: "gh/o/r/pull/9/shot.png", url: "https://x.test/gh/o/r/pull/9/shot.png" },
    ]);
  });

  it("rejects prefix combined with pr", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "list",
      arguments: { prefix: "x/", pr: 9, repo: "o/r" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("prefix cannot be combined");
  });

  it("deletes by key and honors dryRun", async () => {
    const { server, deletes } = serverWith();
    const dry = await rpc(server, "tools/call", {
      name: "delete",
      arguments: { key: "a/b.png", dryRun: true },
    });
    expect(dry.result.structuredContent).toEqual({ key: "a/b.png", deleted: false, dryRun: true });
    // Dry run must not reach the client at all.
    expect(deletes).toEqual([]);
    const res = await rpc(server, "tools/call", { name: "delete", arguments: { key: "a/b.png" } });
    expect(res.result.structuredContent).toEqual({ key: "a/b.png", deleted: true });
    // The real delete forwards exactly the requested key, once.
    expect(deletes).toEqual(["a/b.png"]);
  });

  it("rejects delete without a key as a tool error", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "delete", arguments: {} });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("key");
  });

  it("comment requires pr or issue and reports the sync result", async () => {
    const { run } = ghRunner();
    const { server, puts } = serverWith({ runner: run });
    puts.push({ key: "gh/o/r/issues/45/log.txt", filename: "log.txt" });
    const missing = await rpc(server, "tools/call", { name: "comment", arguments: {} });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain("pr or issue");

    const res = await rpc(server, "tools/call", {
      name: "comment",
      arguments: { issue: 45, repo: "o/r" },
    });
    expect(res.result.structuredContent).toEqual({
      repo: "o/r",
      kind: "issues",
      num: 45,
      action: "created",
      count: 1,
    });
  });
});

describe("config resolution", () => {
  it("surfaces a missing token as a tool error, not a server failure", async () => {
    vi.stubEnv("UPLOADS_TOKEN", "");
    const { server } = serverWith({ globals: { apiUrl: "https://x.test" } });
    const res = await rpc(server, "tools/call", { name: "list", arguments: {} });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("UPLOADS_TOKEN");
    expect(res.result.content[0].text).toContain("MISSING_TOKEN");
  });

  it("health works without a token", async () => {
    vi.stubEnv("UPLOADS_TOKEN", "");
    const { server } = serverWith({ globals: { apiUrl: "https://x.test" } });
    const res = await rpc(server, "tools/call", { name: "health", arguments: {} });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toEqual({ ok: true, apiUrl: "https://x.test" });
  });

  it("a per-call workspace argument overrides the globals", async () => {
    const { server, configs } = serverWith();
    await rpc(server, "tools/call", {
      name: "list",
      arguments: { workspace: "acme" },
    });
    expect(configs[0].workspace).toBe("acme");
    expect(configs[0].apiUrl).toBe("https://x.test");
  });
});
