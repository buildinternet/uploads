import { NotFoundError, UnauthorizedError } from "@uploads/errors";
import { Hono } from "hono";
import type { Files } from "@uploads/storage";
import { badKey, downloadResponse } from "../files-core";
import { getFileMetadata } from "../file-metadata";
import { objectPublicUrls, storage, storageConfig } from "../storage";
import { objectVisibility } from "../visibility";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";

type GithubKind = "pull" | "issue";

interface GithubContext {
  repo: string;
  kind: GithubKind;
  number: number;
  url: string;
}

// Deliberately permissive (not the full GitHub owner/repo charset) — this only
// gates the derived convenience object; malformed input just falls back to
// leaving the raw `gh.*` pairs in `metadata` (see task-5 brief).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

/**
 * Derives the `github` convenience object from `gh.repo`/`gh.kind`/`gh.number`
 * when all three are present and valid. Any missing or malformed piece omits
 * the object entirely — the raw pairs still flow through in `metadata`.
 */
function deriveGithubContext(metadata: Record<string, string>): GithubContext | undefined {
  const repo = metadata["gh.repo"];
  const kind = metadata["gh.kind"];
  const numberRaw = metadata["gh.number"];
  if (!repo || !kind || !numberRaw) return undefined;
  if (kind !== "pull" && kind !== "issue") return undefined;
  if (!REPO_RE.test(repo)) return undefined;
  if (!POSITIVE_INT_RE.test(numberRaw)) return undefined;
  const number = Number(numberRaw);
  if (!Number.isSafeInteger(number)) return undefined;

  const path = kind === "pull" ? "pull" : "issues";
  return { repo, kind, number, url: `https://github.com/${repo}/${path}/${number}` };
}

interface ResolvedPublicObject {
  store: Files;
  meta: { size?: number; type?: string; lastModified?: number; metadata?: Record<string, string> };
  urls: { url: string | null; embedUrl: string | null };
}

/**
 * Shared lookup + visibility gate for the `/public/files/:workspace/:key*` GET
 * handler below: workspace record → publicUrl existence → store.exists/head →
 * objectVisibility 401. Both the JSON-metadata response and the `?download=1`
 * streaming branch call this exact same gate (run once per request) so the
 * two can never disagree about who gets to see — or download — an object.
 */
async function resolvePublicObject(
  env: Env,
  workspace: string,
  key: string,
): Promise<ResolvedPublicObject> {
  if (badKey(key)) throw new NotFoundError();

  // Validates the workspace name (WS_NAME_RE) before the KV lookup, matching the
  // authenticated paths rather than trusting the raw path param.
  const record = await loadWorkspaceRecord(env, workspace);
  if (!record) throw new NotFoundError();

  // Phase 1 is public-workspace-only: resolving the public URL doubles as the
  // visibility gate. A workspace without a public base URL cannot be wrapped
  // here — that is #123's signed-URL territory, swapped in when it lands.
  const cfg = await storageConfig(env, record);
  const urls = objectPublicUrls(env, cfg, key);
  if (!urls.url) throw new NotFoundError();

  const store = await storage(env, record);
  if (!(await store.exists(key))) throw new NotFoundError();
  const meta = await store.head(key);

  if (objectVisibility(meta.metadata ?? undefined)) {
    throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
  }

  return { store, meta, urls };
}

/**
 * Public, unauthenticated metadata for a single object, so `apps/web` (which has
 * no storage bindings) can render a chrome-wrapped file page at
 * `uploads.sh/f/<workspace>/<key>` (issue #135).
 *
 * Security posture mirrors public galleries: exact-key lookup only, no listing,
 * no bearer token in the browser. It adds no new *access* — the bytes are already
 * served unsigned off the R2 public domain — only a curated metadata view. Raw
 * provenance (R2 custom metadata: client, content-sha256, …) is deliberately
 * omitted here (unlike the authenticated HEAD). Queryable `file_metadata` (D1)
 * is a separate, intentionally-public tier — see `file-metadata.ts` — and is
 * included below (with a `github` object derived from any `gh.*` pairs), since
 * it follows the object's own visibility rather than authenticated-only access.
 *
 * `visibility: "private"` (#139) gates this JSON endpoint with 401 `auth_required`.
 * NOTE this is metadata-only enforcement: on a workspace with `publicBaseUrl`, the
 * raw object bytes remain reachable unsigned straight off that public domain — this
 * route never controlled byte access, only this curated view. Real privacy for a
 * "private" object requires a workspace with no `publicBaseUrl` (signed URLs only),
 * which is out of scope for this endpoint.
 *
 * `?download=1` (task 3) switches the response from JSON to a streamed
 * `Content-Disposition: attachment` body via `downloadResponse` — a query
 * flag rather than a `/download` suffix route, because a static suffix after
 * the greedy `:key{.+}` param is inherently ambiguous (a request for
 * `.../screenshots/download` could mean the suffix OR an object literally
 * named `screenshots/download`; see the `?metadata=1` precedent in
 * routes/files.ts for the same reasoning). The gate above runs exactly once
 * either way — this is purely a "stream vs json" branch on the same
 * resolved object.
 */
export const publicFiles = new Hono<WorkspaceVars>().get("/:workspace/:key{.+}", async (c) => {
  const workspace = c.req.param("workspace");
  const key = c.req.param("key");
  const { store, meta, urls } = await resolvePublicObject(c.env, workspace, key);

  const downloadParam = c.req.query("download");
  if (downloadParam === "1" || downloadParam === "true") {
    const filename = key.split("/").filter(Boolean).pop() ?? key;
    return downloadResponse(store, key, filename);
  }

  // Fetched only after the visibility gate above — a private object 401s
  // before this D1 read ever happens, so metadata never leaks.
  const metadata = await getFileMetadata(c.env.DB, workspace, key);
  const github = deriveGithubContext(metadata);

  return c.json({
    workspace,
    key,
    url: urls.url,
    embedUrl: urls.embedUrl,
    size: meta.size ?? 0,
    contentType: meta.type ?? "application/octet-stream",
    ...(meta.lastModified != null ? { uploaded: new Date(meta.lastModified).toISOString() } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(github ? { github } : {}),
  });
});
