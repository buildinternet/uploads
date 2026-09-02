import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { mapBounded } from "./async.js";
import {
  createUploadsClient,
  type AttachExistingResult,
  type GalleryItem,
  type GithubCommentResult,
  type GithubHealthResult,
  type PromoteBranchAttachmentsResult,
  type PutResult,
  type ResolveGhPrefixOptions,
  type ResolveGhPrefixResult,
  type RotateGhPrefixResult,
  type UploadsClient,
} from "./client.js";
import {
  parseCommandArgs,
  flagString,
  flagBool,
  flagInt,
  flagValues,
  UsageError,
  type CommandFlags,
} from "./cli-args.js";
import {
  resolvePutDefaults,
  workspaceMismatch,
  workspaceFromToken,
  type ResolvedConfig,
} from "./config.js";
import { buildUploadMarkdown, inferContentType } from "./embed.js";
import { readLocalRepoCommentConfig, resolveCommentOptions } from "./comment-config.js";
import { urlForGithubEmbed } from "./public-urls.js";
import { UploadsError } from "./errors.js";
import { fetchUploadSource, resolveUploadFilename } from "./fetch-upload-source.js";
import { writeJson, writeStdout } from "./io.js";
import { imageFactsFromBytes } from "./image-facts.js";
import { parseMetaFlags, validateMetaMap } from "./metadata.js";
import { mergeDerivedMeta, nearMissMetaWarnings, validateStateValue } from "./metadata-vocab.js";
import { mergeSidecarMeta } from "./sidecar.js";
import {
  ghAttachmentKeyForMode,
  ghBranchAttachmentKeyForMode,
  ghBranchKeyPrefix,
  ghKeyPrefix,
  ghPrivateKeyPrefix,
  ghPrivateBranchKeyPrefix,
  ghMetadataFromTarget,
  parseGhKey,
  parseGhPrivateKey,
  ghMetadataForBranch,
  attachmentsCommentBody,
  attachmentsMarker,
  AUTO_RENDER_OPTIONS,
  GH_FALLBACK_AUTHOR_NOTE,
  type CommentRenderOptions,
  type GhTarget,
  type AttachmentItem,
  type GalleryCommentItem,
  normalizeGithubCoordinate,
} from "./github.js";
import {
  resolveRepo,
  resolveCurrentPullRequest,
  resolveCurrentBranch,
  resolveCurrentBranchSafe,
  resolveDefaultBranch,
  classifyGhNumber,
  execRunner,
  timedExecRunner,
  ghMetadataFromTargetWithTitle,
  upsertAttachmentsComment,
  hasLinkCandidate,
  extractCandidateUrls,
  fetchAdoptionCandidateText,
  renameLineageFromReflog,
  type CommandRunner,
} from "./github-gh.js";
import { deriveRepoFromGit, deriveRepoSlugFromGit } from "./keys.js";
import { noProjectContextNudge } from "./project-context-nudge.js";
import { resolvePutPrefix } from "./destinations.js";
import {
  optimizeImageForUpload,
  rewriteKeyExtension,
  type OptimizeImageOptions,
  type OptimizeImageResult,
} from "./optimize.js";
import { applyFrame, resolveFrameId, type FrameResult } from "./frame.js";
import { buildCliProvenance } from "./provenance.js";
import { formatByteSize } from "./format-bytes.js";
import { formatUsageHuman } from "./format-usage.js";
import { packageVersion } from "./package-version.js";
import type { PutDefaults } from "./config-file.js";
import type { DetectRoots } from "./screenshot-local.js";
import { colorEnabled, writeCommandHelp } from "./cli-style.js";

/** Parallel fan-out for multi-file put/attach (matches files-sdk bulk default). */
export const UPLOAD_BATCH_CONCURRENCY = 8;
/** @deprecated Use UPLOAD_BATCH_CONCURRENCY. */
export const ATTACH_CONCURRENCY = UPLOAD_BATCH_CONCURRENCY;

/**
 * Fail-open wrapper around `client.resolveGhPrefix` (issue #631): resolves to
 * `{ mode: "plain" }` on ANY failure — an HTTP/network error (already handled
 * inside `resolveGhPrefix` itself), or a self-hosted/older server or test
 * double that lacks the method entirely (the outer try/catch here). Never
 * blocks an upload or a read-back, and never logs — this is not an error.
 * Call once per command invocation and thread the resolved mode through
 * (uploadPuts/uploadAttachments/uploadBranchAttachments each do this once
 * internally, ahead of their per-file loop); `resolveGhPrefix` itself also
 * caches per-process by repo+branch+target, so repeat callers in the same
 * process (e.g. attach's promote + comment-sync + upload, all for the same
 * target) cost one request total.
 */
export async function resolveGhPrefixSafe(
  client: UploadsClient,
  opts: ResolveGhPrefixOptions,
): Promise<ResolveGhPrefixResult> {
  try {
    return await client.resolveGhPrefix(opts);
  } catch {
    return { mode: "plain" };
  }
}

/**
 * The list of prefixes to fan a multi-prefix list/gather across (issue
 * #631): the plain prefix plus every active private prefix, if any — a
 * repo's history can be split across the plain shape and MULTIPLE private
 * prefixes (e.g. a prefix rotation, or the repo went private after some
 * files were uploaded), not just the currently-resolved one. Falls back to
 * `[prefixId]` when the server omits `activePrefixIds` (optional field — an
 * older/self-hosted worker), so a private repo is never listed as zero
 * private prefixes. Collapses to `[plainPrefix]` in plain mode, so callers
 * that special-case a single-prefix array stay byte-identical to pre-#631.
 */
export function ghListPrefixes(
  plainPrefix: string,
  ghPrefix: ResolveGhPrefixResult,
  privatePrefixFor: (prefixId: string) => string,
): string[] {
  if (ghPrefix.mode !== "private") return [plainPrefix];
  return [plainPrefix, ...(ghPrefix.activePrefixIds ?? [ghPrefix.prefixId]).map(privatePrefixFor)];
}

/**
 * Merge-list helper for a multi-prefix fan-out: runs `fetchItems` per prefix
 * concurrently and concatenates in prefix order. Encodes the first-prefix-
 * only cursor rule once — a cursor is opaque and scoped to the prefix it was
 * minted against, so a multi-prefix merge only ever hands it to the FIRST
 * prefix; every other prefix always starts from its own beginning (undefined
 * cursor), or a cursor minted for one prefix's keyspace would get replayed
 * against a different one.
 */
export async function ghMergedList<T>(
  prefixes: readonly string[],
  cursor: string | undefined,
  fetchItems: (prefix: string, cursor: string | undefined) => Promise<T[]>,
): Promise<T[]> {
  const pages = await Promise.all(
    prefixes.map((prefix, i) => fetchItems(prefix, i === 0 ? cursor : undefined)),
  );
  return pages.flat();
}

export { formatUsageHuman } from "./format-usage.js";

export interface CliContext {
  config: ResolvedConfig;
  client: UploadsClient;
  json: boolean;
  quiet: boolean;
  envFile?: string;
}

/** Read a local file (or `-` for stdin). Missing path → FILE_NOT_FOUND (exit 2). */
export function readFileArg(fileArg: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(fileArg === "-" ? 0 : fileArg));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new UploadsError(`file not found: ${fileArg}`, "FILE_NOT_FOUND");
    }
    throw err;
  }
}

// --- put ---

const PUT_HELP = `uploads put <file...> [options]
uploads put --url <url> [options]

Upload one or more images for GitHub embeds. Use "-" for stdin (single file only).
Pass --url (repeatable) to fetch a file instead of a local path. Public HTTPS,
or http://localhost / 127.0.0.1 / *.localhost on this machine. Other private
hosts are rejected. The filename comes from the URL path, or --name.

Multiple files upload in parallel (bounded concurrency). One bad file does not
block the rest; multi-file JSON is { uploads, failures } (exit 1 when any failed).
Single-file JSON stays a flat object (back-compat).

Still images (PNG/JPEG/…) are optimized to WebP by default (long edge capped,
high quality; EXIF stripped) so GitHub embeds stay lean. Original bytes are kept
when they are already smaller, animated, or not an image. Use --no-optimize to
upload as-is, or --keep-exif when image metadata matters for the discussion.
Non-media files (PDF, zip, gzip, logs, JSON, CSV, markdown) upload as-is and
show up in the managed comment as links. HTML and SVG are rejected.

Optional --frame wraps the image in a device/browser chrome before optimize
(default off). See: uploads put --help frames

If the file has a sidecar manifest (<file>.uploads.json, written by
"screenshot --out") and its content hash still matches this file, that
capture's derived metadata (path/url/env/viewport/state) is merged in
automatically — explicit --meta/--state always win. A regenerated or edited
file loses its sidecar silently (hash no longer matches).

Uploads are public. --pr/--issue keys include the repo, number, and filename and
remain public even for private/internal GitHub repositories. Upload only media
that is safe at a predictable public URL.

Overwrite semantics depend on the key (issue #174): --pr/--issue always
hot-swap in place (no prompt) so embeds stay stable — human mode prints
">> replaced existing object (same URL)" after a real put, or ">> would
replace existing object (same URL)" on --dry-run. Every other key (--key, or
the default put path) is strict: re-uploading to an existing key REFUSES with
a "key_exists" error (JSON includes the existing object's url) unless you
pass --replace, or set UPLOADS_OVERWRITE=1 to restore old always-overwrite
behavior for those paths. --dry-run reports ">> would refuse: key already
exists" instead of writing.

Human/json output includes durable url and (when dual-host applies) embedUrl.
MARKDOWN prefers embedUrl for GitHub. Override: UPLOADS_EMBED_PUBLIC_BASE_URL.

Options:
  --key <key>           Object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.<ext>). Single file only
  --name <leaf>         Clean key leaf + default alt (no '/'); keeps --pr/default path. Single file only. Not with --key
  --url <url>           Fetch this URL and upload its body (repeatable). Public HTTPS, or http://localhost on the CLI. Not with file arguments
  --destination <id>    Typed root: screenshots | gh | f (sets --prefix)
  --prefix <path>       Key prefix (default: screenshots, or UPLOADS_DEFAULT_PREFIX)
  --repo <owner/repo>   Repo segment (default: git remote, or UPLOADS_DEFAULT_REPO)
  --ref <id>            PR/issue/branch segment (default: today, or UPLOADS_DEFAULT_REF)
  --alt <text>          Alt text (default: each file's name; with multiple files applies to all)
  --width <px>          <img width=…> markdown (or UPLOADS_DEFAULT_WIDTH)
  --content-type <mime> Override Content-Type (ignored when optimize rewrites the body)
  --frame <id>          Device/browser frame before optimize (phone|browser|iphone-16-pro)
  --frame-url <url>     Address bar text for --frame browser
  --frame-fit cover|contain  How the shot fills the screen (default: cover)
  --no-optimize         Skip client-side image optimization (or UPLOADS_NO_OPTIMIZE=1)
  --optimize-max-edge <px>  Max long edge when optimizing (default: 2400)
  --optimize-quality <1-100>  WebP quality (default: 85)
  --keep-exif           Keep EXIF/XMP/ICC when optimizing (default: strip for privacy)
  --no-git              Don't derive --repo from git (or UPLOADS_NO_GIT=1)
  --auto                Resolve current PR/issue and stamp gh.* metadata (default on)
  --no-auto             Skip gh.* auto-resolution (also skipped by --no-git or UPLOADS_NO_AUTO_META=1)
  --no-pr               Skip auto-PR context (or UPLOADS_NO_AUTO_PR=1) — see below
  --workspace, -w <name>  Override workspace (wins over UPLOADS_WORKSPACE and token inference)
  --format human|url|markdown|json
  --pr <num>            Attach to a pull request: key gh/<owner>/<repo>/pull/<num>/<name> (stable URL, no hash)
  --issue <num>         Attach to an issue: key gh/<owner>/<repo>/issues/<num>/<name>
  --comment             With --pr/--issue, the managed comment sync runs by
                        default; --comment is accepted as a no-op for
                        back-compat (kept redundant with the default).
  --no-comment          With --pr/--issue: skip updating the managed comment
                        with attachments and linked galleries. Otherwise it
                        posts as uploads-sh[bot] when the GitHub App is
                        installed, or via local gh as a fallback.
  --gallery <id>         Add the uploaded object(s) to this public gallery
  --meta <k=v>          Queryable custom metadata (repeatable; value may contain "="): key ^[a-z][a-z0-9._-]{0,63}$, value 1-512 printable ASCII, max 24 pairs
                        Re-uploading to an existing key WITH --meta replaces that file's
                        entire metadata set; without --meta the existing metadata is
                        preserved. Use "uploads meta set" to edit individual keys.
  --state <s>           before|after|empty|error|loading — the UI state shown (sets meta state=)
  --app <name>          Surface shown: web, ios, android, cli (sets meta app=)
  --replace             Allow overwriting an existing object on a strict (--key/default) key
                        (or UPLOADS_OVERWRITE=1). No effect on --pr/--issue, which always overwrite.
  --dry-run             Print key + public URL without uploading; reports if the key would replace
                        (or, on a strict key, be refused). Not with --gallery

A bare put (no --pr/--issue/--key/--ref/--prefix/--destination) on a git branch
that maps to exactly one open PR now behaves as if --pr <n> had been passed
(issue #700): stable gh/ key, managed comment sync — instead of the #403
branch-staging default. A one-line note announces this (stderr in human mode,
the "hint" field in --format json). Opt out with --no-pr, UPLOADS_NO_AUTO_PR=1,
or config UPLOADS_NO_AUTO_PR=1; never fires outside a git repo, on the default
branch, with --no-git, or when no single open PR can be resolved (falls back to
branch staging, then the plain dated layout). When it doesn't fire and the
upload lands on the dated layout with a detectable PR, a similar one-line nudge
names the PR and a ready-made follow-up (uploads attach --pr <n> <key>...).
Suppress either note with --quiet, UPLOADS_NO_NUDGE=1, or config UPLOADS_NO_NUDGE=1.

Exit codes: 0 ok · 2 usage/token/file · 3 auth/policy · 4 network · 1 other (incl. partial multi-file failure).
Scripted formats (json|url|markdown) also print failures on stdout.

Examples:
  uploads put ./shot.png --repo myorg/myapp --ref 1722 --alt "New cards" --width 700
  uploads put ./before.png ./after.png
  uploads put ./mobile.png --frame phone
  uploads put ./ui.png --frame browser --frame-url "https://app.example/settings"
  uploads put ./shot.png --destination screenshots
  uploads put ./capture-….webp --pr 128 --name hero.webp
  uploads put ./shot.png --pr 128 --name hero.webp --dry-run --format url
  uploads put ./after.png --gallery gal_example
  uploads put ./shot.png --meta path=/settings --state after --app web
  uploads put --url https://cdn.example/shot.png --pr 128 --name hero.png
  uploads put --url http://localhost:4321/shot.png
`;

/**
 * Turns a pr/issue pair (+ optional repo) into a GhTarget; undefined when
 * neither is present. Shared by the CLI flags and the MCP tool arguments.
 */
export function makeGhTarget(
  pr: number | undefined,
  issue: number | undefined,
  repoArg: string | undefined,
  run: CommandRunner,
): GhTarget | undefined {
  if (pr === undefined && issue === undefined) return undefined;
  if (pr !== undefined && issue !== undefined) {
    throw new UsageError("--pr and --issue are mutually exclusive");
  }
  const repo = resolveRepo(repoArg, run);
  return { repo, kind: pr !== undefined ? "pull" : "issues", num: (pr ?? issue) as number };
}

/** Reads --pr/--issue (+ --repo) into a GhTarget; undefined when neither flag is present. */
export function ghTargetFromFlags(
  flags: CommandFlags["flags"],
  run: CommandRunner,
): GhTarget | undefined {
  return makeGhTarget(
    flagInt(flags, "--pr", "--pr"),
    flagInt(flags, "--issue", "--issue"),
    flagString(flags, "--repo"),
    run,
  );
}

/**
 * Extensions that mark a `--branch` value as almost certainly a filename that
 * got swallowed by the optional-value lookahead (e.g. `--branch shot.png`
 * with no other file args). Branch names legitimately contain dots (e.g.
 * `release/1.2`, `v1.2.3`), so this only matches known media/document
 * extensions, never bare dotted segments.
 */
const BRANCH_LIKE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
  ".tif",
  ".tiff",
  ".heic",
  ".avif",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mkv",
  ".pdf",
]);

/**
 * True when `value` looks like a filename that was mistakenly consumed as the
 * `--branch` value: it names a file that exists on disk, or its extension is
 * a known media/document type. Ordinary branch names (including dotted ones
 * like `v1.2` or `release/1.2`) never match either check.
 */
function looksLikeFileNotBranch(value: string): boolean {
  if (existsSync(value)) return true;
  return BRANCH_LIKE_FILE_EXTENSIONS.has(extname(value).toLowerCase());
}

/**
 * Reads `--branch [name]` — an optional-value flag: `--branch` alone resolves
 * the current git branch (`resolveCurrentBranch`); `--branch feature/x` uses
 * the given name verbatim. Returns undefined when the flag is absent at all
 * (distinct from an empty/whitespace value, which is rejected). Throws
 * UsageError if `--branch` is given more than once, or if the value looks
 * like a filename accidentally swallowed by the optional-value lookahead
 * (e.g. `uploads attach --branch shot.png` with no other file args) — see
 * `looksLikeFileNotBranch`.
 */
export function branchFromFlags(
  flags: CommandFlags["flags"],
  run: CommandRunner,
): string | undefined {
  if (!flags.has("--branch")) return undefined;
  const raw = flags.get("--branch");
  if (Array.isArray(raw)) throw new UsageError("--branch may only be given once");
  if (raw === true) return resolveCurrentBranch(run);
  if (typeof raw === "string" && raw.trim().length > 0) {
    if (looksLikeFileNotBranch(raw)) {
      throw new UsageError(
        `"${raw}" looks like a file, not a branch name — did you mean ` +
          `"uploads attach ${raw} --branch" (auto-detect the current branch), ` +
          `or "uploads attach --branch <name> ${raw}" (explicit branch name)?`,
      );
    }
    return raw;
  }
  throw new UsageError("--branch requires a non-empty branch name");
}

/**
 * Best-effort GitHub target for the default put path (no --pr/--issue). A
 * numeric --ref is classified as pull vs issue; otherwise the current branch's
 * PR is resolved. Never throws — any failure yields undefined so the upload
 * proceeds without gh metadata.
 */
function resolveAutoGhTarget(
  repoArg: string | undefined,
  ref: string | undefined,
  run: CommandRunner,
): GhTarget | undefined {
  try {
    const repo = resolveRepo(repoArg, run);
    if (ref !== undefined && /^\d+$/.test(ref) && Number(ref) > 0) {
      return classifyGhNumber(repo, Number.parseInt(ref, 10), run);
    }
    return resolveCurrentPullRequest(repo, run);
  } catch {
    return undefined;
  }
}

/** Shared put/attach optimize flags + UPLOADS_NO_OPTIMIZE default. */
export function optimizeOptionsFromFlags(
  flags: CommandFlags["flags"],
  defaults: PutDefaults,
): OptimizeImageOptions {
  if (flags.has("--no-optimize") && typeof flags.get("--no-optimize") === "string") {
    throw new UsageError("--no-optimize takes no value");
  }
  if (flags.has("--keep-exif") && typeof flags.get("--keep-exif") === "string") {
    throw new UsageError("--keep-exif takes no value");
  }
  const quality = flagInt(flags, "--optimize-quality", "--optimize-quality");
  if (quality !== undefined && quality > 100) {
    throw new UsageError("invalid --optimize-quality: must be 1–100");
  }
  return {
    enabled: !(flagBool(flags, "--no-optimize") || defaults.noOptimize === true),
    maxEdge: flagInt(flags, "--optimize-max-edge", "--optimize-max-edge"),
    quality,
    keepExif: flagBool(flags, "--keep-exif") || defaults.keepExif === true,
  };
}

/**
 * Whether the derived-metadata tier is on — screenshot capture facts and EXIF
 * promotion. `--no-auto` and `UPLOADS_NO_AUTO_META=1` turn it off; `--auto`
 * forces past the config default.
 *
 * Deliberately *not* gated on `--no-git`. That flag means "don't shell out to
 * git", which says nothing about a viewport or a URL path — a capture of a
 * local .html file outside any repo should still record what it captured.
 * `--no-git` still disables gh.* below, which genuinely needs a repo.
 */
export function derivedMetaEnabled(
  flags: CommandFlags["flags"],
  defaults: Pick<PutDefaults, "noAutoMeta">,
): boolean {
  return (
    !flagBool(flags, "--no-auto") && (flagBool(flags, "--auto") || defaults.noAutoMeta !== true)
  );
}

/**
 * Warn about metadata keys that look like misspellings of canonical ones, then
 * return the map unchanged — we nag, we never rewrite a caller's key.
 */
export function warnNearMissMeta(
  ctx: CliContext,
  meta: Record<string, string>,
): Record<string, string> {
  if (!ctx.quiet) {
    for (const warning of nearMissMetaWarnings(Object.keys(meta))) {
      process.stderr.write(`!! ${warning}\n`);
    }
  }
  return meta;
}

/**
 * Canonical `state`/`app` pairs from their dedicated flags. Shared by put,
 * attach and screenshot. These are sugar for the matching `--meta` keys; the
 * point is `--help` discoverability and `--state` validation.
 */
export function stateAppMetaFromFlags(flags: CommandFlags["flags"]): Record<string, string> {
  const meta: Record<string, string> = {};
  const state = flagString(flags, "--state");
  if (state !== undefined) meta.state = validateStateValue(state);
  const app = flagString(flags, "--app");
  if (app !== undefined) {
    const normalized = app.trim().toLowerCase();
    if (normalized.length === 0) throw new UsageError("--app requires a value");
    meta.app = normalized;
  }
  return meta;
}

function formatOptimizeNote(opt: {
  optimized: boolean;
  skippedReason?: OptimizeImageResult["skippedReason"];
  originalBytes: number;
  outputBytes: number;
  filename: string;
}): string | undefined {
  if (opt.optimized) {
    return `optimized ${formatByteSize(opt.originalBytes)} → ${formatByteSize(opt.outputBytes)} (${opt.filename})`;
  }
  if (opt.skippedReason && opt.skippedReason !== "disabled") {
    return `optimize skipped (${opt.skippedReason})`;
  }
  return undefined;
}

