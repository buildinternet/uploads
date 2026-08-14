/**
 * Remote MCP tool set — the hosted subset of the CLI's stdio tools. Everything
 * is scoped to the workspace resolved by `workspaceAuth`; token scopes are
 * enforced inside handlers, where a throw becomes an isError tool result
 * rather than a JSON-RPC error.
 *
 * Deliberate hosted divergences (no filesystem / no git / no local `gh`):
 * - No `attach` tool — use `put` with `pr`/`issue` (+ required `repo`) for the
 *   same stable key + managed comment, or `put` with `branch` (+ `repo`) to
 *   stage pre-PR, or `promote` to copy staged files into a PR.
 * - No `doctor` (local checks). No `staged` tool — no git defaults for branch;
 *   use `list` / `find_files` + `repo_link_status` (issue #405).
 */
import {
  buildMarkdown,
  buildScreenshotKey,
  ghAttachmentKeyForMode,
  ghBranchAttachmentKeyForMode,
  ghMetadataForBranch,
  ghMetadataFromTarget,
  type GhTarget,
} from "@buildinternet/uploads";
import {
  appProp,
  METADATA_DESCRIPTION,
  metadataArgWithCanonical,
  stateProp,
  ToolBatchError,
  batchFailureMessage,
  mapBounded,
  metadataProp,
  optBool,
  optPosInt,
  optString,
  optStringArray,
  optStringRecord,
  usage,
  type McpTool,
  insufficientScopeError,
  mcpDestroyPublic,
  mcpOAuthAny,
  mcpOAuthDelete,
  mcpOAuthRead,
  mcpOAuthWrite,
  mcpRead,
  mcpWriteInternal,
  mcpWritePublic,
  hostedOutputSchemas,
  withOutputSchemas,
} from "@buildinternet/uploads/mcp";
import { AppError, NotFoundError } from "@uploads/errors";
import { badKey } from "@uploads/api/files";
import { postManagedComment, type PostCommentResult } from "@uploads/api/github-comment-service";
import {
  postPromoteBranchAttachments,
  type PromoteResult,
} from "@uploads/api/github-promote-service";
import {
  getFileMetadata,
  listFacets,
  META_MAX_KEYS,
  setFileMetadata,
  validateMetadataEntries,
  validateMetadataFilters,
} from "@uploads/api/file-metadata";
import {
  clampSearchLimit,
  normalizeSearchName,
  searchFilesByNameAndMeta,
} from "@uploads/api/file-search";
import { hasGithubTags, uploaderTags } from "@uploads/api/uploader-identity";
import {
  deriveRepoBinding,
  findRepoLink,
  resolveGhKeyContext,
  type GhKeyMode,
} from "@uploads/api/github-repo-binding";
import {
  addExternalReference,
  addGalleryItem,
  createGallery,
  findGalleriesByReference,
  getGallery,
  listGalleryItems,
} from "@uploads/api/galleries";
import {
  encodeGalleryCursor,
  gallerySummary,
  hydrateOwnerGallery,
  referenceDto,
  unwrapMutation,
} from "@uploads/api/gallery-service";
import { parseExternalReference } from "@uploads/api/external-references";
import { publicUrl, storage, storageConfig } from "@uploads/api/storage";
import { deleteObject, listObjects, putObject } from "@uploads/api/files";
import { allowWrite, resolveUploadPolicy } from "@uploads/api/guards";
import { usageWithLimits } from "@uploads/api/budget";
import { reconcileWorkspaceUsage } from "@uploads/api/reconcile";
import { purgeExpiredObjects } from "@uploads/api/retention";
import { getWorkspaceUsage } from "@uploads/api/usage";
import type { FileScope, WorkspaceRecord } from "@uploads/api/workspace";

export interface RemoteToolContext {
  env: Env;
  workspace: WorkspaceRecord;
  workspaceName: string;
  authScopes: readonly FileScope[];
  /**
   * RFC 9728 protected-resource metadata URL for this request's origin.
   * Stamped into insufficient-scope tool errors so ChatGPT can re-consent.
   */
  resourceMetadataUrl: string;
  /**
   * Better Auth user id behind the presented credential (OAuth JWT's `sub`,
   * or an `up_` token's `minting_user_id`) — same id the REST API's
   * `mintingUserId` context var carries. `null` for legacy/enrollment tokens
   * or JWTs with no `sub`. Threaded into `uploaderTags()` for uploader
   * attribution parity with the REST path (#340/#344, #345).
   */
  mintingUserId: string | null;
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  // Pre-decode size gate: base64 encodes 3 bytes per 4 chars, so a string
  // longer than this cannot decode to a within-limit payload. Rejecting here
  // avoids materializing an oversized body in isolate memory; putObject's
  // inspectUpload remains the authoritative post-decode check.
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    usage(`contentBase64 exceeds the workspace upload limit (${maxBytes} bytes)`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    usage("contentBase64 must be valid base64");
  }
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Max items per multi-file put call — bounds decoded bytes held in isolate memory. */
export const MAX_PUT_FILES = 20;
/** Bounded parallelism for batch writes (each is a D1 budget check + R2 put). */
const PUT_CONCURRENCY = 5;

interface PutFileItem {
  filename: string;
  contentBase64: string;
  alt?: string;
}

/** Validate the multi-file `files` argument shape (content, not paths — no filesystem here). */
function optPutFileItems(args: Record<string, unknown>): PutFileItem[] | undefined {
  const v = args.files;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) usage("files must be an array of { filename, contentBase64 } objects");
  return v.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      usage(`files[${i}] must be an object with filename and contentBase64`);
    }
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!["filename", "contentBase64", "alt"].includes(key)) {
        usage(`files[${i}].${key} is not a valid property`);
      }
    }
    const { filename, contentBase64, alt } = rec;
    if (typeof filename !== "string" || !filename) usage(`files[${i}].filename is required`);
    if (typeof contentBase64 !== "string" || !contentBase64) {
      usage(`files[${i}].contentBase64 is required`);
    }
    if (alt !== undefined && typeof alt !== "string") usage(`files[${i}].alt must be a string`);
    return {
      filename,
      contentBase64,
      ...(typeof alt === "string" ? { alt } : {}),
    };
  });
}

