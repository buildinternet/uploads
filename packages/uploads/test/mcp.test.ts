import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalFlags } from "../src/cli-args.js";
import type {
  AddGalleryItemOptions,
  CreateGalleryOptions,
  GithubRepoLinkResult,
  LinkGalleryExternalReferenceOptions,
  ListItem,
  UploadsClient,
} from "../src/client.js";
import type { UploadsClientConfig } from "../src/config.js";
import type { CommandRunner } from "../src/github-gh.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createUploadsMcpTools } from "../src/mcp/tools.js";
import {
  legacyFetch,
  legacyRpc,
  modernFetch,
  modernNotification,
  modernRequest,
  rpc,
  validator,
} from "./mcp-harness.js";

/** Fake client factory capturing every resolved config and put()/delete() call. */
function fakeFactory() {
  const puts: Array<{
    key?: string;
    filename: string;
    contentType?: string;
    metadata?: Record<string, string>;
  }> = [];
  const deletes: string[] = [];
  const configs: UploadsClientConfig[] = [];
  const findCalls: Array<{
    filters: Record<string, string>;
    prefix?: string;
    limit?: number;
    name?: string;
    cursor?: string;
    all?: boolean;
  }> = [];
  const facetCalls: Array<{ kind: "keys" } | { kind: "values"; key: string }> = [];
  // Keyed by object key, mirroring the server's per-key metadata rows well
  // enough to exercise set_metadata/find_files wiring without a real API.
  const metadataStore = new Map<string, Record<string, string>>();
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
        opts: {
          filename: string;
          key?: string;
          contentType?: string;
          metadata?: Record<string, string>;
        },
      ) => {
        // Record the effective key, so list()'s prefix filter (and key
        // assertions) see what a real client would have stored.
        const key = opts.key ?? "generated/key.png";
        puts.push({
          key,
          filename: opts.filename,
          contentType: opts.contentType,
          metadata: opts.metadata,
        });
        if (opts.metadata !== undefined) metadataStore.set(key, opts.metadata);
        return {
          workspace: config.workspace,
          key,
          url: `https://x.test/${key}`,
          embedUrl: null,
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
      usage: async () => ({
        workspace: config.workspace,
        bytes: 0,
        objects: 0,
        uploadsInPeriod: 0,
        periodStart: "",
        updatedAt: "",
        scopes: ["files:read", "files:write"] as const,
      }),
      getMetadata: async (key: string) => ({ metadata: metadataStore.get(key) ?? {} }),
      patchMetadata: async (
        key: string,
        opts: { set?: Record<string, string>; delete?: string[] },
      ) => {
        const current = { ...metadataStore.get(key) };
        for (const k of opts.delete ?? []) delete current[k];
        Object.assign(current, opts.set ?? {});
        metadataStore.set(key, current);
        return { metadata: current };
      },
      findFiles: async (
        filters: Record<string, string> = {},
        opts: { prefix?: string; limit?: number; name?: string } = {},
      ) => {
        findCalls.push({ filters, ...opts });
        const items = [...metadataStore.entries()]
          .filter(([key, meta]) => {
            if (opts.prefix && !key.startsWith(opts.prefix)) return false;
            if (opts.name && !key.toLowerCase().includes(opts.name.toLowerCase())) return false;
            return Object.entries(filters).every(([k, v]) => meta[k] === v);
          })
          .slice(0, opts.limit ?? 50)
          .map(([key, meta]) => ({ key, url: `https://x.test/${key}`, metadata: meta }));
        return { items, cursor: null, truncated: opts.name ? false : undefined };
      },
      findFilesAll: async (
        filters: Record<string, string> = {},
        opts: { prefix?: string; limit?: number; name?: string; cursor?: string } = {},
      ) => {
        findCalls.push({ filters, ...opts, all: true });
        return { items: [], cursor: null, truncated: false };
      },
      listMetadataKeys: async () => {
        facetCalls.push({ kind: "keys" });
        return {
          keys: [{ key: "app", count: 2, distinctValues: 1 }],
          truncated: false,
        };
      },
      listMetadataValues: async (key: string) => {
        facetCalls.push({ kind: "values", key });
        return {
          key,
          values: [{ value: "web", count: 2 }],
          truncated: false,
        };
      },
    } as unknown as UploadsClient;
  };
  return { factory, puts, deletes, configs, metadataStore, findCalls, facetCalls };
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

/**
 * `opts.title` set → the gh.title lookup (`pr|issue view <num> --json title`)
 * resolves it; unset → it throws, same as gh being unable to resolve a title
 * (the default for every existing test in this file, so none of them see an
 * unexpected gh.title show up in their metadata assertions).
 */