export function writeReplacedNote(
  replaced: boolean | undefined,
  quiet: boolean,
  dryRun = false,
  wouldRefuse = false,
): void {
  if (quiet) return;
  if (dryRun && wouldRefuse) {
    process.stderr.write(
      `>> would refuse: key already exists (pass --replace to overwrite; or set UPLOADS_OVERWRITE=1)\n`,
    );
    return;
  }
  if (replaced) {
    process.stderr.write(
      dryRun
        ? `>> would replace existing object (same URL)\n`
        : `>> replaced existing object (same URL)\n`,
    );
  }
}

export type PreparedUpload = OptimizeImageResult & {
  frame?: Pick<FrameResult, "framed" | "frameId" | "skippedReason">;
};

/** Frame (optional) then optimize — shared by put/attach/MCP. */
export async function prepareImageForUpload(
  bytes: Uint8Array,
  filename: string,
  opts: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
    optimize: OptimizeImageOptions;
  },
): Promise<PreparedUpload> {
  let currentBytes = bytes;
  let currentName = filename;
  let frameMeta: PreparedUpload["frame"];

  if (opts.frameId) {
    const framed = await applyFrame(currentBytes, currentName, {
      id: opts.frameId,
      browserUrl: opts.frameUrl,
      fit: opts.frameFit,
    });
    frameMeta = {
      framed: framed.framed,
      frameId: framed.frameId,
      skippedReason: framed.skippedReason,
    };
    if (framed.framed) {
      currentBytes = framed.bytes;
      currentName = framed.filename;
    }
  }

  const optimized = await optimizeImageForUpload(currentBytes, currentName, opts.optimize);
  return { ...optimized, frame: frameMeta };
}

/**
 * Merge an image's own EXIF-derived facts under any explicit metadata.
 * Best-effort by contract: `imageFactsFromBytes` never rejects, and a full key
 * budget drops the derived pairs rather than failing the upload. Returns the
 * input untouched (including `undefined`) when there is nothing to add, so a
 * metadata-free upload stays metadata-free.
 */
async function mergeImageFacts(
  bytes: Uint8Array,
  metadata: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  const facts = await imageFactsFromBytes(bytes);
  if (Object.keys(facts).length === 0) return metadata;
  return mergeDerivedMeta(metadata ?? {}, facts);
}

/**
 * Gate for `mergeImageFacts`: only a filename whose inferred type is
 * image/* (or unresolved — an extension-less screenshot) is worth an
 * `imageFactsFromBytes` probe (`sharp(bytes).metadata()` under the hood). A
 * known non-image extension (a 25 MB zip, a `.log`, a PDF…) skips the probe
 * entirely rather than paying a sharp call that can only come back empty.
 */
function shouldProbeImageFacts(filename: string): boolean {
  const guessed = inferContentType(filename);
  return guessed === "application/octet-stream" || guessed.startsWith("image/");
}

export interface UploadPreparedImageOptions {
  frame: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
  };
  optimize: OptimizeImageOptions;
  /** gh attachment key wins over `key` when both are set (matches every call site). */
  ghTarget?: GhTarget;
  /**
   * Branch-staged key (issue #403): wins over `key`, loses to `ghTarget` (the
   * two are mutually exclusive at every call site — a PR/issue target always
   * implies staging is moot). Produces the exact same key as `attach
   * --branch` for the same filename via `ghBranchAttachmentKey`.
   */
  ghBranchTarget?: BranchTarget;
  /**
   * Resolved GitHub-key mode (issue #631), from a single upstream
   * `resolveGhPrefixSafe` call — never resolved here. Passed straight to
   * `ghAttachmentKeyForMode`/`ghBranchAttachmentKeyForMode`, which own the
   * plain-vs-private branch. Ignored when neither `ghTarget` nor
   * `ghBranchTarget` is set.
   */
  ghPrefix?: ResolveGhPrefixResult;
  key?: string;
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
  contentType?: string;
  dryRun?: boolean;
  /**
   * Opt in to overwriting an existing object on a strict (non-`gh/`) key —
   * see issue #174. Ignored server-side on managed `gh/` paths (`ghTarget`
   * set), which always hot-swap.
   */
  replace?: boolean;
  metadata?: Record<string, string>;
  /**
   * Promote this image's own EXIF allowlist into its metadata (see
   * image-facts.ts). Lives here, on the shared bytes tail, so every upload
   * surface — CLI put/screenshot, MCP put/screenshot — derives alike.
   */
  deriveImageFacts?: boolean;
  provenanceClient?: string;
  /**
   * Alt text for the markdown. Takes the prepared result so callers whose
   * default depends on the post-frame/optimize filename can use it — each
   * call site's existing default is preserved verbatim (see
   * .context/2026-07-16-screenshot-command-RESULT.md, "Simplify pass").
   */
  alt: (prepared: PreparedUpload) => string;
  width?: number;
}

export interface UploadPreparedImageResult {
  result: PutResult;
  prepared: PreparedUpload;
  markdown: string;
  /**
   * The queryable metadata this upload actually sent — `opts.metadata` after
   * any derived image facts were merged in. Callers that need to reason about
   * what was stored (see `pathMetaHintFor`) must read this, not
   * `result.metadata`, which is the API's R2 provenance echo.
   */
  sentMetadata?: Record<string, string>;
}

/**
 * Shared bytes-oriented upload tail: frame + optimize the bytes, resolve the
 * object key (gh attachment key wins over an explicit key; extension
 * rewritten post-optimize), put, and build the GitHub embed markdown. Used by
 * the screenshot CLI command, the MCP screenshot tool, and the MCP put
 * tool's contentBase64 path — the three in-memory-bytes call sites.
 * uploadPuts/uploadAttachments loop over file paths with their own bounded
 * concurrency and delegate here per item.
 */
export async function uploadPreparedImage(
  client: UploadsClient,
  bytes: Uint8Array,
  sourceName: string,
  opts: UploadPreparedImageOptions,
): Promise<UploadPreparedImageResult> {
  // Read EXIF from the original bytes before the optimizer strips it.
  const metadata =
    opts.deriveImageFacts && shouldProbeImageFacts(sourceName)
      ? await mergeImageFacts(bytes, opts.metadata)
      : opts.metadata;
  const prepared = await prepareImageForUpload(bytes, sourceName, {
    frameId: opts.frame.frameId,
    frameUrl: opts.frame.frameUrl,
    frameFit: opts.frame.frameFit,
    optimize: opts.optimize,
  });
  const ghMode = opts.ghPrefix ?? { mode: "plain" as const };
  let key = opts.ghTarget
    ? ghAttachmentKeyForMode(ghMode, opts.ghTarget, prepared.filename)
    : opts.ghBranchTarget
      ? ghBranchAttachmentKeyForMode(
          ghMode,
          opts.ghBranchTarget.repo,
          opts.ghBranchTarget.branch,
          prepared.filename,
        )
      : opts.key;
  if (key && prepared.optimized) key = rewriteKeyExtension(key, prepared.filename);
  const result = await client.put(prepared.bytes, {
    filename: prepared.filename,
    key,
    prefix: opts.prefix,
    repo: opts.repo,
    ref: opts.ref,
    contentType: prepared.optimized ? prepared.contentType : opts.contentType,
    deriveRepoFromGit: opts.deriveRepoFromGit,
    dryRun: opts.dryRun,
    replace: opts.replace,
    provenance: buildCliProvenance({
      sourceName,
      client: opts.provenanceClient,
      optimized: prepared.optimized,
      frameId: prepared.frame?.framed ? prepared.frame.frameId : undefined,
      keepExif: opts.optimize.keepExif === true,
    }),
    metadata,
  });
  const markdown = buildUploadMarkdown(urlForGithubEmbed(result.url, result.embedUrl), {
    alt: opts.alt(prepared),
    width: opts.width,
    key: result.key,
  });
  return { result, prepared, markdown, sentMetadata: metadata };
}

export function frameOptionsFromFlags(flags: CommandFlags["flags"]): {
  frameId?: string;
  frameUrl?: string;
  frameFit?: "cover" | "contain";
} {
  const raw = flagString(flags, "--frame");
  let frameId: string | undefined;
  try {
    frameId = resolveFrameId(raw);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const fitRaw = flagString(flags, "--frame-fit");
  let frameFit: "cover" | "contain" | undefined;
  if (fitRaw) {
    if (fitRaw !== "cover" && fitRaw !== "contain") {
      throw new UsageError(`invalid --frame-fit: ${fitRaw} (use cover or contain)`);
    }
    frameFit = fitRaw;
  }
  if (frameFit && !frameId) throw new UsageError("--frame-fit requires --frame");
  const frameUrl = flagString(flags, "--frame-url");
  if (frameUrl && !frameId) throw new UsageError("--frame-url requires --frame");
  return { frameId, frameUrl, frameFit };
}

/**
 * List every attachment under the target's prefix and create/update the
 * managed comment. Prefers the server-side bot endpoint (`uploads-sh[bot]`,
 * rendered from this workspace's own data); any failure to post that way —
 * not installed, declined, self-hosted 404, network error — falls through to
 * the local-`gh` path so self-hosters keep working unchanged. Throws on gh
 * failure — callers decide whether that is fatal (`comment` command) or a
 * warning (`put --comment`).
 */
export interface AttachmentsCommentResult {
  action: "created" | "updated" | "skipped";
  count: number;
  /** Who posted the comment: the GitHub App bot, or the local `gh` fallback. */
  via: "bot" | "gh";
}

/** Human-mode suffix noting who posted the managed comment. */
export function commentViaSuffix(via: AttachmentsCommentResult["via"]): string {
  return via === "bot" ? " (uploads-sh[bot])" : " (via gh)";
}

/**
 * Thrown by `syncAttachmentsComment` when the server declines with
 * `not_authorized` (issue #297 baseline control — this repo is bound to a
 * different workspace) or `actor_not_authorized` (issue #297 control 2 — the
 * workspace requires the caller to be on the target PR/issue thread).
 * Deliberately not caught by the generic "bot endpoint
 * unreachable" fallback below: falling back to gh here would let the
 * human's own credentials post anyway, defeating the point of the
 * server-side gate.
 */
export class GithubCommentAuthorizationError extends Error {}

/**
 * `opts.resync` marks an explicit `uploads comment` invocation rather than a
 * background sync (attach, screenshot, put --comment). It costs the server one
 * extra comment listing and in exchange collapses any duplicate managed
 * comment (issue #480) — worth it on the rare, explicitly-asked-for resync,
 * not on every attach.
 */
export async function syncAttachmentsComment(
  client: UploadsClient,
  target: GhTarget,
  run: CommandRunner,
  workspace?: string,
  opts: { resync?: boolean } = {},
): Promise<AttachmentsCommentResult> {
  let bot: GithubCommentResult | undefined;
  try {
    bot = await client.upsertGithubComment({
      repo: target.repo,
      num: target.num,
      kind: target.kind,
      ...(opts.resync ? { resync: true } : {}),
    });
  } catch {
    // Endpoint absent/unreachable (self-hosted, network, older worker) — fall
    // through to the gh path below.
    bot = undefined;
  }

  if (bot) {
    if (bot.posted) return { action: bot.action, count: bot.count, via: "bot" };
    if (bot.reason === "not_authorized") {
      throw new GithubCommentAuthorizationError(
        `${bot.message ?? `${target.repo} is not authorized for this workspace.`}\n` +
          `Run \`uploads github link --status --repo ${target.repo}\` to see who owns the ` +
          `binding, use that workspace instead, or post the comment manually with gh.`,
      );
    }
    // Actor-on-PR gate (issue #297 control 2, workspace opt-in): same
    // no-gh-fallback rule as not_authorized — the workspace explicitly asked
    // the server to hold this line, so the CLI shouldn't route around it.
    if (bot.reason === "actor_not_authorized") {
      throw new GithubCommentAuthorizationError(
        `${bot.message ?? `You are not an actor on ${target.repo}#${target.num}.`}\n` +
          `Ask an authorized thread participant to run this, or post the ` +
          `comment manually with gh.`,
      );
    }
    // Installed-but-unapproved is a fixable misconfiguration, not a silent
    // degrade: tell the user (and how to fix it) before falling back to gh.
    if (bot.reason === "forbidden" && bot.message) {
      process.stderr.write(
        `note: ${bot.message}${bot.fixUrl ? `\n  ${bot.fixUrl}` : ""}\n` +
          `Posting via local gh in the meantime.\n`,
      );
    }
  }

  // Link adoption (issue #708): local-gh fallback parity with the bot's own
  // adoption (issue #701, apps/api/src/github-link-adopt.ts). When the bot
  // already handled this target the server already adopted for us, so this
  // only runs once we've fallen through to gh. Scans the PR/issue body and
  // every comment for pasted uploads.sh URLs and adopts each one that
  // resolves (server-side, inside `POST .../github/attach`) to a file in
  // THIS workspace's own bound-repo attachment prefix — copy, never move,
  // same as the bot path. Best-effort end to end: any failure (not a git
  // repo, `gh` unavailable/unauthenticated, config unreadable) degrades to
  // "adopt nothing" rather than blocking the comment sync it rides along
  // with.
  let adoptedCount = 0;
  let preAdoptionAttachmentCount: number | undefined;
  try {
    const root = run("git", ["rev-parse", "--show-toplevel"]).trim();
    const { config: adoptConfig } = readLocalRepoCommentConfig(root);
    const { options: adoptOptions } = resolveCommentOptions(adoptConfig, null);
    if (adoptOptions.adoptLinkedFiles) {
      const text = fetchAdoptionCandidateText(target, run);
      if (hasLinkCandidate(text)) {
        const urls = extractCandidateUrls(text);
        if (urls.length > 0) {
          // Baseline BEFORE this pass's adoptions land (mirrors the bot
          // path's `gatherCommentBody` call before its own copies) — feeds
          // the noise guard below without a lone adoption inflating its own
          // count. Plain prefix only (not the private-prefix listing done
          // for the final render below) — good enough for a guard decision.
          preAdoptionAttachmentCount = (await client.listAll({ prefix: ghKeyPrefix(target) }))
            .length;
          for (const url of urls) {
            try {
              await client.attachExisting({
                source: url,
                repo: target.repo,
                ...(target.kind === "pull" ? { pr: target.num } : { issue: target.num }),
              });
              adoptedCount++;
            } catch {
              // Not a resolvable uploads.sh URL, belongs to a different
              // workspace, or the source was deleted — silently dropped,
              // matching the bot path's contract (a throw from
              // `resolveAttachSourceKey` is caught per-URL there too).
            }
          }
        }
      }
    }
  } catch {
    // Not a git repo, `.uploads.yml` unreadable, or `gh` unavailable for the
    // PR/comments fetch — degrade to no adoption this pass.
  }

  // gh fallback: gather from this workspace's own data and post via local `gh`.
  // Note (issues #304, #365): this CLI process has no server-side
  // WorkspaceRecord in scope, so it cannot honor a workspace's
  // githubCommentLinkToFilePage=false or githubCommentShowMetadata=false — it
  // always links to the file page and always shows metadata here, matching the
  // defaults. This only diverges from the bot-posted comment for a workspace
  // that both sets one of those flags false and falls through to this path.
  //
  // Also list every active private prefix for this repo (issue #631): a
  // private repo's attachments can live under a randomized prefix instead of
  // the plain one. `resolveGhPrefixSafe` is fail-open (any resolve failure,
  // including a client that lacks the method entirely) — plain-only listing,
  // silently, matching pre-#631 behavior exactly.
  const ghPrefix = await resolveGhPrefixSafe(client, {
    repo: target.repo,
    target: { kind: target.kind, num: target.num },
  });
  const prefixes = ghListPrefixes(ghKeyPrefix(target), ghPrefix, (id) =>
    ghPrivateKeyPrefix(id, target),
  );
  const items: AttachmentItem[] = await ghMergedList(prefixes, undefined, async (prefix) =>
    (await client.listAll({ prefix, metadata: true })).map(
      ({ key, url, embedUrl, pageUrl, metadata }) => {
        // The list endpoint returns every metadata key; the comment
        // renders only these two. Narrowing here keeps both render paths
        // byte-identical.
        const path = metadata?.path;
        const state = metadata?.state;
        // Server-derived image dimensions (parity with the bot path's
        // COMMENT_META_KEYS hydration): finite positive numbers only, field
        // omitted entirely when neither parses.
        const imgWidth = Number(metadata?.["image.width"]);
        const imgHeight = Number(metadata?.["image.height"]);
        const hasImgWidth = Number.isFinite(imgWidth) && imgWidth > 0;
        const hasImgHeight = Number.isFinite(imgHeight) && imgHeight > 0;
        return {
          key,
          url,
          embedUrl,
          pageUrl,
          ...(path || state
            ? { meta: { ...(path ? { path } : {}), ...(state ? { state } : {}) } }
            : {}),
          ...(hasImgWidth || hasImgHeight
            ? {
                imageMeta: {
                  ...(hasImgWidth ? { width: imgWidth } : {}),
                  ...(hasImgHeight ? { height: imgHeight } : {}),
                },
              }
            : {}),
        };
      },
    ),
  );

  const galleries: (GalleryCommentItem & { id: string })[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.findGalleriesByReference({
      provider: "github",
      // GitHub references intentionally do not distinguish PRs from issues.
      coordinate: `${target.repo.toLowerCase()}#${target.num}`,
      cursor,
    });
    galleries.push(...page.galleries.map(({ id, title, url }) => ({ title, url, id })));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const previewGalleries = await Promise.all(
    galleries.map(async ({ id, ...gallery }) => {
      try {
        const detail = await client.getGallery(id);
        return {
          ...gallery,
          previews: detail.items
            .filter(
              (item) =>
                item.status === "available" && item.url && item.contentType?.startsWith("image/"),
            )
            .slice(0, 3)
            .map((item) => ({
              url: item.url!,
              embedUrl: item.embedUrl,
              alt: item.altText ?? item.objectKey,
              itemUrl: item.pageUrl,
            })),
        };
      } catch {
        // A deleted or temporarily unavailable gallery still gets a safe title link.
        return gallery;
      }
    }),
  );

  const marker = attachmentsMarker(workspace);
  // Honor a committed .uploads.yml on the working tree (issue #307). This CLI
  // process has no server-side WorkspaceRecord in scope (see the note above),
  // so it resolves against `null` workspace defaults — a documented
  // divergence from the bot path (commands.ts:728 / apps/api's
  // resolveRepoCommentOptions, which also layers the workspace's own
  // githubComment* fields).
  let renderOptions: CommentRenderOptions = AUTO_RENDER_OPTIONS;
  try {
    const root = run("git", ["rev-parse", "--show-toplevel"]).trim();
    const { config } = readLocalRepoCommentConfig(root);
    const { options } = resolveCommentOptions(config, null);
    renderOptions = {
      imageWidth: options.imageWidth,
      maxInlineImages: options.maxInlineImages,
      metaPath: options.metaPath,
      metaState: options.metaState,
      note: options.note,
    };
  } catch {
    // Not a git repo, or the config file couldn't be read — fall back to auto.
  }
  // Append only on the local-gh path: bot posts already carry the uploads-sh
  // bot identity, so this note would be wrong there.
  const body = `${attachmentsCommentBody(items, previewGalleries, marker, renderOptions, target)}\n${GH_FALLBACK_AUTHOR_NOTE}`;
  const count = items.length + previewGalleries.length;
  // Noise guard (issue #708, mirrors the bot's `shouldSyncAfterAdopt`): a
  // lone adopted link with nothing else already attached is already fully
  // visible inline in the PR/comment — don't create a brand-new comment just
  // to repeat it. `upsertAttachmentsComment` still PATCHes an existing
  // managed comment unconditionally (its own `if (existing)` branch runs
  // regardless of `createIfMissing`), so "a managed comment already exists"
  // and "other attachments are already present" both heal/sync for free
  // here without any extra condition — this only ever suppresses a fresh
  // create.
  const skipLoneAdoptionCreate = adoptedCount === 1 && (preAdoptionAttachmentCount ?? 0) === 0;
  // Empty (count 0) renders the neutral empty-state body but must not create a
  // comment — it only rewrites one that already exists (`action: "skipped"`
  // when none does).
  const { action } = upsertAttachmentsComment(target, body, run, marker, {
    createIfMissing: count > 0 && !skipLoneAdoptionCreate,
  });
  return { action, count, via: "gh" };
}

// --- attach ---

const ATTACH_HELP = `uploads attach <file...> [options]

Upload one or more stable PR/issue attachments and maintain a single GitHub
comment. With no target, uses the pull request for the current branch.

Multiple files upload in parallel (bounded concurrency). One bad file does not
block the rest; JSON includes uploads + failures (exit 1 when any failed).

Attachments are public and their repo/number/filename keys are predictable.
Private/internal GitHub repository visibility does not restrict access; upload
only media that is safe at a public URL.

Same filename under the same PR/issue overwrites in place (no prompt) so the
URL and every embed hot-swap. Human mode prints ">> replaced existing object
(same URL)" when that happens.

Still images are optimized to WebP by default (same as put). Use --no-optimize
to upload originals. Optional --frame wraps images in device/browser chrome.

If a file has a sidecar manifest (<file>.uploads.json, written by
"screenshot --out") and its content hash still matches, that capture's
derived metadata (path/url/env/viewport/state) is merged in automatically —
explicit --meta/--state always win. A regenerated or edited file loses its
sidecar silently (hash no longer matches).

An argument that doesn't exist on disk but resolves as an already-uploaded
object — a bare key (e.g. "f/AbC123/shot.webp") or an uploads.sh URL (storage
host, embed host, or /f/ page) — attaches via a server-side copy instead of a
re-upload: the source's own derived metadata (path/url/viewport/state/…)
rides along, and gh.repo/gh.kind/gh.number/gh.ref are stamped fresh. Copy by
default; --move deletes the source after a successful copy. A path that
exists on disk always wins as a local file, even if it also happens to look
like a key.

Branch staging (pre-PR): --branch [name] stages files against a git branch
before a pull request exists, e.g. for a coding agent working a branch that
hasn't opened a PR yet. Key: gh/<owner>/<repo>/branch/<branch>/<filename>
("/" in the branch name sanitizes to "-", e.g. feature/x -> feature-x).
With no value, --branch resolves the current git branch. Staged files are
public like every other attachment — same public-URL caveat applies. There is
no managed comment for a branch (no PR/issue to comment on yet); --branch
never runs the comment sync and cannot combine with --pr/--issue/--comment.

Promotion: once a PR exists, staged files for the current branch are picked
up automatically the first time you attach to that PR (a plain "uploads
attach <file> --pr <num>", or the inferred-PR default with no target flags) —
they're copied into the PR's attachment prefix before the managed comment is
built, so they show up in the same run. Pass --no-promote to skip that. If
you'd rather promote without attaching a new file (e.g. right after
"gh pr create" with nothing new to upload), run "uploads attach --promote"
with no file arguments — it resolves the PR the same way, promotes, and
refreshes the comment; it exits 0 even if nothing was staged. --promote only
takes effect with zero files and cannot combine with --branch/--issue/
--no-promote. Promotion never applies to issues. Staged files stay findable
with "uploads find gh.branch=<branch>" either way.

A branch renamed with "git branch -m" is followed automatically: the rename
is read from the branch reflog and registered, so promotion sweeps the older
names too. That needs one uploads run after the rename. If the branch was
renamed without one, or was deleted, pass "--from-branch <old-name>" with
"--pr <num>". With no file arguments, this promotes the stale branch prefix
and refreshes the managed comment. With file or existing-key arguments, it
promotes the stale prefix before the normal attach flow.

Options:
  --pr <num>            Attach to this pull request
  --issue <num>         Attach to this issue
  --branch [name]       Stage against a branch, pre-PR (default: current git branch);
                        not with --pr/--issue/--comment
  --promote             No files: promote branch-staged attachments into the
                        resolved PR and refresh the comment; not with
                        --branch/--issue/--no-promote
  --from-branch <name>  Promote staged attachments from this branch instead of
                        the current branch; requires a pull-request target
  --no-promote          Skip auto-promoting branch-staged attachments (default path only)
  --move                With an already-uploaded key/URL argument: delete the source
                        object after a successful server-side copy (default: copy)
  --repo <owner/repo>   Repository (default: gh/git inference)
  --no-comment          Upload only; don't create/update the managed comment
  --content-type <mime> Override Content-Type (applied to every file; ignored when optimize rewrites)
  --frame <id>          Device/browser frame before optimize (phone|browser|iphone-16-pro)
  --frame-url <url>     Address bar text for --frame browser
  --frame-fit cover|contain  How the shot fills the screen (default: cover)
  --no-optimize         Skip client-side image optimization (or UPLOADS_NO_OPTIMIZE=1)
  --optimize-max-edge <px>  Max long edge when optimizing (default: 2400)
  --optimize-quality <1-100>  WebP quality (default: 85)
  --keep-exif           Keep EXIF/XMP/ICC when optimizing (default: strip for privacy)
  --workspace, -w <name>  Override workspace
  --meta <k=v>          Extra queryable metadata (repeatable; value may contain "=").
                        gh.repo/gh.kind/gh.number/gh.ref are always set from the resolved
                        target (or gh.repo/gh.kind/gh.branch/gh.staged-at with --branch) —
                        a --meta pair with the same key is overridden by it.
                        Because attach always sends its own gh.* pairs, re-attaching to
                        the same key always replaces that file's entire metadata set
                        (never preserves) — use "uploads meta set" to add to it instead.
  --state <s>           before|after|empty|error|loading — the UI state shown (sets meta state=)
  --app <name>          Surface shown: web, ios, android, cli (sets meta app=)

Examples:
  uploads attach ./before.png ./after.png
  uploads attach ./mobile.png --frame phone
  uploads attach ./shot.png --pr 123 --repo myorg/myapp
  uploads attach ./artifact.zip --issue 45 --no-comment
  uploads attach ./shot.png --meta path=/settings --state after
  uploads attach ./shot.png --branch
  uploads attach --pr 123 --from-branch old/branch
  uploads attach ./shot.png --branch feature/new-settings
  uploads attach --promote
`;

/**
 * Lever 3 (issue #469): a nudge for when an image lands on a PR/issue with
 * no `path` metadata — `path` is one of the highest-value queryable tags
 * (same tier as `state=`), and unlike `uploads screenshot` (which derives it
 * from the captured URL), a plain `attach`/`put --pr`/`put --issue` of an
 * already-existing image has nothing to derive it from, so it's easy to
 * forget. Fires once per batch (not per file). Non-image uploads (zips,
 * PDFs, etc.) are exempt — "findable by page" doesn't apply to them.
 *
 * Checks the *resolved* metadata each upload actually sent (`--meta` pairs +
 * sidecar manifest + derived image facts, index-aligned with `uploads`) —
 * NOT `PutResult.metadata`. That field is the API's echo of the object's R2
 * provenance bag (`client`, `source-name`, `content-sha256`, `uploaded-at`),
 * never the queryable D1 tags, so it can't answer this question: reading it
 * made the tip fire on every image, including ones uploaded with an explicit
 * `--meta path=` (PR #509).
 */
export function pathMetaHintFor(
  uploads: readonly { contentType: string }[],
  /** Index-aligned with `uploads` — see `uploadPuts`/`uploadAttachments`. */
  sentMetadata: readonly (Record<string, string> | undefined)[],
): string | undefined {
  const missingPath = uploads.some(
    (u, i) => u.contentType.startsWith("image/") && !sentMetadata[i]?.path,
  );
  return missingPath ? "tip: add --meta path=/route so this shot is findable by page" : undefined;
}

export type AttachUploadItem = PutResult & {
  file: string;
  markdown: string;
  optimize: {
    optimized: boolean;
    skippedReason?: OptimizeImageResult["skippedReason"];
    originalBytes: number;
    outputBytes: number;
    filename: string;
  };
  frame?: PreparedUpload["frame"];
};

export type AttachFailure = {
  file: string;
  error: { message: string; code?: string; status?: number };
};

/**
 * Bounded fan-out for `uploads attach`'s already-uploaded-object args (issue
 * #702) — attach args are independent server calls (no shared batch state
 * like `uploadAttachments`'s optimize/frame prep), so this stays a thin
 * wrapper rather than a variant of that function.
 */
const ATTACH_EXISTING_CONCURRENCY = 4;

async function attachExistingBatch(
  client: UploadsClient,
  target: GhTarget,
  sources: readonly string[],
  move: boolean,
): Promise<{ results: AttachExistingResult[]; failures: AttachFailure[]; firstError?: unknown }> {
  const outcomes = await mapBounded(sources, ATTACH_EXISTING_CONCURRENCY, async (source) => {
    try {
      const result = await client.attachExisting({
        source,
        repo: target.repo,
        pr: target.kind === "pull" ? target.num : undefined,
        issue: target.kind === "issues" ? target.num : undefined,
        move,
      });
      return { ok: true as const, source, result };
    } catch (err) {
      const message =
        err instanceof UploadsError && err.code === "NOT_FOUND"
          ? `not a local file, and no such object in this workspace: ${source}`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        ok: false as const,
        source,
        cause: err,
        error: {
          message,
          code: err instanceof UploadsError ? err.code : undefined,
          status: err instanceof UploadsError ? err.status : undefined,
        },
      };
    }
  });
  const results: AttachExistingResult[] = [];
  const failures: AttachFailure[] = [];
  let firstError: unknown;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      results.push(outcome.result);
    } else {
      failures.push({ file: outcome.source, error: outcome.error });
      firstError ??= outcome.cause;
    }
  }
  return { results, failures, firstError };
}

