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
 *   use `list` / `find_files` + `repo_link_status` (issue #405). `unstage`
 *   is hosted: pass `repo` and `branch`, or `keys` (issue #1124).
 * - `list_activity` and `list_repo_files` are hosted-only reads of the Files
 *   views. They return tagged files, not a bucket listing.
 */
import {
  buildAttachmentMarkdown,
  buildScreenshotKey,
  DEFAULT_CHANGELOG_LIMIT,
  fetchChangelog,
  fetchUploadSource,
  ghAttachmentKeyForMode,
  ghBranchAttachmentKeyForMode,
  ghMetadataForBranch,
  ghMetadataFromTarget,
  MAX_CHANGELOG_LIMIT,
  parseGithubIssueRef,
  resolveUploadFilename,
  type GhTarget,
} from "@buildinternet/uploads";
import {
  appProp,
  screenProp,
  METADATA_DESCRIPTION,
  METADATA_PATH_CUE,
  MCP_EXAMPLE_PNG_BASE64,
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
  mcpNoAuth,
  mcpOAuthAny,
  mcpOAuthDelete,
  mcpOAuthRead,
  mcpOAuthWrite,
  mcpRead,
  mcpWriteInternal,
  mcpWritePublic,
  hostedOutputSchemas,
  withOutputSchemas,
  SEARCH_DOCS_DESCRIPTION,
  SEARCH_DOCS_INPUT_SCHEMA,
  runSearchDocsTool,
} from "@buildinternet/uploads/mcp";
import {
  AppError,
  InsufficientScopeError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@uploads/errors";
import { attachmentCommentTarget, assertDeleteAllowed } from "@uploads/api/delete-auth";
import { unstageGithubFiles } from "@uploads/api/github-unstage";
import { postManagedComment, type PostCommentResult } from "@uploads/api/github-comment-service";
import {
  postPromoteBranchAttachments,
  type PromoteResult,
} from "@uploads/api/github-promote-service";
import {
  postAttachExisting,
  type AttachExistingResponse,
} from "@uploads/api/github-attach-service";
import {
  getFileMetadata,
  getMetadataForKeys,
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
import {
  mintingUserIdOf,
  type UploaderIdentity,
  withUploaderTags,
} from "@uploads/api/uploader-identity";
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
import { createFeed, getFeed } from "@uploads/api/feeds";
import { hydrateOwnerFeed, unwrapFeedMutation } from "@uploads/api/feed-service";
import { parseExternalReference } from "@uploads/api/external-references";
import { publicUrl, storage, storageConfig } from "@uploads/api/storage";
import {
  badKey,
  deleteObject,
  finalizeUploadKey,
  listObjects,
  putObject,
  type ClassifierHandoff,
  type StreamedBody,
} from "@uploads/api/files";
import { activeContentAllowed } from "@uploads/api/active-content";
import {
  allowWrite,
  contentTypeFromKey,
  isGatedContentType,
  maxBytesForContentType,
  uploadLimits,
} from "@uploads/api/guards";
import { usageWithLimits } from "@uploads/api/budget";
import { reconcileWorkspaceUsage } from "@uploads/api/reconcile";
import { purgeExpiredObjects } from "@uploads/api/retention";
import { getWorkspaceUsage } from "@uploads/api/usage";
import type { FileScope, WorkspaceRecord } from "@uploads/api/workspace";
import { HOLD_AREA_KEY, isHeld, parseHoldArea, storedHoldReason } from "@uploads/api/upload-hold";
import { listHeldKeys } from "@uploads/api/upload-hold-read";
import {
  approveUpload,
  approverLabel,
  attachmentTargetFor,
} from "@uploads/api/upload-hold-service";
import { activityReadTools } from "./activity-tools";
import { canSignUploadTickets, signUploadTicket, UPLOAD_TICKET_TTL_S } from "./upload-ticket";

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
   * Who the presented credential uploads as — the same value the REST API's
   * `uploaderIdentity` context var carries: the Better Auth user (OAuth JWT's
   * `sub`, or an `up_` token's `minting_user_id`), a workspace-owned service
   * token (issue #1026), or `none` for legacy/enrollment tokens and JWTs with
   * no `sub`. Drives uploader attribution parity with the REST path
   * (#340/#344, #345) and the user id the GitHub gates check.
   */
  uploaderIdentity: UploaderIdentity;
  /**
   * The request's `executionCtx.waitUntil`, so classification can finish
   * after the tool answers (issue #1148). Absent skips classification.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Sends a stored file to uploads-api to classify (`classifierHandoff`). */
  classifierHandoff?: ClassifierHandoff;
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

async function bytesFromPutSource(
  source: { contentBase64?: string; contentUrl?: string },
  maxBytes: number,
): Promise<Uint8Array> {
  if (source.contentUrl) {
    return fetchUploadSource(source.contentUrl, {
      maxBytes,
      label: "contentUrl",
      userAgent: "uploads.sh/mcp",
    });
  }
  return decodeBase64(source.contentBase64!, maxBytes);
}

/**
 * Where a non-tool `put` gets its bytes: a ticketed request body, or none
 * at all when `sign_upload_url` only validates the arguments.
 */
type PutUpload = { bytes: Uint8Array | StreamedBody } | { validateOnly: true };

/**
 * Ceiling for one ticketed upload, on top of the workspace's own limit:
 * Cloudflare refuses request bodies over 100 MB. The `PUT /u/<ticket>` route
 * streams large bodies to storage rather than holding them in memory.
 */
const SIGNED_UPLOAD_MAX_BYTES = 100_000_000;

/** Single-quote a filename for the curl line we hand back. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `sign_upload_url`'s `files`: 1–MAX_PUT_FILES unique filenames. */
function signUploadFileItems(args: Record<string, unknown>): { filename: string; alt?: string }[] {
  const v = args.files;
  if (!Array.isArray(v) || v.length === 0) usage("files must be a non-empty array of { filename }");
  if (v.length > MAX_PUT_FILES) usage(`files supports at most ${MAX_PUT_FILES} items per call`);
  const seen = new Set<string>();
  return v.map((entry, i) => {
    const rec = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const { filename, alt } = rec;
    if (typeof filename !== "string" || !filename) usage(`files[${i}].filename is required`);
    if (alt !== undefined && typeof alt !== "string") usage(`files[${i}].alt must be a string`);
    if (seen.has(filename)) usage(`files[${i}] repeats filename ${filename}`);
    seen.add(filename);
    return alt === undefined ? { filename } : { filename, alt };
  });
}

/** Key layout arguments shared by `put` and `sign_upload_url`. */
const keyLayoutProps = {
  prefix: {
    type: "string",
    description: "Key prefix for the default key layout (default: screenshots).",
  },
  repo: {
    type: "string",
    description:
      "GitHub `owner/name`. Required with `pr`/`issue`/`branch`. Optional otherwise (default: misc).",
  },
  ref: {
    type: "string",
    description:
      "Optional key segment (default: today). Cannot combine with `pr`/`issue`/`branch`.",
  },
};

/** Markdown and metadata arguments shared by `put` and `sign_upload_url`. */
const putFormatProps = {
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
    description: METADATA_DESCRIPTION + " On `pr`/`issue`/`branch`, `gh.*` is set for you.",
  },
  state: stateProp,
  app: appProp,
  screen: screenProp,
  replace: {
    type: "boolean",
    description:
      "Overwrite an existing object on a non-`gh/` key. Default false. No effect on `gh/` keys, which always overwrite.",
  },
};

/** Max items per multi-file put call — bounds decoded bytes held in isolate memory. */
export const MAX_PUT_FILES = 20;
/** Bounded parallelism for batch writes (each is a D1 budget check + R2 put). */
const PUT_CONCURRENCY = 5;
const hostedRepoRequired = "GitHub `owner/name`. Required — this server cannot infer it from git.";

interface PutFileItem {
  filename: string;
  contentBase64?: string;
  contentUrl?: string;
  alt?: string;
}

const PUT_FILE_ITEM_KEYS = new Set(["filename", "contentBase64", "contentUrl", "alt"]);

/** Validate the multi-file `files` argument shape (content, not paths — no filesystem here). */
function optPutFileItems(args: Record<string, unknown>): PutFileItem[] | undefined {
  const v = args.files;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    usage("files must be an array of { filename, contentBase64 | contentUrl } objects");
  }
  return v.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      usage(`files[${i}] must be an object with filename and contentBase64 or contentUrl`);
    }
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!PUT_FILE_ITEM_KEYS.has(key)) {
        usage(`files[${i}].${key} is not a valid property`);
      }
    }
    const { filename, contentBase64, contentUrl, alt } = rec;
    if (filename !== undefined && typeof filename !== "string") {
      usage(`files[${i}].filename must be a string`);
    }
    const hasB64 = typeof contentBase64 === "string" && contentBase64.length > 0;
    const hasUrl = typeof contentUrl === "string" && contentUrl.length > 0;
    if (hasB64 === hasUrl) {
      usage(`files[${i}] needs exactly one of contentBase64 or contentUrl`);
    }
    if (contentBase64 !== undefined && typeof contentBase64 !== "string") {
      usage(`files[${i}].contentBase64 must be a string`);
    }
    if (contentUrl !== undefined && typeof contentUrl !== "string") {
      usage(`files[${i}].contentUrl must be a string`);
    }
    if (alt !== undefined && typeof alt !== "string") usage(`files[${i}].alt must be a string`);
    const nameArg = typeof filename === "string" && filename ? filename : undefined;
    let name: string;
    if (hasUrl) {
      try {
        name = resolveUploadFilename(contentUrl as string, nameArg, "contentUrl");
      } catch (err) {
        usage(`files[${i}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (!nameArg) {
      usage(`files[${i}].filename is required`);
    } else {
      name = nameArg;
    }
    const item: PutFileItem = { filename: name };
    if (hasB64) item.contentBase64 = contentBase64 as string;
    if (hasUrl) item.contentUrl = contentUrl as string;
    if (typeof alt === "string") item.alt = alt;
    return item;
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
  return createRemoteToolkit(ctx).tools;
}

/**
 * One file through the `put` path with bytes from a ticketed request body
 * (`PUT /u/<ticket>`, issue #1242). `args` are the ticket's `put` arguments.
 */
export function runTicketedPut(
  ctx: RemoteToolContext,
  args: Record<string, unknown>,
  bytes: Uint8Array | StreamedBody,
) {
  return createRemoteToolkit(ctx).runPut(args, { bytes });
}

function createRemoteToolkit(ctx: RemoteToolContext) {
  const { env, workspace, workspaceName } = ctx;
  const mintingUserId = mintingUserIdOf(ctx.uploaderIdentity);

  function requireScope(scope: FileScope): void {
    // Authorization failure, not a usage error — no (USAGE) suffix in the tool result.
    if (!ctx.authScopes.includes(scope)) {
      throw insufficientScopeError(ctx.resourceMetadataUrl, scope);
    }
  }

  async function requireWriteBudget(): Promise<void> {
    // Mirrors the REST API's writeRateLimit middleware (guards.ts): not
    // usage() — over-budget is not a caller mistake. Typed so the ticketed
    // PUT route answers 429.
    if (!(await allowWrite(env, workspaceName))) throw new RateLimitedError("rate limit exceeded");
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
        mintingUserId,
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
        mintingUserId,
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

  /** Held files, optionally on one PR/issue or under one prefix (`list_held`, `approve`). */
  async function heldFiles(target?: GhTarget, prefix = "") {
    const keys = (await listHeldKeys(env, workspaceName)).filter((key) => key.startsWith(prefix));
    const meta = await getMetadataForKeys(env.DB, workspaceName, keys, {
      metaKeys: [HOLD_AREA_KEY, "ai.secret", "ai.pii", "gh.repo"],
    });
    return keys.flatMap((key) => {
      const row = meta.get(key) ?? {};
      if (target) {
        // Private-prefix keys don't name their repo; `attachmentTargetFor` reads `gh.repo`.
        const on = attachmentTargetFor(key, row);
        if (
          !on ||
          on.repo !== target.repo.toLowerCase() ||
          on.kind !== target.kind ||
          on.num !== target.num
        ) {
          return [];
        }
      }
      return [
        {
          key,
          reason: storedHoldReason(row) ?? "flagged",
          area: parseHoldArea(row[HOLD_AREA_KEY]) ?? null,
        },
      ];
    });
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

  /**
   * The `put` tool body, shared with the ticketed `PUT /u/<ticket>` route
   * (issue #1242). With `upload`, the bytes come from the request body
   * instead of `contentBase64`/`contentUrl`; `validateOnly` (used by
   * `sign_upload_url`) runs every argument check and stops before any write.
   */
  async function runPut(args: Record<string, unknown>, upload?: PutUpload) {
    requireScope("files:write");
    const validateOnly = upload !== undefined && "validateOnly" in upload;
    const ticketBytes = upload !== undefined && "bytes" in upload ? upload.bytes : undefined;
    // One limiter hit per tool call, single or batch — the batch's cost
    // ceiling is bounded by MAX_PUT_FILES instead. A ticketed upload is
    // charged on its PUT, not when the URL is signed.
    if (!validateOnly) await requireWriteBudget();
    const contentBase64 = optString(args, "contentBase64");
    const contentUrl = optString(args, "contentUrl");
    let filename = optString(args, "filename");
    const items = optPutFileItems(args);
    const multi = items !== undefined;
    if (upload) {
      // Ticketed: `sign_upload_url` built these args, one file, no content.
      if (multi || contentBase64 !== undefined || contentUrl !== undefined) {
        usage("a signed upload carries no contentBase64, contentUrl, or files");
      }
      if (!filename) usage("filename is required");
    } else if (multi) {
      if (contentBase64 !== undefined || contentUrl !== undefined || filename !== undefined) {
        usage("contentBase64/contentUrl/filename cannot be combined with files");
      }
      if (items.length === 0) usage("files must be a non-empty array");
      if (items.length > MAX_PUT_FILES) {
        usage(`files supports at most ${MAX_PUT_FILES} items per call`);
      }
      if (optString(args, "key")) usage("key cannot be combined with files");
    } else {
      const hasB64 = Boolean(contentBase64);
      const hasUrl = Boolean(contentUrl);
      if (hasB64 === hasUrl) {
        usage("exactly one of contentBase64 or contentUrl is required");
      }
      if (hasUrl) {
        try {
          filename = resolveUploadFilename(contentUrl!, filename, "contentUrl");
        } catch (err) {
          usage(err instanceof Error ? err.message : String(err));
        }
      } else if (!filename) {
        usage("filename is required");
      }
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
    // Ceilings only, no admission decision — `putObject` is what gates
    // SVG/XML acceptance (see `uploadLimits`, guards.ts).
    const limits = uploadLimits(workspace);
    /**
     * Pre-decode ceiling for one file: the loosest the workspace allows
     * (since video may exceed `maxBytes`), *tightened* only when the
     * filename claims a gated type (the SVG/XML rows cap at 4 MiB
     * however high the workspace ceiling is, issue #929). A name
     * claiming an ordinary, ungated type never narrows below the
     * workspace's general ceiling. `putObject`'s `inspectUpload`
     * enforces the content-specific limit against the decoded bytes
     * either way.
     */
    const maxBytesFor = (name: string | undefined): number => {
      const claimed = name ? contentTypeFromKey(name) : undefined;
      const general = Math.max(limits.maxBytes, limits.maxVideoBytes);
      return claimed !== undefined && isGatedContentType(claimed)
        ? Math.min(general, maxBytesForContentType(limits, claimed))
        : general;
    };
    // Uploader attribution (#345): server tags after caller pairs so they
    // can't be spoofed; drop if they'd exceed the key cap.
    // Service tokens (#1026) attribute to their label.
    if (metadata && !validateOnly) {
      metadata = await withUploaderTags(env, metadata, ctx.uploaderIdentity, META_MAX_KEYS);
    }
    const alt = optString(args, "alt");
    const width = optPosInt(args, "width");
    // Strict overwrite (issue #174) only on non-gh/ keys.
    const replaceArg = optBool(args, "replace") === true;
    // Every hosted MCP client can approve a hold with the `approve` tool on
    // this same server, whatever app or version is connecting, so a flagged
    // upload is held here as it is for the CLI (`clientCanApprove`).
    const classify = {
      waitUntil: ctx.waitUntil,
      enforceHold: true,
      classifierHandoff: ctx.classifierHandoff,
    };
    const putOpts =
      metadata !== undefined || replaceArg
        ? { metadata, replace: replaceArg, surface: "mcp" as const, ...classify }
        : { surface: "mcp" as const, ...classify };

    // Resolved at most once per tool call and shared by every file in a
    // batch (same memo shape as `resolveGhPrefixOnce` below): the gate is
    // a workspace-level answer — a Flagship evaluation plus a KV read —
    // so a 20-SVG batch shouldn't pay for it 20 times. Never resolved at
    // all unless some file actually claims a gated type.
    let activeContentPromise: Promise<boolean> | undefined;
    function activeContentOnce(): Promise<boolean> {
      activeContentPromise ??= activeContentAllowed(env, workspace);
      return activeContentPromise;
    }

    /**
     * `putObject` options for one file: the shared bag, plus the
     * active-content gate result when this file's name claims one of the
     * gated SVG/XML types (issue #929). Any other name leaves the gate
     * unresolved — `putObject` wouldn't consult it either.
     */
    async function putOptsForFile(name: string) {
      const claimed = contentTypeFromKey(name);
      if (claimed === undefined || !isGatedContentType(claimed)) return putOpts;
      return { ...putOpts, activeContent: await activeContentOnce() };
    }

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
      ghPrefixPromise ??= resolveGhKeyContext(env, workspaceName, mintingUserId, req);
      return ghPrefixPromise;
    }

    /** Resolve the object key for one filename (+ bytes for the dated layout). */
    async function resolveKey(name: string, bytes: Uint8Array | StreamedBody): Promise<string> {
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
        // A streamed body isn't hashed until it's written, so its key gets a
        // random suffix in place of the content-hash one.
        fileBytes: bytes instanceof Uint8Array ? bytes : crypto.getRandomValues(new Uint8Array(32)),
        prefix,
        repo,
        ref,
        deriveRepoFromGit: false,
      });
    }

    if (validateOnly) {
      // Run the workspace's key policy now, so a disallowed prefix fails when
      // the URL is signed rather than after the whole body has been sent.
      finalizeUploadKey(
        await resolveKey(filename!, crypto.getRandomValues(new Uint8Array(32))),
        workspace,
      );
      return { maxBytes: maxBytesFor(filename) };
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
      // Resolve every item before any write so a bad batch fails whole.
      // Bounded fan-out: 20 parallel Worker fetches would pin isolate RAM.
      const decoded = await mapBounded(items, PUT_CONCURRENCY, async (item, i) => {
        try {
          return await bytesFromPutSource(item, maxBytesFor(item.filename));
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
            await putOptsForFile(item.filename),
          );
          const markdown =
            result.url === null
              ? undefined
              : buildAttachmentMarkdown(item.filename, result.url, {
                  alt: item.alt ?? alt ?? item.filename,
                  width,
                  contentType: result.contentType,
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

    const bytes =
      ticketBytes ??
      (await bytesFromPutSource({ contentBase64, contentUrl }, maxBytesFor(filename)));
    const key = await resolveKey(filename!, bytes);
    const result = await putObject(
      env,
      workspace,
      key,
      bytes,
      workspaceName,
      await putOptsForFile(filename!),
    );
    const markdown =
      result.url === null
        ? undefined
        : buildAttachmentMarkdown(filename!, result.url, {
            alt: alt ?? filename!,
            width,
            contentType: result.contentType,
          });
    // A ticketed upload never syncs the comment: parallel PUTs on a new PR
    // would each create one. The agent calls `comment` once afterwards.
    const extras = ticketBytes ? {} : await afterUploadExtras(true);
    return { workspace: workspaceName, ...result, markdown, ...extras };
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
      name: "feed_create",
      title: "Create change feed",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Create a public newest-first screenshot feed (same product as CLI `uploads feed create`). Pass `repo` alone for the whole GitHub repo. Pass `pr` plus `repo` — or `github` as owner/repo#123 / a GitHub PR URL — to scope that same feed to one pull request. `issue` does the same for an issue. Optional `path` filters by page-path metadata. Creating the same scope again returns the existing URL. This is a live query, not a curated gallery. Anyone who knows the URL can view it. See https://uploads.sh/docs/feeds.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "GitHub owner/repo, for example acme/app. Required unless github is set.",
          },
          pr: {
            type: "integer",
            minimum: 1,
            description:
              "Scope the feed to this pull request. Same product as a repo feed — one extra filter. Mutually exclusive with issue and github.",
          },
          issue: {
            type: "integer",
            minimum: 1,
            description: "Scope the feed to this issue. Mutually exclusive with pr and github.",
          },
          github: {
            type: "string",
            description:
              "Scope via owner/repo#number or a GitHub issue/PR URL. Supplies repo when omitted. Mutually exclusive with pr and issue.",
          },
          path: {
            type: "string",
            description: "Optional exact page-path metadata filter, for example /settings.",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const github = optString(args, "github");
        const repoArg = optString(args, "repo");
        const pr = optPosInt(args, "pr");
        const issue = optPosInt(args, "issue");
        if (pr != null && issue != null) usage("pr and issue are mutually exclusive");
        if (github && (pr != null || issue != null))
          usage("github cannot be combined with pr or issue");
        let repo = repoArg;
        let number: number | undefined;
        let kind: "pull" | "issue" | undefined;
        if (github) {
          const ref = parseGithubIssueRef(github);
          if (!ref) usage("github must be owner/repo#number or a GitHub issue/PR URL");
          if (repo && repo.trim().toLowerCase() !== ref.repo) usage("repo does not match github");
          repo = ref.repo;
          number = ref.number;
          kind = ref.kind;
        } else {
          if (!repo) usage("repo is required");
          if (pr != null) {
            number = pr;
            kind = "pull";
          } else if (issue != null) {
            number = issue;
            kind = "issue";
          }
        }
        const result = unwrapFeedMutation(
          await createFeed(env.DB, {
            workspace: workspaceName,
            repo,
            path: optString(args, "path"),
            number,
            kind,
          }),
        );
        const record = await getFeed(env.DB, workspaceName, result.value.id);
        if (!record) throw new Error("feed not found");
        return hydrateOwnerFeed(env, workspace, record);
      },
    },
    {
      name: "feed_get",
      title: "Get change feed",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "Get a workspace-owned change feed by ID, including its current newest-first screenshots and the canonical public /c/<id> URL. Each item includes pageUrl (`/c/<id>/<item>`) for the pager. The feed may be repo-wide or scoped to one pull request / issue (see `number` and `kind` on the result). Anyone with the URL can view the media.",
      inputSchema: {
        type: "object",
        properties: {
          feedId: { type: "string", description: "Opaque feed ID." },
        },
        required: ["feedId"],
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:read");
        const record = await getFeed(env.DB, workspaceName, requiredString(args, "feedId"));
        if (!record) throw new Error("feed not found");
        return hydrateOwnerFeed(env, workspace, record);
      },
    },
    {
      name: "put",
      title: "Upload file",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description:
        'Upload a file (or files) and get a public URL plus GitHub-ready markdown. Prefer the returned `embedUrl` in GitHub markdown. All uploads are public. Pass `pr`+`repo` to attach to a PR (stable key + managed comment). A result with `holdCheck: "pending"` may still be held for review if it shows a secret; `comment.held` counts files on the PR or issue held for review; see `list_held`. Pass `branch`+`repo` to stage for a PR that does not exist yet. When the bytes are already at a public HTTPS URL, pass `contentUrl` instead of base64 — the server fetches them. Accepts images (PNG, JPEG, GIF, WebP, AVIF), video (MP4, WebM, MOV), PDF, zip, gzip, and text (plain, markdown, CSV, JSON). SVG and XML are accepted only on storage lanes verified to serve them sandboxed (see the workspace\'s storage settings); HTML is rejected.',
      inputSchema: {
        type: "object",
        properties: {
          contentBase64: {
            type: "string",
            description:
              "Base64-encoded file content to upload (must be non-empty). Exactly one of contentBase64, contentUrl, or files is required.",
          },
          contentUrl: {
            type: "string",
            description:
              "Public HTTPS URL of an already-hosted file to fetch and re-host. Filename is optional when the URL path has a leaf. No auth headers are forwarded; private/internal hosts are rejected. Exactly one of contentBase64, contentUrl, or files is required.",
          },
          filename: {
            type: "string",
            description:
              "Filename for the content (drives the key and content type). Required with contentBase64; optional with contentUrl when the URL path has a leaf.",
          },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: {
                  type: "string",
                  description:
                    "Filename for this item (drives the key and content type). Required with contentBase64; optional with contentUrl when the URL path has a leaf.",
                },
                contentBase64: {
                  type: "string",
                  description:
                    "Base64-encoded content for this item (must be non-empty). Exactly one of contentBase64 or contentUrl per item.",
                },
                contentUrl: {
                  type: "string",
                  description:
                    "Public HTTPS URL to fetch for this item. Exactly one of contentBase64 or contentUrl per item.",
                },
                alt: {
                  type: "string",
                  description:
                    "Per-item alt text override (default: top-level alt, then filename).",
                },
              },
              additionalProperties: false,
            },
            description: `Multiple files in one call (max ${MAX_PUT_FILES}). Each item needs contentBase64 or contentUrl. Filename is optional with contentUrl when the URL path has a leaf. Cannot combine with contentBase64, contentUrl, filename, or key.`,
          },
          key: {
            type: "string",
            description: "Override the object key. Cannot combine with `pr`/`issue`/`branch`.",
          },
          ...keyLayoutProps,
          pr: {
            type: "number",
            description:
              "Attach to this pull request (stable `gh/` key). Mutually exclusive with `issue`. Requires `repo`. With `branch`, also promotes that branch's staged files.",
          },
          issue: {
            type: "number",
            description:
              "Attach to this issue (stable `gh/` key). Mutually exclusive with `pr` and `branch`. Requires `repo`.",
          },
          branch: {
            type: "string",
            description:
              "Git branch to stage under (no comment yet). With `pr`, also promote this branch's staged files into the PR. Requires `repo`.",
          },
          comment: {
            type: "boolean",
            description:
              "With `pr` or `issue`: create or update the managed attachments comment after upload. Default true. Pass false to skip. A comment failure never fails the upload.",
          },
          ...putFormatProps,
        },
        additionalProperties: false,
        examples: [
          {
            contentBase64: MCP_EXAMPLE_PNG_BASE64,
            filename: "settings-after.png",
            pr: 12,
            repo: "acme/web",
            state: "after",
          },
          {
            contentBase64: MCP_EXAMPLE_PNG_BASE64,
            filename: "settings-after.png",
            branch: "feat/settings",
            repo: "acme/web",
            state: "after",
          },
          {
            contentUrl: "https://cdn.example/settings-after.png",
            pr: 12,
            repo: "acme/web",
            state: "after",
          },
          {
            files: [
              { filename: "settings-before.png", contentBase64: MCP_EXAMPLE_PNG_BASE64 },
              { filename: "settings-after.png", contentBase64: MCP_EXAMPLE_PNG_BASE64 },
            ],
            pr: 12,
            repo: "acme/web",
          },
        ],
      },
      async handler(args) {
        return runPut(args);
      },
    },
    {
      name: "sign_upload_url",
      title: "Sign upload URLs",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description: `Get short-lived upload URLs so a shell can send files straight from disk, without base64 in the tool call. Use this instead of \`put\` when the files are on a local or sandbox disk and you can run curl. Takes \`put\`'s arguments without the bytes, plus \`files: [{ filename, alt? }]\` (max ${MAX_PUT_FILES}). Run each returned \`curl\` line from the folder holding the file (or swap in its path); the response is the same JSON \`put\` returns, including \`markdown\`. URLs expire after 15 minutes; each takes a file up to its \`maxBytes\` (the workspace's upload limit, at most 100 MB). With \`pr\`/\`issue\`, call \`comment\` once after every upload succeeds. If curl gets a 403 from a proxy, the sandbox blocks agents.uploads.sh: ask the person to allow it, or fall back to \`put\` with contentBase64. All uploads are public.`,
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: {
                  type: "string",
                  description: "File name, extension included (drives the key and content type).",
                },
                alt: {
                  type: "string",
                  description:
                    "Alt text for this file's markdown (default: top-level alt, then filename).",
                },
              },
              required: ["filename"],
              additionalProperties: false,
            },
            description: `Files to upload, one URL each (max ${MAX_PUT_FILES}).`,
          },
          ...keyLayoutProps,
          pr: {
            type: "number",
            description:
              "Attach to this pull request (stable `gh/` key). Mutually exclusive with `issue` and `branch`. Requires `repo`.",
          },
          issue: {
            type: "number",
            description:
              "Attach to this issue (stable `gh/` key). Mutually exclusive with `pr` and `branch`. Requires `repo`.",
          },
          branch: {
            type: "string",
            description:
              "Git branch to stage under, before the PR exists. Requires `repo`. Call `promote` once the PR is open.",
          },
          ...putFormatProps,
        },
        required: ["files"],
        additionalProperties: false,
        examples: [
          {
            files: [{ filename: "settings-before.png" }, { filename: "settings-after.png" }],
            pr: 12,
            repo: "acme/web",
          },
        ],
      },
      async handler(args) {
        requireScope("files:write");
        if (!canSignUploadTickets(env)) {
          throw new Error("signed uploads are not available on this server; use put");
        }
        const items = signUploadFileItems(args);
        if (args.branch !== undefined && (args.pr !== undefined || args.issue !== undefined)) {
          usage("branch cannot be combined with pr or issue here; call promote after uploading");
        }
        const { files: _files, ...shared } = args;
        // Every argument check `put` makes, per file, before anything is signed.
        const planned = await Promise.all(
          items.map(async (item) => {
            const fileArgs: Record<string, unknown> = { ...shared, filename: item.filename };
            if (item.alt !== undefined) fileArgs.alt = item.alt;
            const checked = await runPut(fileArgs, { validateOnly: true });
            const maxBytes = Math.min(
              (checked as { maxBytes: number }).maxBytes,
              SIGNED_UPLOAD_MAX_BYTES,
            );
            return { item, fileArgs, maxBytes };
          }),
        );
        // The upload origin is the one this request came in on (agents.uploads.sh
        // in production), so the sandbox only needs the MCP host allowed.
        const origin = new URL(ctx.resourceMetadataUrl).origin;
        const now = Date.now();
        const expiresAt = new Date(now + UPLOAD_TICKET_TTL_S * 1000).toISOString();
        const uploads = await Promise.all(
          planned.map(async ({ item, fileArgs, maxBytes }) => {
            const signed = await signUploadTicket(
              env,
              { ws: workspaceName, who: ctx.uploaderIdentity, args: fileArgs, maxBytes },
              now,
            );
            const uploadUrl = `${origin}/u/${signed.ticket}`;
            return {
              file: item.filename,
              uploadUrl,
              curl: `curl -sS --fail-with-body -T ${shellQuote(item.filename)} '${uploadUrl}'`,
              maxBytes,
            };
          }),
        );
        const next =
          args.pr !== undefined || args.issue !== undefined
            ? "After every upload succeeds, call `comment` with the same repo and pr/issue to update the attachments comment."
            : args.branch !== undefined
              ? "Files are staged for the branch. Once the PR is open, call `promote` with repo, pr, and branch."
              : undefined;
        return {
          workspace: workspaceName,
          expiresAt,
          uploads,
          ...(next ? { next } : {}),
          hint: "If curl fails with a 403 from a proxy, this sandbox blocks agents.uploads.sh. Ask the person to allow it in the environment's network settings, or fall back to put with contentBase64.",
        };
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
    ...activityReadTools({ env, workspace, workspaceName, requireScope }),
    {
      name: "unstage",
      title: "Unstage files",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Clear staged files for a branch, or specific keys, without deleting them. Sets gh.status=unstaged so they drop out of auto-promotion. Pass repo and branch, or keys. Needs files:write.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: hostedRepoRequired },
          branch: {
            type: "string",
            description:
              "Branch whose staged files to clear. Requires repo. Do not combine with keys.",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            description: "Object keys to unstage. Do not combine with branch.",
          },
          dryRun: {
            type: "boolean",
            description: "Report what would change without writing.",
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const branch = branchFromArgs(args);
        const keys = optStringArray(args, "keys");
        const repo = optString(args, "repo");
        const dryRun = optBool(args, "dryRun");
        if (keys && keys.length > 0 && branch) usage("pass keys or branch, not both");
        if ((!keys || keys.length === 0) && !branch) usage("branch or keys is required");
        if (branch && !repo) usage("repo is required with branch");
        if (repo && !validRepoGrammar(repo)) usage("repo must be owner/name");
        return unstageGithubFiles(env, workspace, workspaceName, {
          repo,
          branch,
          keys,
          dryRun,
        });
      },
    },
    {
      name: "delete",
      title: "Delete file",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthDelete,
      description:
        "Permanently delete one uploaded file by key, along with its metadata. A files:write token can delete a gh/ object the server stamped as its upload. Older files and any other object need files:delete. Deleting a PR or issue attachment refreshes the managed comment.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to delete." },
        },
        required: ["key"],
        additionalProperties: false,
      },
      async handler(args) {
        const key = optString(args, "key");
        if (!key) usage("key is required");
        if (badKey(key)) throw new ValidationError("invalid key", { code: "invalid_key" });
        const attachment =
          /^gh\/(?:[^/]+\/[^/]+|private\/[0-9a-f]{32})\/(?:pull|issues)\/[1-9][0-9]*\//.test(key);
        const metadata =
          attachment || !ctx.authScopes.includes("files:delete")
            ? await getFileMetadata(env.DB, workspaceName, key)
            : undefined;
        try {
          await assertDeleteAllowed({
            db: env.DB,
            workspaceName,
            key,
            scopes: ctx.authScopes,
            identity: ctx.uploaderIdentity,
            metadata,
          });
        } catch (err) {
          if (err instanceof InsufficientScopeError) {
            throw insufficientScopeError(ctx.resourceMetadataUrl, "files:delete");
          }
          throw err;
        }
        await requireWriteBudget();
        const target = attachmentCommentTarget(key, metadata ?? {});
        const result = await deleteObject(env, workspace, key, workspaceName);
        if (!target) return result;
        const flag = target.kind === "pull" ? "--pr" : "--issue";
        const commentHint = `uploads comment ${flag} ${target.num}`;
        try {
          const comment = await postManagedComment(
            env,
            workspace,
            workspaceName,
            mintingUserId,
            target,
            { resync: true },
          );
          if (comment.posted) return { ...result, commentRefreshed: true };
        } catch {
          // The object is already gone. The hint is the recovery.
        }
        return { ...result, commentRefreshed: false, commentHint };
      },
    },
    {
      name: "comment",
      title: "Sync attachments comment",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthRead,
      description:
        "Refresh the managed attachments comment on a GitHub PR or issue without re-uploading. Use after deleting media. Requires `repo` and exactly one of `pr`/`issue`. `held` counts files there held for review; see `list_held`.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: hostedRepoRequired,
          },
          pr: {
            type: "number",
            description: "Pull request number. Mutually exclusive with issue.",
          },
          issue: { type: "number", description: "Issue number. Mutually exclusive with pr." },
        },
        required: ["repo"],
        additionalProperties: false,
        examples: [{ repo: "acme/web", pr: 12 }],
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
        return postManagedComment(env, workspace, workspaceName, mintingUserId, target, {
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
        "Copy staged or existing files into a PR's stable `gh/…/pull/…` prefix, then refresh the managed comment. Pass `branch` and/or `keys`. Requires `repo` and `pr`.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: hostedRepoRequired,
          },
          pr: {
            type: "number",
            description: "Pull request number to promote/attach into. Never applies to issues.",
          },
          branch: {
            type: "string",
            description: "Staged branch to copy into the PR.",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 20,
            description:
              "Already-uploaded object keys or uploads.sh URLs to copy into the PR. One bad source does not abort the rest.",
          },
          move: {
            type: "boolean",
            description:
              "For `keys` only: delete each source after a successful copy. Default false. Ignored for the branch sweep.",
          },
          comment: {
            type: "boolean",
            description:
              "Refresh the managed attachments comment after a successful copy. Default true. A comment failure never fails the copy.",
          },
        },
        required: ["repo", "pr"],
        additionalProperties: false,
        examples: [
          { repo: "acme/web", pr: 12, branch: "feat/settings" },
          { repo: "acme/web", pr: 12, keys: ["screenshots/hero.png"] },
        ],
      },
      async handler(args) {
        requireScope("files:write");
        await requireWriteBudget();
        const repo = requiredString(args, "repo");
        if (!validRepoGrammar(repo)) usage("repo must be owner/name");
        const pr = optPosInt(args, "pr");
        if (pr === undefined) usage("pr is required");
        const branch = branchFromArgs(args);
        const keys = optStringArray(args, "keys");
        if (branch === undefined && (keys === undefined || keys.length === 0)) {
          usage("at least one of branch or keys is required");
        }
        if (branch !== undefined) {
          // Validate branch is stageable (metadata rules) before the copy.
          branchMetadata(repo, branch);
        }
        const move = optBool(args, "move") ?? false;

        const commentArg = args.comment == null ? undefined : optBool(args, "comment");
        if (commentArg === true) requireScope("files:read");
        const wantComment = commentArg ?? ctx.authScopes.includes("files:read");

        // Primary job — failures throw (isError), unlike put's best-effort promote.
        const promotion =
          branch !== undefined
            ? await postPromoteBranchAttachments(env, workspace, workspaceName, mintingUserId, {
                repo,
                num: pr,
                branch,
              })
            : undefined;

        // Explicit keys (issue #702): each copy is independent — one bad
        // source degrades to attachFailures rather than aborting the batch,
        // same "one bad item doesn't abort the rest" posture as put/attach's
        // multi-file paths. Each successful attach already syncs its own
        // comment server-side (postAttachExisting), so `comment`/`wantComment`
        // below only covers the branch-sweep promotion path.
        let attached: AttachExistingResponse[] | undefined;
        let attachFailures: { key: string; error: ReturnType<typeof errorDetail> }[] | undefined;
        if (keys !== undefined && keys.length > 0) {
          attached = [];
          attachFailures = [];
          for (const source of keys) {
            try {
              attached.push(
                await postAttachExisting(env, workspace, workspaceName, mintingUserId, {
                  source,
                  target: { repo, kind: "pull", num: pr },
                  move,
                }),
              );
            } catch (err) {
              attachFailures.push({ key: source, error: errorDetail(err) });
            }
          }
        }

        const commentResult = wantComment
          ? await attachComment({ repo, kind: "pull", num: pr })
          : undefined;
        // Explicit-undefined values (not just absent keys) trip the SDK's
        // structured-content validator ("Instances of \"undefined\" type are
        // not supported") — omit rather than include-as-undefined.
        return {
          ...(promotion !== undefined ? { promotion } : {}),
          ...(attached !== undefined ? { attached } : {}),
          ...(attachFailures !== undefined ? { attachFailures } : {}),
          ...commentResult,
        };
      },
    },
    {
      name: "get_metadata",
      title: "Get metadata",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description: "Read the queryable tags on one file. Returns `{ metadata }` (empty when none).",
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
        const key = requiredString(args, "key");
        if (badKey(key)) usage("invalid key");
        const metadata = await getFileMetadata(env.DB, workspaceName, key);
        // A held file's bytes may have left the bucket; its rows still answer.
        if (!isHeld(metadata) && !(await (await storage(env, workspace)).exists(key))) {
          throw new NotFoundError("object not found");
        }
        return { metadata };
      },
    },
    {
      name: "list_held",
      title: "List held files",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "List uploads held for review. The classifier holds a file it thinks shows a secret (an API key, a password, a token) or sensitive personal data (an ID, a card number). A held file stays out of the managed PR comment, feeds, galleries, and its /f/ page, and its raw URL may 404, until a workspace member approves it with `approve`. Pass `pr`/`issue` + `repo` for one PR or issue, or `prefix`. Each item has `reason` (`secret: api_key`, `pii: financial`) and `area`, an approximate box around the flagged content as fractions of the image (null when unknown).",
      inputSchema: {
        type: "object",
        properties: {
          pr: { type: "number", description: "Held files on this pull request." },
          issue: { type: "number", description: "Held files on this issue." },
          repo: { type: "string", description: hostedRepoRequired },
          prefix: { type: "string", description: "Only keys under this prefix." },
        },
        additionalProperties: false,
        examples: [{ pr: 12, repo: "acme/web" }],
      },
      async handler(args) {
        requireScope("files:read");
        return { items: await heldFiles(ghTargetFromArgs(args), optString(args, "prefix")) };
      },
    },
    {
      name: "approve",
      title: "Approve held files",
      annotations: mcpWritePublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Release uploads held for review (see `list_held`): pass `keys`, or `pr`/`issue` + `repo` to approve every held file there. The file returns at the same URL and the managed PR comment re-syncs. Check the file first: if it shows a real credential, rotate it and delete the file instead of approving. Same as `uploads approve`.",
      inputSchema: {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, description: "Held keys to approve." },
          pr: { type: "number", description: "Approve every held file on this pull request." },
          issue: { type: "number", description: "Approve every held file on this issue." },
          repo: { type: "string", description: hostedRepoRequired },
        },
        additionalProperties: false,
        examples: [{ keys: ["gh/acme/web/pull/12/settings.png"] }, { pr: 12, repo: "acme/web" }],
      },
      async handler(args) {
        requireScope("files:write");
        const keys = optStringArray(args, "keys") ?? [];
        const target = ghTargetFromArgs(args);
        if (keys.length > 0 && target) usage("pass keys or pr/issue, not both");
        if (keys.length === 0 && !target) usage("approve requires keys or pr/issue");
        for (const key of keys) if (badKey(key)) usage(`invalid key: ${key}`);
        await requireWriteBudget();
        const toApprove = target
          ? await heldFiles(target)
          : keys.map((key) => ({ key, reason: undefined }));
        const by = await approverLabel(env, ctx.uploaderIdentity);
        const files = [];
        for (const { key, reason } of toApprove) {
          const result = await approveUpload(env, workspace, workspaceName, key, by);
          files.push({
            key,
            action: result.approved ? "approved" : "not_held",
            ...(reason ? { reason } : {}),
          });
        }
        return { files };
      },
    },
    {
      name: "set_metadata",
      title: "Set metadata",
      annotations: mcpDestroyPublic,
      securitySchemes: mcpOAuthWrite,
      description:
        "Set or delete queryable tags on an existing file. `set` wins over `delete` for the same key. Tags appear on the public file page — do not store secrets. Requires `set` and/or `delete`.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Object key to update." },
          set: {
            ...metadataProp,
            description: "Keys to set or overwrite. " + METADATA_PATH_CUE,
          },
          delete: {
            type: "array",
            items: { type: "string" },
            description: "Keys to remove.",
          },
        },
        required: ["key"],
        additionalProperties: false,
        examples: [{ key: "screenshots/settings.png", set: { path: "/settings", state: "after" } }],
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
        "Search files by metadata (`filters`) and/or filename substring (`name`). At least one is required.",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            ...metadataProp,
            description:
              "Equality filters; all must match. " +
              METADATA_PATH_CUE +
              " Optional when `name` is set.",
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
          cursor: {
            type: "string",
            description:
              "Opaque continuation from a previous call's `cursor`. Pass it back unchanged with the same filters/name to get the next page; a null `cursor` means there are no more pages.",
          },
        },
        additionalProperties: false,
        examples: [{ filters: { path: "/settings", state: "after" } }, { name: "hero.png" }],
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
            ...(optString(args, "cursor") ? { cursor: optString(args, "cursor")! } : {}),
          }),
        ]);
        const items = result.matches.map((match) => ({
          key: match.key,
          url: publicUrl(cfg, match.key),
          metadata: match.metadata,
        }));
        // Meta-only keeps the pre-#528 shape (no truncated). `cursor` was
        // always present and always null; it now carries the continuation
        // token when more pages exist (issue #829 §4).
        if (nameTerm === undefined) return { items, cursor: result.cursor };
        return { items, cursor: result.cursor, truncated: result.truncated };
      },
    },
    {
      name: "list_metadata_keys",
      title: "List metadata keys",
      annotations: mcpRead,
      securitySchemes: mcpOAuthRead,
      description:
        "List metadata keys in the workspace (with counts). Pass `key` to list that key's values instead. Use before `find_files`.",
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
      name: "search_docs",
      title: "Search uploads.sh docs",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      securitySchemes: mcpNoAuth,
      description: SEARCH_DOCS_DESCRIPTION,
      inputSchema: SEARCH_DOCS_INPUT_SCHEMA,
      handler: runSearchDocsTool,
    },
    {
      name: "changelog",
      title: "Product changelog",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      securitySchemes: mcpNoAuth,
      description:
        "Read recent uploads.sh product updates (platform and CLI). Returns the latest entries with titles, dates, summaries, and a link to the full changelog at https://uploads.sh/changelog. Same as `uploads changelog`.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: `How many entries to return (default ${DEFAULT_CHANGELOG_LIMIT}, max ${MAX_CHANGELOG_LIMIT}).`,
          },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const limit = optPosInt(args, "limit") ?? DEFAULT_CHANGELOG_LIMIT;
        if (limit > MAX_CHANGELOG_LIMIT) usage(`limit must be ${MAX_CHANGELOG_LIMIT} or less`);
        return fetchChangelog({ limit });
      },
    },
    {
      name: "whoami",
      title: "Who am I",
      annotations: mcpRead,
      securitySchemes: mcpOAuthAny,
      description:
        "Show the current uploads.sh identity: the workspace this token acts in and its scopes. A successful result also means the server is up.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        return {
          ok: true,
          workspace: workspaceName,
          scopes: [...ctx.authScopes],
          userId: mintingUserId,
          ...(ctx.uploaderIdentity.kind === "service"
            ? { serviceToken: { label: ctx.uploaderIdentity.label } }
            : {}),
        };
      },
    },
  ];
  return { tools: withOutputSchemas(tools, hostedOutputSchemas, { required: true }), runPut };
}