function ghRunner(opts: { title?: string } = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if ((args[0] === "pr" || args[0] === "issue") && args[1] === "view" && args.includes("title")) {
      if (opts.title !== undefined) return `${opts.title}\n`;
      throw new Error("gh: title not resolvable");
    }
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

/** Answers only `git config --get remote.origin.url`; anything else throws,
 * so staging/gh auto-resolution stay out of the picture and only the
 * derived-`repo` wiring is under test. */
function repoOnlyRunner(originUrl: string): CommandRunner {
  return (cmd, args) => {
    if (cmd === "git" && args[0] === "config") return `${originUrl}\n`;
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

/**
 * Fake gh/git runner for the bare-put branch-staging trigger (issue #403),
 * mirroring `stagingRunner` in commands-put.test.ts for the MCP `put` tool.
 */
function branchStagingRunner(opts: {
  branch?: string;
  defaultBranch?: string;
  originUrl?: string;
  repo?: string;
}): CommandRunner {
  return (cmd, args) => {
    if (cmd === "git" && args[0] === "config") {
      if (opts.originUrl === undefined) throw new Error("not a git repo");
      return `${opts.originUrl}\n`;
    }
    if (cmd === "git" && args[0] === "rev-parse") {
      if (opts.branch === undefined) throw new Error("detached HEAD");
      return `${opts.branch}\n`;
    }
    if (cmd === "git" && args[0] === "symbolic-ref") {
      if (opts.defaultBranch === undefined) throw new Error("no origin/HEAD");
      return `origin/${opts.defaultBranch}\n`;
    }
    if (cmd === "gh" && args[0] === "repo") {
      if (opts.repo === undefined) throw new Error("gh unauthenticated");
      return `${opts.repo}\n`;
    }
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

function serverWith(overrides?: {
  globals?: GlobalFlags;
  runner?: CommandRunner;
  factory?: (config: UploadsClientConfig) => UploadsClient;
}) {
  const { factory, puts, deletes, configs, metadataStore, findCalls, facetCalls } = fakeFactory();
  const server = createMcpServer({
    serverInfo: { name: "uploads", version: "0.0.0-test" },
    validator,
    tools: createUploadsMcpTools({
      globals: overrides?.globals ?? { apiUrl: "https://x.test", token: "up_test_x" },
      runner: overrides?.runner ?? noRun,
      clientFactory: overrides?.factory ?? factory,
    }),
  });
  return { server, puts, deletes, configs, metadataStore, findCalls, facetCalls };
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
  vi.unstubAllGlobals();
});

describe("createMcpServer protocol — 2025-era (legacy) clients", () => {
  it("echoes a supported protocol version on initialize", async () => {
    const { server } = serverWith();
    const res = await legacyRpc(server, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo).toEqual({ name: "uploads", version: "0.0.0-test" });
  });

  it("falls back to the newest supported revision for unknown versions", async () => {
    const { server } = serverWith();
    const res = await legacyRpc(server, "initialize", {
      protocolVersion: "1999-01-01",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    // The SDK negotiates down to the newest revision it can serve on the
    // legacy leg, which is 2025-11-25 — not the 2025-06-18 our hand-rolled
    // core used to pin.
    expect(res.result.protocolVersion).toBe("2025-11-25");
  });

  it("answers legacy calls as plain JSON, never SSE", async () => {
    const { server } = serverWith();
    const res = await legacyFetch(
      server,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { result: unknown }).result).toEqual({});
  });

  it("still answers ping, which 2026-07-28 removed", async () => {
    const { server } = serverWith();
    expect((await legacyRpc(server, "ping")).result).toEqual({});
  });

  it("returns no JSON-RPC reply for notifications", async () => {
    const { server } = serverWith();
    const res = await legacyFetch(
      server,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("createMcpServer protocol", () => {
  it("returns no response for notifications", async () => {
    const { server } = serverWith();
    const res = await modernFetch(
      server,
      modernNotification("notifications/cancelled", { requestId: 1 }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("rejects malformed JSON with -32700", async () => {
    const { server } = serverWith();
    const req = modernRequest("tools/list");
    const res = await modernFetch(server, new Request(req, { body: "{nope", method: "POST" }));
    const body = (await res.json()) as { error: { code: number }; id: unknown };
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it("rejects arrays (batching removed from MCP) with -32600", async () => {
    const { server } = serverWith();
    const req = modernRequest("tools/list");
    const res = await modernFetch(server, new Request(req, { body: "[]", method: "POST" }));
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("rejects a request missing the required Mcp-Method header with 400", async () => {
    const { server } = serverWith();
    const req = modernRequest("tools/list");
    const headers = new Headers(req.headers);
    headers.delete("mcp-method");
    const res = await modernFetch(
      server,
      new Request(req.url, { method: "POST", headers, body: await req.text() }),
    );
    expect(res.status).toBe(400);
  });

  it("carries the spec's cache hints and resultType on tools/list", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/list");
    expect(res.result.resultType).toBe("complete");
    expect(res.result.ttlMs).toBe(3_600_000);
    expect(res.result.cacheScope).toBe("private");
  });

  it("implements server/discover", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "server/discover");
    expect(res.result.supportedVersions).toContain("2026-07-28");
    expect(res.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "uploads",
      version: "0.0.0-test",
    });
  });

  it("echoes serverInfo.icons on initialize and server/discover", async () => {
    const { factory } = fakeFactory();
    const icons = [
      {
        src: "https://uploads.sh/apple-touch-icon.png",
        mimeType: "image/png",
        sizes: ["180x180"],
      },
    ];
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test", icons },
      validator,
      tools: createUploadsMcpTools({
        globals: { apiUrl: "https://x.test", token: "up_test_x" },
        runner: noRun,
        clientFactory: factory,
      }),
    });
    const init = await legacyRpc(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result.serverInfo.icons).toEqual(icons);
    const discover = await rpc(server, "server/discover");
    expect(discover.result._meta["io.modelcontextprotocol/serverInfo"].icons).toEqual(icons);
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
      "screenshot",
      "attach",
      "list",
      "staged",
      "delete",
      "get_metadata",
      "set_metadata",
      "find_files",
      "list_metadata_keys",
      "usage",
      "reconcile",
      "purge_expired",
      "comment",
      "whoami",
      "doctor",
      "report",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(typeof tool.inputSchema.properties).toBe("object");
      expect(tool.annotations).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      if (tool.outputSchema) {
        expect(tool.outputSchema.type, `${tool.name} outputSchema`).toBe("object");
      }
      expect(tool._meta.securitySchemes).toEqual([
        expect.objectContaining({ type: expect.stringMatching(/^(oauth2|noauth)$/) }),
      ]);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.delete.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.put.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.reconcile.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.delete._meta.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["files:delete"] },
    ]);
    expect(byName.list._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["files:read"] }]);
    expect(byName.whoami._meta.securitySchemes).toEqual([{ type: "noauth" }]);
  });

  it("advertises inputSchema examples on the complex tools", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/list");
    const byName = Object.fromEntries(
      (res.result.tools as Array<{ name: string; inputSchema: { examples?: unknown } }>).map(
        (t) => [t.name, t],
      ),
    );
    for (const name of ["put", "screenshot", "attach", "find_files", "comment", "set_metadata"]) {
      const examples = byName[name]?.inputSchema.examples;
      expect(Array.isArray(examples), `${name} examples`).toBe(true);
      expect((examples as unknown[]).length, `${name} examples`).toBeGreaterThan(0);
    }
  });
});

describe("gallery tool workflow", () => {
  it("creates, adds, links, and finds with current versions and canonical URLs", async () => {
    const state = galleryFactory();
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test" },
      validator,
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
    expect(res.result.structuredContent.comment).toEqual({
      action: "created",
      count: 1,
      via: "gh",
    });
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

  it("requires exactly one of file, files, contentBase64, or contentUrl", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "put", arguments: {} });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("file, files, contentBase64, or contentUrl");
  });

  it("uploads from a loopback contentUrl", async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PNG, { status: 200 })),
    );
    const { server, puts } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: {
        contentUrl: "http://127.0.0.1:4321/shot.png",
        key: "screenshots/x/shot.png",
        noGit: true,
      },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].filename).toBe("shot.png");
  });

  it("uploads from contentUrl", async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PNG, { status: 200 })),
    );
    const { server, puts } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: {
        contentUrl: "https://cdn.example/shot.png",
        key: "screenshots/x/shot.png",
        noGit: true,
      },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].filename).toBe("shot.png");
    expect(puts[0].key).toBe("screenshots/x/shot.png");
  });

  it("requires filename when contentUrl has no path leaf", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentUrl: "https://cdn.example/", noGit: true },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/no filename/);
  });

  it("uploads multiple files in parallel and returns uploads + failures", async () => {
    const { UploadsError } = await import("../src/errors.js");
    const { server } = serverWith({
      factory: () =>
        ({
          put: async (_body: Uint8Array, opts: { key: string; filename: string }) => {
            if (opts.filename === "bad.png") {
              throw new UploadsError("forced fail", "API_ERROR", 500);
            }
            return {
              workspace: "test",
              key: opts.key ?? `generated/${opts.filename}`,
              url: `https://x.test/${opts.filename}`,
              embedUrl: null,
              size: 3,
              contentType: "image/png",
            };
          },
          listAll: async () => [],
          findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
          getGallery: async () => ({ items: [] }),
        }) as never,
    });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-put-"));
    const good = join(dir, "good.png");
    const bad = join(dir, "bad.png");
    writeFileSync(good, "png");
    writeFileSync(bad, "png");

    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { files: [good, bad], noGit: true },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.uploads).toHaveLength(1);
    expect(res.result.structuredContent.failures).toHaveLength(1);
    expect(res.result.structuredContent.failures[0].file).toContain("bad.png");
  });

  it("surfaces all failures with isError when every multi-file put fails", async () => {
    const { UploadsError } = await import("../src/errors.js");
    const { server } = serverWith({
      factory: () =>
        ({
          put: async () => {
            throw new UploadsError("forced fail", "API_ERROR", 500);
          },
        }) as never,
    });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-put-"));
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    writeFileSync(a, "png");
    writeFileSync(b, "png");

    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { files: [a, b], noGit: true },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.uploads).toEqual([]);
    expect(res.result.structuredContent.failures).toHaveLength(2);
    expect(res.result.content[0].text).toContain("a.png");
    expect(res.result.content[0].text).toContain("b.png");
  });

  it("passes custom metadata through to the client", async () => {
    const { server, puts } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: {
        contentBase64: PNG_B64,
        filename: "shot.png",
        key: "tagged/shot.png",
        metadata: { app: "myapp", page: "settings" },
      },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].metadata).toEqual({ app: "myapp", page: "settings" });
  });

  it("leaves metadata undefined (untouched) when the argument is omitted", async () => {
    const { server, puts } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png", key: "plain/shot.png" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].metadata).toBeUndefined();
  });

  it("rejects an invalid metadata key as a tool error", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: {
        contentBase64: PNG_B64,
        filename: "shot.png",
        key: "bad/shot.png",
        metadata: { "Bad-Key": "x" },
      },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("invalid metadata key");
  });

  describe("derived repo metadata (spec: 2026-08-11-screenshots-project-grouping)", () => {
    it("folds derived repo into explicitly-supplied metadata", async () => {
      const { server, puts } = serverWith({
        runner: repoOnlyRunner("git@github.com:Acme/Web.git"),
      });
      const res = await rpc(server, "tools/call", {
        name: "put",
        arguments: {
          contentBase64: PNG_B64,
          filename: "shot.png",
          key: "tagged/shot.png",
          metadata: { app: "myapp" },
        },
      });
      expect(res.result.isError).toBe(false);
      expect(puts[0].metadata).toEqual({ app: "myapp", repo: "acme/web" });
    });

    // Critical regression guard: metadataProp's contract is "omit means leave
    // stored metadata untouched; a defined object (even {}) fully replaces
    // it". A derivable repo must never turn an omitted `metadata` argument
    // into a defined object — that would silently wipe everything already
    // stored on a bare re-upload of an existing key.
    it("does NOT synthesize a metadata object just to add repo when metadata is omitted", async () => {
      const { server, puts } = serverWith({
        runner: repoOnlyRunner("git@github.com:Acme/Web.git"),
      });
      const res = await rpc(server, "tools/call", {
        name: "put",
        arguments: { contentBase64: PNG_B64, filename: "shot.png", key: "plain/shot.png" },
      });
      expect(res.result.isError).toBe(false);
      expect(puts[0].metadata).toBeUndefined();
    });

    it("suppresses derived repo with noGit even when metadata is supplied", async () => {
      const { server, puts } = serverWith();
      const res = await rpc(server, "tools/call", {
        name: "put",
        arguments: {
          contentBase64: PNG_B64,
          filename: "shot.png",
          key: "tagged/shot.png",
          metadata: { app: "myapp" },
          noGit: true,
        },
      });
      expect(res.result.isError).toBe(false);
      expect(puts[0].metadata).toEqual({ app: "myapp" });
    });
  });
});