/** Shared shape of every prepare + put batch (`uploadPuts`/`uploadAttachments`). */
export interface UploadBatchResult<T> {
  uploads: T[];
  failures: AttachFailure[];
  /** The original cause of the first failure — for rethrowing single-file CLI paths. */
  firstError?: unknown;
  /**
   * Index-aligned with `uploads`: the queryable metadata each upload actually
   * sent (flags + sidecar + derived image facts). Kept beside the items rather
   * than on them so it stays out of the `--format json` upload objects, which
   * spread the item wholesale. See `pathMetaHintFor`.
   */
  sentMetadata: (Record<string, string> | undefined)[];
}

interface UploadAttachmentBatchOptions {
  client: UploadsClient;
  files: readonly string[];
  /** Builds the object key for a file from its (post-optimize) filename. */
  keyFor: (filename: string) => string;
  contentType?: string;
  optimize: OptimizeImageOptions;
  frame: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
  };
  metadata?: Record<string, string>;
  /** Forwarded per file — see image-facts.ts. */
  deriveImageFacts?: boolean;
  /** Provenance `client` field (default uploads-cli). */
  provenanceClient?: string;
  concurrency?: number;
}

/**
 * Shared prepare + put loop for both PR/issue attach (`uploadAttachments`)
 * and branch-staged attach (`uploadBranchAttachments`) — bounded concurrency,
 * per-file errors collect in `failures` (does not throw). `firstError` is the
 * original cause of the first failure — for rethrowing single-file CLI paths.
 */
async function uploadAttachmentBatch(
  opts: UploadAttachmentBatchOptions,
): Promise<UploadBatchResult<AttachUploadItem>> {
  if (opts.files.some((f) => f === "-")) {
    throw new UsageError("attach does not support stdin; pass one or more file paths");
  }

  type Slot =
    | { ok: true; upload: AttachUploadItem; sentMetadata?: Record<string, string> }
    | { ok: false; file: string; err: unknown };

  const slots = await mapBounded(
    opts.files,
    opts.concurrency ?? UPLOAD_BATCH_CONCURRENCY,
    async (file): Promise<Slot> => {
      try {
        const sourceName = basename(file);
        const bytes = readFileArg(file);
        // Sidecar manifest from a prior `screenshot --out` of this exact file
        // (issue #469 lever 2) — see mergeSidecarMeta.
        const baseMetadata = mergeSidecarMeta(file, bytes, opts.metadata);
        // Same EXIF promotion uploadPreparedImage does; attach keeps its own
        // per-file tail (it builds keys differently), so it opts in here too.
        const metadata =
          opts.deriveImageFacts && shouldProbeImageFacts(sourceName)
            ? await mergeImageFacts(bytes, baseMetadata)
            : baseMetadata;
        const prepared = await prepareImageForUpload(bytes, sourceName, {
          ...opts.frame,
          optimize: opts.optimize,
        });
        const result = await opts.client.put(prepared.bytes, {
          filename: prepared.filename,
          key: opts.keyFor(prepared.filename),
          contentType: prepared.optimized ? prepared.contentType : opts.contentType,
          provenance: buildCliProvenance({
            sourceName,
            client: opts.provenanceClient,
            optimized: prepared.optimized,
            frameId: prepared.frame?.framed ? prepared.frame.frameId : undefined,
            keepExif: opts.optimize.keepExif === true,
          }),
          metadata,
        });
        return {
          ok: true,
          sentMetadata: metadata,
          upload: {
            ...result,
            file,
            markdown: buildUploadMarkdown(urlForGithubEmbed(result.url, result.embedUrl), {
              alt: sourceName,
              key: result.key,
            }),
            optimize: {
              optimized: prepared.optimized,
              skippedReason: prepared.skippedReason,
              originalBytes: prepared.originalBytes,
              outputBytes: prepared.outputBytes,
              filename: prepared.filename,
            },
            frame: prepared.frame,
          },
        };
      } catch (err) {
        return { ok: false, file, err };
      }
    },
  );

  const uploads: AttachUploadItem[] = [];
  const sentMetadata: (Record<string, string> | undefined)[] = [];
  const failures: AttachFailure[] = [];
  let firstError: unknown;
  for (const slot of slots) {
    // Pushed together so the two arrays stay index-aligned across failures.
    if (slot.ok) {
      uploads.push(slot.upload);
      sentMetadata.push(slot.sentMetadata);
    } else {
      firstError ??= slot.err;
      failures.push({ file: slot.file, error: errorDetail(slot.err) });
    }
  }
  return { uploads, failures, firstError, sentMetadata };
}

/**
 * Prepare + put each path as a PR/issue attachment with bounded concurrency.
 * Per-file errors collect in `failures` (does not throw). `firstError` is the
 * original cause of the first failure — for rethrowing single-file CLI paths.
 */
export async function uploadAttachments(opts: {
  client: UploadsClient;
  target: GhTarget;
  files: readonly string[];
  contentType?: string;
  optimize: OptimizeImageOptions;
  frame: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
  };
  metadata?: Record<string, string>;
  /** Forwarded per file — see image-facts.ts. */
  deriveImageFacts?: boolean;
  /** Provenance `client` field (default uploads-cli). */
  provenanceClient?: string;
  concurrency?: number;
}): Promise<UploadBatchResult<AttachUploadItem>> {
  // Resolved once for the whole batch (issue #631) — never per file.
  const ghPrefix = await resolveGhPrefixSafe(opts.client, {
    repo: opts.target.repo,
    target: { kind: opts.target.kind, num: opts.target.num },
  });
  return uploadAttachmentBatch({
    ...opts,
    keyFor: (filename) => ghAttachmentKeyForMode(ghPrefix, opts.target, filename),
  });
}

/** A branch to stage attachments against pre-PR (`uploads attach --branch`). */
export interface BranchTarget {
  repo: string;
  branch: string;
}

/**
 * Prepare + put each path as a branch-staged attachment (pre-PR) with
 * bounded concurrency. Same shape as `uploadAttachments`, keyed under
 * `gh/<owner>/<repo>/branch/<branch>/<filename>` instead of a PR/issue
 * number. Never syncs the managed comment — callers must not call
 * `syncAttachmentsComment` for a branch target.
 */
export async function uploadBranchAttachments(opts: {
  client: UploadsClient;
  target: BranchTarget;
  files: readonly string[];
  contentType?: string;
  optimize: OptimizeImageOptions;
  frame: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
  };
  metadata?: Record<string, string>;
  /** Forwarded per file — see image-facts.ts. */
  deriveImageFacts?: boolean;
  provenanceClient?: string;
  concurrency?: number;
}): Promise<UploadBatchResult<AttachUploadItem>> {
  // Resolved once for the whole batch (issue #631) — never per file.
  const ghPrefix = await resolveGhPrefixSafe(opts.client, {
    repo: opts.target.repo,
    branch: opts.target.branch,
  });
  return uploadAttachmentBatch({
    ...opts,
    keyFor: (filename) =>
      ghBranchAttachmentKeyForMode(ghPrefix, opts.target.repo, opts.target.branch, filename),
  });
}

function errorDetail(err: unknown): { message: string; code?: string; status?: number } {
  if (err instanceof UploadsError)
    return { message: err.message, code: err.code, status: err.status };
  return { message: err instanceof Error ? err.message : String(err) };
}

export type PutUploadItem = PutResult & {
  file: string;
  markdown: string;
  optimize: AttachUploadItem["optimize"];
  frame?: PreparedUpload["frame"];
};

/**
 * Prepare + put each path with put-style key resolution and bounded concurrency.
 * Same partial-failure shape as uploadAttachments.
 */
export async function uploadPuts(opts: {
  client: UploadsClient;
  files?: readonly string[];
  /**
   * In-memory bodies (CLI `--url`, MCP `contentUrl`). Mutually exclusive
   * with `files`. `source` is the failure/progress label (the URL).
   */
  byteSources?: readonly { bytes: Uint8Array; filename: string; source: string }[];
  /** Single-file --name leaf override. */
  nameOverride?: string;
  /** Single-file --key. */
  explicitKey?: string;
  ghTarget?: GhTarget;
  /** Branch-staged key (issue #403) — see UploadPreparedImageOptions.ghBranchTarget. */
  ghBranchTarget?: BranchTarget;
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
  contentType?: string;
  dryRun?: boolean;
  /**
   * Opt in to overwriting an existing object on a strict (non-`gh/`) key —
   * see issue #174. Ignored server-side when `ghTarget` targets a managed
   * `gh/` path, which always hot-swaps.
   */
  replace?: boolean;
  optimize: OptimizeImageOptions;
  frame: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
  };
  metadata?: Record<string, string>;
  /** Forwarded per file to `uploadPreparedImage` — see image-facts.ts. */
  deriveImageFacts?: boolean;
  provenanceClient?: string;
  /** When set, used as alt for every file; else each file's basename. */
  alt?: string;
  width?: number;
  concurrency?: number;
}): Promise<UploadBatchResult<PutUploadItem>> {
  const files = opts.files ?? [];
  const byteSources = opts.byteSources ?? [];
  if (files.length > 0 && byteSources.length > 0) {
    throw new UsageError("internal: uploadPuts files and byteSources are mutually exclusive");
  }
  const count = files.length + byteSources.length;
  if (count === 0) throw new UsageError("put requires at least one file");
  if (count > 1 && files.some((f) => f === "-")) {
    throw new UsageError("stdin (-) cannot be combined with multiple file arguments");
  }
  if (count > 1 && opts.explicitKey) {
    throw new UsageError("--key cannot be combined with multiple files");
  }
  if (count > 1 && opts.nameOverride) {
    throw new UsageError("--name cannot be combined with multiple files");
  }

  // Resolved once for the whole batch (issue #631) — never per file.
  const ghPrefix = opts.ghTarget
    ? await resolveGhPrefixSafe(opts.client, {
        repo: opts.ghTarget.repo,
        target: { kind: opts.ghTarget.kind, num: opts.ghTarget.num },
      })
    : opts.ghBranchTarget
      ? await resolveGhPrefixSafe(opts.client, {
          repo: opts.ghBranchTarget.repo,
          branch: opts.ghBranchTarget.branch,
        })
      : undefined;

  type Slot =
    | { ok: true; upload: PutUploadItem; sentMetadata?: Record<string, string> }
    | { ok: false; file: string; err: unknown };

  type Item = {
    source: string;
    filename?: string;
    bytes?: Uint8Array;
    path?: string;
  };

  const items: Item[] =
    byteSources.length > 0
      ? byteSources.map((s) => ({
          source: s.source,
          filename: opts.nameOverride ?? s.filename,
          bytes: s.bytes,
        }))
      : files.map((file) => ({
          source: file,
          path: file,
        }));

  const slots = await mapBounded(
    items,
    opts.concurrency ?? UPLOAD_BATCH_CONCURRENCY,
    async (item): Promise<Slot> => {
      const file = item.source;
      try {
        const bytes = item.bytes ?? readFileArg(item.path ?? file);
        const sourceName =
          item.filename ??
          opts.nameOverride ??
          (file === "-"
            ? opts.explicitKey
              ? basename(opts.explicitKey)
              : "stdin.bin"
            : basename(file));
        // Sidecar manifest from a prior `screenshot --out` of this exact file
        // (issue #469 lever 2) — see mergeSidecarMeta. Not applicable to stdin
        // or URL fetches.
        const metadata =
          item.path && item.path !== "-"
            ? mergeSidecarMeta(item.path, bytes, opts.metadata)
            : opts.metadata;
        const { result, prepared, markdown, sentMetadata } = await uploadPreparedImage(
          opts.client,
          bytes,
          sourceName,
          {
            frame: opts.frame,
            optimize: opts.optimize,
            ghTarget: opts.ghTarget,
            ghBranchTarget: opts.ghBranchTarget,
            ghPrefix,
            key: opts.explicitKey,
            prefix: opts.prefix,
            repo: opts.repo,
            ref: opts.ref,
            deriveRepoFromGit: opts.deriveRepoFromGit,
            contentType: opts.contentType,
            dryRun: opts.dryRun,
            replace: opts.replace,
            metadata,
            deriveImageFacts: opts.deriveImageFacts,
            provenanceClient: opts.provenanceClient,
            alt: () => opts.alt ?? basename(sourceName),
            width: opts.width,
          },
        );
        return {
          ok: true,
          sentMetadata,
          upload: {
            ...result,
            file,
            markdown,
            optimize: {
              optimized: prepared.optimized,
              skippedReason: prepared.skippedReason,
              originalBytes: prepared.originalBytes,
              outputBytes: prepared.outputBytes,
              filename: prepared.filename,
            },
            frame: prepared.frame,
          },
        };
      } catch (err) {
        return { ok: false, file, err };
      }
    },
  );

  const uploads: PutUploadItem[] = [];
  const sentMetadata: (Record<string, string> | undefined)[] = [];
  const failures: AttachFailure[] = [];
  let firstError: unknown;
  for (const slot of slots) {
    // Pushed together so the two arrays stay index-aligned across failures.
    if (slot.ok) {
      uploads.push(slot.upload);
      sentMetadata.push(slot.sentMetadata);
    } else {
      firstError ??= slot.err;
      failures.push({ file: slot.file, error: errorDetail(slot.err) });
    }
  }
  return { uploads, failures, firstError, sentMetadata };
}

/**
 * Best-effort branch-rename registration (issue #920): reads this branch's
 * reflog for `git branch -m` steps and tells the server about each one, so a
 * later promote sweeps the branch's whole name lineage instead of only its
 * current name. No-op when the reflog has no rename (the common case) and
 * when the client predates the route. Every failure is swallowed — this runs
 * alongside staging and promote, and must never fail either. Set
 * `UPLOADS_DEBUG=1` to see what was skipped.
 *
 * `opts.explicit` marks a branch the user named themselves (`--from-branch`
 * / the MCP `fromBranch` argument): that is the manual escape hatch (PR
 * #919), and its lineage belongs to a different name than the one we are
 * standing on, so nothing is registered for it.
 */
export async function registerRenamesBestEffort(
  client: UploadsClient,
  run: CommandRunner,
  repo: string,
  branch: string,
  opts: { explicit?: boolean } = {},
): Promise<void> {
  if (opts.explicit) return;
  let lineage: ReturnType<typeof renameLineageFromReflog>;
  try {
    lineage = renameLineageFromReflog(run, branch);
  } catch {
    return;
  }
  if (lineage.length === 0) return;
  for (const step of lineage) {
    try {
      await client.registerBranchRename({ repo, from: step.from, to: step.to });
    } catch (err) {
      if (process.env.UPLOADS_DEBUG === "1") {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `debug: could not register branch rename ${step.from} -> ${step.to}: ${detail}\n`,
        );
      }
      return; // one failure means the route is unavailable; don't retry the rest
    }
  }
}

/**
 * Best-effort call to `POST /v1/workspaces/:workspace/github/promote` (server contract,
 * PR #310). Degrade-safe like `syncAttachmentsComment`'s bot path: an older
 * or self-hosted worker without this route (404), a forbidden token (403),
 * or a network error all collapse to "nothing promoted" — the caller must
 * never let this fail the attach. Returns undefined on any failure.
 */
async function attemptPromoteBranch(
  client: UploadsClient,
  target: GhTarget,
  branch: string,
): Promise<PromoteBranchAttachmentsResult | undefined> {
  try {
    return await client.promoteBranchAttachments({ repo: target.repo, num: target.num, branch });
  } catch {
    return undefined;
  }
}

