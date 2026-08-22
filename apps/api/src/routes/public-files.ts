import { NotFoundError, UnauthorizedError } from "@uploads/errors";
import { Hono } from "hono";
import type { Files, StorageConfig } from "@uploads/storage";
import {
  findCounterpartCandidate,
  isPairableImageContentType,
  type BeforeAfterState,
} from "../before-after";
import { badKey, downloadResponse, publicObjectDateFields } from "../files-core";
import { displayTitle, getFileMetadata, isServerMetaKey } from "../file-metadata";
import { githubAvatarProxyUrl, ownerFromRepo } from "../github-avatars";
import { resolveTitles, withPublicTitleBudget } from "../github-titles";
import { videoPresentation } from "../poster";
import { objectPublicUrls, resolveObjectLane } from "../storage";
import { objectVisibility } from "../visibility";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";
import { requestOrigin } from "../well-known";

type GithubKind = "pull" | "issue";

interface GithubContext {
  repo: string;
  kind: GithubKind;
  number: number;
  url: string;
  /** Attach-time stamp and/or live resolveTitles overlay; omitted when unknown. */
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

interface ResolvedPublicObject {
  store: Files;
  meta: { size?: number; type?: string; lastModified?: number; metadata?: Record<string, string> };
  urls: { url: string | null; embedUrl: string | null };
  env: Env;
  cfg: StorageConfig;
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
 * (no `storageLanes`) take the exact path this always has: one `exists` call
 * against the active lane.
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

  const lane = await resolveObjectLane(env, record, key);
  if (!lane) throw new NotFoundError();

  // Phase 1 is public-workspace-only: resolving the public URL doubles as the
  // visibility gate. A lane without a public base URL cannot be wrapped here
  // — that is #123's signed-URL territory, swapped in when it lands. Kept
  // per-lane: a lane hit whose config lacks `publicBaseUrl` still 404s, even
  // though a different lane on this same workspace might have one.
  const urls = objectPublicUrls(env, lane.config, key);
  if (!urls.url) throw new NotFoundError();

  const meta = await lane.store.head(key);

  if (objectVisibility(meta.metadata ?? undefined)) {
    throw new UnauthorizedError("sign in to view this file", { code: "auth_required" });
  }

  return { store: lane.store, meta, urls, env, cfg: lane.config };
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
  const { store, meta, urls, env, cfg } = await resolvePublicObject(c.env, workspace, key);

  const downloadParam = c.req.query("download");
  if (downloadParam === "1" || downloadParam === "true") {
    const filename = key.split("/").filter(Boolean).pop() ?? key;
    return downloadResponse(store, key, filename);
  }

  // After the visibility gate — private objects 401 before this D1 read.
  const metadata = await getFileMetadata(c.env.DB, workspace, key);
  let github = deriveGithubContext(metadata);

  // `video.*` rows are server-owned (issue #299) and never meant to reach
  // clients as generic metadata — only via the derived posterUrl/videoDimensions
  // fields below. Filter them out of the raw metadata pass-through the same way
  // provenance/visibility are already excluded from D1 reads entirely.
  const publicMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([metaKey]) => !isServerMetaKey(metaKey)),
  );

  // Before/after counterpart (issue #420). findCounterpartCandidate only
  // proposes a key from D1 metadata / filename convention — it has no
  // storage binding, so this route must independently verify the candidate
  // exists, is public, AND is an image before ever mentioning it in the
  // response. Skipping any of those would either leak the existence of a
  // private counterpart object, or hand the web page's static side-by-side
  // layout (issue #420 v1 renders both sides as an image element) a video
  // or other non-image file it can't render that way.
  let counterpart: { key: string; url: string; state: BeforeAfterState } | undefined;
  const ownContentType = meta.type ?? "application/octet-stream";
  const candidate = isPairableImageContentType(ownContentType)
    ? await findCounterpartCandidate(c.env.DB, workspace, key, metadata)
    : null;
  if (candidate && candidate.key !== key) {
    if (await store.exists(candidate.key)) {
      const counterpartMeta = await store.head(candidate.key);
      const counterpartType = counterpartMeta.type ?? "application/octet-stream";
      if (
        isPairableImageContentType(counterpartType) &&
        !objectVisibility(counterpartMeta.metadata ?? undefined)
      ) {
        const counterpartUrls = objectPublicUrls(env, cfg, candidate.key);
        if (counterpartUrls.url) {
          counterpart = { key: candidate.key, url: counterpartUrls.url, state: candidate.state };
        }
      }
    }
  }

  const { posterUrl, videoDimensions } = videoPresentation(env, cfg, key, metadata);

  // Live title (KV-cached App ladder) wins over stamped gh.title. Failures and
  // budget timeouts never 500 — keep the stamp or omit title entirely.
  // avatarUrl is pure derivation from gh.repo — no extra network here.
  if (github) {
    const ref = githubRefKey(metadata, github);
    let title = github.title;
    try {
      const titles = await withPublicTitleBudget(resolveTitles(c.env, [ref]));
      const live = titles ? displayTitle(titles[ref]?.title) : undefined;
      if (live) title = live;
    } catch {
      // Missing GITHUB_CACHE / App misconfig / transient — keep stamp if any.
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

  return c.json({
    workspace,
    key,
    url: urls.url,
    embedUrl: urls.embedUrl,
    size: meta.size ?? 0,
    contentType: meta.type ?? "application/octet-stream",
    ...publicObjectDateFields(meta),
    ...(Object.keys(publicMetadata).length > 0 ? { metadata: publicMetadata } : {}),
    ...(github ? { github } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(videoDimensions ? { videoDimensions } : {}),
    ...(counterpart ? { counterpart } : {}),
  });
});