describe("tools/call put branch staging (issue #403)", () => {
  const staged = {
    branch: "feature/thing",
    defaultBranch: "main",
    originUrl: "git@github.com:o/r.git",
    repo: "o/r",
  };

  it("stages a bare put on a non-default branch with detectable git context", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].key).toBe("gh/o/r/branch/feature-thing/shot.png");
  });

  it("does not stage with an explicit destination — regression test for the destination-ignored bug", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png", destination: "screenshots" },
    });
    expect(res.result.isError).toBe(false);
    // No explicit key was given, so the fake client falls back to its
    // default — the key must NOT be the branch-staged key that
    // `ghBranchTarget` would otherwise silently win with.
    expect(puts[0].key).toBe("generated/key.png");
  });

  it("does not stage with an explicit prefix", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png", prefix: "custom" },
    });
    expect(res.result.isError).toBe(false);
    // No explicit key was given, so the fake client falls back to its
    // default — the key must NOT be the branch-staged key that
    // `ghBranchTarget` would otherwise silently win with.
    expect(puts[0].key).toBe("generated/key.png");
  });

  it("does not stage on the default branch", async () => {
    const { server, puts } = serverWith({
      runner: branchStagingRunner({ ...staged, branch: "main" }),
    });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png" },
    });
    expect(res.result.isError).toBe(false);
    // No explicit key was given, so the fake client falls back to its
    // default — the key must NOT be the branch-staged key that
    // `ghBranchTarget` would otherwise silently win with.
    expect(puts[0].key).toBe("generated/key.png");
  });

  it("does not stage with noGit", async () => {
    const { server, puts } = serverWith({ runner: noRun });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png", noGit: true },
    });
    expect(res.result.isError).toBe(false);
    // No explicit key was given, so the fake client falls back to its
    // default — the key must NOT be the branch-staged key that
    // `ghBranchTarget` would otherwise silently win with.
    expect(puts[0].key).toBe("generated/key.png");
  });
});