/**
 * Human-mode note(s) for a promotion that actually promoted something. When
 * the server-side sweep followed a rename it adds a second line naming the
 * older branch names (issue #920): `lineage` is current-name-first, so the
 * older names are its tail.
 */
function promotionNote(
  promotion: PromoteBranchAttachmentsResult,
  branch: string | undefined,
): string {
  const n = promotion.promoted.length;
  const branchSuffix = branch ? ` from branch ${branch}` : "";
  const promoted = `>> promoted ${n} staged attachment${n === 1 ? "" : "s"}${branchSuffix}\n`;
  const older = (promotion.lineage ?? []).slice(1);
  if (older.length === 0) return promoted;
  return `${promoted}>> followed rename from ${older.join(", ")}\n`;
}

export async function runAttach(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(ATTACH_HELP);
    return 0;
  }
  if (parsed.flags.has("--no-comment") && typeof parsed.flags.get("--no-comment") === "string") {
    throw new UsageError("--no-comment takes no value — place it after the file arguments");
  }
  if (parsed.flags.has("--promote") && typeof parsed.flags.get("--promote") === "string") {
    throw new UsageError("--promote takes no value — place it after the file arguments");
  }
  if (parsed.flags.has("--no-promote") && typeof parsed.flags.get("--no-promote") === "string") {
    throw new UsageError("--no-promote takes no value — place it after the file arguments");
  }
  if (parsed.flags.has("--move") && typeof parsed.flags.get("--move") === "string") {
    throw new UsageError("--move takes no value — place it after the file arguments");
  }
  if (parsed.flags.has("--from-branch") && !flagString(parsed.flags, "--from-branch")) {
    throw new UsageError("--from-branch requires a branch name");
  }

  const fromBranch = flagString(parsed.flags, "--from-branch");

  if (
    parsed.flags.has("--promote") ||
    (fromBranch !== undefined && parsed.positionals.length === 0)
  ) {
    if (parsed.positionals.length > 0) {
      throw new UsageError(
        "--promote takes no file arguments — attaching a file to a PR already auto-promotes " +
          "staged files; use `uploads attach <file> --pr <num>` instead",
      );
    }
    if (parsed.flags.has("--branch"))
      throw new UsageError("--promote cannot be combined with --branch");
    if (parsed.flags.has("--issue"))
      throw new UsageError("--promote cannot be combined with --issue");
    if (parsed.flags.has("--no-promote"))
      throw new UsageError("--promote cannot be combined with --no-promote");
    return runAttachPromoteOnly(ctx, parsed, run);
  }

  // Validate --branch (including the filename-lookahead guard) before the
  // zero-positionals bailout below — otherwise `uploads attach --branch
  // shot.png` (where shot.png is swallowed as the branch value, leaving no
  // file args) would silently print help instead of a clear UsageError.
  const branchArg = branchFromFlags(parsed.flags, run);

  if (parsed.positionals.length === 0) {
    throw new UsageError("attach requires at least one file", {
      example: "uploads attach ./shot.png --pr 123",
    });
  }

  if (branchArg !== undefined) {
    if (parsed.flags.has("--pr")) throw new UsageError("--branch cannot be combined with --pr");
    if (parsed.flags.has("--issue"))
      throw new UsageError("--branch cannot be combined with --issue");
    if (parsed.flags.has("--comment"))
      throw new UsageError("--branch cannot be combined with --comment");
    return runAttachBranch(ctx, parsed, branchArg, run);
  }
  if (fromBranch !== undefined && parsed.flags.has("--issue")) {
    throw new UsageError("--from-branch cannot be combined with --issue");
  }
  if (fromBranch !== undefined && parsed.flags.has("--no-promote")) {
    throw new UsageError("--from-branch cannot be combined with --no-promote");
  }

  const explicitTarget = ghTargetFromFlags(parsed.flags, run);
  const target =
    explicitTarget ??
    resolveCurrentPullRequest(resolveRepo(flagString(parsed.flags, "--repo"), run), run);
  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
  const optimizeOpts = optimizeOptionsFromFlags(parsed.flags, defaults);
  const frameOpts = frameOptionsFromFlags(parsed.flags);
  const contentTypeOverride = flagString(parsed.flags, "--content-type");
  // User-supplied extras first, then the resolved target's gh.* — explicit
  // target pairs always win over a same-named --meta extra (documented above).
  // Validate the merged map (not just the extras) so the 24-key/8KB caps are
  // enforced client-side even when extras alone are under the cap but extras
  // + the gh.* pairs push the merged map over it.
  const metaExtras = warnNearMissMeta(ctx, parseMetaFlags(flagValues(parsed.flags, "--meta")));
  const metadata = {
    ...metaExtras,
    ...stateAppMetaFromFlags(parsed.flags),
    ...ghMetadataFromTargetWithTitle(target, run),
  };
  if (Object.keys(metadata).length > 0) validateMetaMap(metadata);

  // Args that exist on disk are always local files, even if they'd also
  // parse as a key/URL. Everything else is a candidate for the server-side
  // attach-existing path (issue #702) — resolved/validated server-side, so a
  // typo'd path and a genuinely-missing object key report the same way.
  const localFiles = parsed.positionals.filter((p) => existsSync(p));
  const remoteArgs = parsed.positionals.filter((p) => !existsSync(p));
  const moveExisting = parsed.flags.has("--move");
  if (moveExisting && remoteArgs.length === 0) {
    throw new UsageError("--move only applies to already-uploaded key/URL arguments");
  }

  const logHuman = !ctx.quiet && !ctx.json;
  if (logHuman && localFiles.length > 0) {
    const n = localFiles.length;
    process.stderr.write(`>> uploading ${n} file${n === 1 ? "" : "s"}\n`);
  }

  const uploadResult =
    localFiles.length > 0
      ? await uploadAttachments({
          client: ctx.client,
          target,
          files: localFiles,
          contentType: contentTypeOverride,
          optimize: optimizeOpts,
          frame: frameOpts,
          metadata,
          deriveImageFacts: derivedMetaEnabled(parsed.flags, defaults),
        })
      : { uploads: [], failures: [], firstError: undefined, sentMetadata: [] };
  const { uploads, sentMetadata } = uploadResult;
  const localFailures = uploadResult.failures;

  if (logHuman && remoteArgs.length > 0) {
    const n = remoteArgs.length;
    process.stderr.write(`>> attaching ${n} existing object${n === 1 ? "" : "s"}\n`);
  }
  const remoteResult =
    remoteArgs.length > 0
      ? await attachExistingBatch(ctx.client, target, remoteArgs, moveExisting)
      : {
          results: [] as AttachExistingResult[],
          failures: [] as AttachFailure[],
          firstError: undefined,
        };
  const { results: attachedExisting, failures: remoteFailures } = remoteResult;

  const failures = [...localFailures, ...remoteFailures];
  const firstError = localFailures.length > 0 ? uploadResult.firstError : remoteResult.firstError;

  // Single-arg total failure: rethrow so CLI exit codes stay auth/network-aware.
  // The remote-attach path's friendlier not-found message (attachExistingBatch)
  // wins over the raw client error text, but the original error's class/code
  // (UploadsError) is preserved so exit-code mapping stays unaffected.
  if (
    uploads.length === 0 &&
    attachedExisting.length === 0 &&
    failures.length === 1 &&
    parsed.positionals.length === 1
  ) {
    const only = failures[0]!;
    if (firstError instanceof UploadsError && firstError.message !== only.error.message) {
      throw new UploadsError(only.error.message, firstError.code, firstError.status);
    }
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  // Auto-promote: before the comment sync, best-effort promote this
  // workspace's own branch-staged attachments (from an earlier `attach
  // --branch` while the PR didn't exist yet) into this PR's attachment
  // prefix, so the comment gather below sees them in the same invocation.
  // Never for issues (branch staging only ever targets a future PR), never
  // with --no-promote, and silently skipped (no client call at all) when the
  // current git branch can't be resolved (detached HEAD, not a repo) — this
  // must never fail the attach itself.
  let promotion: PromoteBranchAttachmentsResult | undefined;
  let promotedBranch: string | undefined;
  if (target.kind === "pull" && !parsed.flags.has("--no-promote")) {
    promotedBranch = fromBranch ?? resolveCurrentBranchSafe(run);
    if (promotedBranch !== undefined) {
      await registerRenamesBestEffort(ctx.client, run, target.repo, promotedBranch, {
        explicit: fromBranch !== undefined,
      });
      promotion = await attemptPromoteBranch(ctx.client, target, promotedBranch);
    }
  }

  let comment: AttachmentsCommentResult | undefined;
  let commentError: string | undefined;
  // Existing-key attach syncs server-side, but a stale-branch promotion runs
  // afterward. Refresh once more so that copy is visible in the same command.
  const shouldRefreshComment =
    uploads.length > 0 || (fromBranch !== undefined && attachedExisting.length > 0);
  if (!parsed.flags.has("--no-comment") && shouldRefreshComment) {
    try {
      comment = await syncAttachmentsComment(ctx.client, target, run, ctx.config.workspace);
    } catch (err) {
      commentError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warning: uploads succeeded but the GitHub comment failed (is gh installed and authenticated?): ${commentError}\n`,
      );
    }
  }

  // Lever 3 (issue #469): tip when an image lands here with no `path` meta.
  const pathHint =
    uploads.length > 0 && !ctx.quiet ? pathMetaHintFor(uploads, sentMetadata) : undefined;

  if (ctx.json) {
    await writeJson({
      target,
      uploads,
      attachedExisting,
      failures,
      comment,
      commentError,
      promotion: promotion ?? null,
      ...(pathHint ? { hint: pathHint } : {}),
    });
  } else {
    for (const result of uploads) {
      if (logHuman) {
        if (result.frame?.framed) {
          process.stderr.write(
            `>> ${basename(result.file)}: framed with ${result.frame.frameId}\n`,
          );
        }
        const note = formatOptimizeNote(result.optimize);
        if (note) process.stderr.write(`>> ${basename(result.file)}: ${note}\n`);
        writeReplacedNote(result.replaced, false);
      }
      const embedLine = result.embedUrl ? `EMBED: ${result.embedUrl}\n` : "";
      await writeStdout(`URL: ${result.url}\n${embedLine}MARKDOWN: ${result.markdown}\n`);
    }
    for (const attached of attachedExisting) {
      if (logHuman) {
        process.stderr.write(
          `>> ${attached.source.key}: attached${attached.moved ? " (moved)" : ""} as ${attached.key}\n`,
        );
      }
      const embedLine = attached.embedUrl ? `EMBED: ${attached.embedUrl}\n` : "";
      await writeStdout(`URL: ${attached.url}\n${embedLine}`);
    }
    for (const failure of failures) {
      process.stderr.write(`warning: could not upload ${failure.file}: ${failure.error.message}\n`);
    }
    if (!ctx.quiet && promotion && promotion.promoted.length > 0) {
      process.stderr.write(promotionNote(promotion, promotedBranch));
    }
    if (!ctx.quiet && comment)
      process.stderr.write(
        `>> attachments comment ${comment.action}${commentViaSuffix(comment.via)}\n`,
      );
    if (!ctx.quiet && uploads.length > 0) {
      const ref = ghMetadataFromTarget(target)["gh.ref"];
      process.stderr.write(`>> find these later: uploads find gh.ref=${ref}\n`);
    }
    if (pathHint) process.stderr.write(`${pathHint}\n`);
  }
  return failures.length === 0 ? 0 : 1;
}

/**
 * `attach --branch` path: stages files under
 * `gh/<owner>/<repo>/branch/<branch>/<filename>` instead of a PR/issue
 * number. Never syncs the managed comment (there is no PR/issue to comment
 * on yet, and the comment-gatherer only lists PR/issue prefixes anyway —
 * branch-staged keys are invisible to it by construction).
 */
async function runAttachBranch(
  ctx: CliContext,
  parsed: CommandFlags,
  branch: string,
  run: CommandRunner,
): Promise<number> {
  const repo = resolveRepo(flagString(parsed.flags, "--repo"), run);
  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
  const optimizeOpts = optimizeOptionsFromFlags(parsed.flags, defaults);
  const frameOpts = frameOptionsFromFlags(parsed.flags);
  const contentTypeOverride = flagString(parsed.flags, "--content-type");
  const metaExtras = warnNearMissMeta(ctx, parseMetaFlags(flagValues(parsed.flags, "--meta")));
  const metadata = {
    ...metaExtras,
    ...stateAppMetaFromFlags(parsed.flags),
    ...ghMetadataForBranch(repo, branch),
  };
  validateMetaMap(metadata);

  const logHuman = !ctx.quiet && !ctx.json;
  if (logHuman) {
    const n = parsed.positionals.length;
    process.stderr.write(
      `>> uploading ${n} file${n === 1 ? "" : "s"} (staged for branch ${branch})\n`,
    );
  }

  const target: BranchTarget = { repo, branch };
  // Register any `git branch -m` steps behind this name (issue #920) so the
  // promote that runs when the PR opens sweeps the older names too.
  await registerRenamesBestEffort(ctx.client, run, repo, branch);
  const { uploads, failures, firstError } = await uploadBranchAttachments({
    client: ctx.client,
    target,
    files: parsed.positionals,
    contentType: contentTypeOverride,
    optimize: optimizeOpts,
    frame: frameOpts,
    metadata,
    deriveImageFacts: derivedMetaEnabled(parsed.flags, defaults),
  });

  // Single-file total failure: rethrow so CLI exit codes stay auth/network-aware.
  if (uploads.length === 0 && failures.length === 1 && parsed.positionals.length === 1) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  // Stage-time binding warning (issue #398): only worth checking once staging
  // actually produced something to warn about. Best-effort — see
  // resolveStageBindingWarning; never affects exit code or the upload itself.
  const bindingWarning =
    uploads.length > 0 ? await resolveStageBindingWarning({ ctx, defaults, repo }) : undefined;

  if (ctx.json) {
    await writeJson({
      target,
      uploads,
      failures,
      ...(bindingWarning ? { hint: bindingWarning } : {}),
    });
  } else {
    for (const result of uploads) {
      if (logHuman) {
        if (result.frame?.framed) {
          process.stderr.write(
            `>> ${basename(result.file)}: framed with ${result.frame.frameId}\n`,
          );
        }
        const note = formatOptimizeNote(result.optimize);
        if (note) process.stderr.write(`>> ${basename(result.file)}: ${note}\n`);
        writeReplacedNote(result.replaced, false);
      }
      const embedLine = result.embedUrl ? `EMBED: ${result.embedUrl}\n` : "";
      await writeStdout(`URL: ${result.url}\n${embedLine}MARKDOWN: ${result.markdown}\n`);
    }
    for (const failure of failures) {
      process.stderr.write(`warning: could not upload ${failure.file}: ${failure.error.message}\n`);
    }
    if (!ctx.quiet && uploads.length > 0) {
      process.stderr.write(`>> find these later: uploads find gh.branch=${branch.toLowerCase()}\n`);
      process.stderr.write(
        `>> staged: these auto-attach to this branch's PR when it opens ` +
          `(or run \`uploads attach --promote\` after opening)\n`,
      );
    }
    if (bindingWarning) process.stderr.write(`${bindingWarning}\n`);
  }
  return failures.length === 0 ? 0 : 1;
}

/**
 * One source of truth for the "staged, but not going to auto-attach" advisory
 * text (issue #398), shared by the `attach --branch`/bare-`put` stage-time
 * warning below and the `uploads staged` view (issue #405) — both surfaces
 * must say the exact same thing for the same binding state, verified by
 * tests on both call sites. Returns undefined for `"self"` (the happy path —
 * callers each phrase that themselves) and any unrecognized value.
 */
export function stagingBindingAdvisory(binding: string, repo: string): string | undefined {
  switch (binding) {
    case "none":
      return (
        `staged, but ${repo} isn't linked to your workspace yet — staged files only ` +
        `auto-attach on PR open for linked repos. Link it once with: uploads attach <file> ` +
        `(on any PR) or uploads github link. After the PR opens: uploads attach --promote`
      );
    case "other":
      return (
        `staged, but ${repo} is linked to a different workspace — these files won't ` +
        `auto-attach from here.`
      );
    default:
      return undefined; // "self", or any unrecognized value
  }
}

/**
 * Best-effort stage-time binding warning (issue #398): after `attach
 * --branch` stages files, checks whether `repo` is bound to THIS workspace —
 * webhook auto-promotion at PR open only fires for a repo already bound
 * (#297), and staging alone never binds one. Fires only for `binding: "none"`
 * (unbound) or `"other"` (bound elsewhere); `"self"` and any failure
 * (network, non-200, older server without the route, `binding: "unknown"`)
 * are silent — this is advisory only and must never make staging look like
 * it failed. Same suppression as the #393 put nudge: `--quiet`,
 * `UPLOADS_NO_NUDGE=1` (env or config).
 */
export async function resolveStageBindingWarning(opts: {
  ctx: CliContext;
  defaults: PutDefaults;
  repo: string;
}): Promise<string | undefined> {
  const { ctx, defaults, repo } = opts;
  if (ctx.quiet) return undefined;
  if (defaults.noNudge) return undefined;
  try {
    const { binding } = await ctx.client.githubRepoLinkStatus(repo);
    const advisory = stagingBindingAdvisory(binding, repo);
    return advisory ? `note: ${advisory}` : undefined;
  } catch {
    return undefined; // any failure (network, non-200, older server) — stay silent
  }
}

/**
 * `attach --promote` with zero file arguments: resolve the PR target (same
 * resolution as the default `runAttach` path), promote this workspace's
 * branch-staged attachments into it, then run the comment sync — useful
 * right after `gh pr create` when the PR was opened without a fresh attach
 * (auto-promotion on the default path only fires when you attach a file).
 * Unlike the default path's best-effort branch resolution, this is an
 * explicit user action: `resolveCurrentBranch` throwing (detached HEAD, not
 * a repo) propagates as a UsageError instead of silently skipping. Always
 * exits 0 — an empty staging prefix is success, not a failure.
 */
