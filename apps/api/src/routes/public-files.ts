import { NotFoundError, UnauthorizedError } from "@uploads/errors";
import { Hono } from "hono";
import {
  ServerTiming,
  serverTimingDisabled,
  slowOpThresholdMs,
  timeOp,
} from "@uploads/observability";
import type { Files, StorageConfig } from "@uploads/storage";
import {
  findCounterpartCandidate,
  isPairableImageContentType,
  type BeforeAfterState,
} from "../before-after";
import { badKey, downloadResponse, publicObjectDateFields } from "../files-core";
import { displayTitle, getFileMetadata, publicFileMetadata } from "../file-metadata";
import { githubAvatarProxyUrl, ownerFromRepo } from "../github-avatars";
import { readCachedPublicTitle, resolveTitles, withPublicTitleBudget } from "../github-titles";
import { videoPresentation } from "../poster";
import { objectPublicUrls, resolveObjectLaneWithHead } from "../storage";
import { isHeld } from "../upload-hold";
import { isKeyHeld } from "../upload-hold-read";
import { objectVisibility } from "../visibility";
import { loadWorkspaceRecord, type WorkspaceRecord, type WorkspaceVars } from "../workspace";
import { requestOrigin } from "../well-known";
import { dbFor } from "../db-session";

type GithubKind = "pull" | "issue";

interface GithubContext {
  repo: string;
  kind: GithubKind;
  number: number;
  url: string;
  /** Attach-time stamp and/or verified-public cache overlay; omitted when unknown. */
  title?: string;
  /** API proxy for the repo owner avatar; omitted when owner is invalid. */
  avatarUrl?: string;
}

// Deliberately permissive (not the full GitHub owner/repo charset) — this only
// gates the derived convenience object; malformed input just falls back to
// leaving the raw `gh.*` pairs in `metadata` (see task-5 brief).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;
/** Lowercased `owner/repo#number` — same shape as CLI `gh.ref` / resolveTitles keys. */
const GH_REF_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+#[1-9][0-9]*$/;

/**
 * Derives the `github` convenience object from `gh.repo`/`gh.kind`/`gh.number`
 * when all three are present and valid. Any missing or malformed piece omits
 * the object entirely — the raw pairs still flow through in `metadata`.
 * Optional `gh.title` becomes `github.title` (live resolve may overwrite later).
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
  const title = displayTitle(metadata["gh.title"]);
  return {
    repo,
    kind,
    number,
    url: `https://github.com/${repo}/${path}/${number}`,
    ...(title ? { title } : {}),
  };
}

/**
 * Cache / resolveTitles key for a derived github context. Prefer stamped
 * `gh.ref` when well-formed (already lowercased by the CLI); else build from
 * repo + number so keys match `ghref:owner/repo#num`.
 */
function githubRefKey(metadata: Record<string, string>, github: GithubContext): string {
  const stamped = metadata["gh.ref"]?.trim().toLowerCase();
  if (stamped && GH_REF_RE.test(stamped)) return stamped;
  return `${github.repo.toLowerCase()}#${github.number}`;
}

/** Cache previews by bytes, while copied/download URLs keep their stable identity. */
function previewUrl(url: string, etag: string | undefined): string {
  if (!etag) return url;
  const versioned = new URL(url);
  versioned.searchParams.set("v", etag);
  return versioned.href;
}

type Measure = <T>(name: string, work: () => Promise<T>) => Promise<T>;

interface ResolvedPublicObject {
  metadata: Record<string, string>;
  store: Files;
  meta: {
    size?: number;
    type?: string;
    etag?: string;
    lastModified?: number;
    metadata?: Record<string, string>;
  };
  urls: { url: string | null; embedUrl: string | null };
  env: Env;
  cfg: StorageConfig;
  /** The workspace record, so a caller resolving a second key (e.g. a before/after counterpart) doesn't repeat the KV lookup. */
  record: WorkspaceRecord;
}