/** branchStagingRunner + a `gh pr view <branch>` stub for the #700 auto-PR lookup. */
function autoPrRunner(opts: {
  branch?: string;
  defaultBranch?: string;
  originUrl?: string;
  repo?: string;
  pr?: number;
}): CommandRunner {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      if (opts.pr === undefined) throw new Error("no pull request found");
      return `${opts.pr}\n`;
    }
    return branchStagingRunner(opts)(cmd, args);
  };
}

describe("tools/call put auto-PR context (issue #700)", () => {
  const withPr = {
    branch: "feature/thing",
    defaultBranch: "main",
    originUrl: "git@github.com:o/r.git",
    repo: "o/r",
    pr: 1250,
  };

  it("behaves as if pr had been passed when the branch maps to exactly one open PR", async () => {
    const { server, puts } = serverWith({ runner: autoPrRunner(withPr) });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].key).toBe("gh/o/r/pull/1250/shot.png");
    expect(res.result.structuredContent.hint).toContain("branch maps to open PR #1250");
  });

  it("opts out with noPr, falling back to branch staging", async () => {
    const { server, puts } = serverWith({ runner: autoPrRunner(withPr) });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png", noPr: true },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].key).toBe("gh/o/r/branch/feature-thing/shot.png");
  });

  it("never fires when an explicit destination is set", async () => {
    const { server, puts } = serverWith({ runner: autoPrRunner(withPr) });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png", destination: "screenshots" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].key).toBe("generated/key.png");
  });

  it("falls back to staging when there is no open PR for the branch", async () => {
    const { server, puts } = serverWith({ runner: autoPrRunner({ ...withPr, pr: undefined }) });
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { contentBase64: PNG_B64, filename: "shot.png" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0].key).toBe("gh/o/r/branch/feature-thing/shot.png");
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
    expect(res.result.structuredContent.failures).toEqual([]);
    expect(res.result.structuredContent.comment).toEqual({
      action: "created",
      count: 1,
      via: "gh",
    });
    expect(calls.some((call) => call[1] === "pr" && call[2] === "view")).toBe(true);
  });

  it("uploads multiple files and reports per-file failures without aborting the batch", async () => {
    const { run } = ghRunner();
    const { UploadsError } = await import("../src/errors.js");
    const putCalls: string[] = [];
    const { server } = serverWith({
      runner: run,
      factory: () =>
        ({
          put: async (_body: Uint8Array, opts: { key: string; filename: string }) => {
            putCalls.push(opts.key);
            if (opts.filename === "bad.png") {
              throw new UploadsError("forced fail", "API_ERROR", 500);
            }
            return {
              workspace: "test",
              key: opts.key,
              url: `https://x.test/${opts.key}`,
              embedUrl: null,
              size: 3,
              contentType: "image/png",
            };
          },
          listAll: async () => [],
          findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
          getGallery: async () => ({ items: [] }),
        }) as never,
    });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const good = join(dir, "good.png");
    const bad = join(dir, "bad.png");
    writeFileSync(good, "png");
    writeFileSync(bad, "png");

    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [good, bad], noComment: true },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.uploads).toHaveLength(1);
    expect(res.result.structuredContent.uploads[0].key).toContain("good.png");
    expect(res.result.structuredContent.failures).toHaveLength(1);
    expect(res.result.structuredContent.failures[0].file).toContain("bad.png");
    expect(putCalls.some((k) => k.includes("good.png"))).toBe(true);
  });

  it("on total multi-file failure returns isError with every failure in structuredContent", async () => {
    const { run } = ghRunner();
    const { UploadsError } = await import("../src/errors.js");
    const { server } = serverWith({
      runner: run,
      factory: () =>
        ({
          put: async () => {
            throw new UploadsError("forced fail", "API_ERROR", 500);
          },
          listAll: async () => [],
          findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
          getGallery: async () => ({ items: [] }),
        }) as never,
    });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    writeFileSync(a, "png");
    writeFileSync(b, "png");

    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [a, b], noComment: true },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.uploads).toEqual([]);
    expect(res.result.structuredContent.failures).toHaveLength(2);
    expect(res.result.structuredContent.failures[0].file).toContain("a.png");
    expect(res.result.content[0].text).toContain("a.png");
    expect(res.result.content[0].text).toContain("b.png");
  });

  it("rejects an empty files array", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "attach", arguments: { files: [] } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("files");
  });

  it("auto-injects gh.* metadata, merged with user extras", async () => {
    const { run } = ghRunner();
    const { server, puts } = serverWith({ runner: run });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const file = join(dir, "before.png");
    writeFileSync(file, "png");

    await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [file], metadata: { app: "myapp" } },
    });
    expect(puts[0].metadata).toEqual({
      app: "myapp",
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "123",
      "gh.ref": "buildinternet/uploads#123",
    });
  });

  it("a gh.* metadata extra loses to the resolved target's own value", async () => {
    const { run } = ghRunner();
    const { server, puts } = serverWith({ runner: run });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const file = join(dir, "before.png");
    writeFileSync(file, "png");

    await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [file], metadata: { "gh.repo": "someone/else" } },
    });
    expect(puts[0].metadata?.["gh.repo"]).toBe("buildinternet/uploads");
  });

  it("rejects when 22 extras + the 4 automatic gh.* pairs exceed the 24-key cap", async () => {
    const { run } = ghRunner();
    const { server, puts } = serverWith({ runner: run });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const file = join(dir, "before.png");
    writeFileSync(file, "png");

    const metadata: Record<string, string> = {};
    for (let i = 0; i < 22; i++) metadata[`k${i}`] = "v";

    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [file], metadata },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("too many");
    expect(puts.length).toBe(0);
  });

  it("stamps gh.title (issue #267) when the resolved PR title is available", async () => {
    const { run } = ghRunner({ title: "Fix the login bug" });
    const { server, puts } = serverWith({ runner: run });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const file = join(dir, "before.png");
    writeFileSync(file, "png");

    await rpc(server, "tools/call", { name: "attach", arguments: { files: [file] } });
    expect(puts[0].metadata).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "123",
      "gh.ref": "buildinternet/uploads#123",
      "gh.title": "Fix the login bug",
    });
  });

  it("omits gh.title (and does not fail the upload) when the title can't be resolved", async () => {
    const { run } = ghRunner(); // no opts.title → gh title lookup throws
    const { server, puts } = serverWith({ runner: run });
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const file = join(dir, "before.png");
    writeFileSync(file, "png");

    const res = await rpc(server, "tools/call", { name: "attach", arguments: { files: [file] } });
    expect(res.result.isError).toBe(false);
    expect(puts[0].metadata).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "123",
      "gh.ref": "buildinternet/uploads#123",
    });
  });
});

