/**
 * Shape coverage for `public/.well-known/integrations.json`.
 *
 * integrations.sh silently ignores a declaration that fails to parse or match
 * the v3 shape — there is no error surface to notice. A typo would just make
 * uploads.sh look like it has no integration surfaces at all, so the invariants
 * that would fail silently in production are asserted here instead:
 *
 *   - it is strict JSON at version 3;
 *   - every credential referenced by a surface's auth exists in `credentials`;
 *   - every `basis.source` points at this document's own canonical URL;
 *   - declared surfaces stay in sync with what the repo actually ships
 *     (no GraphQL, MCP is streamable-http only — see apps/mcp/src/index.ts).
 *
 * The `/openapi.json` case guards the other half of the discovery change:
 * src/pages/openapi.json.ts re-serves the canonical `.well-known` spec, so the
 * two paths must never diverge.
 */
import { describe, expect, it } from "vitest";
import manifest from "../public/.well-known/integrations.json";
import canonicalSpec from "../public/.well-known/openapi.json";
import { GET } from "./pages/openapi.json";

const CANONICAL_SOURCE = "https://uploads.sh/.well-known/integrations.json";

type Basis = { via: string; source: string };
type Mechanics = Record<string, unknown> & { source: string };
type AuthEntry = { use: { id: string; mechanics: Mechanics }[]; basis: Basis };
type Surface = {
  type: string;
  slug: string;
  name: string;
  docs?: string;
  basis: Basis;
  auth: { status: string; entries?: AuthEntry[]; basis?: Basis };
  [key: string]: unknown;
};

const surfaces = manifest.surfaces as unknown as Surface[];
const credentials = manifest.credentials as unknown as Record<
  string,
  { type: string; setup: string }
>;

/** Every `basis` object anywhere in the document, surface- and auth-level alike. */
function allBases(): Basis[] {
  const found: Basis[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.via === "string" && typeof record.source === "string") {
      found.push(record as unknown as Basis);
    }
    Object.values(record).forEach(walk);
  };
  walk(manifest);
  return found;
}

describe("integrations.json (v3)", () => {
  it("declares version 3 with a summary", () => {
    expect(manifest.version).toBe(3);
    expect(manifest.summary).toBeTruthy();
  });

  it("references only credentials defined in the top-level map", () => {
    const declared = Object.keys(credentials);
    expect(declared.length).toBeGreaterThan(0);
    const referenced = surfaces.flatMap((surface) =>
      (surface.auth.entries ?? []).flatMap((entry) => entry.use.map((use) => use.id)),
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(declared).toContain(id);
    }
    // No orphans either — an unreferenced credential is dead weight agents act on.
    for (const id of declared) {
      expect(referenced).toContain(id);
    }
  });

  it("gives every credential a label and setup instructions", () => {
    for (const [id, credential] of Object.entries(credentials)) {
      expect(credential.type, id).toBeTruthy();
      expect(credential.setup, id).toBeTruthy();
    }
  });

  it("points every basis at this document's canonical URL", () => {
    const bases = allBases();
    // 3 surfaces + 4 auth entries.
    expect(bases).toHaveLength(7);
    for (const basis of bases) {
      expect(basis.via).toBe("declared");
      expect(basis.source).toBe(CANONICAL_SOURCE);
    }
  });

  it("declares each auth entry with concrete mechanics", () => {
    for (const surface of surfaces) {
      expect(surface.auth.status, surface.slug).toBe("required");
      for (const entry of surface.auth.entries ?? []) {
        expect(entry.use.length, surface.slug).toBeGreaterThan(0);
        for (const use of entry.use) {
          expect(use.mechanics.source, surface.slug).not.toBe("unknown");
        }
      }
    }
  });

  it("declares the three surfaces this repo actually ships", () => {
    expect(surfaces.map((s) => `${s.type}:${s.slug}`)).toEqual([
      "http:uploads-api",
      "mcp:uploads-mcp",
      "cli:uploads-cli",
    ]);
  });

  it("advertises the API base URL and spec the OpenAPI document agrees with", () => {
    const api = surfaces.find((s) => s.type === "http")!;
    expect(api.url).toBe(canonicalSpec.servers[0].url);
    expect(api.spec).toBe("https://uploads.sh/openapi.json");
  });

  it("advertises the hosted MCP endpoint as streamable-http only", () => {
    const mcp = surfaces.find((s) => s.type === "mcp")!;
    expect(mcp.url).toBe("https://agents.uploads.sh/mcp");
    // apps/mcp is stateless with no SSE stream — see apps/mcp/src/index.ts.
    expect(mcp.transports).toEqual(["streamable-http"]);
    // Workspace bearer OR OAuth: two alternatives, not one AND'd pair.
    expect(mcp.auth.entries).toHaveLength(2);
  });

  it("advertises the published CLI binary and npm package", () => {
    const cli = surfaces.find((s) => s.type === "cli")!;
    expect(cli.command).toBe("uploads");
    expect(cli.packages).toEqual([
      { registryType: "npm", identifier: "@buildinternet/uploads", runtimeHint: "npx" },
    ]);
  });
});

describe("/openapi.json", () => {
  it("serves the canonical .well-known spec verbatim", async () => {
    const response = await GET({} as Parameters<typeof GET>[0]);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual(canonicalSpec);
  });
});