async function runAttachPromoteOnly(
  ctx: CliContext,
  parsed: CommandFlags,
  run: CommandRunner,
): Promise<number> {
  const explicitTarget = ghTargetFromFlags(parsed.flags, run);
  const target =
    explicitTarget ??
    resolveCurrentPullRequest(resolveRepo(flagString(parsed.flags, "--repo"), run), run);
  if (target.kind !== "pull") {
    throw new UsageError("--from-branch only promotes into a pull request");
  }
  const explicitFromBranch = flagString(parsed.flags, "--from-branch");
  const branch = explicitFromBranch ?? resolveCurrentBranch(run);

  await registerRenamesBestEffort(ctx.client, run, target.repo, branch, {
    explicit: explicitFromBranch !== undefined,
  });
  const promotion = await attemptPromoteBranch(ctx.client, target, branch);

  let comment: AttachmentsCommentResult | undefined;
  let commentError: string | undefined;
  if (!parsed.flags.has("--no-comment")) {
    try {
      comment = await syncAttachmentsComment(ctx.client, target, run, ctx.config.workspace);
    } catch (err) {
      commentError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warning: promotion succeeded but the GitHub comment failed (is gh installed and authenticated?): ${commentError}\n`,
      );
    }
  }

  if (ctx.json) {
    await writeJson({
      target,
      uploads: [],
      failures: [],
      comment,
      commentError,
      promotion: promotion ?? null,
    });
  } else {
    if (!ctx.quiet && promotion && promotion.promoted.length > 0) {
      process.stderr.write(promotionNote(promotion, branch));
    }
    if (!ctx.quiet && comment)
      process.stderr.write(
        `>> attachments comment ${comment.action}${commentViaSuffix(comment.via)}\n`,
      );
  }
  return 0;
}

/** Bounds the best-effort `gh pr view` lookup the put nudge (issue #393) makes
 * on top of the normal put flow — long enough for a real gh call, short
 * enough to never be felt as a hang. */
const PUT_NUDGE_GH_TIMEOUT_MS = 3000;

/**
 * The bare-put nudge's wording (issue #393, made concrete by issue #700):
 * teaches `--pr`/`attach --branch` as an upgrade from a targetless `put`.
 * `pr` present → names the PR and, once upload `keys` are known, appends a
 * ready-made follow-up command naming them verbatim (e.g. `uploads attach
 * --pr 1250 f/abc123.webp`); otherwise a generic variant that still points
 * at `--pr <num>`. Used verbatim for both the human-mode stderr line and the
 * JSON `hint` field.
 */
export function putNudgeText(branch: string, pr: number | undefined, keys: string[] = []): string {
  const prClause =
    pr !== undefined ? ` (PR #${pr} open) — rerun with --pr ${pr}` : ` — rerun with --pr <num>`;
  const base =
    `note: on branch ${branch}${prClause} for a stable key plus a managed comment ` +
    `that collects this PR's media, or stage pre-PR files with: uploads attach <file> --branch`;
  if (pr === undefined || keys.length === 0) return base;
  return `${base}. Already uploaded? uploads attach --pr ${pr} ${keys.join(" ")}`;
}

/**
 * Auto-PR note (issue #700): announces at the moment it fires that a bare
 * put/screenshot on this branch was auto-attached to `pr` — the default
 * behavior change this issue introduces — and how to opt out.
 */
export function autoPrNoteText(pr: number): string {
  return (
    `note: branch maps to open PR #${pr} — auto-attached (stable key + managed comment sync). ` +
    `Opt out with --no-pr or UPLOADS_NO_AUTO_PR=1.`
  );
}

/**
 * Best-effort bare-put/screenshot nudge context (issue #393): resolves the
 * branch and, when detectable, the open PR for it — fires only when there is
 * no targeting flag at all (`--pr`/`--issue`/`--key`; `--branch` too, though
 * `put` doesn't currently accept it — defensive parity with `attach`), is
 * inside a git repo (reusing `deriveRepoFromGit`, the same detection the
 * default screenshot key's repo segment uses), and the current branch isn't
 * the default one. Never throws — any failure (not a repo, detached HEAD,
 * `gh` missing/unauthenticated/timed out) degrades to "no nudge" or, once a
 * branch is already known, to a context with `pr: undefined` (the generic
 * no-PR wording). Must never affect put's exit code, stdout, or upload
 * behavior. Callers turn the result into text via `putNudgeText`, once any
 * upload keys are known.
 */
export function resolvePutNudgeContext(opts: {
  quiet: boolean;
  noNudge: boolean;
  ghTarget: GhTarget | undefined;
  keyHint: string | undefined;
  /** True when an explicit `--branch`-style flag was given (CLI `attach`
   * parity; `put`/MCP `put` don't accept one — pass false there). */
  hasBranchFlag?: boolean;
  noGit: boolean;
  repoArg: string | undefined;
  run: CommandRunner;
}): { branch: string; pr: number | undefined } | undefined {
  const { quiet, noNudge, ghTarget, keyHint, hasBranchFlag, noGit, repoArg, run } = opts;
  if (quiet) return undefined;
  if (noNudge) return undefined;
  if (ghTarget || keyHint || noGit) return undefined;
  if (hasBranchFlag) return undefined; // not a real put flag today; defensive only
  try {
    if (deriveRepoFromGit(run) === undefined) return undefined; // not a (usable) git repo
    const branch = resolveCurrentBranchSafe(run);
    if (branch === undefined) return undefined; // detached HEAD, or git unavailable
    const defaultBranch = resolveDefaultBranch(run);
    const onDefaultBranch = defaultBranch
      ? branch === defaultBranch
      : branch === "main" || branch === "master"; // undetermined: err toward not nudging
    if (onDefaultBranch) return undefined;

    let pr: number | undefined;
    try {
      // Only swap in the bounded runner for the real subprocess path — an
      // injected `run` (tests, or a future caller) is trusted to already be
      // fast/fake, and execFileSync's `timeout` option is meaningless
      // against anything that isn't actually shelling out.
      const timed = run === execRunner ? timedExecRunner(PUT_NUDGE_GH_TIMEOUT_MS) : run;
      const repo = resolveRepo(repoArg, timed);
      pr = resolveCurrentPullRequest(repo, timed).num;
    } catch {
      pr = undefined; // gh missing/unauthenticated/timed out/no open PR — generic wording
    }
    return { branch, pr };
  } catch {
    return undefined;
  }
}

/** A #700 auto-PR match: the PR the current branch maps to, plus that branch. */
export interface AutoPrMatch {
  target: GhTarget;
  branch: string;
}

/**
 * Auto-PR context (issue #700): when a bare put/screenshot has no explicit
 * destination flag at all (`--pr`/`--issue`/`--key`/`--ref`/`--prefix`/
 * `--destination`, and for `screenshot` no explicit `--branch`) and runs on a
 * branch that maps to exactly one open PR, this resolves that PR so the
 * caller can behave as if `--pr <n>` had been passed — stable key + managed
 * comment sync — instead of the #403/#469 staging default or the plain dated
 * layout. `resolveCurrentPullRequest`'s `gh pr view <branch>` lookup is
 * already the unambiguous case: it names the single open PR whose head is
 * that branch, or fails (no open PR, or `gh` unavailable/unauthenticated) —
 * there is no "ambiguous, more than one" state to further disambiguate.
 * Opt-out: `noAutoPr` (the caller folds in `--no-pr` and
 * `UPLOADS_NO_AUTO_PR=1`/config). Never fires outside a git checkout, on the
 * default branch, or with `--no-git`; any failure (not a repo, detached
 * HEAD, gh missing/unauthenticated/timed out, no open PR) degrades to
 * undefined so the caller falls back to its normal staging/dated behavior.
 *
 * The match carries the `branch` it was resolved from, so callers that need
 * the current branch (the #920 rename registration) reuse it instead of
 * spawning `git rev-parse` a second time.
 */
export function resolveAutoPrTarget(opts: {
  ghTarget: GhTarget | undefined;
  keyHint: string | undefined;
  refArg: string | undefined;
  prefixArg: string | undefined;
  destinationArg: string | undefined;
  /** Explicit `--branch` (screenshot only) also opts out — put has no
   * `--branch` flag today, so callers pass undefined there. */
  branchArg?: string | undefined;
  noGit: boolean;
  noAutoPr: boolean;
  repoArg: string | undefined;
  run: CommandRunner;
}): AutoPrMatch | undefined {
  const {
    ghTarget,
    keyHint,
    refArg,
    prefixArg,
    destinationArg,
    branchArg,
    noGit,
    noAutoPr,
    repoArg,
    run,
  } = opts;
  if (noAutoPr) return undefined;
  if (ghTarget || keyHint || noGit) return undefined;
  if (refArg || prefixArg || destinationArg || branchArg !== undefined) return undefined;
  try {
    if (deriveRepoFromGit(run) === undefined) return undefined; // not a (usable) git repo
    const branch = resolveCurrentBranchSafe(run);
    if (branch === undefined) return undefined; // detached HEAD, or git unavailable
    const defaultBranch = resolveDefaultBranch(run);
    const onDefaultBranch = defaultBranch
      ? branch === defaultBranch
      : branch === "main" || branch === "master"; // undetermined: err toward the old default
    if (onDefaultBranch) return undefined;

    // Same bounded-timeout treatment as the #393 nudge's `gh pr view` call —
    // this must never be felt as a hang.
    const timed = run === execRunner ? timedExecRunner(PUT_NUDGE_GH_TIMEOUT_MS) : run;
    const repo = resolveRepo(repoArg, timed);
    return { target: resolveCurrentPullRequest(repo, timed), branch };
  } catch {
    return undefined; // gh/git unavailable, no open PR, or repo unresolvable
  }
}

/**
 * Bare-put branch-staging trigger (issue #403): put on a non-default git
 * branch stages to the branch prefix by default — the branch becomes the
 * organizing unit instead of the date, superseding the #393 CLI nudge for
 * this case (see `putStagingNoteText`). Reuses the same detection stack as
 * `resolvePutNudge` (`deriveRepoFromGit` / `resolveCurrentBranch` /
 * `resolveDefaultBranch` / main-master fallback) plus a `resolveRepo` lookup
 * (needed for the "owner/name" staging key) and an explicit-flag opt-out:
 * `ghTarget`/`keyHint`/`refArg`/`prefixArg`/`destinationArg` set, or `noGit`,
 * forces the classic dated (or typed-destination) layout. Never throws — any
 * failure (not a repo, detached HEAD, gh missing/unauthenticated/timed out,
 * unresolvable repo) degrades to "no staging", leaving the caller to fall
 * back to the dated path.
 *
 * Plain-params (not CLI `flags`) so both `runPut` and the local stdio MCP
 * `put` tool — same staging default, issue #403's scope — can call this
 * without either depending on the other's argument shape.
 */
export function resolvePutStagingTarget(opts: {
  ghTarget: GhTarget | undefined;
  keyHint: string | undefined;
  refArg: string | undefined;
  prefixArg: string | undefined;
  /** Explicit `--destination` (CLI) / `destination` (MCP) also opts out — it
   * resolves to its own prefix via `resolvePutPrefix`, which staging would
   * otherwise silently override. */
  destinationArg: string | undefined;
  noGit: boolean;
  repoArg: string | undefined;
  run: CommandRunner;
}): BranchTarget | undefined {
  const { ghTarget, keyHint, refArg, prefixArg, destinationArg, noGit, repoArg, run } = opts;
  if (ghTarget || keyHint || noGit) return undefined;
  if (refArg || prefixArg || destinationArg) return undefined;
  try {
    if (deriveRepoFromGit(run) === undefined) return undefined; // not a (usable) git repo
    const branch = resolveCurrentBranchSafe(run);
    if (branch === undefined) return undefined; // detached HEAD, or git unavailable
    const defaultBranch = resolveDefaultBranch(run);
    const onDefaultBranch = defaultBranch
      ? branch === defaultBranch
      : branch === "main" || branch === "master"; // undetermined: err toward the dated layout
    if (onDefaultBranch) return undefined;

    // Same bounded-timeout treatment as the #393 nudge's `gh pr view` call —
    // this is best-effort, and must never be felt as a hang.
    const timed = run === execRunner ? timedExecRunner(PUT_NUDGE_GH_TIMEOUT_MS) : run;
    const repo = resolveRepo(repoArg, timed);
    return { repo, branch };
  } catch {
    return undefined; // gh/git unavailable, or repo unresolvable — dated layout
  }
}

/**
 * Merges a staging target's `gh.*` branch metadata over `base` and validates
 * the result (same builder, same contract as `attach --branch`) — the one
 * merge+validate step shared by every staging call site: `runPut`,
 * `runScreenshot`, and both the local stdio MCP `put` and `screenshot`
 * tools.
 */
export function mergeStagingMeta(
  base: Record<string, string> | undefined,
  target: BranchTarget,
): Record<string, string> {
  const merged = { ...base, ...ghMetadataForBranch(target.repo, target.branch) };
  validateMetaMap(merged);
  return merged;
}

/**
 * The bare-put staging note's wording (issue #403): replaces the #393 nudge
 * for the (now default) case where a bare put on a non-default branch stages
 * to the branch prefix instead of landing on the dated layout. Used verbatim
 * for both the human-mode stderr line and the JSON `hint` field.
 */
export function putStagingNoteText(branch: string): string {
  return (
    `note: staged for branch ${branch} — auto-comments to pull request when opened ` +
    `(or run: uploads attach --promote once it exists). Use --ref/--prefix for a plain dated upload.`
  );
}

// --- staged ---

/** One file currently staged for a branch (issue #405). */
export interface StagedFile {
  /** Full object key (`gh/<owner>/<repo>/branch/<branch>/<filename>`). */
  key: string;
  /** `key` with the staging prefix stripped. */
  filename: string;
  size?: number;
  /** `gh.staged-at` metadata (ISO 8601 UTC), when present. */
  stagedAt?: string;
  url: string | null;
}

/** Tri-state binding, folded into a ready-to-render advisory (issue #405/#398). */
export interface StagedBinding {
  state: "self" | "other" | "none" | "unknown";
  /** True only for "self" — the only state where staged files actually auto-attach. */
  autoAttach: boolean;
  message: string;
}

export interface StagedResult {
  repo: string;
  branch: string;
  files: StagedFile[];
  binding: StagedBinding;
}

/**
 * Binding lookup for `uploads staged`, folded into a renderable `StagedBinding`.
 * `"none"`/`"other"` reuse `stagingBindingAdvisory` — the exact #398 wording,
 * one source of truth. `"self"` gets its own message (the #398 warning stays
 * silent on "self"; this view is the one place that names the happy path
 * explicitly). Any failure (network, non-200, older server without the
 * route) degrades to `"unknown"` rather than throwing — this is a read-only
 * view and a binding check failing must never make it fail outright.
 */
async function resolveStagedBinding(client: UploadsClient, repo: string): Promise<StagedBinding> {
  try {
    const { binding } = await client.githubRepoLinkStatus(repo);
    switch (binding) {
      case "self":
        return {
          state: "self",
          autoAttach: true,
          message: "these auto-attach when this branch's PR opens",
        };
      case "none":
      case "other":
        return {
          state: binding,
          autoAttach: false,
          // stagingBindingAdvisory is total for "none"/"other" — never undefined here.
          message: stagingBindingAdvisory(binding, repo)!,
        };
      default:
        return { state: "unknown", autoAttach: false, message: "binding status unrecognized" };
    }
  } catch {
    return {
      state: "unknown",
      autoAttach: false,
      message: "could not check binding status (offline, or an older server without this route)",
    };
  }
}

/**
 * Shared core for `uploads staged` (CLI) and the `staged` MCP tool (issue
 * #405): one `list` call against the branch staging prefix
 * (`ghBranchKeyPrefix` — never hand-built) plus the #398 binding check. Never
 * throws on the binding check (see `resolveStagedBinding`); a failed `list`
 * call still propagates, same as every other read command.
 */
export async function resolveStaged(opts: {
  client: UploadsClient;
  repo: string;
  branch: string;
}): Promise<StagedResult> {
  const { client, repo, branch } = opts;
  const plainPrefix = ghBranchKeyPrefix(repo, branch);
  // Also list every active private prefix, if any (issue #631) — mirrors
  // syncAttachmentsComment's gh-fallback gather above: a repo's staged
  // history can be split across the plain shape and MULTIPLE private
  // prefixes (e.g. a prefix rotation, or the repo went private after some
  // files were staged), not just the currently-resolved one. Fail-open: any
  // resolve failure degrades to plain-only, byte-identical to pre-#631.
  const ghPrefix = await resolveGhPrefixSafe(client, { repo, branch });
  const prefixes = ghListPrefixes(plainPrefix, ghPrefix, (id) => ghPrivateBranchKeyPrefix(id));
  const [files, binding] = await Promise.all([
    ghMergedList(prefixes, undefined, async (prefix) => {
      const list = await client.list({ prefix, metadata: true });
      return list.items.map((item) => ({
        key: item.key,
        filename: item.key.slice(prefix.length),
        size: item.size,
        stagedAt: item.metadata?.["gh.staged-at"],
        url: item.url,
      }));
    }),
    resolveStagedBinding(client, repo),
  ]);
  return { repo, branch, files, binding };
}

const STAGED_HELP = `uploads staged [--branch <name>] [--repo <owner/name>] [--format json] [--workspace <name>]

Read-only view of what's staged for a branch (\`attach --branch\` / bare
\`put\` on a non-default branch, issue #403) and whether it will auto-attach
once a PR opens. One \`list\` call against the branch staging prefix
(gh/<owner>/<repo>/branch/<branch>/) plus a binding check — files:read only,
no new server surface.

Defaults: current git branch (same resolution as \`attach --branch\`, worktree-
safe), repo from --repo / gh / git remote (same as every other command).

Binding: self means these files auto-attach when this branch's PR opens; none
or other means they won't (repo unlinked, or linked to a different
workspace) — same advisory as the attach --branch stage-time warning.

Examples:
  uploads staged
  uploads staged --branch feature/thing --repo owner/name
  uploads staged --format json
`;

export async function runStaged(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(STAGED_HELP);
    return 0;
  }
  const format = ctx.json
    ? "json"
    : (() => {
        const raw = flagString(parsed.flags, "--format");
        if (!raw || raw === "human") return "human" as const;
        if (raw === "json") return "json" as const;
        throw new UsageError(`invalid --format: ${raw} (expected: json)`);
      })();

  const repo = resolveRepo(flagString(parsed.flags, "--repo"), run);
  const branch = flagString(parsed.flags, "--branch") ?? resolveCurrentBranch(run);

  const result = await resolveStaged({ client: ctx.client, repo, branch });

  if (format === "json") {
    // Always a valid JSON document, even with zero files — never empty
    // stdout (issue #405 explicitly calls out find --format json's empty-
    // stdout-on-no-matches wart as a wrong pattern to avoid here).
    await writeJson(result);
    return 0;
  }

  if (result.files.length === 0) {
    await writeStdout(`nothing staged for ${branch} in ${repo}\n`);
    return 0;
  }

  for (const file of result.files) {
    const size = file.size !== undefined ? formatByteSize(file.size) : "? B";
    const staged = file.stagedAt ? `  staged ${file.stagedAt}` : "";
    await writeStdout(`${file.filename}  ${size}${staged}  ${file.url ?? "(no url)"}\n`);
  }
  process.stderr.write(`binding: ${result.binding.state} — ${result.binding.message}\n`);
  // Promote is pointless advice when the repo belongs to another workspace —
  // the cross-tenant gate (#297) would reject it from here.
  if (result.binding.state !== "other") {
    process.stderr.write(`once the PR exists: uploads attach --promote\n`);
  }
  return 0;
}

export async function runPut(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  if (help) {
    writeCommandHelp(PUT_HELP);
    return 0;
  }
  const parsed = parseCommandArgs(args);
  if (parsed.help) {
    writeCommandHelp(PUT_HELP);
    return 0;
  }

  const files = parsed.positionals;
  if (parsed.flags.get("--url") === true) {
    throw new UsageError("missing value for --url", {
      example: "uploads put --url https://cdn.example/shot.png --pr 123",
    });
  }
  const urlArgs = flagValues(parsed.flags, "--url");
  if (files.length > 0 && urlArgs.length > 0) {
    throw new UsageError("--url cannot be combined with file arguments", {
      example: "uploads put --url https://cdn.example/shot.png --pr 123",
    });
  }
  if (files.length === 0 && urlArgs.length === 0) {
    throw new UsageError("put requires at least one file or --url", {
      example: "uploads put ./shot.png --pr 123",
    });
  }
  const multi = files.length > 1 || urlArgs.length > 1;

  // Resolved early (issue #700): both the auto-PR opt-out default and the
  // `--no-git`-gated staging/auto-PR detection below need it before the rest
  // of put's flag parsing.
  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
  const noGit = flagBool(parsed.flags, "--no-git") || defaults.noGit === true;

  const keyHint = flagString(parsed.flags, "--key");
  const destFlag = flagString(parsed.flags, "--destination");
  const prefixFlag = flagString(parsed.flags, "--prefix");
  const ghTarget = ghTargetFromFlags(parsed.flags, run);
  if (parsed.flags.has("--no-pr") && typeof parsed.flags.get("--no-pr") === "string") {
    throw new UsageError("--no-pr takes no value");
  }
  const noAutoPr = flagBool(parsed.flags, "--no-pr") || defaults.noAutoPr === true;
  // Auto-PR context (issue #700): a bare put (no --pr/--issue/--key/--ref/
  // --prefix/--destination, not --no-git/--no-pr) on a branch that maps to
  // exactly one open PR behaves as if `--pr <n>` had been passed — see
  // resolveAutoPrTarget. Supersedes both the #403 staging default and the
  // #393 nudge for this case; computed before the gh.* metadata resolution
  // below since it takes over that resolution entirely.
  const autoPrMatch: AutoPrMatch | undefined = ghTarget
    ? undefined
    : resolveAutoPrTarget({
        ghTarget,
        keyHint,
        refArg: flagString(parsed.flags, "--ref"),
        prefixArg: prefixFlag,
        destinationArg: destFlag,
        noGit,
        noAutoPr,
        repoArg: flagString(parsed.flags, "--repo") ?? defaults.repo,
        run,
      });
  const autoPrTarget = autoPrMatch?.target;
  const effectiveGhTarget = ghTarget ?? autoPrTarget;
  // Comment sync runs by default with --pr/--issue (matches `attach`); opt
  // out with --no-comment. --comment is accepted as a redundant no-op for
  // back-compat with scripts written before this default flipped (#537).
  const wantComment = !parsed.flags.has("--no-comment");
  const galleryId = flagString(parsed.flags, "--gallery");
  const nameFlag = flagString(parsed.flags, "--name");
  const dryRun = flagBool(parsed.flags, "--dry-run");
  // Strict-overwrite escape hatch (issue #174): only matters on non-gh/ keys
  // (--key or the default put path) — the server ignores `replace` on
  // managed gh/ paths (--pr/--issue), which always hot-swap regardless.
  const replaceFlag = flagBool(parsed.flags, "--replace") || process.env.UPLOADS_OVERWRITE === "1";
  // Validate --meta up front (fail fast, before reading/optimizing the file).
  const userMeta = ((): Record<string, string> | undefined => {
    const pairs = flagValues(parsed.flags, "--meta");
    const fromMeta = warnNearMissMeta(ctx, pairs.length > 0 ? parseMetaFlags(pairs) : {});
    // Dedicated flags are explicit input and win over a same-named --meta pair.
    const merged = { ...fromMeta, ...stateAppMetaFromFlags(parsed.flags) };
    if (Object.keys(merged).length === 0) return undefined;
    validateMetaMap(merged);
    return merged;
  })();
  if (parsed.flags.has("--comment") && typeof parsed.flags.get("--comment") === "string") {
    throw new UsageError("--comment takes no value — place it after the file argument");
  }
  if (parsed.flags.has("--no-comment") && typeof parsed.flags.get("--no-comment") === "string") {
    throw new UsageError("--no-comment takes no value");
  }
  if (parsed.flags.has("--auto") && typeof parsed.flags.get("--auto") === "string") {
    throw new UsageError("--auto takes no value");
  }
  if (parsed.flags.has("--no-auto") && typeof parsed.flags.get("--no-auto") === "string") {
    throw new UsageError("--no-auto takes no value");
  }
  if (parsed.flags.has("--no-comment") && !effectiveGhTarget) {
    throw new UsageError("--no-comment requires --pr or --issue");
  }
  if (multi) {
    if (keyHint) throw new UsageError("--key cannot be combined with multiple files");
    if (nameFlag !== undefined)
      throw new UsageError("--name cannot be combined with multiple files");
    if (files.some((f) => f === "-")) {
      throw new UsageError("stdin (-) cannot be combined with multiple file arguments");
    }
  }
  if (ghTarget) {
    if (keyHint) {
      throw new UsageError(
        "--key cannot be combined with --pr/--issue; use --name <leaf> to set a clean filename on the stable path",
      );
    }
    if (flagString(parsed.flags, "--ref")) {
      throw new UsageError("--ref cannot be combined with --pr/--issue");
    }
    if (prefixFlag) throw new UsageError("--prefix cannot be combined with --pr/--issue");
  }
  if (nameFlag !== undefined) {
    if (nameFlag === "" || nameFlag.includes("/")) {
      throw new UsageError("--name must be a bare filename with no '/'");
    }
    if (keyHint) throw new UsageError("--name cannot be combined with --key");
  }
  if (dryRun && galleryId) throw new UsageError("--dry-run cannot be combined with --gallery");
  let resolvedPrefix: string | undefined;
  try {
    resolvedPrefix = resolvePutPrefix({
      destination: destFlag,
      prefix: prefixFlag,
      key: keyHint,
      ghAttachment: Boolean(effectiveGhTarget),
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const format = ctx.json
    ? "json"
    : (() => {
        const raw = flagString(parsed.flags, "--format");
        if (!raw || raw === "human") return "human" as const;
        if (raw === "url" || raw === "markdown" || raw === "json") return raw;
        throw new UsageError(`invalid --format: ${raw}`);
      })();

  const optimizeOpts = optimizeOptionsFromFlags(parsed.flags, defaults);
  const frameOpts = frameOptionsFromFlags(parsed.flags);
  const contentTypeOverride = flagString(parsed.flags, "--content-type");
  const altFlag = flagString(parsed.flags, "--alt");
  const widthRaw = flagString(parsed.flags, "--width");
  const width =
    widthRaw && /^\d+$/.test(widthRaw) && Number(widthRaw) > 0
      ? Number.parseInt(widthRaw, 10)
      : widthRaw
        ? (() => {
            throw new UsageError(`invalid --width: ${widthRaw}`);
          })()
        : defaults.width;

  // Bare-put branch staging (issue #403): a bare put (no --pr/--issue/--key/
  // --ref/--prefix/--destination, not --no-git) on a non-default git branch
  // stages to the branch prefix — identical key/metadata to `attach
  // --branch` — instead of the dated layout. Computed before gh.* metadata
  // resolution below since it takes over that resolution entirely (branch
  // metadata, not PR/issue metadata) and supersedes the #393 nudge for this
  // case. `effectiveGhTarget` (explicit --pr/--issue OR the #700 auto-PR
  // match) wins over staging, same as it wins over the dated layout.
  const stagingTarget = resolvePutStagingTarget({
    ghTarget: effectiveGhTarget,
    keyHint,
    refArg: flagString(parsed.flags, "--ref"),
    prefixArg: prefixFlag,
    destinationArg: destFlag,
    noGit,
    repoArg: flagString(parsed.flags, "--repo") ?? defaults.repo,
    run,
  });

  // gh.* metadata: explicit --pr/--issue target (or the #700 auto-PR match)
  // wins over --meta; staging wins over --meta the same way (matches attach
  // --branch); otherwise best-effort auto resolution (on by default) where
  // --meta wins. --no-git, --no-auto, or UPLOADS_NO_AUTO_META disable auto;
  // --auto forces past the config default but never past --no-git (no repo
  // to resolve).
  let metadata = userMeta;
  let attachedRef: string | undefined;
  if (effectiveGhTarget) {
    const merged = { ...userMeta, ...ghMetadataFromTargetWithTitle(effectiveGhTarget, run) };
    validateMetaMap(merged); // enforce 24-key/8KB caps on the merged map (matches attach)
    metadata = merged;
    attachedRef = merged["gh.ref"];
    // Auto-PR (#700) suppresses staging, so the staging branch below never
    // runs — but this put still comes from a branch that may have been
    // renamed while files were staged under the old name. Register the
    // lineage here too (issue #920), reusing the branch the match already
    // resolved. Only for the auto-PR match: an explicit --pr/--issue names
    // no branch of its own.
    if (autoPrMatch && !dryRun) {
      await registerRenamesBestEffort(ctx.client, run, autoPrMatch.target.repo, autoPrMatch.branch);
    }
  } else if (stagingTarget) {
    metadata = mergeStagingMeta(userMeta, stagingTarget);
    // Branch staging: register any rename behind this name (issue #920) so
    // the PR-time promote finds files staged under the older names too.
    if (!dryRun) {
      await registerRenamesBestEffort(ctx.client, run, stagingTarget.repo, stagingTarget.branch);
    }
  } else {
    // gh.* additionally needs git, which the shared derived gate ignores.
    if (!noGit && derivedMetaEnabled(parsed.flags, defaults)) {
      const autoTarget = resolveAutoGhTarget(
        flagString(parsed.flags, "--repo") ?? defaults.repo,
        flagString(parsed.flags, "--ref") ?? defaults.ref,
        run,
      );
      if (autoTarget) {
        const autoMeta = ghMetadataFromTargetWithTitle(autoTarget, run);
        const merged = { ...autoMeta, ...userMeta };
        // Auto resolution must never fail the upload: if merging the gh.* pairs
        // would exceed the metadata caps, drop them and upload with --meta only.
        try {
          validateMetaMap(merged);
          metadata = merged;
          attachedRef = merged["gh.ref"];
        } catch {
          // keep metadata = userMeta (already validated); skip auto gh.*
        }
      }
    }
  }

  // Derived `repo` (spec: 2026-08-11-screenshots-project-grouping-design.md):
  // the capturing repo, on every layout including gh/staging. mergeDerivedMeta
  // keeps explicit --meta repo= wins and never breaks the caps.
  //
  // `metadata === undefined` means "leave whatever's already stored for this
  // key untouched" (client.ts only sends X-Uploads-Meta-* when the map is
  // defined; a defined map is a full replace server-side). A bare `uploads
  // put` with no --meta/gh/staging context leaves `metadata` undefined by
  // design — never synthesize `{ repo }` there just because a repo happens
  // to be derivable, or a plain re-upload of an existing key would silently
  // wipe everything already stored on it. Only fold repo in when `metadata`
  // is already a defined object for another reason.
  if (!noGit && derivedMetaEnabled(parsed.flags, defaults) && metadata !== undefined) {
    const slug = deriveRepoSlugFromGit(run);
    if (slug) metadata = mergeDerivedMeta(metadata, { repo: slug });
  }

  // #692 follow-up: a path-tagged upload with no repo/gh.repo/app context and
  // no real (non-local) origin lands in the screenshots page's fallback
  // buckets — one advisory line at the moment the context went missing.
  // --no-git is an explicit choice, so it suppresses the nudge too.
  const contextNudge =
    !ctx.quiet && !defaults.noNudge && !noGit ? noProjectContextNudge(metadata) : undefined;

  // Bare-put nudge (issue #393): only relevant when neither auto-PR nor
  // staging took over — once `effectiveGhTarget`/`stagingTarget` resolves,
  // that IS the upgrade the nudge used to point at, so this is skipped
  // entirely rather than firing redundantly. Still fires as before for a
  // bare put that lands on the dated layout with a detectable PR (e.g. an
  // explicit --ref/--prefix opts out of staging AND auto-PR, or --no-pr/
  // UPLOADS_NO_AUTO_PR opts out of auto-PR specifically). The concrete
  // key-naming text (issue #700) is finished below, once upload keys exist.
  // Best-effort — see resolvePutNudgeContext; never affects exit code,
  // stdout, or the upload.
  const nudgeContext =
    effectiveGhTarget || stagingTarget
      ? undefined
      : resolvePutNudgeContext({
          quiet: ctx.quiet,
          noNudge: defaults.noNudge === true,
          ghTarget,
          keyHint,
          hasBranchFlag: parsed.flags.has("--branch"),
          noGit,
          repoArg: flagString(parsed.flags, "--repo") ?? defaults.repo,
          run,
        });

  // Staging note (issue #403): same suppression as the #393 nudge
  // (--quiet, UPLOADS_NO_NUDGE=1 env/config); staging itself is NOT gated by
  // either — only whether the note is printed/hinted.
  const stagingNote =
    stagingTarget && !ctx.quiet && !defaults.noNudge
      ? putStagingNoteText(stagingTarget.branch)
      : undefined;

  // Auto-PR note (issue #700): announces the default-behavior change at the
  // moment it fires, so a bare put that silently became a --pr attach isn't
  // a surprise — names the PR and how to opt out. Same suppression as the
  // other advisories (--quiet, UPLOADS_NO_NUDGE=1); NOT gated by --no-pr/
  // UPLOADS_NO_AUTO_PR since those are what prevent it from firing at all.
  const autoPrNote =
    autoPrTarget && !ctx.quiet && !defaults.noNudge ? autoPrNoteText(autoPrTarget.num) : undefined;

  const logHuman = !ctx.quiet && format === "human";
  if (logHuman) {
    if (multi) {
      const n = files.length > 0 ? files.length : urlArgs.length;
      process.stderr.write(`>> ${dryRun ? "dry run for" : "uploading"} ${n} files\n`);
    } else {
      const fileArg = files[0] ?? urlArgs[0]!;
      process.stderr.write(
        `>> ${dryRun ? "dry run" : "uploading"} ${fileArg === "-" ? "stdin" : fileArg}\n`,
      );
    }
    if (attachedRef) process.stderr.write(`>> attached to ${attachedRef}\n`);
  }

  let byteSources: { bytes: Uint8Array; filename: string; source: string }[] | undefined;
  const urlFetchFailures: AttachFailure[] = [];
  let urlFetchFirstError: unknown;
  if (urlArgs.length > 0) {
    byteSources = [];
    for (const raw of urlArgs) {
      try {
        const filename = resolveUploadFilename(raw, !multi ? nameFlag : undefined, "--url", {
          allowLoopback: true,
        });
        const bytes = await fetchUploadSource(raw, {
          label: "--url",
          userAgent: "uploads.sh/cli",
          allowLoopback: true,
        });
        byteSources.push({ bytes, filename, source: raw });
      } catch (err) {
        urlFetchFirstError ??= err;
        urlFetchFailures.push({ file: raw, error: errorDetail(err) });
      }
    }
  }

  let uploads: PutUploadItem[];
  let failures: AttachFailure[];
  let firstError: unknown;
  let sentMetadata: (Record<string, string> | undefined)[];
  if (byteSources && byteSources.length === 0) {
    uploads = [];
    failures = urlFetchFailures;
    firstError = urlFetchFirstError;
    sentMetadata = [];
  } else {
    const batch = await uploadPuts({
      client: ctx.client,
      files: byteSources ? undefined : files,
      byteSources,
      nameOverride: byteSources ? undefined : nameFlag,
      explicitKey: keyHint,
      ghTarget: effectiveGhTarget,
      ghBranchTarget: stagingTarget,
      prefix: resolvedPrefix ?? defaults.prefix,
      repo: flagString(parsed.flags, "--repo") ?? defaults.repo,
      ref: flagString(parsed.flags, "--ref") ?? defaults.ref,
      deriveRepoFromGit: !noGit,
      contentType: contentTypeOverride,
      dryRun,
      replace: replaceFlag,
      optimize: optimizeOpts,
      frame: frameOpts,
      metadata,
      deriveImageFacts: derivedMetaEnabled(parsed.flags, defaults),
      alt: altFlag,
      width,
    });
    uploads = batch.uploads;
    failures = [...urlFetchFailures, ...batch.failures];
    firstError = urlFetchFirstError ?? batch.firstError;
    sentMetadata = batch.sentMetadata;
  }

  // Single-file total failure: rethrow so CLI exit codes stay auth/network-aware.
  if (uploads.length === 0 && failures.length > 0 && !multi) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  // Concrete bare-put nudge text (issue #700): built once upload keys exist,
  // so the ready-made follow-up names them, e.g.
  // "uploads attach --pr 1250 f/abc123.webp". Falls back to the plain
  // #393 wording when there are no successful uploads to name.
  const nudge =
    nudgeContext && uploads.length > 0
      ? putNudgeText(
          nudgeContext.branch,
          nudgeContext.pr,
          uploads.map((u) => u.key),
        )
      : undefined;

  // Stage-time binding warning (issue #398/#400): same check `attach
  // --branch` runs, now also on the bare-put staging path. Best-effort — see
  // resolveStageBindingWarning; never affects exit code or the upload.
  const bindingWarning =
    stagingTarget && uploads.length > 0
      ? await resolveStageBindingWarning({ ctx, defaults, repo: stagingTarget.repo })
      : undefined;
  // Lever 3 (issue #469): tip when a --pr/--issue put lands an image with no
  // `path` meta. Only relevant on the (explicit or auto) gh target path — the
  // bare-put staging/dated paths aren't attached to a PR/issue yet, so
  // there's nothing to look up from a page later.
  const pathHint =
    effectiveGhTarget && uploads.length > 0 && !ctx.quiet
      ? pathMetaHintFor(uploads, sentMetadata)
      : undefined;
  // One JSON `hint` slot, shared across every advisory this command can
  // surface. `autoPrNote` and `nudge` are mutually exclusive with each other
  // and with `stagingNote` (each corresponds to a different destination the
  // upload landed on); pathHint only ever fires on the gh-target path, so it
  // never competes with the other three. Same precedence stderr prints,
  // below.
  const jsonHint = autoPrNote ?? nudge ?? bindingWarning ?? stagingNote ?? pathHint ?? contextNudge;

  type GalleryOutcome = {
    id: string;
    url?: string;
    item?: GalleryItem;
    error?: { message: string; code?: string; status?: number };
  };
  const galleriesByKey = new Map<string, GalleryOutcome>();
  let galleryHadError = false;
  if (galleryId && uploads.length > 0) {
    for (const upload of uploads) {
      const alt = altFlag ?? basename(upload.file === "-" ? upload.optimize.filename : upload.file);
      try {
        // Gallery mutations use optimistic versions. Re-fetch before each add.
        const current = await ctx.client.getGallery(galleryId);
        const item = await ctx.client.addGalleryItem(galleryId, upload.key, {
          expectedVersion: current.version,
          altText: alt,
        });
        galleriesByKey.set(upload.key, { id: galleryId, url: current.url, item });
      } catch (err) {
        galleryHadError = true;
        galleriesByKey.set(upload.key, { id: galleryId, error: errorDetail(err) });
      }
    }
  }

  let comment: AttachmentsCommentResult | undefined;
  let commentError: string | undefined;
  if (wantComment && effectiveGhTarget && !dryRun && uploads.length > 0) {
    try {
      comment = await syncAttachmentsComment(
        ctx.client,
        effectiveGhTarget,
        run,
        ctx.config.workspace,
      );
      if (logHuman)
        process.stderr.write(
          `>> attachments comment ${comment.action}${commentViaSuffix(comment.via)}\n`,
        );
    } catch (err) {
      commentError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warning: upload succeeded but the GitHub comment failed (is gh installed and authenticated?): ${commentError}\n`,
      );
    }
  }

  // --- multi-file output ---
  if (multi) {
    if (format === "json") {
      await writeJson({
        uploads: uploads.map((u) => ({
          ...u,
          gallery: galleriesByKey.get(u.key),
          ...(dryRun ? { dryRun: true } : {}),
        })),
        failures,
        comment,
        commentError,
        ...(jsonHint ? { hint: jsonHint } : {}),
      });
    } else {
      for (const result of uploads) {
        if (logHuman) {
          if (result.frame?.framed) {
            process.stderr.write(
              `>> ${basename(result.file)}: framed with ${result.frame.frameId}\n`,
            );
          }
          const note = formatOptimizeNote(result.optimize);
          if (note) process.stderr.write(`>> ${basename(result.file)}: ${note}\n`);
          writeReplacedNote(result.replaced, false, dryRun, result.wouldRefuse);
          process.stderr.write(
            `>> key: ${result.key}${dryRun ? " (dry run — not uploaded)" : ""}\n`,
          );
        }
        const gallery = galleriesByKey.get(result.key);
        if (format === "url") await writeStdout(`${result.url}\n`);
        else if (format === "markdown") await writeStdout(`${result.markdown}\n`);
        else {
          const embedLine = result.embedUrl ? `EMBED: ${result.embedUrl}\n` : "";
          await writeStdout(
            `URL: ${result.url}\n${embedLine}MARKDOWN: ${result.markdown}${gallery?.url ? `\nGALLERY: ${gallery.url}` : ""}\n`,
          );
        }
        if (gallery?.error) {
          process.stderr.write(
            `warning: upload succeeded but adding ${result.key} to gallery ${gallery.id} failed: ${gallery.error.message}\n`,
          );
        }
      }
      for (const failure of failures) {
        process.stderr.write(
          `warning: could not upload ${failure.file}: ${failure.error.message}\n`,
        );
      }
      if (autoPrNote) process.stderr.write(`${autoPrNote}\n`);
      if (nudge) process.stderr.write(`${nudge}\n`);
      if (stagingNote) process.stderr.write(`${stagingNote}\n`);
      if (bindingWarning) process.stderr.write(`${bindingWarning}\n`);
      if (pathHint) process.stderr.write(`${pathHint}\n`);
      if (contextNudge) process.stderr.write(`${contextNudge}\n`);
    }
    return failures.length === 0 && !galleryHadError ? 0 : 1;
  }

  // --- single-file output (flat JSON shape, back-compat) ---
  const result = uploads[0]!;
  const gallery = galleriesByKey.get(result.key);
  if (logHuman) {
    if (result.frame?.framed) {
      process.stderr.write(`>> framed with ${result.frame.frameId}\n`);
    }
    const note = formatOptimizeNote(result.optimize);
    if (note) process.stderr.write(`>> ${note}\n`);
    writeReplacedNote(result.replaced, ctx.quiet, dryRun, result.wouldRefuse);
    process.stderr.write(`>> key: ${result.key}${dryRun ? " (dry run — not uploaded)" : ""}\n\n`);
  }

  switch (format) {
    case "json":
      await writeJson({
        workspace: result.workspace,
        key: result.key,
        url: result.url,
        embedUrl: result.embedUrl,
        size: result.size,
        contentType: result.contentType,
        replaced: result.replaced,
        markdown: result.markdown,
        optimize: result.optimize,
        frame: result.frame,
        gallery,
        comment,
        commentError,
        ...(dryRun ? { dryRun: true } : {}),
        ...(jsonHint ? { hint: jsonHint } : {}),
      });
      break;
    case "url":
      await writeStdout(`${result.url}\n`);
      break;
    case "markdown":
      await writeStdout(`${result.markdown}\n`);
      break;
    default: {
      const embedLine = result.embedUrl ? `EMBED: ${result.embedUrl}\n` : "";
      await writeStdout(
        `URL: ${result.url}\n${embedLine}MARKDOWN: ${result.markdown}${gallery?.url ? `\nGALLERY: ${gallery.url}` : ""}\n`,
      );
    }
  }

  if (gallery?.url && format !== "human") {
    process.stderr.write(`gallery: ${gallery.url}\n`);
  }
  if (gallery?.error) {
    process.stderr.write(
      `warning: upload succeeded but adding it to gallery ${gallery.id} failed: ${gallery.error.message}\n`,
    );
  }
  if (autoPrNote && format !== "json") process.stderr.write(`${autoPrNote}\n`);
  if (nudge && format !== "json") process.stderr.write(`${nudge}\n`);
  if (stagingNote && format !== "json") process.stderr.write(`${stagingNote}\n`);
  if (bindingWarning && format !== "json") process.stderr.write(`${bindingWarning}\n`);
  if (pathHint && format !== "json") process.stderr.write(`${pathHint}\n`);
  if (contextNudge && format !== "json") process.stderr.write(`${contextNudge}\n`);

  return gallery?.error ? 1 : 0;
}

// --- galleries ---

const GALLERY_HELP = `uploads gallery <command> [args]

Public galleries can be viewed by anyone who knows the URL. Do not add sensitive media.
Deleting a gallery only removes the gallery record; it never deletes its uploaded objects.

Commands:
  create --title <title> [--description <text>]
  show <gallery-id>
  list [--limit <n>] [--cursor <c>] [--all]
  delete <gallery-id>
  add <gallery-id> <object-key...> [--caption <text>] [--alt <text>]
  link <gallery-id> --github <owner/repo#number|github-url>
  unlink <gallery-id> --github <owner/repo#number|github-url>
  list --github <owner/repo#number|github-url> [--limit <n>] [--cursor <c>] [--all]

Examples:
  uploads gallery create --title "Settings redesign"
  uploads gallery add gal_example screenshots/app/after.webp --alt "Updated settings page"
  uploads gallery show gal_example
  uploads gallery link gal_example --github buildinternet/uploads#58
  uploads gallery list --github https://github.com/buildinternet/uploads/pull/58
`;

function githubCoordinateFromFlags(flags: CommandFlags["flags"]): string {
  const value = flagString(flags, "--github");
  if (!value)
    throw new UsageError(
      "--github requires an owner/repo#number coordinate or GitHub issue/PR URL",
    );
  const normalized = normalizeGithubCoordinate(value);
  if (!normalized)
    throw new UsageError(
      "--github must be owner/repo#number or an https://github.com/.../issues|pull/number URL",
    );
  return normalized.coordinate;
}

export async function runGallery(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  const action = parsed.positionals[0];
  if (help || parsed.help) {
    writeCommandHelp(GALLERY_HELP);
    return 0;
  }
  if (!action) {
    throw new UsageError(
      "gallery requires a subcommand: create, show, list, delete, add, link, or unlink",
      { example: 'uploads gallery create --title "Release screenshots"' },
    );
  }

  switch (action) {
    case "create": {
      const title = flagString(parsed.flags, "--title");
      if (!title) {
        throw new UsageError("gallery create requires --title", {
          example: 'uploads gallery create --title "Release screenshots"',
        });
      }
      const gallery = await ctx.client.createGallery({
        title,
        description: flagString(parsed.flags, "--description"),
      });
      if (ctx.json) await writeJson(gallery);
      else await writeStdout(`${gallery.url}\n`);
      if (!ctx.quiet && !ctx.json)
        process.stderr.write("warning: galleries are public to anyone with the URL\n");
      return 0;
    }
    case "show": {
      const id = parsed.positionals[1];
      if (!id) throw new UsageError("gallery show requires a gallery ID");
      const gallery = await ctx.client.getGallery(id);
      if (ctx.json) await writeJson(gallery);
      else await writeStdout(`${gallery.url}\n`);
      return 0;
    }
    case "list": {
      const limit = flagInt(parsed.flags, "--limit", "--limit");
      const cursor = flagString(parsed.flags, "--cursor");
      const github = parsed.flags.has("--github")
        ? githubCoordinateFromFlags(parsed.flags)
        : undefined;
      if (flagBool(parsed.flags, "--all")) {
        const galleries = [];
        let nextCursor: string | undefined = cursor;
        do {
          const page = github
            ? await ctx.client.findGalleriesByReference({
                provider: "github",
                coordinate: github,
                limit,
                cursor: nextCursor,
              })
            : await ctx.client.listGalleries({ limit, cursor: nextCursor });
          galleries.push(...page.galleries);
          nextCursor = page.nextCursor ?? undefined;
        } while (nextCursor);
        if (ctx.json) await writeJson({ galleries, nextCursor: null });
        else
          for (const gallery of galleries)
            await writeStdout(`${gallery.id}  ${gallery.url}  ${gallery.title}\n`);
        return 0;
      }
      const page = github
        ? await ctx.client.findGalleriesByReference({
            provider: "github",
            coordinate: github,
            limit,
            cursor,
          })
        : await ctx.client.listGalleries({ limit, cursor });
      if (ctx.json) await writeJson(page);
      else {
        for (const gallery of page.galleries)
          await writeStdout(`${gallery.id}  ${gallery.url}  ${gallery.title}\n`);
        if (page.nextCursor) process.stderr.write(`cursor: ${page.nextCursor}\n`);
      }
      return 0;
    }
    case "link": {
      const id = parsed.positionals[1];
      if (!id) throw new UsageError("gallery link requires a gallery ID");
      const coordinate = githubCoordinateFromFlags(parsed.flags);
      const current = await ctx.client.getGallery(id);
      const reference = await ctx.client.linkGalleryExternalReference(id, {
        expectedVersion: current.version,
        provider: "github",
        coordinate,
      });
      if (ctx.json) await writeJson({ galleryId: id, reference });
      else await writeStdout((reference.canonicalUrl ?? reference.coordinate) + "\n");
      return 0;
    }
    case "unlink": {
      const id = parsed.positionals[1];
      if (!id) throw new UsageError("gallery unlink requires a gallery ID");
      const coordinate = githubCoordinateFromFlags(parsed.flags);
      const references = await ctx.client.listGalleryExternalReferences(id);
      const reference = references.references.find(
        (entry) => entry.provider === "github" && entry.coordinate === coordinate,
      );
      if (!reference) {
        const output = { galleryId: id, coordinate, deleted: false };
        if (ctx.json) await writeJson(output);
        else if (!ctx.quiet) process.stderr.write("GitHub reference was already absent\n");
        return 0;
      }
      const current = await ctx.client.getGallery(id);
      const result = await ctx.client.unlinkGalleryExternalReference(id, reference.id, {
        expectedVersion: current.version,
      });
      if (ctx.json) await writeJson({ galleryId: id, coordinate, ...result });
      else if (!ctx.quiet) process.stderr.write("unlinked " + coordinate + "\n");
      return 0;
    }
    case "delete": {
      const id = parsed.positionals[1];
      if (!id) throw new UsageError("gallery delete requires a gallery ID");
      const current = await ctx.client.getGallery(id);
      const result = await ctx.client.deleteGallery(id, { expectedVersion: current.version });
      if (ctx.json) await writeJson(result);
      else if (!ctx.quiet) process.stderr.write(`deleted gallery ${result.id} (objects kept)\n`);
      return 0;
    }
    case "add": {
      const id = parsed.positionals[1];
      const keys = parsed.positionals.slice(2);
      if (!id || keys.length === 0)
        throw new UsageError("gallery add requires a gallery ID and one or more object keys");
      const caption = flagString(parsed.flags, "--caption");
      const altText = flagString(parsed.flags, "--alt");
      const added: GalleryItem[] = [];
      let galleryUrl: string | undefined;
      const failures: Array<{
        objectKey: string;
        error: { message: string; code?: string; status?: number };
      }> = [];
      for (const objectKey of keys) {
        try {
          // Always re-read before the next write: each add increments the version,
          // and this also avoids stale versions after an independent writer.
          const current = await ctx.client.getGallery(id);
          galleryUrl = current.url;
          added.push(
            await ctx.client.addGalleryItem(id, objectKey, {
              expectedVersion: current.version,
              caption,
              altText,
            }),
          );
        } catch (err) {
          failures.push({ objectKey, error: errorDetail(err) });
        }
      }
      const output = { galleryId: id, galleryUrl: galleryUrl ?? null, added, failures };
      if (ctx.json) await writeJson(output);
      else {
        if (galleryUrl) await writeStdout(`GALLERY: ${galleryUrl}\n`);
        for (const item of added) await writeStdout(`${item.objectKey}\n`);
        for (const failure of failures)
          process.stderr.write(
            `warning: could not add ${failure.objectKey}: ${failure.error.message}\n`,
          );
      }
      return failures.length === 0 ? 0 : 1;
    }
    default:
      throw new UsageError(
        `unknown gallery command: ${action} (expected create, show, list, delete, add, link, or unlink)`,
        { example: 'uploads gallery create --title "Release screenshots"' },
      );
  }
}

// --- list ---

const LIST_HELP = `uploads list [--prefix <p>] [--pr <num> | --issue <num>] [--repo <owner/name>] [--limit <n>] [--cursor <c>] [--all] [--meta <k=v>]... [--name <term>] [--workspace <name>]

Default prefix: UPLOADS_DEFAULT_PREFIX (screenshots if unset).

--meta <k=v> (repeatable, ANDed) and/or --name <term> switch to the search
endpoint — returned items include their matched metadata. Combines with
--prefix, not with --pr/--issue. --name is a case-insensitive
substring match on object keys. Search pages are continued with --cursor
(opaque, from the previous page); --all follows it for up to 20 pages and
prints the next cursor if more remain. See also: uploads find.

Examples:
  uploads list --prefix screenshots/
  uploads list --pr 123
  uploads list --all --json
  uploads list --meta gh.repo=buildinternet/uploads --meta gh.number=123
  uploads list --name hero --meta app=web
`;

/** Human-mode stderr note when a paged API response was capped server-side. */
function writeTruncatedNotice(
  truncated: boolean | undefined,
  quiet: boolean,
  detail: string,
): void {
  if (truncated && !quiet) {
    process.stderr.write(`truncated: true (${detail})\n`);
  }
}

/** `--meta` / `--name` search path, shared by `runList` and `runFind`. */
async function runFindFiles(
  ctx: CliContext,
  filters: Record<string, string>,
  flags: CommandFlags["flags"],
  name?: string,
): Promise<number> {
  const prefix = flagString(flags, "--prefix");
  const limit = flagInt(flags, "--limit", "--limit");
  const cursor = flagString(flags, "--cursor");
  const nameTerm = name ?? flagString(flags, "--name");
  if (Object.keys(filters).length === 0 && !nameTerm) {
    throw new UsageError("find requires at least one k=v pair, --meta k=v, or --name <term>", {
      example: "uploads find path=/settings state=after",
    });
  }
  // `--all` follows the search cursor, but only up to FIND_FILES_MAX_PAGES —
  // never an unbounded drain. `--cursor` resumes a specific page by hand.
  const searchOpts = { prefix, limit, name: nameTerm, cursor };
  const result = flagBool(flags, "--all")
    ? await ctx.client.findFilesAll(filters, searchOpts)
    : await ctx.client.findFiles(filters, searchOpts);
  if (ctx.json) await writeJson(result);
  else {
    for (const item of result.items) {
      // LIST_HELP promises matched metadata in the output; render it inline
      // (sorted for stable output) so human mode honors that, not just --json.
      const meta = Object.entries(item.metadata)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      await writeStdout(
        `${item.key}${item.url ? `  ${item.url}` : ""}${meta ? `  ${meta}` : ""}\n`,
      );
    }
    writeTruncatedNotice(result.truncated, ctx.quiet, "more matches may exist beyond this page");
    // Human mode surfaces the continuation the same way `uploads list` does.
    if (result.cursor) process.stderr.write(`cursor: ${result.cursor}\n`);
  }
  return 0;
}

export async function runList(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(LIST_HELP);
    return 0;
  }
  const metaPairs = flagValues(parsed.flags, "--meta");
  const nameFlag = flagString(parsed.flags, "--name");
  if (metaPairs.length > 0 || nameFlag !== undefined) {
    if (ghTargetFromFlags(parsed.flags, run)) {
      throw new UsageError("--meta/--name cannot be combined with --pr/--issue");
    }
    return runFindFiles(
      ctx,
      metaPairs.length > 0 ? parseMetaFlags(metaPairs) : {},
      parsed.flags,
      nameFlag,
    );
  }
  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
  const prefixFlag = flagString(parsed.flags, "--prefix");
  let prefix = prefixFlag ?? (defaults.prefix ? `${defaults.prefix}/` : undefined);
  const ghTarget = ghTargetFromFlags(parsed.flags, run);
  // Also list every active private prefix, if any (issue #631) — mirrors
  // syncAttachmentsComment's gh-fallback gather: a repo's attachment
  // history can be split across the plain shape and MULTIPLE private
  // prefixes, not just the currently-resolved one. `prefixes` stays
  // undefined outside --pr/--issue (unchanged behavior); when defined it
  // collapses to just `[prefix]` in plain mode, so the single-request path
  // below is byte-identical to pre-#631 output there.
  let prefixes: string[] | undefined;
  if (ghTarget) {
    if (prefixFlag) throw new UsageError("--prefix cannot be combined with --pr/--issue");
    prefix = ghKeyPrefix(ghTarget);
    const ghPrefix = await resolveGhPrefixSafe(ctx.client, {
      repo: ghTarget.repo,
      target: { kind: ghTarget.kind, num: ghTarget.num },
    });
    prefixes = ghListPrefixes(prefix, ghPrefix, (id) => ghPrivateKeyPrefix(id, ghTarget));
  }
  const limit = flagInt(parsed.flags, "--limit", "--limit");
  const cursor = flagString(parsed.flags, "--cursor");

  if (flagBool(parsed.flags, "--all")) {
    // --all may start from a caller-provided --cursor and drains from there.
    const items =
      prefixes && prefixes.length > 1
        ? await ghMergedList(prefixes, cursor, (p, c) =>
            ctx.client.listAll({ prefix: p, limit, cursor: c }),
          )
        : await ctx.client.listAll({ prefix, limit, cursor });
    if (ctx.json) await writeJson({ items, cursor: null });
    else
      for (const item of items)
        await writeStdout(`${item.key}${item.url ? `  ${item.url}` : ""}\n`);
    return 0;
  }

  // Merged multi-prefix pages don't have a meaningful combined cursor —
  // dropped (null) only when there's more than one prefix to merge; the
  // single-prefix path (every non-private call, plus every call before
  // #631) is untouched. Same first-prefix-only cursor guard as --all above.
  const result =
    prefixes && prefixes.length > 1
      ? {
          items: await ghMergedList(
            prefixes,
            cursor,
            async (p, c) => (await ctx.client.list({ prefix: p, limit, cursor: c })).items,
          ),
          cursor: null,
        }
      : await ctx.client.list({ prefix, limit, cursor });
  if (ctx.json) await writeJson(result);
  else {
    for (const item of result.items)
      await writeStdout(`${item.key}${item.url ? `  ${item.url}` : ""}\n`);
    if (result.cursor) process.stderr.write(`cursor: ${result.cursor}\n`);
  }
  return 0;
}

// --- find ---

const FIND_HELP = `uploads find [k=v...] [--meta k=v]... [--name <term>] [--prefix <p>] [--limit <n>] [--cursor <c>] [--all] [--workspace <name>]

Find objects by queryable metadata (ANDed equality) and/or a case-insensitive
filename substring. Same output as \`uploads list --meta\` / \`--name\`.

Results are paged. When more matches exist the next page's opaque cursor is
printed to stderr (and carried in --json as \`cursor\`); pass it back with
--cursor. --all follows the cursor for you, up to 20 pages, then prints the
cursor to resume from.

Pairs are positional k=v, or spelled --meta k=v. A bare positional without
\`=\` is treated as --name (e.g. \`uploads find hero\`). At least one of a
meta pair or a name term is required.

Examples:
  uploads find gh.repo=buildinternet/uploads gh.number=123
  uploads find path=/settings state=after --prefix screenshots/
  uploads find --meta path=/settings
  uploads find hero
  uploads find --name hero --meta app=web
  uploads find app=web --all --json
`;

export async function runFind(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(FIND_HELP);
    return 0;
  }
  // Same flag/positional symmetry as `meta set` (issue #545): `find` is the
  // alias for `list --meta`, so `find --meta k=v` must not dead-end.
  // Bare positionals without `=` are the filename term (issue #528) so
  // `uploads find hero` works without a flag. Empty input is rejected inside
  // `runFindFiles` (shared with `list --name` / `--meta`).
  const nameFlag = flagString(parsed.flags, "--name");
  const kvPositionals: string[] = [];
  const bareNames: string[] = [];
  for (const pos of parsed.positionals) {
    if (pos.includes("=")) kvPositionals.push(pos);
    else bareNames.push(pos);
  }
  if (bareNames.length > 1) {
    throw new UsageError("find accepts at most one bare name term (or use --name)", {
      example: "uploads find hero --meta app=web",
    });
  }
  if (bareNames.length === 1 && nameFlag !== undefined) {
    throw new UsageError("pass the name term either as a bare positional or --name, not both", {
      example: "uploads find hero",
    });
  }
  const pairs = [...kvPositionals, ...flagValues(parsed.flags, "--meta")];
  return runFindFiles(
    ctx,
    pairs.length > 0 ? parseMetaFlags(pairs) : {},
    parsed.flags,
    nameFlag ?? bareNames[0],
  );
}

// --- meta ---

const META_HELP = `uploads meta <command> [args]

Read/write an object's queryable custom metadata (D1-backed key-value pairs;
distinct from the R2 provenance headers put on upload). Discover which keys
and values exist in the workspace before filtering with find/list.

Commands:
  get <key>                            Show metadata for an object
  set <key> k=v [k=v...] [--delete k]...   Merge-set and/or delete pairs
  keys                                 List distinct metadata keys (with counts)
  values <meta-key>                    List distinct values for one key

Pairs take either form: positional k=v, or --meta k=v (same spelling as
put/screenshot/list). Both can appear in one call.

Examples:
  uploads meta get screenshots/myapp/42/shot.png
  uploads meta set screenshots/myapp/42/shot.png path=/settings state=after
  uploads meta set screenshots/myapp/42/shot.png --meta path=/settings
  uploads meta set screenshots/myapp/42/shot.png --delete path --delete state
  uploads meta keys
  uploads meta values app
`;

export async function runMeta(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  const action = parsed.positionals[0];
  if (help || parsed.help) {
    writeCommandHelp(META_HELP);
    return 0;
  }
  if (!action) {
    throw new UsageError("meta requires a subcommand: get, set, keys, or values", {
      example: "uploads meta set screenshots/myapp/42/shot.png --meta path=/settings",
    });
  }

  switch (action) {
    case "get": {
      const key = parsed.positionals[1];
      if (!key) {
        throw new UsageError("meta get requires an object key", {
          example: "uploads meta get screenshots/myapp/42/shot.png",
        });
      }
      const result = await ctx.client.getMetadata(key);
      if (ctx.json) await writeJson(result);
      else if (Object.keys(result.metadata).length === 0) {
        // Empty stdout reads as failure; a stderr note keeps stdout parseable.
        if (!ctx.quiet) process.stderr.write("(no metadata)\n");
      } else for (const [k, v] of Object.entries(result.metadata)) await writeStdout(`${k}=${v}\n`);
      return 0;
    }
    case "set": {
      const key = parsed.positionals[1];
      if (!key) {
        throw new UsageError("meta set requires an object key", {
          example: "uploads meta set screenshots/myapp/42/shot.png --meta path=/settings",
        });
      }
      // `--meta k=v` is accepted alongside the positional form: `put`, `list`,
      // and `screenshot` all spell metadata that way, and `put`'s own success
      // tip teaches the flag, so carrying it here is the natural guess
      // (issue #545). Positionals come first so argument order still reads
      // left to right when both are used.
      const pairs = [...parsed.positionals.slice(2), ...flagValues(parsed.flags, "--meta")];
      const del = flagValues(parsed.flags, "--delete");
      if (pairs.length === 0 && del.length === 0) {
        throw new UsageError("meta set requires k=v pairs and/or --delete <key>", {
          example: `uploads meta set ${key} --meta path=/settings`,
        });
      }
      const set = pairs.length > 0 ? parseMetaFlags(pairs) : undefined;
      const result = await ctx.client.patchMetadata(key, {
        set,
        delete: del.length > 0 ? del : undefined,
      });
      if (ctx.json) await writeJson(result);
      else for (const [k, v] of Object.entries(result.metadata)) await writeStdout(`${k}=${v}\n`);
      await resyncCommentAfterMetaSet(ctx, key, [...Object.keys(set ?? {}), ...del]);
      return 0;
    }
    case "keys": {
      // Workspace vocabulary discovery (issue #528) — which meta keys exist
      // and how common they are, before agents guess at find filters.
      const result = await ctx.client.listMetadataKeys();
      if (ctx.json) await writeJson(result);
      else {
        for (const row of result.keys) {
          await writeStdout(`${row.key}  count=${row.count}  distinct=${row.distinctValues}\n`);
        }
        writeTruncatedNotice(result.truncated, ctx.quiet, "more keys may exist beyond this page");
      }
      return 0;
    }
    case "values": {
      const key = parsed.positionals[1];
      if (!key) {
        throw new UsageError("meta values requires a metadata key", {
          example: "uploads meta values app",
        });
      }
      const result = await ctx.client.listMetadataValues(key);
      if (ctx.json) await writeJson(result);
      else {
        for (const row of result.values) {
          await writeStdout(`${row.value}  count=${row.count}\n`);
        }
        writeTruncatedNotice(result.truncated, ctx.quiet, "more values may exist beyond this page");
      }
      return 0;
    }
    default:
      throw new UsageError(`unknown meta command: ${action} (expected get, set, keys, or values)`, {
        example: "uploads meta get screenshots/myapp/42/shot.png",
      });
  }
}

/** The metadata keys the managed comment renders (path/state, PR #370). */
const COMMENT_RENDERED_META_KEYS = ["path", "state"];

/**
 * Best-effort managed-comment refresh after `meta set` touches a
 * display-relevant key on a PR/issue-keyed object (issue #470) — without
 * this, backfilled `path=`/`state=` never reaches the rendered comment until
 * an unrelated attach fires. Bot endpoint only (no gh fallback — this is a
 * metadata tweak, not an explicit comment command); any failure degrades to
 * a stderr hint instead of failing the metadata write that already landed.
 */
/**
 * Resolve the `{repo, kind, num}` target for a key, whether plain
 * (`parseGhKey`) or private-prefixed (issue #631, `parseGhPrivateKey` —
 * cannot recover the repo from the key alone, since the randomized prefix
 * deliberately omits it). For a private key, reads `gh.repo` metadata — the
 * attach/put that created this key already wrote it — via the same metadata
 * client call `meta get` uses. Fail-open: any read failure, or a key that
 * isn't gh-managed at all, resolves to undefined (nothing to resync).
 */
async function resolveGhTargetForResync(
  client: UploadsClient,
  key: string,
): Promise<GhTarget | undefined> {
  const plain = parseGhKey(key);
  if (plain) return plain;
  const priv = parseGhPrivateKey(key);
  if (!priv) return undefined;
  try {
    const { metadata } = await client.getMetadata(key);
    const repo = metadata["gh.repo"];
    if (!repo) return undefined;
    return { repo, kind: priv.kind, num: priv.num };
  } catch {
    return undefined;
  }
}

async function resyncCommentAfterMetaSet(
  ctx: CliContext,
  key: string,
  touchedKeys: string[],
): Promise<void> {
  if (!touchedKeys.some((k) => COMMENT_RENDERED_META_KEYS.includes(k))) return;
  const target = await resolveGhTargetForResync(ctx.client, key);
  if (!target) return;
  try {
    const bot = await ctx.client.upsertGithubComment({
      repo: target.repo,
      num: target.num,
      kind: target.kind,
      resync: true,
    });
    if (bot.posted) {
      if (!ctx.quiet && !ctx.json) {
        process.stderr.write(`refreshed the managed comment on ${target.repo}#${target.num}\n`);
      }
      return;
    }
  } catch {
    // Fall through to the hint.
  }
  if (!ctx.quiet && !ctx.json) {
    const flag = target.kind === "pull" ? "--pr" : "--issue";
    process.stderr.write(
      `tip: run \`uploads comment ${flag} ${target.num}\` to refresh the PR comment\n`,
    );
  }
}

// --- delete ---

const DELETE_HELP = `uploads delete <key> [--dry-run] [--workspace <name>]

Options:
  --dry-run             Preview without deleting
  --workspace, -w <name>

Examples:
  uploads delete screenshots/myapp/42/shot-a1b2c3.png
  uploads delete screenshots/myapp/42/shot-a1b2c3.png --dry-run
`;

export async function runDelete(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(DELETE_HELP);
    return 0;
  }
  const key = parsed.positionals[0];
  if (!key) {
    throw new UsageError("delete requires an object key", {
      example: "uploads delete screenshots/myapp/42/shot.png --dry-run",
    });
  }
  if (flagBool(parsed.flags, "--dry-run")) {
    if (ctx.json) await writeJson({ key, deleted: false, dryRun: true });
    else process.stderr.write(`dry-run: would delete ${key}\n`);
    return 0;
  }
  const result = await ctx.client.delete(key);
  if (ctx.json) await writeJson(result);
  else if (!ctx.quiet) process.stderr.write(`deleted ${result.key}\n`);
  return 0;
}

// --- comment ---

const COMMENT_HELP = `uploads comment (--pr <num> | --issue <num>) [--repo <owner/name>] [--workspace <name>]

Create or update the managed attachments comment on a GitHub PR or issue,
listing everything uploaded for it. Posts as uploads-sh[bot] when the GitHub
App is installed on the repo; otherwise via your local gh auth. Finds its own
prior comment via a hidden marker and edits it in place; never touches other
comments or the description.

If this repo is bound to a different workspace, the bot post is declined and
this command fails rather than silently falling back to gh — see
\`uploads github link --status\`.

Examples:
  uploads --env-file .env comment --pr 123
  uploads comment --issue 45 --repo buildinternet/uploads
`;

export async function runComment(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(COMMENT_HELP);
    return 0;
  }
  const target = ghTargetFromFlags(parsed.flags, run);
  if (!target) {
    throw new UsageError("comment requires --pr or --issue", {
      example: "uploads comment --pr 123",
    });
  }

  const result = await syncAttachmentsComment(ctx.client, target, run, ctx.config.workspace, {
    resync: true,
  });
  if (ctx.json) {
    await writeJson({ ...target, ...result });
  } else if (!ctx.quiet) {
    const via = commentViaSuffix(result.via);
    let line: string;
    if (result.action === "skipped") {
      line = `no attachments under ${ghKeyPrefix(target)} — nothing to do\n`;
    } else if (result.count === 0) {
      // An existing comment rewritten to the empty state (every file removed).
      line = `cleared attachments comment on ${target.repo}#${target.num} — no files remaining${via}\n`;
    } else {
      line = `${result.action} attachments comment on ${target.repo}#${target.num} (${result.count} file${result.count === 1 ? "" : "s"})${via}\n`;
    }
    process.stderr.write(line);
  }
  return 0;
}

// --- ingest ---

const INGEST_HELP = `uploads ingest — mirror GitHub-native attachments from a PR/issue into the workspace

Usage:
  uploads ingest --pr <n> [--repo owner/name]
  uploads ingest --issue <n> [--repo owner/name]

Scans the PR/issue description and comments for github.com/user-attachments
media, mirrors new ones into the workspace (indexed, not added to the managed
comment), and detaches ones no longer referenced. Works on any repo linked to
the workspace; the .uploads.yml ingestGithubAttachments knob only gates the
automatic webhook path. Bot-authored attachments and images under 200px on
either side are always skipped (the .uploads.yml ingestBotAttachments knob
re-admits bot media on the webhook path only).

Examples:
  uploads ingest --pr 123
  uploads ingest --issue 45 --repo acme/app --format json
`;

export async function runIngest(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(INGEST_HELP);
    return 0;
  }
  const target = ghTargetFromFlags(parsed.flags, run);
  if (!target) {
    throw new UsageError("--pr or --issue required");
  }

  const result = await ctx.client.ingestGithub(target);
  const jsonMode = ctx.json || flagString(parsed.flags, "--format") === "json";
  if (jsonMode) {
    await writeJson(result);
    return 0;
  }
  if (!ctx.quiet) {
    let line = `Ingested ${result.ingested.length}, re-attached ${result.reattached.length}, detached ${result.detached.length}, skipped ${result.skipped.length}\n`;
    for (const skip of result.skipped) {
      line += `  skipped: ${skip.url} (${skip.reason})\n`;
    }
    process.stderr.write(line);
  }
  return 0;
}

// --- github link ---

const GITHUB_HELP = `uploads github link [--repo <owner/name>] [--status] [--workspace <name>]
uploads github unlink [--repo <owner/name>] [--workspace <name>]
uploads github doctor [--workspace <name>]
uploads github rotate-prefix [--repo <owner/name>] [--branch <name> | --repo-level] [--workspace <name>]

Claim, inspect, or release this workspace's binding to a GitHub repo (see the
managed attachments comment / webhook auto-promotion, which use this
binding). First-claim-wins: claiming an already-bound repo never steals it
from whichever workspace claimed it first — the command reports who owns it,
and how to get it released, instead.

--repo defaults the same way as --pr/--issue elsewhere (gh repo view, then
the git remote). --status only inspects the current binding (files:read);
without it, "link" claims the repo (files:write). "unlink" releases a
binding this workspace owns — it 403s (via the server) if another workspace
owns it; an operator can reassign or remove that binding instead.

\`doctor\` checks the GitHub App itself: whether it's configured on the
server, and whether it's subscribed to the webhook events uploads.sh's
handler needs (required: issues, pull_request; recommended: issue_comment —
see docs/github-app). A missing
subscription is the classic silent failure: the App's ping stays green
while webhook auto-promotion and title-cache invalidation quietly do
nothing.

\`rotate-prefix\` mints a fresh randomized URL prefix for a private repo's
attachments and moves everything under the old one to it, so the old URLs
404 at origin immediately (see docs/private-attachments.md). --branch
defaults to the current git branch; --repo-level rotates the id shared by
issue attachments and ingested assets instead of a branch's id. Rotation
is an explicit action — an unauthorized caller gets an error, not a silent
no-op.

Examples:
  uploads github link
  uploads github link --repo buildinternet/uploads
  uploads github link --status
  uploads github unlink --repo buildinternet/uploads
  uploads github doctor
  uploads github rotate-prefix --branch feature-x
  uploads github rotate-prefix --repo-level
`;

/** Older servers' health payload predates recommendedEvents/missingRecommendedEvents — treat as no recommendations rather than crashing. */
function missingRecommendedEventsOf(result: GithubHealthResult): string[] {
  return Array.isArray(result.missingRecommendedEvents) ? result.missingRecommendedEvents : [];
}

function recommendedNoteLine(result: GithubHealthResult): string {
  const missing = missingRecommendedEventsOf(result);
  if (missing.length === 0) return "";
  return `note: not subscribed to ${missing.join(", ")} (recommended) — enables bot-comment self-healing and comment-attachment ingestion; subscribe under the App's Permissions & events\n`;
}

function formatGithubDoctor(result: GithubHealthResult): string {
  if (!result.configured) {
    return `github app: not configured on this server${result.hint ? ` — ${result.hint}` : ""}\n`;
  }
  if (result.events === null) {
    return `github app: configured, but health check failed${result.hint ? ` — ${result.hint}` : ""}\n`;
  }
  if (result.ok) {
    // The ACTUAL subscribed list, not just the required subset — printing
    // requiredEvents here once misdiagnosed a live App as "not subscribed to
    // issue_comment" when it was (2026-08-11). `events` is non-null on every
    // ok result (the null case returns above); the requiredEvents fallback
    // only guards a malformed payload from an older server.
    const subscribed = Array.isArray(result.events)
      ? [...result.events].sort()
      : [...result.requiredEvents];
    const allPresent = missingRecommendedEventsOf(result).length === 0;
    return (
      `github app: ok — subscribed to ${subscribed.join(", ")}` +
      (allPresent ? " (all required + recommended events)" : "") +
      "\n" +
      recommendedNoteLine(result)
    );
  }
  return (
    `github app: missing webhook event subscription(s): ${result.missingEvents.join(", ")}\n` +
    (result.hint ? `  ${result.hint}\n` : "") +
    recommendedNoteLine(result)
  );
}

function formatGithubLink(
  repo: string,
  result: { workspace: string | null; source: string | null },
): string {
  return result.workspace
    ? `${repo} is bound to workspace "${result.workspace}"${result.source ? ` (${result.source})` : ""}\n`
    : `${repo} is not bound to any workspace\n`;
}

async function runGithubDoctor(ctx: CliContext): Promise<number> {
  let result: GithubHealthResult;
  try {
    result = await ctx.client.githubHealth();
  } catch (err) {
    if (err instanceof UploadsError && err.status === 404) {
      throw new UsageError(
        "server does not support the GitHub App health check yet (404) — upgrade the uploads.sh API/self-hosted worker",
      );
    }
    throw err;
  }
  if (ctx.json) {
    await writeJson(result);
  } else {
    await writeStdout(formatGithubDoctor(result));
  }
  return result.ok ? 0 : 1;
}

async function runGithubLink(ctx: CliContext, repo: string, statusOnly: boolean): Promise<number> {
  let result: {
    repo: string;
    linked: boolean;
    workspace: string | null;
    source: string | null;
    claimed?: boolean;
    reason?: "not_authorized";
  };
  try {
    result = statusOnly
      ? await ctx.client.githubLinkStatus(repo)
      : await ctx.client.githubLinkClaim(repo);
  } catch (err) {
    if (err instanceof UploadsError && err.status === 404) {
      throw new UsageError(
        "server does not support repo bindings yet (404) — upgrade the uploads.sh API/self-hosted worker",
      );
    }
    throw err;
  }

  if (ctx.json) {
    await writeJson(result);
    return 0;
  }
  if (!statusOnly && result.claimed === false) {
    // Cross-tenant authorization (issue #297): `reason: "not_authorized"`
    // means the repo is unbound but this workspace couldn't be verified as
    // entitled to claim it (no linked GitHub account, or that account lacks
    // push access) — distinct from the older "someone else already owns it"
    // case, which still reports `result.workspace`.
    if (result.reason === "not_authorized") {
      process.stderr.write(
        `note: ${repo} isn't linked to any workspace yet, and this workspace couldn't be ` +
          `verified as entitled to claim it. Link a GitHub account with push access to ` +
          `${repo}, or ask an operator to bind it explicitly.\n`,
      );
    } else {
      process.stderr.write(
        `note: ${repo} is already bound to a different workspace ("${result.workspace}") — first-claim-wins, not overwritten. Run "uploads github unlink --repo ${repo}" from that workspace, or ask an operator to reassign it.\n`,
      );
    }
  }
  await writeStdout(formatGithubLink(repo, result));
  return 0;
}

async function runGithubUnlink(ctx: CliContext, repo: string): Promise<number> {
  let result: { repo: string; unlinked: boolean; reason?: "not_linked" };
  try {
    result = await ctx.client.githubLinkUnlink(repo);
  } catch (err) {
    if (err instanceof UploadsError && err.status === 404) {
      throw new UsageError(
        "server does not support repo bindings yet (404) — upgrade the uploads.sh API/self-hosted worker",
      );
    }
    if (err instanceof UploadsError && err.status === 403) {
      throw new UsageError(
        `${repo} is bound to a different workspace — ask an operator to reassign or remove it (${err.message})`,
      );
    }
    throw err;
  }

  if (ctx.json) {
    await writeJson(result);
    return 0;
  }
  await writeStdout(
    result.unlinked
      ? `unlinked ${repo}\n`
      : `${repo} was not bound to any workspace — nothing to unlink\n`,
  );
  return 0;
}

function formatGithubRotatePrefix(
  repo: string,
  branchLabel: string,
  result: RotateGhPrefixResult,
): string {
  if (!result.rotated) {
    return `nothing to rotate for ${repo} (${branchLabel}): ${result.reason}\n`;
  }
  return `rotated ${repo} (${branchLabel}): moved ${result.moved} object${result.moved === 1 ? "" : "s"} to a new prefix (${result.prefixId})\n`;
}

async function runGithubRotatePrefix(
  ctx: CliContext,
  repo: string,
  branch: string | undefined,
  repoLevel: boolean,
): Promise<number> {
  let result: RotateGhPrefixResult;
  try {
    result = await ctx.client.rotateGhPrefix(
      repoLevel ? { repo, repoLevel: true } : { repo, branch },
    );
  } catch (err) {
    if (err instanceof UploadsError && err.status === 404) {
      throw new UsageError(
        "server does not support private-prefix rotation yet (404) — upgrade the uploads.sh API/self-hosted worker",
      );
    }
    if (err instanceof UploadsError && err.status === 403) {
      throw new UsageError(`not authorized to rotate ${repo}'s attachment prefix (${err.message})`);
    }
    throw err;
  }

  if (ctx.json) {
    await writeJson(result);
    return result.rotated ? 0 : 1;
  }
  const branchLabel = repoLevel ? "repo-level" : (branch ?? "");
  await writeStdout(formatGithubRotatePrefix(repo, branchLabel, result));
  return result.rotated ? 0 : 1;
}

export async function runGithub(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  const action = parsed.positionals[0];
  if (help || parsed.help || !action) {
    writeCommandHelp(GITHUB_HELP);
    return help || parsed.help ? 0 : 2;
  }
  if (
    action !== "link" &&
    action !== "unlink" &&
    action !== "doctor" &&
    action !== "rotate-prefix"
  ) {
    throw new UsageError(
      `unknown github subcommand: ${action} (expected link, unlink, doctor, or rotate-prefix)`,
      { example: "uploads github link" },
    );
  }

  if (action === "doctor") return runGithubDoctor(ctx);

  const repo = resolveRepo(flagString(parsed.flags, "--repo"), run);

  if (action === "rotate-prefix") {
    const repoLevel = flagBool(parsed.flags, "--repo-level");
    const branchFlag = flagString(parsed.flags, "--branch");
    if (repoLevel && branchFlag !== undefined) {
      throw new UsageError("pass either --branch or --repo-level, not both");
    }
    const branch = repoLevel ? undefined : (branchFlag ?? resolveCurrentBranch(run));
    return runGithubRotatePrefix(ctx, repo, branch, repoLevel);
  }

  if (action === "unlink") return runGithubUnlink(ctx, repo);

  const statusOnly = flagBool(parsed.flags, "--status");
  return runGithubLink(ctx, repo, statusOnly);
}

// --- usage / reconcile / purge ---

const USAGE_HELP = `uploads usage [--workspace <name>]

Show workspace storage and monthly upload counters.

When the API reports workspace quotas (typical on uploads.sh cloud /
self-serve Free and Pro), human output includes the plan name and progress
bars toward those caps. Free is not unlimited — storage and monthly upload
limits show on the meters. Self-hosted or unlimited operator workspaces get
usage totals only, plus a short unmetered note — no invented limits.

Examples:
  uploads --env-file .env usage
  uploads usage --json
`;

function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : String(n);
}

export async function runUsage(ctx: CliContext, args: string[], help = false): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    writeCommandHelp(USAGE_HELP);
    return 0;
  }
  const result = await ctx.client.usage();
  if (ctx.json) {
    await writeJson(result);
    return 0;
  }
  await writeStdout(
    formatUsageHuman(result, { color: colorEnabled(process.stdout) }).join("\n") + "\n",
  );
  return 0;
}

const RECONCILE_HELP = `uploads reconcile [--workspace <name>]

Rebuild ledger bytes/objects from storage (source of truth). Preserves the
monthly upload counter. Requires files:write.

Examples:
  uploads --env-file .env reconcile
`;

export async function runReconcile(ctx: CliContext, args: string[], help = false): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    writeCommandHelp(RECONCILE_HELP);
    return 0;
  }
  const result = await ctx.client.reconcile();
  if (ctx.json) {
    await writeJson(result);
    return 0;
  }
  await writeStdout(
    result.changed
      ? `reconciled ${result.workspace}: ${result.previous.bytes}→${result.bytes} bytes, ${result.previous.objects}→${result.objects} objects\n`
      : `reconciled ${result.workspace}: unchanged (${result.bytes} bytes, ${result.objects} objects)\n`,
  );
  return 0;
}