describe("tools/call attach promote (issue #920)", () => {
  /** gh/git runner with a controllable current branch and reflog. */
  function promoteRunner(
    opts: {
      branch?: string;
      detached?: boolean;
      renames?: Array<{ from: string; to: string }>;
    } = {},
  ): CommandRunner {
    const branch = opts.detached ? "HEAD" : (opts.branch ?? "feat-c");
    return (cmd, args) => {
      if (cmd === "git" && args[0] === "reflog") {
        return [...(opts.renames ?? [])]
          .reverse()
          .map((step) => `Branch: renamed refs/heads/${step.from} to refs/heads/${step.to}`)
          .join("\n");
      }
      if (cmd === "git" && args[0] === "rev-parse") return `${branch}\n`;
      if (args[0] === "repo") return "buildinternet/uploads\n";
      if ((args[0] === "pr" || args[0] === "issue") && args[1] === "view" && args.includes("title"))
        throw new Error("gh: title not resolvable");
      if (args[0] === "pr" && args[1] === "view") return "123\n";
      if (args[1]?.includes("per_page=100")) return "[]";
      return JSON.stringify({ id: 9 });
    };
  }

  /** Client that records promote + rename registrations. */
  function promoteFactory(opts: { promoteFails?: boolean } = {}) {
    const promoteCalls: Array<{ repo: string; num: number; branch: string }> = [];
    const renameCalls: Array<{ repo: string; from: string; to: string }> = [];
    const factory = (): UploadsClient =>
      ({
        put: async (_body: Uint8Array, putOpts: { key: string }) => ({
          workspace: "test",
          key: putOpts.key,
          url: `https://x.test/${putOpts.key}`,
          embedUrl: null,
          size: 3,
          contentType: "image/png",
        }),
        list: async () => ({ items: [], cursor: null }),
        listAll: async () => [],
        findGalleriesByReference: async () => ({ galleries: [], nextCursor: null }),
        getGallery: async () => ({ items: [] }),
        registerBranchRename: async (renameOpts: { repo: string; from: string; to: string }) => {
          renameCalls.push(renameOpts);
          return { recorded: true };
        },
        promoteBranchAttachments: async (promoteOpts: {
          repo: string;
          num: number;
          branch: string;
        }) => {
          promoteCalls.push(promoteOpts);
          if (opts.promoteFails) throw new Error("promote unavailable");
          return { promoted: [`gh/buildinternet/uploads/pull/123/staged.png`], skipped: [] };
        },
      }) as unknown as UploadsClient;
    return { factory, promoteCalls, renameCalls };
  }

  function tempFile(name = "shot.png"): string {
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-test-"));
    const file = join(dir, name);
    writeFileSync(file, "png");
    return file;
  }

  it("registers renames then promotes the current branch, reporting `promotion`", async () => {
    const { factory, promoteCalls, renameCalls } = promoteFactory();
    const { server } = serverWith({
      runner: promoteRunner({ renames: [{ from: "feat-b", to: "feat-c" }] }),
      factory,
    });
    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [tempFile()], noComment: true },
    });
    expect(res.result.isError).toBe(false);
    expect(renameCalls).toEqual([{ repo: "buildinternet/uploads", from: "feat-b", to: "feat-c" }]);
    expect(promoteCalls).toEqual([{ repo: "buildinternet/uploads", num: 123, branch: "feat-c" }]);
    expect(res.result.structuredContent.promotion).toEqual({
      promoted: ["gh/buildinternet/uploads/pull/123/staged.png"],
      skipped: [],
    });
  });

  it("reports promoteError without failing the attach", async () => {
    const { factory } = promoteFactory({ promoteFails: true });
    const { server } = serverWith({ runner: promoteRunner(), factory });
    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [tempFile()], noComment: true },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.uploads).toHaveLength(1);
    expect(res.result.structuredContent.promotion).toBeUndefined();
    expect(res.result.structuredContent.promoteError).toContain("promote unavailable");
  });

  it("fromBranch promotes the named branch and registers no renames", async () => {
    const { factory, promoteCalls, renameCalls } = promoteFactory();
    const { server } = serverWith({
      runner: promoteRunner({ renames: [{ from: "feat-b", to: "feat-c" }] }),
      factory,
    });
    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [tempFile()], noComment: true, fromBranch: "old/name" },
    });
    expect(res.result.isError).toBe(false);
    expect(renameCalls).toEqual([]);
    expect(promoteCalls).toEqual([{ repo: "buildinternet/uploads", num: 123, branch: "old/name" }]);
  });

  it("noPromote skips promotion entirely", async () => {
    const { factory, promoteCalls, renameCalls } = promoteFactory();
    const { server } = serverWith({
      runner: promoteRunner({ renames: [{ from: "feat-b", to: "feat-c" }] }),
      factory,
    });
    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [tempFile()], noComment: true, noPromote: true },
    });
    expect(res.result.isError).toBe(false);
    expect(promoteCalls).toEqual([]);
    expect(renameCalls).toEqual([]);
    expect(res.result.structuredContent.promotion).toBeUndefined();
  });

  it("rejects fromBranch combined with noPromote", async () => {
    const { factory } = promoteFactory();
    const { server } = serverWith({ runner: promoteRunner(), factory });
    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [tempFile()], fromBranch: "old", noPromote: true },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("noPromote");
  });

  it("never promotes for an issue target", async () => {
    const { factory, promoteCalls } = promoteFactory();
    const { server } = serverWith({ runner: promoteRunner(), factory });
    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [tempFile()], issue: 45, repo: "o/r", noComment: true },
    });
    expect(res.result.isError).toBe(false);
    expect(promoteCalls).toEqual([]);
  });

  it("skips promotion on a detached HEAD", async () => {
    const { factory, promoteCalls } = promoteFactory();
    const { server } = serverWith({ runner: promoteRunner({ detached: true }), factory });
    const res = await rpc(server, "tools/call", {
      name: "attach",
      arguments: { files: [tempFile()], pr: 123, repo: "buildinternet/uploads", noComment: true },
    });
    expect(res.result.isError).toBe(false);
    expect(promoteCalls).toEqual([]);
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

  it("lists every active private prefix, not just the currently-resolved one (issue #631)", async () => {
    const PREFIX_ID = "0123456789abcdef0123456789abcdef";
    const OTHER_PREFIX_ID = "fedcba9876543210fedcba9876543210";
    const PLAIN_PREFIX = "gh/o/r/pull/9/";
    const PRIVATE_PREFIX = `gh/private/${PREFIX_ID}/pull/9/`;
    const OTHER_PRIVATE_PREFIX = `gh/private/${OTHER_PREFIX_ID}/pull/9/`;
    const items: Record<string, { key: string; url: string }[]> = {
      [PLAIN_PREFIX]: [],
      [PRIVATE_PREFIX]: [
        { key: `${PRIVATE_PREFIX}current.png`, url: "https://x.test/current.png" },
      ],
      [OTHER_PRIVATE_PREFIX]: [
        { key: `${OTHER_PRIVATE_PREFIX}rotated.png`, url: "https://x.test/rotated.png" },
      ],
    };
    const { server } = serverWith({
      factory: () =>
        ({
          list: async (opts: { prefix?: string } = {}) => ({
            items: items[opts.prefix ?? ""] ?? [],
            cursor: null,
          }),
          listAll: async (opts: { prefix?: string } = {}) => items[opts.prefix ?? ""] ?? [],
          resolveGhPrefix: async () => ({
            mode: "private" as const,
            prefixId: PREFIX_ID,
            activePrefixIds: [PREFIX_ID, OTHER_PREFIX_ID],
          }),
        }) as unknown as UploadsClient,
    });
    const res = await rpc(server, "tools/call", {
      name: "list",
      arguments: { pr: 9, repo: "o/r" },
    });
    expect(res.result.isError).toBe(false);
    expect(
      res.result.structuredContent.items.map((i: { key: string }) => i.key.split("/").pop()).sort(),
    ).toEqual(["current.png", "rotated.png"].sort());
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
      via: "gh",
    });
  });
});

