# SVG/XML active content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept `image/svg+xml`, `application/xml`, and `text/xml` uploads on a storage lane only while that lane's public host is verified to serve them with a sandboxing CSP and `nosniff`.

**Architecture:** One probe (`checkActiveContentHeaders`) verifies a public host. It runs inside the existing BYO lane verify and stamps the lane; a daily cron runs it against the hosted hosts and stamps a KV host record. `activeContentAllowed(env, ws)` combines a fail-closed Flagship flag, a workspace opt-out, and the lane stamp. `resolveUploadPolicy` strips gated rows from every allowlist (including overrides) unless the gate passes. The three types are declared-only rows with their own plausibility predicate plus a reputation pre-filter; the CSP is the control.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, KV (`REGISTRY`), Flagship (`FLAGS`), vitest, Astro settings page.

**Spec:** `docs/superpowers/specs/2026-09-02-svg-xml-active-content-design.md`

## Global Constraints

- Branch `claude/issue-929-svg-xml` in worktree `/Users/zachdunn/Code/uploads/.claude/worktrees/svg-xml-929`, stacked on `claude/issue-925-planning-13dccd` (PR #928). Do not rebase onto main until #928 merges.
- Gated types, exactly: `image/svg+xml`, `application/xml`, `text/xml`. HTML stays out.
- Probe acceptance: CSP has a `sandbox` directive with neither `allow-scripts` nor `allow-same-origin`; `X-Content-Type-Options: nosniff` present; response `Content-Type` starts with `image/svg+xml`. Fetch uses `redirect: "manual"` and the existing 5 s timeout; a thrown fetch is `inconclusive` and never enables.
- Freshness: hosted host record ≤ 48 h; BYO lane stamp ≤ 30 days and no `storageUnhealthyAt`.
- Flag name `active-content-uploads`, fail-closed exactly like `POSTER_FLAG`.
- Gated types are declared-only (never sniffed). A `.log` starting with `<?xml` stays `text/plain`.
- Every `resolveUploadPolicy` caller passes the gate result; an `allowedContentTypes` override cannot bypass it.
- Probe objects live under `_internal/uploads-csp-verify/` and are deleted in `finally`.
- Commit messages: no attribution lines. `pnpm run check` before each commit; the hook runs `pnpm types`.

---

### Task 1: CSP parser and the header probe

**Files:**

- Modify: `apps/api/src/storage-verify.ts` (new exports after `checkEmbedCache`; wire into `verifyStorageConfig` after the public-url branch)
- Test: `apps/api/src/storage-verify.test.ts` (find the existing test file for this module; if it is under `apps/api/test/`, add there)

**Interfaces:**

- Produces: `parseSandboxCsp(header: string | null): { ok: boolean; reason?: string }`, `ACTIVE_CONTENT_PROBE_SVG: Uint8Array`, `checkActiveContentHeaders(publicBaseUrl: string, probeKey: string, fetchImpl: typeof fetch): Promise<StorageVerifyCheck>` with `id: "active-content-headers"`, `required: false`. `StorageVerifyCheck.id` doc comment lists the new id.

- [ ] **Step 1: Write the failing tests**

```ts
describe("parseSandboxCsp", () => {
  it("accepts the recommended policy, extra directives, and bare sandbox", () => {
    expect(
      parseSandboxCsp("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox").ok,
    ).toBe(true);
    expect(parseSandboxCsp("sandbox; frame-ancestors 'none'").ok).toBe(true);
    expect(parseSandboxCsp("sandbox").ok).toBe(true);
    expect(parseSandboxCsp("SANDBOX allow-forms").ok).toBe(true);
  });
  it("rejects a missing header, a policy without sandbox, or a sandbox that re-enables script or origin", () => {
    expect(parseSandboxCsp(null)).toMatchObject({ ok: false });
    expect(parseSandboxCsp("default-src 'none'")).toMatchObject({ ok: false });
    expect(parseSandboxCsp("sandbox allow-scripts")).toMatchObject({ ok: false });
    expect(parseSandboxCsp("sandbox allow-same-origin allow-forms")).toMatchObject({ ok: false });
  });
});

describe("checkActiveContentHeaders", () => {
  const good = () =>
    new Response(ACTIVE_CONTENT_PROBE_SVG, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  it("passes when type, csp, and nosniff are all right", async () => {
    const check = await checkActiveContentHeaders(
      "https://cdn.example",
      "_internal/x.svg",
      async () => good(),
    );
    expect(check).toEqual({ id: "active-content-headers", ok: true, required: false });
  });
  it("fails on a rewritten content type, a missing csp, or a missing nosniff, naming the header", async () => {
    const without = (h: string) => async () => {
      const res = good();
      const headers = new Headers(res.headers);
      headers.delete(h);
      return new Response(ACTIVE_CONTENT_PROBE_SVG, { status: 200, headers });
    };
    for (const h of ["content-security-policy", "x-content-type-options"]) {
      const check = await checkActiveContentHeaders("https://cdn.example", "k.svg", without(h));
      expect(check.ok).toBe(false);
      expect(check.hint).toContain(h);
    }
    const typed = await checkActiveContentHeaders(
      "https://cdn.example",
      "k.svg",
      async () =>
        new Response("x", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
          },
        }),
    );
    expect(typed.ok).toBe(false);
  });
  it("is inconclusive when the fetch throws", async () => {
    const check = await checkActiveContentHeaders("https://cdn.example", "k.svg", async () => {
      throw new Error("boom");
    });
    expect(check).toMatchObject({ ok: false, inconclusive: true });
  });
});
```

Also assert in the existing `verifyStorageConfig` tests that a candidate whose public-url check passes now carries an `active-content-headers` check (ok or not), and one whose public-url fails does not.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @uploads/api test storage-verify`

- [ ] **Step 3: Implement**

```ts
/** A 1×1 inert SVG; what the active-content probe writes and fetches. */
export const ACTIVE_CONTENT_PROBE_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
);