const PURGE_HELP = `uploads purge-expired [--workspace <name>]

Delete objects older than the workspace retentionDays setting, then reconcile.
Skips if retention is unset. Requires files:delete.

Examples:
  uploads --env-file .env purge-expired
`;

export async function runPurgeExpired(
  ctx: CliContext,
  args: string[],
  help = false,
): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    writeCommandHelp(PURGE_HELP);
    return 0;
  }
  const result = await ctx.client.purgeExpired();
  if (ctx.json) {
    await writeJson(result);
    return 0;
  }
  if ("skipped" in result) {
    await writeStdout(`skipped: ${result.reason}\n`);
    return 0;
  }
  await writeStdout(
    `purged ${result.deleted} object(s), freed ${result.freedBytes} bytes (retention ${result.retentionDays}d)\n`,
  );
  return 0;
}

// --- health & doctor ---

const HEALTH_HELP = `uploads health

API liveness (no auth).

Examples:
  uploads health
  uploads --api-url http://localhost:8787 health
`;

export async function runHealth(
  ctx: Pick<CliContext, "json"> & { apiUrl: string },
  args: string[],
  help = false,
): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    writeCommandHelp(HEALTH_HELP);
    return 0;
  }
  const result = await createUploadsClient({
    apiUrl: ctx.apiUrl,
    workspace: "default",
    token: "",
  }).health();

  if (ctx.json) await writeJson({ ...result, apiUrl: ctx.apiUrl });
  else await writeStdout(result.ok ? `ok (${ctx.apiUrl})\n` : `unhealthy (${ctx.apiUrl})\n`);
  return result.ok ? 0 : 1;
}