describe("tools/call usage, reconcile, purge_expired (output schema drift)", () => {
  // Regression test for the shipped bug: the two-lane storage work added
  // `sharedBytes`/`sharedObjects`/`storageBudgetBasis` (and the API route
  // separately stamps `scopes`/`plan`/`storage`) to the real GET /v1/usage
  // payload, but `usageResultSchema` in ../src/mcp/output-schemas.ts kept its
  // narrower field list. Because that schema has `additionalProperties:
  // false` and the SDK validates `structuredContent` against it, calling
  // `usage` — or `reconcile`/`purge_expired`, which embed it — failed at
  // runtime with "Invalid structured content" even though the handler ran
  // fine. Returning the FULL real-world shape here (not just the fields the
  // old schema knew about) is the point: a future field the API adds but the
  // schema doesn't will fail this test the same way it failed in production.
  const fullUsage = {
    workspace: "acme",
    bytes: 100,
    objects: 2,
    sharedBytes: 40,
    sharedObjects: 1,
    uploadsInPeriod: 3,
    periodStart: "2026-08-01",
    updatedAt: "2026-08-27T00:00:00.000Z",
    storageBudgetBasis: "shared" as const,
    maxStorageBytes: 1000,
    storageRemainingBytes: 900,
    maxUploadsPerPeriod: 50,
    uploadsRemaining: 47,
    scopes: ["files:read", "files:write"],
    plan: "pro",
    storage: {
      mode: "byo" as const,
      fallbackLanes: 1,
      health: { ok: true },
    },
  };

  function serverWithUsage() {
    return serverWith({
      factory: () =>
        ({
          usage: async () => fullUsage,
          reconcile: async () => ({
            workspace: "acme",
            bytes: 100,
            objects: 2,
            previous: { bytes: 90, objects: 2 },
            changed: true,
            usage: fullUsage,
          }),
          purgeExpired: async () => ({
            workspace: "acme",
            retentionDays: 30,
            cutoff: "2026-07-28T00:00:00.000Z",
            deleted: 1,
            freedBytes: 10,
            keys: ["a.png"],
            keysTruncated: false,
            reconcile: {
              workspace: "acme",
              bytes: 100,
              objects: 2,
              previous: { bytes: 90, objects: 2 },
              changed: true,
              usage: fullUsage,
            },
          }),
        }) as unknown as UploadsClient,
    });
  }

  it("usage validates against the real GET /v1/usage response shape", async () => {
    const { server } = serverWithUsage();
    const res = await rpc(server, "tools/call", { name: "usage", arguments: {} });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toEqual(fullUsage);
  });

  it("reconcile validates when its embedded usage carries the full shape", async () => {
    const { server } = serverWithUsage();
    const res = await rpc(server, "tools/call", { name: "reconcile", arguments: {} });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.usage).toEqual(fullUsage);
  });

  it("purge_expired validates when its nested reconcile.usage carries the full shape", async () => {
    const { server } = serverWithUsage();
    const res = await rpc(server, "tools/call", { name: "purge_expired", arguments: {} });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.reconcile.usage).toEqual(fullUsage);
  });
});