/**
 * Does a Content-Security-Policy sandbox the document? The `sandbox`
 * directive puts the document in an opaque origin with script disabled;
 * `allow-scripts` and `allow-same-origin` each undo the part we rely on.
 * Any other directives are the host owner's business.
 */
export function parseSandboxCsp(header: string | null): { ok: boolean; reason?: string } {
  if (!header) return { ok: false, reason: "missing Content-Security-Policy" };
  const sandbox = header
    .split(";")
    .map((d) => d.trim().toLowerCase())
    .find((d) => d === "sandbox" || d.startsWith("sandbox "));
  if (!sandbox) return { ok: false, reason: "Content-Security-Policy has no sandbox directive" };
  const tokens = new Set(sandbox.split(/\s+/).slice(1));
  if (tokens.has("allow-scripts")) return { ok: false, reason: "sandbox allows scripts" };
  if (tokens.has("allow-same-origin")) return { ok: false, reason: "sandbox allows same-origin" };
  return { ok: true };
}

const ACTIVE_CONTENT_HINT =
  "serve SVG/XML with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox` and `X-Content-Type-Options: nosniff` on this host, then check again";

/** Recommended check: the public host serves SVG sandboxed. Never required; gates SVG/XML acceptance per lane. */
export async function checkActiveContentHeaders(
  publicBaseUrl: string,
  probeKey: string,
  fetchImpl: typeof fetch,
): Promise<StorageVerifyCheck> {
  const id = "active-content-headers";
  const url = `${publicBaseUrl.replace(/\/$/, "")}/${probeKey}`;
  try {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PUBLIC_URL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok)
      return {
        id,
        ok: false,
        required: false,
        hint: `fetching the SVG probe returned HTTP ${res.status} — ${ACTIVE_CONTENT_HINT}`,
      };
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("image/svg+xml"))
      return {
        id,
        ok: false,
        required: false,
        hint: `the host served the SVG probe as ${type || "no content-type"} instead of image/svg+xml — ${ACTIVE_CONTENT_HINT}`,
      };
    const csp = parseSandboxCsp(res.headers.get("content-security-policy"));
    if (!csp.ok)
      return {
        id,
        ok: false,
        required: false,
        hint: `${csp.reason} (content-security-policy) — ${ACTIVE_CONTENT_HINT}`,
      };
    if ((res.headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff")
      return {
        id,
        ok: false,
        required: false,
        hint: `missing x-content-type-options: nosniff — ${ACTIVE_CONTENT_HINT}`,
      };
    return { id, ok: true, required: false };
  } catch {
    return {
      id,
      ok: false,
      required: false,
      inconclusive: true,
      hint: "we couldn't fetch the SVG probe from here (Cloudflare-fronted domains are often unreachable as a server-side request); SVG/XML stay off for this lane until a check succeeds",
    };
  }
}
```

Wire-up in `verifyStorageConfig`: inside the round-trip `try`, after `publicUrlCheck` is set and `ok`, upload `ACTIVE_CONTENT_PROBE_SVG` to `${PROBE_PREFIX}${crypto.randomUUID()}.svg` with `contentType: "image/svg+xml"`, run `checkActiveContentHeaders`, store the result, delete the SVG probe in the same `finally` (best-effort). Push the check right after the `embed-cache` check.

- [ ] **Step 4: Run to verify pass**, then `pnpm run check`.
- [ ] **Step 5: Commit** — `feat(api): probe a public host for a sandboxing CSP on SVG`

### Task 2: Lane and workspace state

**Files:**

- Modify: `apps/api/src/workspace.ts` (`StorageLane.activeContentVerifiedAt?`, `WorkspaceRecord.storageActiveContentVerifiedAt?`, `WorkspaceRecord.activeContentUploads?: boolean` with a doc comment mirroring `videoPosterEnabled`)
- Modify: `apps/api/src/workspace-lanes.ts` (`demoteActiveLane` copies `storageActiveContentVerifiedAt` → `activeContentVerifiedAt`; `promoteLane` takes it back; `PromotableLane` type if needed)
- Modify: `apps/api/src/routes/workspace-settings.ts` (`storagePutHandler`: set `lane.activeContentVerifiedAt = nowIso` when the verify result has `active-content-headers` ok, else leave unset; `storageActivateHandler`: when re-verify ran, derive the stamp the same way and pass it to `promoteLane`; when it did not run, carry `target.activeContentVerifiedAt`)
- Modify: `apps/api/src/routes/workspace-storage.ts` (`StorageLaneStatus.activeContentVerifiedAt?`, active-lane status field of the same name in `storageStatusResponse`)
- Test: `apps/api/src/workspace-lanes.test.ts`, the storage settings route tests

**Interfaces:**

- Produces: `activeContentStampFromVerify(result: StorageVerifyResult, nowIso: string): string | undefined` exported from `workspace-storage.ts` (ok check → `nowIso`, else `undefined`).

- [ ] Steps: tests for demote/promote round-trip of the stamp; PUT saves the stamp only when the check passed; activate carries or refreshes it; status response exposes it. Implement, run `pnpm --filter @uploads/api test workspace-lanes workspace-settings workspace-storage`, commit `feat(api): stamp lanes with the active-content verification`.

### Task 3: Hosted host sweep and admin probe

**Files:**

- Create: `apps/api/src/active-content-hosts.ts`
- Modify: `apps/api/src/index.ts` (`scheduled`: one more `ctx.waitUntil(runActiveContentHostSweep(env).catch(...))` logging `active_content_sweep_failed`)
- Modify: `apps/api/src/routes/admin-ui.ts` (`.post("/active-content/probe", ...)` → runs the sweep, returns the host records)
- Test: `apps/api/src/active-content-hosts.test.ts`

**Interfaces:**

- Produces:

```ts
export interface HostActiveContentRecord {
  ok: boolean;
  verifiedAt: string;
  detail?: string;
}
export function hostActiveContentKey(host: string): string; // `host-active-content:${host}`
export const HOSTED_ACTIVE_CONTENT_HOSTS: readonly string[]; // ["storage.uploads.sh", "store.uploads.sh", "embed.uploads.sh"], overridable via env for self-host (read EMBED_PUBLIC_BASE_URL / the self-serve default publicBaseUrl if present)
export async function probeHostActiveContent(
  env: Env,
  host: string,
  fetchImpl?: typeof fetch,
): Promise<HostActiveContentRecord>;
export async function runActiveContentHostSweep(
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<Record<string, HostActiveContentRecord>>;
export async function readHostActiveContent(
  env: Env,
  host: string,
): Promise<HostActiveContentRecord | null>;
```

- `probeHostActiveContent` writes `ACTIVE_CONTENT_PROBE_SVG` to `env.UPLOADS_DEFAULT` at `_internal/uploads-csp-verify/<uuid>.svg` with `httpMetadata: { contentType: "image/svg+xml" }`, calls `checkActiveContentHeaders(`https://${host}`, key, fetchImpl)`, deletes the object in `finally`, and `REGISTRY.put`s the record (no TTL; freshness is judged by the reader).

- [ ] Steps: tests with a fake `UPLOADS_DEFAULT` (put/delete spy) and fake `REGISTRY`; ok and failing probes both write a record; the sweep covers every host and never throws for one host's failure. Commit `feat(api): probe the hosted storage hosts for the SVG sandbox headers daily`.

### Task 4: The gate

**Files:**

- Create: `apps/api/src/active-content.ts`
- Test: `apps/api/src/active-content.test.ts` (model on `poster-gate.test.ts`)

```ts
export const ACTIVE_CONTENT_FLAG = "active-content-uploads";
export const HOST_RECORD_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const LANE_STAMP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function activeContentAllowed(
  env: Env,
  ws: WorkspaceRecord,
  now = new Date(),
): Promise<boolean> {
  if (ws.activeContentUploads === false) return false;
  if (!env.FLAGS) return false;
  try {
    if (!(await env.FLAGS.getBooleanValue(ACTIVE_CONTENT_FLAG, false))) return false;
  } catch {
    return false;
  }
  if (ws.storageUnhealthyAt) return false;
  if (isSharedLane(ws)) {
    const host = hostOf(ws.publicBaseUrl);
    if (!host) return false;
    const record = await readHostActiveContent(env, host);
    return !!record && record.ok && fresh(record.verifiedAt, HOST_RECORD_MAX_AGE_MS, now);
  }
  return fresh(ws.storageActiveContentVerifiedAt, LANE_STAMP_MAX_AGE_MS, now);
}
```

- [ ] Steps: tests for opt-out, missing flag, flag off, thrown flag, unhealthy, shared fresh/stale/missing/not-ok, BYO fresh/stale/missing. Commit `feat(api): activeContentAllowed gate`.

### Task 5: Guards, pre-filter, and caller wiring

**Files:**

- Modify: `apps/api/src/guards.ts`
- Modify: `apps/api/src/files-core.ts` (`putObject`: `const policy = resolveUploadPolicy(ws, { activeContent: await activeContentAllowed(env, ws) })`)
- Modify: `apps/api/src/routes/files-shared-handlers.ts` (presign + PUT: same)
- Modify: `apps/api/src/github-ingest.ts`, `apps/mcp/src/tools.ts` (ceiling only; pass `{ activeContent: false }` there since the ceiling does not depend on it)
- Test: `apps/api/test/guards.test.ts`, `apps/api/test/routes-files.test.ts`

**Interfaces:**

- `UploadTypeRow` gains `gate?: "active-content"` and `plausible?: (bytes: Uint8Array) => boolean` (declared rows only; text rows use `looksLikeText`).
- `resolveUploadPolicy(record, opts: { activeContent: boolean })` — second argument required so no caller forgets it.
- `export function containsActiveMarkup(text: string): boolean` — `/<script|\bon[a-z]+\s*=|javascript:|<foreignobject|<\?xml-stylesheet/i`.
- `export function looksLikeSvg(bytes: Uint8Array): boolean` — `looksLikeText` and, in the first 4 KiB decoded, after stripping a BOM, `<?xml … ?>`, `<!-- … -->`, and `<!DOCTYPE …>` prefixes, the text starts with `<svg`.
- `export function looksLikeXml(bytes: Uint8Array): boolean` — `looksLikeText` and first non-whitespace char is `<`.
- SVG/XML rows' `plausible` = the above AND `!containsActiveMarkup(decodedHead)` where the decoded text is the whole body (they are small; `maxBytes` still applies).
- `DEFAULT_ALLOWED_CONTENT_TYPES` stays the ungated list (so existing tests and docs are unchanged); add `GATED_CONTENT_TYPES`.

- [ ] Tests: gated rows absent by default; present with `activeContent: true`; an override `["image/png","image/svg+xml"]` yields only png without the gate; `inspectUpload` with declared `image/svg+xml`: inert SVG ok (with and without prolog/comment), SVG with `<script>` 415, `<html>` 415, PNG bytes declared svg → stored png; declared `application/xml` with `<?xml…` ok; `.log` key + `<?xml` body + declared text/plain → text/plain; route test: PUT `.svg` 415 on an unverified workspace, 201 with `FLAGS` on + fake host record fresh; presign `image/svg+xml` mirrors that.
- [ ] Commit `feat(api): accept SVG and XML only on lanes verified for active content`.

### Task 6: On-demand lane check route

**Files:**

- Modify: `apps/api/src/routes/workspace-settings.ts` — `.post("/:workspace/storage/lanes/:laneId/verify-active-content", sessionAdminGate(), ...)`; `laneId` may be the active lane's `storageLaneId` or the literal `active`. Runs only the probe (upload SVG probe through the lane's storage client, `checkActiveContentHeaders`, delete), then `mutateWorkspaceRecord` to set or clear the stamp, returns `{ check, status }`. Rate-limited with `allowWrite`.
- Test: route test for ok (stamp set), fail (stamp cleared), inconclusive (stamp unchanged).
- [ ] Commit `feat(api): on-demand active-content check per lane`.

### Task 7: Web

**Files:**

- Modify: `apps/web/src/lib/public-file.ts` (`fileKind("image/svg+xml") → "image"`; remove `unsupported` from `MediaKind` if nothing else produces it — grep `public-gallery.ts` and `MediaStage.astro`), `apps/web/src/components/MediaStage.astro` (drop the branch), tests.
- Modify: `apps/web/src/lib/api-client.ts` — `verifyLaneActiveContent(apiOrigin, workspace, laneId)` next to `activateWorkspaceStorage`.
- Modify: `apps/web/src/pages/account/workspaces/[name]/settings/storage.astro` — in `buildStorageRows`, add a row `["SVG & XML", …]` reading `activeContentVerifiedAt`: "Verified <date>" or "Not verified — set the headers below"; under the BYO lane card a small `<details>` with the two header lines and a "Check now" button wired like the activate button but calling the new client function and re-applying status. The hosted lane row reads the same field from the status response (the API fills it from the host record for shared lanes).
- [ ] Commit `feat(web): show and re-check SVG/XML readiness per storage lane`.

### Task 8: CLI, docs, ops

**Files:**

- `packages/comment-render/src/index.ts` map: `xml: "application/xml"`; regenerate; `.changeset/svg-xml-active-content.md` (`"@buildinternet/uploads": minor`).
- `docs/ops.md`: new subsection "SVG and XML on the hosted hosts" with the Transform Rule: When `(http.host in {"storage.uploads.sh" "store.uploads.sh" "embed.uploads.sh"}) and (any(http.response.headers["content-type"][*] matches "^(image/svg\\+xml|application/xml|text/xml)"))` → set `Content-Security-Policy` and `X-Content-Type-Options`; the daily sweep and `POST /admin/active-content/probe`; the flag name.
- `apps/web/src/content/docs/byo-bucket.mdx`: "### 5. Optional: serve SVG and XML" with the header values, the check-now button, and the 30-day re-check.
- `apps/web/src/content/docs/limits.mdx`: SVG/XML "on lanes verified for sandboxed serving".
- [ ] Commit `docs: SVG and XML behind a verified sandboxing CSP`.

### Task 9: Verification and PR

- `pnpm run check && pnpm types && pnpm test`.
- Open a PR against `claude/issue-925-planning-13dccd` marked draft until #928 merges, then rebase onto main and retarget. Body: link #929, list the decisions, and the prod checklist from the spec's Testing section.