const DOCTOR_HELP = `uploads doctor [--workspace <name>]

Checks API health, token auth, and workspace/token alignment.

Examples:
  uploads --env-file .env doctor
  uploads --workspace acme --env-file .env doctor
  uploads doctor --json
`;

export interface DoctorReport {
  ok: boolean;
  /** Installed @buildinternet/uploads package version. */
  cliVersion: string;
  apiUrl: string;
  workspace: string;
  workspaceSource: ResolvedConfig["workspaceSource"];
  workspaceFromToken: string | undefined;
  configPath: string;
  configExists: boolean;
  health: { ok: boolean };
  auth: { ok: boolean; error: string | undefined };
  /** Usage snapshot when auth works (optional fields when the endpoint fails). */
  usage?: {
    ok: boolean;
    bytes?: number;
    objects?: number;
    uploadsInPeriod?: number;
    error?: string;
  };
  /** File scopes of the presented token (absent against pre-scopes servers). */
  scopes?: string[];
  /** Workspace/token mismatch warning (also present in hints). */
  warning?: string;
  /**
   * Storage-lane summary (issue #775): the usage endpoint carries a
   * bearer-safe `storage` object (mode + fallback-lane count + health), so
   * doctor reports it from the same call it already makes. `checked` is
   * false when usage failed or the server predates the field — then `note`
   * falls back to the honest "can't check from here" line (the full
   * projection on `GET /me/workspaces/:name/storage` stays session-gated).
   */
  storage: {
    checked: boolean;
    mode?: "shared" | "byo";
    fallbackLanes?: number;
    healthy?: boolean;
    note: string;
  };
  hints: string[];
  /** `screenshot`'s local-browser detection (fs scans only — never launches a browser). */
  browser: {
    /** false when this runtime has no Node fs/process (e.g. the apps/mcp Worker). */
    supported: boolean;
    found: boolean;
    /** Which backend `uploads screenshot --via auto` would pick right now. */
    autoBackend: "local" | "remote";
    candidates: { source: string; kind: string; executablePath: string }[];
    /** The best candidate by rank (may differ from candidates[0], which is scan order). */
    winner?: { source: string; kind: string; executablePath: string };
    note?: string;
  };
}