describe("tools/call get_metadata, set_metadata, find_files", () => {
  it("get_metadata returns the map (or empty) and requires key", async () => {
    const { server, metadataStore } = serverWith();
    metadataStore.set("shots/a.png", { app: "myapp", page: "settings" });

    const withMeta = await rpc(server, "tools/call", {
      name: "get_metadata",
      arguments: { key: "shots/a.png" },
    });
    expect(withMeta.result.isError).toBe(false);
    expect(withMeta.result.structuredContent).toEqual({
      metadata: { app: "myapp", page: "settings" },
    });

    const empty = await rpc(server, "tools/call", {
      name: "get_metadata",
      arguments: { key: "shots/empty.png" },
    });
    expect(empty.result.isError).toBe(false);
    expect(empty.result.structuredContent).toEqual({ metadata: {} });

    const missingKey = await rpc(server, "tools/call", {
      name: "get_metadata",
      arguments: {},
    });
    expect(missingKey.result.isError).toBe(true);
    // The SDK validates the tool's JSON Schema before the handler runs, so a
    // missing required argument is reported by schema validation rather than
    // by our own `key is required`.
    expect(missingKey.result.content[0].text).toContain("key");
  });

  it("sets and deletes metadata, returning the merged map", async () => {
    const { server, metadataStore } = serverWith();
    metadataStore.set("shots/a.png", { app: "myapp", page: "old" });

    const res = await rpc(server, "tools/call", {
      name: "set_metadata",
      arguments: {
        key: "shots/a.png",
        set: { page: "settings" },
        delete: ["app"],
      },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toEqual({ metadata: { page: "settings" } });
  });

  it("set wins when a key is both set and deleted", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "set_metadata",
      arguments: { key: "shots/a.png", set: { app: "myapp" }, delete: ["app"] },
    });
    expect(res.result.structuredContent).toEqual({ metadata: { app: "myapp" } });
  });

  it("requires at least one of set or delete", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "set_metadata",
      arguments: { key: "shots/a.png" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("set and/or delete");
  });

  it("rejects an invalid set key as a tool error", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "set_metadata",
      arguments: { key: "shots/a.png", set: { "Bad-Key": "x" } },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("invalid metadata key");
  });

  it("finds objects matching ANDed metadata filters", async () => {
    const { server, metadataStore } = serverWith();
    metadataStore.set("shots/a.png", { app: "myapp", page: "settings" });
    metadataStore.set("shots/b.png", { app: "myapp", page: "home" });

    const res = await rpc(server, "tools/call", {
      name: "find_files",
      arguments: { filters: { app: "myapp", page: "settings" } },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toEqual({
      items: [
        {
          key: "shots/a.png",
          url: "https://x.test/shots/a.png",
          metadata: { app: "myapp", page: "settings" },
        },
      ],
      cursor: null,
    });
  });

  it("requires filters and/or name", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "find_files", arguments: { filters: {} } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/filters|name/);
  });

  it("finds by name alone", async () => {
    const { server, findCalls } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "find_files",
      arguments: { name: "hero" },
    });
    expect(res.result.isError).toBe(false);
    expect(findCalls[0]).toMatchObject({ filters: {}, name: "hero" });
  });

  it("forwards a cursor, and routes `all` through the bounded drain", async () => {
    const { server, findCalls } = serverWith();
    await rpc(server, "tools/call", {
      name: "find_files",
      arguments: { name: "hero", cursor: "c0" },
    });
    expect(findCalls[0]).toMatchObject({ name: "hero", cursor: "c0" });
    expect(findCalls[0].all).toBeUndefined();

    await rpc(server, "tools/call", {
      name: "find_files",
      arguments: { name: "hero", all: true },
    });
    expect(findCalls[1]).toMatchObject({ name: "hero", all: true });
  });

  it("list_metadata_keys returns keys and values shapes", async () => {
    const { server, facetCalls } = serverWith();
    const keys = await rpc(server, "tools/call", {
      name: "list_metadata_keys",
      arguments: {},
    });
    expect(keys.result.isError).toBe(false);
    expect(keys.result.structuredContent).toEqual({
      keys: [{ key: "app", count: 2, distinctValues: 1 }],
      truncated: false,
    });
    expect(facetCalls).toEqual([{ kind: "keys" }]);

    const values = await rpc(server, "tools/call", {
      name: "list_metadata_keys",
      arguments: { key: "app" },
    });
    expect(values.result.isError).toBe(false);
    expect(values.result.structuredContent).toEqual({
      key: "app",
      values: [{ value: "web", count: 2 }],
      truncated: false,
    });
    expect(facetCalls).toEqual([{ kind: "keys" }, { kind: "values", key: "app" }]);
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

  it("whoami works without a token and reports signedIn false", async () => {
    vi.stubEnv("UPLOADS_TOKEN", "");
    const { server } = serverWith({ globals: { apiUrl: "https://x.test" } });
    const res = await rpc(server, "tools/call", { name: "whoami", arguments: {} });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toMatchObject({
      ok: true,
      signedIn: false,
      apiUrl: "https://x.test",
    });
  });

  it("whoami reports workspace and scopes when signed in", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "whoami", arguments: {} });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toMatchObject({
      ok: true,
      signedIn: true,
      scopes: ["files:read", "files:write"],
    });
  });

  it("report rejects short messages", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "report",
      arguments: { message: "hi" },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/too short/i);
  });

  it("report rejects oversized attachments", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "report",
      arguments: {
        message: "log attached is too big",
        attachmentText: "x".repeat(256 * 1024 + 1),
      },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/exceeds/i);
  });

  it("report submits successfully when the intake responds", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, id: "rpt_test", hasAttachment: false }), {
        status: 202,
      })) as typeof fetch;
    try {
      const { server } = serverWith();
      const res = await rpc(server, "tools/call", {
        name: "report",
        arguments: {
          message: "put fails with KEY_POLICY in tests",
          type: "error",
          command: "put",
          errorCode: "KEY_POLICY",
        },
      });
      expect(res.result.isError).toBe(false);
      expect(res.result.structuredContent).toEqual({
        ok: true,
        id: "rpt_test",
        hasAttachment: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
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

describe("canonical metadata vocabulary in tool schemas", () => {
  function toolList() {
    return createUploadsMcpTools({
      globals: { apiUrl: "https://x.test", token: "up_test_x" },
      runner: noRun,
    });
  }

  it("exposes state and app on put, screenshot and attach", () => {
    const tools = toolList();
    for (const name of ["put", "screenshot", "attach"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} tool missing`).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, unknown>;
      expect(props.state, `${name}.state missing`).toBeDefined();
      expect(props.app, `${name}.app missing`).toBeDefined();
    }
  });

  it("constrains state to the canonical enum", () => {
    const put = toolList().find((t) => t.name === "put")!;
    const state = (put.inputSchema.properties as Record<string, { enum?: string[] }>).state;
    expect(state.enum).toEqual(["before", "after", "empty", "error", "loading"]);
  });

  it("no longer suggests non-canonical keys", () => {
    const put = toolList().find((t) => t.name === "put")!;
    const metadata = (put.inputSchema.properties as Record<string, { description: string }>)
      .metadata;
    // `page` and `resolution` were suggested here and are exactly the
    // near-miss spellings the CLI now warns about.
    expect(metadata.description).not.toMatch(/Suggested keys/);
    expect(metadata.description).not.toMatch(/resolution/);
    expect(metadata.description).toMatch(/\bpath\b/);
    // Keep the path cue and omit-vs-replace gotcha; don't dump the key regex
    // and canonical-key list into every tools/list.
    expect(metadata.description.length).toBeLessThan(400);
  });
});

describe("canonical metadata params reach the upload", () => {
  it("put stamps state and app", async () => {
    const { server, puts } = serverWith();
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-canon-"));
    const file = join(dir, "shot.png");
    writeFileSync(file, "png");
    await rpc(server, "tools/call", {
      name: "put",
      arguments: { file, state: "after", app: "web" },
    });
    expect(puts[0]?.metadata?.state).toBe("after");
    expect(puts[0]?.metadata?.app).toBe("web");
  });

  it("put rejects a state outside the enum", async () => {
    const { server, puts } = serverWith();
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-canon-bad-"));
    const file = join(dir, "shot.png");
    writeFileSync(file, "png");
    const res = await rpc(server, "tools/call", {
      name: "put",
      arguments: { file, state: "post" },
    });
    // The advertised `enum` on `state` is enforced by the SDK's schema
    // validation, which runs before the handler — so an out-of-enum value is
    // rejected there rather than by `validateStateValue`, and the CLI's
    // near-miss suggestion ("post" -> "after") does not reach MCP callers.
    // Keeping the enum is the deliberate trade: it steers models to a valid
    // value up front, which beats explaining the mistake afterwards.
    expect(res.result.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("state");
    expect(puts).toHaveLength(0);
  });

  it("state wins over a same-named metadata key", async () => {
    const { server, puts } = serverWith();
    const dir = mkdtempSync(join(tmpdir(), "uploads-mcp-canon-win-"));
    const file = join(dir, "shot.png");
    writeFileSync(file, "png");
    await rpc(server, "tools/call", {
      name: "put",
      arguments: { file, metadata: { state: "before" }, state: "after" },
    });
    expect(puts[0]?.metadata?.state).toBe("after");
  });
});

describe("staged tool (issue #405)", () => {
  function stagedFactory(opts: {
    items?: ListItem[];
    repoLinkStatus?: GithubRepoLinkResult | Error;
  }) {
    const listCalls: { prefix?: string; metadata?: boolean }[] = [];
    const factory = (): UploadsClient =>
      ({
        list: async (listOpts: { prefix?: string; metadata?: boolean }) => {
          listCalls.push(listOpts);
          return { items: opts.items ?? [], cursor: null };
        },
        ...(opts.repoLinkStatus !== undefined
          ? {
              githubRepoLinkStatus: async () => {
                if (opts.repoLinkStatus instanceof Error) throw opts.repoLinkStatus;
                return opts.repoLinkStatus!;
              },
            }
          : {}),
      }) as unknown as UploadsClient;
    return { factory, listCalls };
  }

  function branchRunner(branch = "feature/thing"): CommandRunner {
    return (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") return `${branch}\n`;
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    };
  }

  it("is registered and mirrors the CLI (repo/branch args, files + binding)", async () => {
    const { factory, listCalls } = stagedFactory({
      items: [
        {
          key: "gh/o/r/branch/feature-thing/shot.png",
          url: "https://x.test/shot.png",
          size: 10,
          metadata: { "gh.staged-at": "2026-07-20T10:00:00Z" },
        },
      ],
      repoLinkStatus: { binding: "self" },
    });
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test" },
      validator,
      tools: createUploadsMcpTools({
        globals: { apiUrl: "https://x.test", token: "up_test_x" },
        runner: noRun,
        clientFactory: factory,
      }),
    });
    const res = await rpc(server, "tools/call", {
      name: "staged",
      arguments: { branch: "feature/thing", repo: "o/r" },
    });
    expect(res.result.isError).toBe(false);
    expect(listCalls[0]).toEqual({ prefix: "gh/o/r/branch/feature-thing/", metadata: true });
    expect(res.result.structuredContent).toEqual({
      repo: "o/r",
      branch: "feature/thing",
      files: [
        {
          key: "gh/o/r/branch/feature-thing/shot.png",
          filename: "shot.png",
          size: 10,
          stagedAt: "2026-07-20T10:00:00Z",
          url: "https://x.test/shot.png",
        },
      ],
      binding: {
        state: "self",
        autoAttach: true,
        message: "these auto-attach when this branch's PR opens",
      },
    });
  });

  it("defaults branch to the current git branch when omitted", async () => {
    const { factory, listCalls } = stagedFactory({ repoLinkStatus: { binding: "none" } });
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test" },
      validator,
      tools: createUploadsMcpTools({
        globals: { apiUrl: "https://x.test", token: "up_test_x" },
        runner: branchRunner("main"),
        clientFactory: factory,
      }),
    });
    const res = await rpc(server, "tools/call", {
      name: "staged",
      arguments: { repo: "o/r" },
    });
    expect(res.result.isError).toBe(false);
    expect(listCalls[0]?.prefix).toBe("gh/o/r/branch/main/");
  });

  it("empty staging returns a valid empty files array (never an error, never empty)", async () => {
    const { factory } = stagedFactory({ repoLinkStatus: { binding: "none" } });
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test" },
      validator,
      tools: createUploadsMcpTools({
        globals: { apiUrl: "https://x.test", token: "up_test_x" },
        runner: noRun,
        clientFactory: factory,
      }),
    });
    const res = await rpc(server, "tools/call", {
      name: "staged",
      arguments: { branch: "feature/thing", repo: "o/r" },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.files).toEqual([]);
    expect(res.result.structuredContent.binding.state).toBe("none");
  });

  it("binding degrades to unknown when the lookup route is absent (older server)", async () => {
    const { factory } = stagedFactory({}); // no repoLinkStatus -> method absent
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test" },
      validator,
      tools: createUploadsMcpTools({
        globals: { apiUrl: "https://x.test", token: "up_test_x" },
        runner: noRun,
        clientFactory: factory,
      }),
    });
    const res = await rpc(server, "tools/call", {
      name: "staged",
      arguments: { branch: "feature/thing", repo: "o/r" },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.binding.state).toBe("unknown");
  });
});