// Same owner/name grammar as the REST route's parseTarget (routes/github-comment.ts,
// now apps/api/src/github-comment-service.ts's caller) — `repo` is interpolated into
// a server-side api.github.com path via postManagedComment, so a dot-only segment
// ("..") must be rejected here too, not just the simpler public-files grammar.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;

function validRepoGrammar(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg));
}

/**
 * Reads `pr`/`issue` (+ `repo`) into a `GhTarget`; undefined when neither is
 * present. Unlike the stdio tool, `repo` is REQUIRED with a target — there is
 * no git context on this server to infer it from (deliberate divergence,
 * documented on the arg itself).
 */
function ghTargetFromArgs(args: Record<string, unknown>): GhTarget | undefined {
  const pr = optPosInt(args, "pr");
  const issue = optPosInt(args, "issue");
  if (pr === undefined && issue === undefined) return undefined;
  if (pr !== undefined && issue !== undefined) usage("pr and issue are mutually exclusive");
  const repo = optString(args, "repo");
  if (!repo) usage("repo is required with pr/issue (no git context on the hosted server)");
  if (!validRepoGrammar(repo)) usage("repo must be owner/name");
  return { repo, kind: pr !== undefined ? "pull" : "issues", num: (pr ?? issue) as number };
}

/**
 * Branch name for staging / promote. Required non-empty printable string when
 * present; `ghMetadataForBranch` enforces the metadata value rules and is
 * the source of truth for "is this branch name stageable?".
 */
function branchFromArgs(args: Record<string, unknown>): string | undefined {
  if (!("branch" in args) || args.branch === undefined || args.branch === null) return undefined;
  const branch = optString(args, "branch");
  if (branch === undefined || branch.length === 0) {
    usage("branch must be a non-empty string");
  }
  return branch;
}

/** Stamp gh.* branch metadata; surface metadata rule failures as usage errors. */
function branchMetadata(repo: string, branch: string): Record<string, string> {
  try {
    return ghMetadataForBranch(repo, branch);
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
  }
}