/**
 * Shared lookup + visibility gate for the `/public/files/:workspace/:key*` GET
 * handler below: workspace record → lane resolution → publicUrl existence →
 * objectVisibility 401. Both the JSON-metadata response and the `?download=1`
 * streaming branch call this exact same gate (run once per request) so the
 * two can never disagree about who gets to see — or download — an object.
 *
 * Two-lane storage (spec: "Read path"): `resolveObjectLane` finds whichever
 * lane actually holds the key — a file uploaded before a storage switch keeps
 * resolving from its original lane — and the public URL is derived from that
 * lane's config, not the workspace's current active lane. Single-lane records
 * (no `storageLanes`) need one HEAD call against the active lane. The HEAD
 * result is reused for the visibility gate.
 */
async function resolvePublicObject(
  env: Env,
  workspace: string,
  key: string,
  measure: Measure,
): Promise<ResolvedPublicObject> {
  if (badKey(key)) throw new NotFoundError();

  // Validates the workspace name (WS_NAME_RE) before the KV lookup, matching the
  // authenticated paths rather than trusting the raw path param.
  const record = await measure("file_workspace", () => loadWorkspaceRecord(env, workspace));
  if (!record) throw new NotFoundError();

  const lane = await measure("file_storage", () => resolveObjectLaneWithHead(env, record, key));
  if (!lane) {
    // A moved hold has no object in any lane; its bytes sit in UPLOADS_HELD.
    // Answer like a private file so a member's page can show the hold.
    if (await measure("file_metadata", () => isKeyHeld(env, workspace, key))) {
      throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
    }
    throw new NotFoundError();
  }

  // Phase 1 is public-workspace-only: resolving the public URL doubles as the
  // visibility gate. A lane without a public base URL cannot be wrapped here
  // — that is #123's signed-URL territory, swapped in when it lands. Kept
  // per-lane: a lane hit whose config lacks `publicBaseUrl` still 404s, even
  // though a different lane on this same workspace might have one.
  const urls = objectPublicUrls(env, lane.config, key);
  if (!urls.url) throw new NotFoundError();

  const meta = lane.head;

  if (objectVisibility(meta.metadata ?? undefined)) {
    throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
  }
  // One fresh D1 read supplies both the hold gate and the response metadata.
  // Keep it after the private-object gate; nothing from either check is cached.
  const metadata = await measure("file_metadata", () =>
    getFileMetadata(dbFor(env), workspace, key),
  );
  // A held upload (`upload-hold.ts`) gets the same answer as a private one.
  if (isHeld(metadata)) {
    throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
  }

  return { store: lane.store, meta, metadata, urls, env, cfg: lane.config, record };
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
  const timing = new ServerTiming();
  const started = Date.now();
  const measure: Measure = (name, work) =>
    timeOp(work, {
      name,
      timing,
      route: "/public/files/:workspace/:key",
      thresholdMs: slowOpThresholdMs(c.env),
    });
  // Replaced objects, private flips, and holds must be checked on every open.
  c.header("Cache-Control", "no-store");
  try {
    const workspace = c.req.param("workspace");
    const key = c.req.param("key");
    const { store, meta, metadata, urls, env, cfg, record } = await resolvePublicObject(
      c.env,
      workspace,
      key,
      measure,
    );

    const downloadParam = c.req.query("download");
    if (downloadParam === "1" || downloadParam === "true") {
      c.res = await downloadResponse(store, key);
      return c.res;
    }

    let github = deriveGithubContext(metadata);
    // Overlap the bounded display-cache read with counterpart verification.
    const cachedTitle = github
      ? measure("file_title_cache", () =>
          withPublicTitleBudget(readCachedPublicTitle(c.env, githubRefKey(metadata, github!)), 75),
        ).catch(() => null)
      : Promise.resolve(null);

    const publicMetadata = publicFileMetadata(metadata);

    // Before/after counterpart (issue #420). findCounterpartCandidate only
    // proposes a key from D1 metadata / filename convention — it has no
    // storage binding, so this route must independently verify the candidate
    // exists, is public, AND is an image before ever mentioning it in the
    // response. Skipping any of those would either leak the existence of a
    // private counterpart object, or hand the web page's static side-by-side
    // layout (issue #420 v1 renders both sides as an image element) a video
    // or other non-image file it can't render that way. Two-lane storage
    // (CodeRabbit review, PR #771): the counterpart is resolved via its OWN
    // lane, not the primary object's `store`/`cfg` — a before/after pair can
    // straddle a storage switch just like any other pair of keys.
    const ownContentType = meta.type ?? "application/octet-stream";
    const counterpart = await measure("file_pair", async () => {
      let result:
        | { key: string; url: string; previewUrl: string; state: BeforeAfterState }
        | undefined;
      const candidate = isPairableImageContentType(ownContentType)
        ? await findCounterpartCandidate(dbFor(c.env), workspace, key, metadata)
        : null;
      if (candidate && candidate.key !== key) {
        const counterpartLane = await resolveObjectLaneWithHead(env, record, candidate.key);
        if (counterpartLane) {
          const counterpartMeta = counterpartLane.head;
          const counterpartType = counterpartMeta.type ?? "application/octet-stream";
          if (
            isPairableImageContentType(counterpartType) &&
            !objectVisibility(counterpartMeta.metadata ?? undefined) &&
            !(await isKeyHeld(env, workspace, candidate.key))
          ) {
            const counterpartUrls = objectPublicUrls(env, counterpartLane.config, candidate.key);
            if (counterpartUrls.url) {
              result = {
                key: candidate.key,
                url: counterpartUrls.url,
                previewUrl: previewUrl(counterpartUrls.url, counterpartMeta.etag),
                state: candidate.state,
              };
            }
          }
        }
      }

      return result;
    });

    const { posterUrl, videoDimensions } = videoPresentation(
      env,
      cfg,
      key,
      metadata,
      ownContentType,
    );

    // Serve only an epoch-checked public cache hit or the attach-time stamp.
    // Optional display enrichment cannot hold the page hostage to GitHub.
    if (github) {
      const ref = githubRefKey(metadata, github);
      const cached = await cachedTitle;
      const title = displayTitle(cached?.value?.title) ?? github.title;
      if (!cached) {
        // Hono's executionCtx getter throws in non-Workers callers. Without a
        // lifetime owner, skip optional refresh rather than leave floating I/O.
        let ctx: Pick<ExecutionContext, "waitUntil"> | undefined;
        try {
          ctx = c.executionCtx;
        } catch {
          /* no background lifetime */
        }
        if (ctx) ctx.waitUntil(resolveTitles(c.env, [ref], { audience: "public" }).catch(() => {}));
      }
      const owner = ownerFromRepo(github.repo);
      github = {
        repo: github.repo,
        kind: github.kind,
        number: github.number,
        url: github.url,
        ...(title ? { title } : {}),
        ...(owner ? { avatarUrl: githubAvatarProxyUrl(requestOrigin(c.req.url), owner) } : {}),
      };
    }

    c.res = c.json({
      workspace,
      key,
      url: urls.url,
      previewUrl: previewUrl(urls.url!, meta.etag),
      embedUrl: urls.embedUrl,
      size: meta.size ?? 0,
      contentType: meta.type ?? "application/octet-stream",
      ...publicObjectDateFields(meta),
      ...(publicMetadata ? { metadata: publicMetadata } : {}),
      ...(github ? { github } : {}),
      ...(posterUrl ? { posterUrl } : {}),
      ...(videoDimensions ? { videoDimensions } : {}),
      ...(counterpart ? { counterpart } : {}),
    });
    return c.res;
  } finally {
    timing.record({ name: "file_api", wallMs: Date.now() - started });
    if (!serverTimingDisabled(c.env)) {
      const header = timing.header();
      if (header) c.header("Server-Timing", header, { append: true });
    }
  }
});