/**
 * Best-effort local-browser detection for doctor. fs scans only, no browser
 * launch. Guarded for non-Node runtimes as a precaution for any future
 * non-Node consumer of this module — apps/mcp today only imports
 * `buildMarkdown`/`buildScreenshotKey` from the package root, not
 * `buildDoctorReport`, so this guard isn't exercised on that path currently.
 */
async function detectBrowserForDoctor(detectRoots?: DetectRoots): Promise<DoctorReport["browser"]> {
  if (typeof process === "undefined" || !process.versions?.node) {
    return {
      supported: false,
      found: false,
      autoBackend: "remote",
      candidates: [],
      note: "browser detection is not supported in this runtime",
    };
  }
  try {
    const { detectLocalBrowser } = await import("./screenshot-local.js");
    const { candidates, winner } = detectLocalBrowser(detectRoots);
    return {
      supported: true,
      found: Boolean(winner),
      autoBackend: winner ? "local" : "remote",
      candidates: candidates.map((c) => ({
        source: c.source,
        kind: c.kind,
        executablePath: c.executablePath,
      })),
      winner: winner
        ? { source: winner.source, kind: winner.kind, executablePath: winner.executablePath }
        : undefined,
    };
  } catch (err) {
    return {
      supported: true,
      found: false,
      autoBackend: "remote",
      candidates: [],
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Doctor's health + auth + workspace checks, shared by the CLI and the MCP tool. */
export async function buildDoctorReport(
  config: ResolvedConfig,
  client: UploadsClient,
  detectRoots?: DetectRoots,
): Promise<DoctorReport> {
  const mismatch = workspaceMismatch(config);
  const hints: string[] = [];
  if (mismatch) hints.push(mismatch);
  if (config.apiUrl.includes("localhost") || config.apiUrl.includes("127.0.0.1")) {
    hints.push("local API uses dev KV — prod tokens won't work unless minted with --local");
  }
  // Independent checks — fs-based browser detection doesn't depend on the
  // network health probe (or vice versa).
  const [browser, health] = await Promise.all([
    detectBrowserForDoctor(detectRoots),
    client.health(),
  ]);

  let authOk = false;
  let authError: string | undefined;
  try {
    await client.list({ limit: 1 });
    authOk = true;
  } catch (err) {
    authError = err instanceof UploadsError ? err.message : String(err);
    if (err instanceof UploadsError && err.code === "UNAUTHORIZED") {
      hints.push(
        "if this token works on api.uploads.sh, set UPLOADS_API_URL=https://api.uploads.sh",
      );
    }
  }

  let usage:
    | {
        ok: boolean;
        bytes?: number;
        objects?: number;
        uploadsInPeriod?: number;
        error?: string;
      }
    | undefined;
  let storage: DoctorReport["storage"] = {
    checked: false,
    note: "not checked from the CLI — this server doesn't report a storage summary on the usage endpoint; sign in on the web (Account → workspace → Settings) to view mode and verification status",
  };
  let scopes: string[] | undefined;
  if (authOk) {
    try {
      const snap = await client.usage();
      usage = {
        ok: true,
        bytes: snap.bytes,
        objects: snap.objects,
        uploadsInPeriod: snap.uploadsInPeriod,
      };
      if (snap.storage) {
        const laneNote =
          snap.storage.fallbackLanes > 0
            ? ` (${snap.storage.fallbackLanes} previous lane${snap.storage.fallbackLanes === 1 ? "" : "s"} still serving old files)`
            : "";
        const healthNote = snap.storage.health.ok
          ? ""
          : " — not working; rotate credentials on the web settings page";
        storage = {
          checked: true,
          mode: snap.storage.mode,
          fallbackLanes: snap.storage.fallbackLanes,
          healthy: snap.storage.health.ok,
          note:
            (snap.storage.mode === "byo" ? "your bucket" : "hosted storage") +
            laneNote +
            healthNote,
        };
      }
      scopes = snap.scopes;
      if (scopes && !scopes.includes("files:delete")) {
        hints.push(
          "token lacks files:delete (`uploads delete` will be forbidden) — re-run `uploads login` for a full-scope token",
        );
      }
    } catch (err) {
      usage = {
        ok: false,
        error: err instanceof UploadsError ? err.message : String(err),
      };
    }
  }

  if (!config.configExists && !config.token) {
    hints.push(`run uploads setup to configure ${config.configPath}`);
  }

  return {
    ok: health.ok && authOk,
    cliVersion: packageVersion(),
    apiUrl: config.apiUrl,
    workspace: config.workspace,
    workspaceSource: config.workspaceSource,
    workspaceFromToken: workspaceFromToken(config.token),
    configPath: config.configPath,
    configExists: config.configExists,
    health,
    auth: { ok: authOk, error: authError },
    usage,
    scopes,
    warning: mismatch,
    storage,
    hints,
    browser,
  };
}

export async function runDoctor(ctx: CliContext, args: string[], help = false): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    writeCommandHelp(DOCTOR_HELP);
    return 0;
  }

  const report = await buildDoctorReport(ctx.config, ctx.client);

  if (ctx.json) {
    await writeJson(report);
    return report.ok ? 0 : 1;
  }

  const lines = [
    `cli:       @buildinternet/uploads@${report.cliVersion}`,
    `config:    ${report.configPath}${report.configExists ? "" : " (missing)"}`,
    `api:       ${report.apiUrl} (${report.health.ok ? "ok" : "failed"})`,
    `workspace: ${report.workspace}`,
    `auth:      ${report.auth.ok ? "ok" : `failed — ${report.auth.error ?? "no token"}`}`,
  ];
  if (report.scopes) lines.push(`scopes:    ${report.scopes.join(", ")}`);
  if (report.usage) {
    lines.push(
      report.usage.ok
        ? `usage:     ${formatByteSize(report.usage.bytes ?? 0)}, ${formatCount(report.usage.objects ?? 0)} objects, ${formatCount(report.usage.uploadsInPeriod ?? 0)} uploads this period`
        : `usage:     failed — ${report.usage.error ?? "unknown"}`,
    );
  }
  if (report.browser.supported) {
    lines.push(
      report.browser.found
        ? `browser:   found (${report.browser.winner?.source}/${report.browser.winner?.kind}) — screenshot --via auto uses local`
        : `browser:   none found — screenshot --via auto uses remote`,
    );
  } else {
    lines.push(`browser:   ${report.browser.note ?? "not supported in this runtime"}`);
  }
  lines.push(`storage:   ${report.storage.note}`);
  if (report.warning) lines.push(`warning:   ${report.warning}`);
  for (const h of report.hints) if (h !== report.warning) lines.push(`hint:      ${h}`);
  await writeStdout(lines.join("\n") + "\n");
  return report.ok ? 0 : 1;
}