/** Per-item failure detail, same shape as the CLI/stdio `failures[]` entries. */
function errorDetail(err: unknown): {
  message: string;
  code?: string;
  status?: number;
} {
  if (err instanceof AppError) {
    return { message: err.message, code: String(err.code), status: err.status };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

export function createRemoteTools(ctx: RemoteToolContext): McpTool[] {
  const { env, workspace, workspaceName } = ctx;

  function requireScope(scope: FileScope): void {
    // Authorization failure, not a usage error — no (USAGE) suffix in the tool result.
    if (!ctx.authScopes.includes(scope)) {
      throw insufficientScopeError(ctx.resourceMetadataUrl, scope);
    }
  }

  async function requireWriteBudget(): Promise<void> {
    // Mirrors the REST API's writeRateLimit middleware (guards.ts): plain
    // Error, not usage() — over-budget is not a caller mistake.
    if (!(await allowWrite(env, workspaceName))) throw new Error("rate limit exceeded");
  }

  /**
   * Best-effort managed-comment sync after a successful `put` (issue #392),
   * reusing the REST route's in-process service (so a repo's `.uploads.yml`
   * applies the same way as on the bot path; issue #536). A comment failure
   * — a decline (not_installed/not_authorized/forbidden/...) is NOT a
   * failure, it's returned honestly in `comment` — never fails the tool
   * call; a throw (e.g. an unexpected GitHub API error) is caught into
   * `commentError`, same shape as the stdio tools' `syncComment`.
   */
  async function attachComment(
    target: GhTarget,
  ): Promise<{ comment?: PostCommentResult; commentError?: string }> {
    try {
      const comment = await postManagedComment(
        env,
        workspace,
        workspaceName,
        ctx.mintingUserId,
        target,
      );
      return { comment };
    } catch (err) {
      return { commentError: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Best-effort promote (CLI attach --pr parity). Never fails the caller —
   * promote problems surface as `promoteError` so an upload/comment path
   * still returns its primary result.
   */
  async function attemptPromote(
    repo: string,
    num: number,
    branch: string,
  ): Promise<{ promotion?: PromoteResult; promoteError?: string }> {
    try {
      const promotion = await postPromoteBranchAttachments(
        env,
        workspace,
        workspaceName,
        ctx.mintingUserId,
        { repo, num, branch },
      );
      return { promotion };
    } catch (err) {
      return { promoteError: err instanceof Error ? err.message : String(err) };
    }
  }

  function requiredString(args: Record<string, unknown>, name: string): string {
    const value = optString(args, name);
    if (!value) usage(name + " is required");
    return value;
  }

  /** Key format + object existence (shared by get_metadata / set_metadata). */
  async function requireExistingObjectKey(args: Record<string, unknown>): Promise<string> {
    const key = requiredString(args, "key");
    if (badKey(key)) usage("invalid key");
    const store = await storage(env, workspace);
    if (!(await store.exists(key))) throw new NotFoundError("object not found");
    return key;
  }

  async function ownerGallery(id: string) {
    const record = await getGallery(env.DB, workspaceName, id);
    if (!record) throw new Error("gallery not found");
    return hydrateOwnerGallery(
      env,
      workspace,
      record,
      await listGalleryItems(env.DB, workspaceName, id),
    );
  }

  const tools: McpTool[] = [
    {
      name: "gallery_create",
      title: "Create gallery",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Create a public ordered media gallery in this workspace. The returned canonical URL is suitable for an agent response, but anyone who knows it can view the gallery and its media.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Gallery title (1–120 characters).",
          },
          description: {
            type: "string",
            description: "Optional public gallery description.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const result = unwrapMutation(
          await createGallery(env.DB, {
            workspace: workspaceName,
            title: requiredString(args, "title"),
            description: optString(args, "description"),
          }),
        );
        return ownerGallery(result.value.id);
      },
    },
    {
      name: "gallery_get",
      title: "Get gallery",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Get a workspace-owned gallery, including its ordered media and canonical public URL. Gallery media is public to anyone with the URL.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
        },
        required: ["galleryId"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        return ownerGallery(requiredString(args, "galleryId"));
      },
    },
    {
      name: "gallery_add",
      title: "Add gallery item",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Add one existing, publicly served workspace object to a gallery. The tool reads the current version before writing and does not upload or delete the object.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
          objectKey: {
            type: "string",
            description: "Existing public object key to add.",
          },
          caption: { type: "string", description: "Optional public caption." },
          altText: { type: "string", description: "Optional public alt text." },
        },
        required: ["galleryId", "objectKey"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const id = requiredString(args, "galleryId");
        const objectKey = requiredString(args, "objectKey");
        if (badKey(objectKey)) usage("invalid key");
        const gallery = await getGallery(env.DB, workspaceName, id);
        if (!gallery) throw new Error("gallery not found");
        const existing = (await listGalleryItems(env.DB, workspaceName, id)).find(
          (item) => item.object_key === objectKey,
        );
        if (existing) {
          const item = (await ownerGallery(id)).items.find((entry) => entry.id === existing.id);
          if (!item) throw new Error("gallery item not found");
          return item;
        }
        try {
          const [store, config] = await Promise.all([
            storage(env, workspace),
            storageConfig(env, workspace),
          ]);
          if (!(await store.exists(objectKey))) throw new Error("object not found");
          if (publicUrl(config, objectKey) === null) throw new Error("object has no public URL");
        } catch (err) {
          if (
            err instanceof Error &&
            ["object not found", "object has no public URL"].includes(err.message)
          ) {
            throw err;
          }
          // Typed storage errors (storage_misconfigured, storage_credentials_unreadable,
          // …) carry a caller-useful message already — pass them through rather
          // than flattening into a generic message that loses the code.
          if (err instanceof AppError) throw err;
          throw new Error("gallery storage unavailable", { cause: err });
        }
        const result = unwrapMutation(
          await addGalleryItem(env.DB, workspaceName, id, {
            expectedVersion: gallery.version,
            objectKey,
            caption: optString(args, "caption"),
            altText: optString(args, "altText"),
          }),
        );
        const item = (await ownerGallery(id)).items.find((entry) => entry.id === result.value.id);
        if (!item) throw new Error("gallery item not found");
        return item;
      },
    },
    {
      name: "gallery_link",
      title: "Link gallery",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Link a gallery to an external reference. Uses provider-neutral fields; github currently accepts owner/repo#number or a strict GitHub issue/PR URL. No GitHub credentials or API calls are used.",
      inputSchema: {
        type: "object",
        properties: {
          galleryId: { type: "string", description: "Opaque gallery ID." },
          provider: {
            type: "string",
            description: "External provider (currently github).",
          },
          coordinate: {
            type: "string",
            description: "Provider-native external reference coordinate.",
          },
        },
        required: ["galleryId", "provider", "coordinate"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const id = requiredString(args, "galleryId");
        const gallery = await getGallery(env.DB, workspaceName, id);
        if (!gallery) throw new Error("gallery not found");
        const parsed = parseExternalReference(args.provider, args.coordinate);
        if (!parsed.ok) usage(parsed.message);
        const result = unwrapMutation(
          await addExternalReference(env.DB, workspaceName, id, {
            expectedVersion: gallery.version,
            ...parsed.value,
          }),
        );
        return referenceDto(result.value);
      },
    },
    {
      name: "gallery_find_by_reference",
      title: "Find galleries",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Find galleries in this workspace linked to an external reference. Returns canonical public gallery URLs without contacting the provider.",
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "External provider (currently github).",
          },
          coordinate: {
            type: "string",
            description: "Provider-native external reference coordinate.",
          },
          limit: {
            type: "number",
            description: "Page size (default 50, max 100).",
          },
        },
        required: ["provider", "coordinate"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const parsed = parseExternalReference(args.provider, args.coordinate);
        if (!parsed.ok) usage(parsed.message);
        const page = await findGalleriesByReference(
          env.DB,
          workspaceName,
          parsed.value.normalizedKey,
          {
            limit: optPosInt(args, "limit"),
          },
        );
        return {
          galleries: page.galleries.map((gallery) => gallerySummary(env, gallery)),
          nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor) : null,
        };
      },
    },
    {
      name: "put",
      title: "Upload file",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Upload base64-encoded content to the workspace and get a public URL plus GitHub-ready embed markdown (the returned `markdown` is ready to paste into a PR or issue). Single file: pass `contentBase64` + `filename` (flat result). Multiple files: pass `files` (uploaded in parallel; returns `uploads` + `failures`, one bad item does not abort the rest). The key defaults to <prefix>/<repo>/<ref>/<name>-<hash>.<ext>; pass `key` for an explicit path instead (single-file only). With `pr`/`issue` (+ required `repo`) the key is stable instead (gh/…, always overwrites) and the managed attachments comment is synced by default as uploads-sh[bot] (bot-only on this hosted server, no local gh fallback; body honors the repo's `.uploads.yml` when present) — pass `comment: false` to skip it. With `branch` (+ required `repo`, no pr/issue) stages under gh/…/branch/… for pre-PR capture (CLI attach --branch parity); no comment yet. With `pr` + `branch`, also best-effort promotes that branch's staged files into the PR before the comment sync (CLI attach --pr auto-promote parity). Uploads are public regardless of GitHub repository visibility; explicit predictable keys must contain only non-sensitive media. The stored content type is sniffed from the bytes and restricted to the workspace's allowlist (images plus mp4/webm by default).",
      inputSchema: {
        type: "object",
        properties: {
          contentBase64: {
            type: "string",
            description:
              "Base64-encoded file content to upload (must be non-empty). Exactly one of contentBase64 or files is required.",
          },
          filename: {
            type: "string",
            description: "Filename for the content (drives the key and content type).",
          },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: {
                  type: "string",
                  description: "Filename for this item (drives the key and content type).",
                },
                contentBase64: {
                  type: "string",
                  description: "Base64-encoded content for this item (must be non-empty).",
                },
                alt: {
                  type: "string",
                  description:
                    "Per-item alt text override (default: top-level alt, then filename).",
                },
              },
              required: ["filename", "contentBase64"],
              additionalProperties: false,
            },
            description: `Multiple files to upload in one call (max ${MAX_PUT_FILES} items). Cannot be combined with contentBase64, filename, or key; prefix/repo/ref/pr/issue/branch/width/metadata apply to every item. Returns { uploads, failures } with per-item results (plus comment/commentError / promotion once for the whole batch when those run).`,
          },
          key: {
            type: "string",
            description:
              "Explicit object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.<ext>). Cannot be combined with prefix/repo/ref/pr/issue/branch.",
          },
          prefix: {
            type: "string",
            description: "Key prefix for the default key layout (default: screenshots).",
          },
          repo: {
            type: "string",
            description:
              "owner/name repo segment for the default key layout (default: misc). REQUIRED (and must be owner/name) with pr/issue/branch — there is no git context on this server to infer it from.",
          },
          ref: {
            type: "string",
            description:
              "PR/issue/branch key segment for the default key layout (default: today). Cannot be combined with pr/issue/branch.",
          },
          pr: {
            type: "number",
            description:
              "Attach to this pull request: uses a stable gh/ key (always overwrites) and stamps canonical gh.* metadata. Mutually exclusive with issue. Cannot combine with key/prefix/ref, or with branch-only staging (branch alone stages; pr + branch uploads to the PR and promotes that branch). Requires repo.",
          },
          issue: {
            type: "number",
            description:
              "Attach to this issue: uses a stable gh/ key (always overwrites) and stamps canonical gh.* metadata. Mutually exclusive with pr and with branch (promotion is PR-only). Cannot combine with key/prefix/ref. Requires repo.",
          },
          branch: {
            type: "string",
            description:
              "Git branch name. Without pr/issue: stage under gh/<owner>/<repo>/branch/<branch>/<filename> (pre-PR; no comment). With pr: after upload, best-effort promote this branch's staged files into the PR (never fails the upload; see promotion/promoteError). Requires repo. Cannot combine with issue, key, prefix, or ref.",
          },
          comment: {
            type: "boolean",
            description:
              "With pr/issue: after a successful upload, create or update the managed attachments comment via the uploads.sh GitHub App (bot-only on this hosted server — no local gh fallback; body honors the repo's `.uploads.yml` when present). Defaults to true when pr/issue is given (requires the files:read scope; a write-only token skips the sync unless comment is explicitly true); pass false to skip. Requires pr or issue (not branch-only staging). A comment failure never fails the upload; see the response's `comment`/`commentError`.",
          },
          alt: {
            type: "string",
            description: "Alt text for the markdown (default: filename).",
          },
          width: {
            type: "number",
            description: "Emit <img width=…> markdown instead of a plain image embed.",
          },
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              METADATA_DESCRIPTION +
              " On this hosted server the gh.* pairs are normally system-managed by the attach flow.",
          },
          state: stateProp,
          app: appProp,
          replace: {
            type: "boolean",
            description:
              "Allow overwriting an existing object on a strict (non-gh/) key: an explicit `key`, or the default prefix/repo/ref layout. Default false — an existing object there is refused (error code key_exists, with the existing object's url) unless this is true. No effect on gh/-prefixed keys, which always overwrite. Applies to every item in a `files` batch.",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        // One limiter hit per tool call, single or batch — the batch's cost
        // ceiling is bounded by MAX_PUT_FILES instead.
        await requireWriteBudget();
        const contentBase64 = optString(args, "contentBase64");
        const filename = optString(args, "filename");
        const items = optPutFileItems(args);
        const multi = items !== undefined;
        if (multi) {
          if (contentBase64 !== undefined || filename !== undefined) {
            usage("contentBase64/filename cannot be combined with files");
          }
          if (items.length === 0) usage("files must be a non-empty array");
          if (items.length > MAX_PUT_FILES) {
            usage(`files supports at most ${MAX_PUT_FILES} items per call`);
          }
          if (optString(args, "key")) usage("key cannot be combined with files");
        } else {
          if (!contentBase64) usage("contentBase64 is required");
          if (!filename) usage("filename is required");
        }

        // Destinations (no git on this server — repo is always required when
        // the key layout needs it):
        // - pr/issue → stable gh/…/pull|issues/… keys + optional comment (#392)
        // - branch alone → stage under gh/…/branch/… (CLI attach --branch)
        // - pr + branch → PR key, then best-effort promote that branch
        const target = ghTargetFromArgs(args);
        const branch = branchFromArgs(args);
        const explicitKey = optString(args, "key");
        const prefix = optString(args, "prefix");
        const repo = optString(args, "repo");
        const ref = optString(args, "ref");

        if (branch !== undefined && target?.kind === "issues") {
          usage("branch cannot be combined with issue (promotion only applies to pull requests)");
        }
        // Branch-only staging vs pr+branch promote-after.
        const staging = branch !== undefined && !target;
        const promoteBranch = branch !== undefined && target?.kind === "pull" ? branch : undefined;
        if (staging) {
          if (!repo) usage("repo is required with branch (no git context on the hosted server)");
          if (!validRepoGrammar(repo)) usage("repo must be owner/name");
        }

        // Stable gh layouts (PR/issue or branch stage) own the key path.
        const ghLayout = target ? "pr/issue" : staging ? "branch" : null;
        if (ghLayout) {
          if (explicitKey) usage(`key cannot be combined with ${ghLayout}`);
          if (prefix) usage(`prefix cannot be combined with ${ghLayout}`);
          if (ref) usage(`ref cannot be combined with ${ghLayout}`);
        } else if (explicitKey && (prefix ?? repo ?? ref) !== undefined) {
          usage("key cannot be combined with prefix/repo/ref");
        }

        // optBool collapses "absent" to false; absent vs explicit false matters
        // for default-on comment with pr/issue.
        const commentArg = args.comment == null ? undefined : optBool(args, "comment");
        if (commentArg && !target) usage("comment requires pr or issue");
        // Comment gather needs files:read (same as REST). Check up front so a
        // write-only token is rejected before any bytes are written when the
        // caller explicitly asked for comment: true.
        if (commentArg === true) requireScope("files:read");
        // Default-on with pr/issue when the token has files:read (#537);
        // write-only tokens still upload, just skip the sync unless comment:true.
        const wantComment =
          commentArg ?? (target !== undefined && ctx.authScopes.includes("files:read"));

        // state/app win over same-named metadata. No EXIF derivation on Workers.
        let metadata = metadataArgWithCanonical(args);
        if (metadata) {
          try {
            validateMetadataEntries(metadata);
          } catch (err) {
            usage(err instanceof Error ? err.message : String(err));
          }
        }
        // Canonical gh.* stamps win over caller pairs (attach parity).
        if (target) metadata = { ...metadata, ...ghMetadataFromTarget(target) };
        else if (staging && repo && branch) {
          metadata = { ...metadata, ...branchMetadata(repo, branch) };
        }
        // Uploader attribution (#345): server tags after caller pairs so they
        // can't be spoofed; drop if they'd exceed the key cap.
        if (metadata && hasGithubTags(metadata)) {
          const uploader = await uploaderTags(env, ctx.mintingUserId, metadata["gh.repo"]);
          if (uploader) {
            const merged = { ...metadata, ...uploader };
            if (Object.keys(merged).length <= META_MAX_KEYS) metadata = merged;
          }
        }

        const policy = resolveUploadPolicy(workspace);
        // Pre-decode uses the policy ceiling (video may exceed maxBytes);
        // putObject's inspectUpload enforces the content-specific limit.
        const maxBytes = Math.max(policy.maxBytes, policy.maxVideoBytes);
        const alt = optString(args, "alt");
        const width = optPosInt(args, "width");
        // Strict overwrite (issue #174) only on non-gh/ keys.
        const replaceArg = optBool(args, "replace") === true;
        const putOpts =
          metadata !== undefined || replaceArg
            ? { metadata, replace: replaceArg, surface: "mcp" as const }
            : { surface: "mcp" as const };

        // Resolved once per tool call, cached across every file in a batch
        // (issue #631) — `resolveGhKeyContext` itself is fail-open (any
        // failure degrades to `{ mode: "plain" }`), so this never blocks an
        // upload; it just avoids resolving it once per file.
        let ghPrefixPromise: Promise<GhKeyMode> | undefined;
        function resolveGhPrefixOnce(req: {
          repo: string;
          branch?: string;
          target?: { kind: "pull" | "issues"; num: number };
        }): Promise<GhKeyMode> {
          ghPrefixPromise ??= resolveGhKeyContext(env, workspaceName, ctx.mintingUserId, req);
          return ghPrefixPromise;
        }

        /** Resolve the object key for one filename (+ bytes for the dated layout). */
        async function resolveKey(name: string, bytes: Uint8Array): Promise<string> {
          if (explicitKey) return explicitKey;
          if (target) {
            const ghPrefix = await resolveGhPrefixOnce({
              repo: target.repo,
              target: { kind: target.kind, num: target.num },
            });
            return ghAttachmentKeyForMode(ghPrefix, target, name);
          }
          if (staging && repo && branch) {
            const ghPrefix = await resolveGhPrefixOnce({ repo, branch });
            return ghBranchAttachmentKeyForMode(ghPrefix, repo, branch, name);
          }
          // deriveRepoFromGit: false — no git on a worker.
          return buildScreenshotKey({
            filename: name,
            fileBytes: bytes,
            prefix,
            repo,
            ref,
            deriveRepoFromGit: false,
          });
        }

        /** After successful write(s): optional promote, then comment (CLI order). */
        async function afterUploadExtras(hadSuccess: boolean): Promise<Record<string, unknown>> {
          if (!hadSuccess || !target) return {};
          const promoteResult =
            promoteBranch !== undefined
              ? await attemptPromote(target.repo, target.num, promoteBranch)
              : undefined;
          const commentResult = wantComment ? await attachComment(target) : undefined;
          return { ...promoteResult, ...commentResult };
        }

        if (multi) {
          // Decode every item before any write so a bad batch fails whole.
          const decoded = items.map((item, i) => {
            try {
              return decodeBase64(item.contentBase64, maxBytes);
            } catch (err) {
              usage(
                `files[${i}] (${item.filename}): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          });
          const keys = await Promise.all(
            items.map((item, i) => resolveKey(item.filename, decoded[i]!)),
          );
          // Deterministic keys can collide (same file twice). Reject first.
          const firstIndexByKey = new Map<string, number>();
          keys.forEach((key, i) => {
            const first = firstIndexByKey.get(key);
            if (first === undefined) {
              firstIndexByKey.set(key, i);
              return;
            }
            usage(
              `files[${i}] (${items[i]!.filename}) resolves to the same key as files[${first}] (${items[first]!.filename}): ${key}`,
            );
          });
          type Slot =
            | { ok: true; upload: Record<string, unknown> }
            | { ok: false; file: string; err: unknown };
          const slots: Slot[] = await mapBounded(items, PUT_CONCURRENCY, async (item, i) => {
            try {
              const result = await putObject(
                env,
                workspace,
                keys[i]!,
                decoded[i]!,
                workspaceName,
                putOpts,
              );
              const markdown =
                result.url === null
                  ? undefined
                  : buildMarkdown(result.url, {
                      alt: item.alt ?? alt ?? item.filename,
                      width,
                    });
              return {
                ok: true,
                upload: { file: item.filename, ...result, markdown },
              };
            } catch (err) {
              return { ok: false, file: item.filename, err };
            }
          });
          const uploads = slots.flatMap((slot) => (slot.ok ? [slot.upload] : []));
          const failures = slots.flatMap((slot) =>
            slot.ok ? [] : [{ file: slot.file, error: errorDetail(slot.err) }],
          );
          if (uploads.length === 0 && failures.length > 0) {
            throw new ToolBatchError(batchFailureMessage(failures), {
              workspace: workspaceName,
              uploads,
              failures,
            });
          }
          const extras = await afterUploadExtras(uploads.length > 0);
          return { workspace: workspaceName, uploads, failures, ...extras };
        }

        const bytes = decodeBase64(contentBase64!, maxBytes);
        const key = await resolveKey(filename!, bytes);
        const result = await putObject(env, workspace, key, bytes, workspaceName, putOpts);
        const markdown =
          result.url === null
            ? undefined
            : buildMarkdown(result.url, {
                alt: alt ?? filename!,
                width,
              });
        const extras = await afterUploadExtras(true);
        return { workspace: workspaceName, ...result, markdown, ...extras };
      },
    },
    {
      name: "list",
      title: "List files",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "List uploaded objects in the workspace, optionally filtered by key prefix. Paginate with cursor; each item includes its public URL when the workspace has one.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Key prefix filter." },
          limit: {
            type: "number",
            description: "Page size (default 100, max 1000).",
          },
          cursor: {
            type: "string",
            description: "Pagination cursor from a previous call.",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        return listObjects(env, workspace, {
          prefix: optString(args, "prefix"),
          limit: optPosInt(args, "limit"),
          cursor: optString(args, "cursor"),
        });
      },
    },
    {
      name: "delete",
      title: "Delete file",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthDelete,
      description: "Delete an uploaded object in the workspace by key.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to delete." },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:delete");
        await requireWriteBudget();
        const key = optString(args, "key");
        if (!key) usage("key is required");
        return deleteObject(env, workspace, key, workspaceName);
      },
    },
    {
      name: "comment",
      title: "Sync attachments comment",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthRead,
      description:
        "Create or update the managed attachments comment on a GitHub PR or issue, listing everything this workspace has uploaded for it. Refreshes the comment WITHOUT re-uploading — use after deleting media to re-sync (e.g. it will show a neutral empty state once the last attachment is removed). Posts as uploads-sh[bot] via the uploads.sh GitHub App — bot-only on this hosted server, no local gh fallback; body honors the repo's `.uploads.yml` when present (same as the bot path). If the App isn't installed/authorized the decline is returned honestly. Requires repo (owner/name — no git context on this server) and exactly one of pr/issue.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description:
              "owner/name repo segment. REQUIRED (owner/name) — there is no git context on this server to infer it from.",
          },
          pr: {
            type: "number",
            description: "Pull request number. Mutually exclusive with issue.",
          },
          issue: { type: "number", description: "Issue number. Mutually exclusive with pr." },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      async handler(args) {
        // Reading the workspace's own objects/metadata/galleries to render the
        // body is a files:read operation (mirrors the REST route + put
        // --comment); no workspace bytes are written, but the App write it
        // triggers is still rate-limited like the other mutating tools.
        requireScope("files:read");
        await requireWriteBudget();
        const target = ghTargetFromArgs(args);
        if (!target) usage("comment requires pr or issue");
        // Explicit resync (issue #480): hunt for the marker instead of
        // trusting the cached comment id, so a duplicate gets collapsed here
        // rather than waiting on a cache miss.
        return postManagedComment(env, workspace, workspaceName, ctx.mintingUserId, target, {
          resync: true,
        });
      },
    },
    {
      name: "promote",
      title: "Promote staged attachments",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Copy this workspace's branch-staged attachments (gh/…/branch/… keys from put with branch, or CLI attach --branch) into a PR's stable gh/…/pull/… prefix, then optionally refresh the managed attachments comment. Hosted stand-in for `uploads attach --promote` — no git context, so repo, pr, and branch are all required. Does not delete staged originals. Promotion is a pure workspace-data copy (no GitHub API for the copy itself); the comment path is bot-only like the comment tool. Returns { promotion: { promoted, skipped }, comment?, commentError? }.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description:
              "owner/name repo. REQUIRED — there is no git context on this server to infer it from.",
          },
          pr: {
            type: "number",
            description: "Pull request number to promote into. Promotion never applies to issues.",
          },
          branch: {
            type: "string",
            description:
              "Git branch whose staged prefix (gh/…/branch/<branch>/) should be copied into the PR.",
          },
          comment: {
            type: "boolean",
            description:
              "After a successful promote, create or update the managed attachments comment (default true when files:read is on the token; pass false to skip). A comment failure never fails the promote; see commentError.",
          },
        },
        required: ["repo", "pr", "branch"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const repo = requiredString(args, "repo");
        if (!validRepoGrammar(repo)) usage("repo must be owner/name");
        const pr = optPosInt(args, "pr");
        if (pr === undefined) usage("pr is required");
        const branch = branchFromArgs(args) ?? usage("branch is required");
        // Validate branch is stageable (metadata rules) before the copy.
        branchMetadata(repo, branch);

        const commentArg = args.comment == null ? undefined : optBool(args, "comment");
        if (commentArg === true) requireScope("files:read");
        const wantComment = commentArg ?? ctx.authScopes.includes("files:read");

        // Primary job — failures throw (isError), unlike put's best-effort promote.
        const promotion = await postPromoteBranchAttachments(
          env,
          workspace,
          workspaceName,
          ctx.mintingUserId,
          { repo, num: pr, branch },
        );

        const commentResult = wantComment
          ? await attachComment({ repo, kind: "pull", num: pr })
          : undefined;
        return { promotion, ...commentResult };
      },
    },
    {
      name: "get_metadata",
      title: "Get metadata",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Read an object's queryable custom metadata (D1 key-value pairs, not R2 provenance). Returns `{ metadata }` (empty when none). Object must exist. Same as `uploads meta get`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to inspect." },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const key = await requireExistingObjectKey(args);
        return { metadata: await getFileMetadata(env.DB, workspaceName, key) };
      },
    },
    {
      name: "set_metadata",
      title: "Set metadata",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Merge-set and/or delete an object's queryable custom metadata (D1 key-value pairs, not R2 provenance). `set` wins over `delete` for the same key. " +
        METADATA_DESCRIPTION +
        " Requires at least one of `set` or `delete`. Same as `uploads meta set`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to update." },
          set: {
            ...metadataProp,
            description: "Keys to set/overwrite. " + METADATA_DESCRIPTION,
          },
          delete: {
            type: "array",
            items: { type: "string" },
            description: "Keys to remove.",
          },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const set = optStringRecord(args, "set");
        const del = optStringArray(args, "delete");
        if ((!set || Object.keys(set).length === 0) && (!del || del.length === 0)) {
          usage("set_metadata requires set and/or delete");
        }
        const key = await requireExistingObjectKey(args);
        return {
          metadata: await setFileMetadata(env.DB, workspaceName, key, set ?? {}, del ?? []),
        };
      },
    },
    {
      name: "find_files",
      title: "Find files",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Find objects whose queryable custom metadata matches ALL of `filters` (ANDed equality) and/or whose key contains `name` (case-insensitive substring). At least one of `filters` or `name` is required. Returns each match's key, public URL, full metadata map, and optional `truncated`. Same as the CLI/local MCP's `find_files` tool.",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            ...metadataProp,
            description:
              "Metadata equality filters (optional when `name` is set). " + METADATA_DESCRIPTION,
          },
          name: {
            type: "string",
            description:
              "Case-insensitive substring match on object keys (1–128 chars). Optional when `filters` is non-empty.",
          },
          prefix: {
            type: "string",
            description: "Key prefix filter, combinable with filters/name.",
          },
          limit: {
            type: "number",
            description: "Page size (default 50, max 500).",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const filters = optStringRecord(args, "filters") ?? {};
        const rawName = optString(args, "name");
        const hasMeta = Object.keys(filters).length > 0;
        if (!hasMeta && !rawName) {
          usage("find_files requires filters and/or name");
        }
        // Shares the count cap + key-format checks with the REST list endpoint's meta.* filters.
        if (hasMeta) validateMetadataFilters(filters);
        const nameTerm = rawName === undefined ? undefined : normalizeSearchName(rawName);
        const pageSize = clampSearchLimit(optPosInt(args, "limit"));
        const [cfg, result] = await Promise.all([
          storageConfig(env, workspace),
          searchFilesByNameAndMeta(env, workspace, workspaceName, {
            filters: hasMeta ? filters : undefined,
            nameTerm,
            prefix: optString(args, "prefix"),
            pageSize,
          }),
        ]);
        const items = result.matches.map((match) => ({
          key: match.key,
          url: publicUrl(cfg, match.key),
          metadata: match.metadata,
        }));
        // Meta-only keeps the pre-#528 shape (no truncated).
        if (nameTerm === undefined) return { items, cursor: null };
        return { items, cursor: null, truncated: result.truncated };
      },
    },
    {
      name: "list_metadata_keys",
      title: "List metadata keys",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "List the distinct queryable metadata keys present in the workspace, with file counts and distinct-value counts. Use this to discover what is filterable before calling find_files — keys are user/agent-defined, not a fixed schema. Same as the CLI's `uploads meta keys`. Pass optional `key` to list that key's values instead (`uploads meta values <key>`).",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "When set, return distinct values for this metadata key (with counts) instead of the key list.",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        return listFacets(env.DB, workspaceName, optString(args, "key"));
      },
    },
    {
      name: "repo_link_status",
      title: "Check repo binding",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        'Whether files staged for a repo will auto-attach into that repo\'s PRs from this workspace. Returns a tri-state `binding`: "self" (this repo is bound to this workspace — staged files will auto-attach), "other" (bound to a different workspace — they will not; the owning workspace is deliberately never disclosed), or "none" (unbound).',
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "GitHub repo as owner/name.",
          },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const repo = requiredString(args, "repo");
        if (!validRepoGrammar(repo)) usage("repo must be owner/name");
        const link = await findRepoLink(env.DB, repo);
        return { binding: deriveRepoBinding(link, workspaceName) };
      },
    },
    {
      name: "usage",
      title: "Show usage",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Workspace storage and monthly upload counters (and remaining headroom when budgets are configured).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        requireScope("files:read");
        const snapshot = await getWorkspaceUsage(env.DB, workspaceName);
        return usageWithLimits(snapshot, workspace);
      },
    },
    {
      name: "reconcile",
      title: "Reconcile usage",
      annotations: mcpWriteInternal,
      securitySchemes: mcpOAuthWrite,
      description:
        "Rebuild usage ledger bytes/objects from storage (source of truth). Preserves the monthly upload counter. Requires files:write.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        requireScope("files:write");
        await requireWriteBudget();
        const result = await reconcileWorkspaceUsage(env, workspace, workspaceName);
        return {
          ...result,
          usage: usageWithLimits(result.usage, workspace),
        };
      },
    },
    {
      name: "purge_expired",
      title: "Purge expired files",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthDelete,
      description:
        "Delete objects older than the workspace retentionDays setting, then reconcile. Skips if retention is unset. Requires files:delete.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        requireScope("files:delete");
        await requireWriteBudget();
        const result = await purgeExpiredObjects(env, workspace, workspaceName);
        if ("skipped" in result) return result;
        return {
          ...result,
          reconcile: {
            ...result.reconcile,
            usage: usageWithLimits(result.reconcile.usage, workspace),
          },
        };
      },
    },
    {
      name: "health",
      title: "Check health",
      annotations: mcpRead,
      securitySchemes: mcpOAuthAny,
      description: "Check uploads.sh MCP server liveness. No scope required.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        return { ok: true };
      },
    },
  ];
  return withOutputSchemas(tools, hostedOutputSchemas, { required: true });
}
