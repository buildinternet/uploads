import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { mapBounded } from "./async.js";
import {
  createUploadsClient,
  type GalleryItem,
  type GithubCommentResult,
  type GithubHealthResult,
  type PromoteBranchAttachmentsResult,
  type PutResult,
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
import { buildMarkdown } from "./embed.js";
import { urlForGithubEmbed } from "./public-urls.js";
import { UploadsError } from "./errors.js";
import { writeJson, writeStdout } from "./io.js";
import { imageFactsFromBytes } from "./image-facts.js";
import { parseMetaFlags, validateMetaMap } from "./metadata.js";
import { mergeDerivedMeta, nearMissMetaWarnings, validateStateValue } from "./metadata-vocab.js";
import { mergeSidecarMeta } from "./sidecar.js";
import {
  ghAttachmentKey,
  ghBranchAttachmentKey,
  ghBranchKeyPrefix,
  ghKeyPrefix,
  ghMetadataFromTarget,
  parseGhKey,
  ghMetadataForBranch,
  attachmentsCommentBody,
  attachmentsMarker,
  type GhTarget,
  type AttachmentItem,
  type GalleryCommentItem,
  normalizeGithubCoordinate,
} from "./github.js";
import {
  resolveRepo,
  resolveCurrentPullRequest,
  resolveCurrentBranch,
  resolveDefaultBranch,
  classifyGhNumber,
  execRunner,
  timedExecRunner,
  ghMetadataFromTargetWithTitle,
  upsertAttachmentsComment,
  type CommandRunner,
} from "./github-gh.js";
import { deriveRepoFromGit } from "./keys.js";
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

Upload one or more images for GitHub embeds. Use "-" for stdin (single file only).

Multiple files upload in parallel (bounded concurrency). One bad file does not
block the rest; multi-file JSON is { uploads, failures } (exit 1 when any failed).
Single-file JSON stays a flat object (back-compat).

Still images (PNG/JPEG/…) are optimized to WebP by default (long edge capped,
high quality; EXIF stripped) so GitHub embeds stay lean. Original bytes are kept
when they are already smaller, animated, or not an image. Use --no-optimize to
upload as-is, or --keep-exif when image metadata matters for the discussion.

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
  --workspace, -w <name>  Override workspace (wins over UPLOADS_WORKSPACE and token inference)
  --format human|url|markdown|json
  --pr <num>            Attach to a pull request: key gh/<owner>/<repo>/pull/<num>/<name> (stable URL, no hash)
  --issue <num>         Attach to an issue: key gh/<owner>/<repo>/issues/<num>/<name>
  --comment             With --pr/--issue: update one managed comment with
                        attachments and linked galleries. Posts as uploads-sh[bot]
                        when the GitHub App is installed; otherwise via local gh.
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
                        (or, on a strict key, be refused). Not with --comment/--gallery

A bare put (no --pr/--issue/--key) on a non-default git branch prints a one-line
nudge toward --pr/attach --branch (stderr in human mode, a "hint" field in
--format json). Suppress with --quiet, UPLOADS_NO_NUDGE=1, or config UPLOADS_NO_NUDGE=1.

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

function writeReplacedNote(
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
  const metadata = opts.deriveImageFacts
    ? await mergeImageFacts(bytes, opts.metadata)
    : opts.metadata;
  const prepared = await prepareImageForUpload(bytes, sourceName, {
    frameId: opts.frame.frameId,
    frameUrl: opts.frame.frameUrl,
    frameFit: opts.frame.frameFit,
    optimize: opts.optimize,
  });
  let key = opts.ghTarget
    ? ghAttachmentKey(opts.ghTarget, prepared.filename)
    : opts.ghBranchTarget
      ? ghBranchAttachmentKey(
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
  const markdown = buildMarkdown(urlForGithubEmbed(result.url, result.embedUrl)!, {
    alt: opts.alt(prepared),
    width: opts.width,
  });
  return { result, prepared, markdown };
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
 * `not_authorized` (issue #297 baseline control) — this repo is bound to a
 * different workspace. Deliberately not caught by the generic "bot endpoint
 * unreachable" fallback below: falling back to gh here would let the
 * human's own credentials post anyway, defeating the point of the
 * server-side gate.
 */
export class GithubCommentAuthorizationError extends Error {}

export async function syncAttachmentsComment(
  client: UploadsClient,
  target: GhTarget,
  run: CommandRunner,
  workspace?: string,
): Promise<AttachmentsCommentResult> {
  let bot: GithubCommentResult | undefined;
  try {
    bot = await client.upsertGithubComment({
      repo: target.repo,
      num: target.num,
      kind: target.kind,
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
    // Installed-but-unapproved is a fixable misconfiguration, not a silent
    // degrade: tell the user (and how to fix it) before falling back to gh.
    if (bot.reason === "forbidden" && bot.message) {
      process.stderr.write(
        `note: ${bot.message}${bot.fixUrl ? `\n  ${bot.fixUrl}` : ""}\n` +
          `Posting via local gh in the meantime.\n`,
      );
    }
  }

  // gh fallback: gather from this workspace's own data and post via local `gh`.
  // Note (issues #304, #365): this CLI process has no server-side
  // WorkspaceRecord in scope, so it cannot honor a workspace's
  // githubCommentLinkToFilePage=false or githubCommentShowMetadata=false — it
  // always links to the file page and always shows metadata here, matching the
  // defaults. This only diverges from the bot-posted comment for a workspace
  // that both sets one of those flags false and falls through to this path.
  const items: AttachmentItem[] = (
    await client.listAll({ prefix: ghKeyPrefix(target), metadata: true })
  ).map(({ key, url, embedUrl, pageUrl, metadata }) => {
    // The list endpoint returns every metadata key; the comment renders only
    // these two. Narrowing here keeps both render paths byte-identical.
    const path = metadata?.path;
    const state = metadata?.state;
    return {
      key,
      url,
      embedUrl,
      pageUrl,
      ...(path || state
        ? { meta: { ...(path ? { path } : {}), ...(state ? { state } : {}) } }
        : {}),
    };
  });

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
  const body = attachmentsCommentBody(items, previewGalleries, marker);
  const count = items.length + previewGalleries.length;
  // Empty (count 0) renders the neutral empty-state body but must not create a
  // comment — it only rewrites one that already exists (`action: "skipped"`
  // when none does).
  const { action } = upsertAttachmentsComment(target, body, run, marker, {
    createIfMissing: count > 0,
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

Options:
  --pr <num>            Attach to this pull request
  --issue <num>         Attach to this issue
  --branch [name]       Stage against a branch, pre-PR (default: current git branch);
                        not with --pr/--issue/--comment
  --promote             No files: promote branch-staged attachments into the
                        resolved PR and refresh the comment; not with
                        --branch/--issue/--no-promote
  --no-promote          Skip auto-promoting branch-staged attachments (default path only)
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
  uploads attach ./shot.png --branch feature/new-settings
  uploads attach --promote
`;

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
): Promise<{ uploads: AttachUploadItem[]; failures: AttachFailure[]; firstError?: unknown }> {
  if (opts.files.some((f) => f === "-")) {
    throw new UsageError("attach does not support stdin; pass one or more file paths");
  }

  type Slot = { ok: true; upload: AttachUploadItem } | { ok: false; file: string; err: unknown };

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
        const metadata = opts.deriveImageFacts
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
          upload: {
            ...result,
            file,
            markdown: buildMarkdown(urlForGithubEmbed(result.url, result.embedUrl)!, {
              alt: sourceName,
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
  const failures: AttachFailure[] = [];
  let firstError: unknown;
  for (const slot of slots) {
    if (slot.ok) uploads.push(slot.upload);
    else {
      firstError ??= slot.err;
      failures.push({ file: slot.file, error: errorDetail(slot.err) });
    }
  }
  return { uploads, failures, firstError };
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
}): Promise<{ uploads: AttachUploadItem[]; failures: AttachFailure[]; firstError?: unknown }> {
  return uploadAttachmentBatch({
    ...opts,
    keyFor: (filename) => ghAttachmentKey(opts.target, filename),
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
}): Promise<{ uploads: AttachUploadItem[]; failures: AttachFailure[]; firstError?: unknown }> {
  return uploadAttachmentBatch({
    ...opts,
    keyFor: (filename) => ghBranchAttachmentKey(opts.target.repo, opts.target.branch, filename),
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
  files: readonly string[];
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
}): Promise<{ uploads: PutUploadItem[]; failures: AttachFailure[]; firstError?: unknown }> {
  if (opts.files.length > 1 && opts.files.some((f) => f === "-")) {
    throw new UsageError("stdin (-) cannot be combined with multiple file arguments");
  }
  if (opts.files.length > 1 && opts.explicitKey) {
    throw new UsageError("--key cannot be combined with multiple files");
  }
  if (opts.files.length > 1 && opts.nameOverride) {
    throw new UsageError("--name cannot be combined with multiple files");
  }

  type Slot = { ok: true; upload: PutUploadItem } | { ok: false; file: string; err: unknown };

  const slots = await mapBounded(
    opts.files,
    opts.concurrency ?? UPLOAD_BATCH_CONCURRENCY,
    async (file): Promise<Slot> => {
      try {
        const sourceName =
          opts.nameOverride ??
          (file === "-"
            ? opts.explicitKey
              ? basename(opts.explicitKey)
              : "stdin.bin"
            : basename(file));
        const bytes = readFileArg(file);
        // Sidecar manifest from a prior `screenshot --out` of this exact file
        // (issue #469 lever 2) — see mergeSidecarMeta. Not applicable to stdin.
        const metadata =
          file !== "-" ? mergeSidecarMeta(file, bytes, opts.metadata) : opts.metadata;
        const { result, prepared, markdown } = await uploadPreparedImage(
          opts.client,
          bytes,
          sourceName,
          {
            frame: opts.frame,
            optimize: opts.optimize,
            ghTarget: opts.ghTarget,
            ghBranchTarget: opts.ghBranchTarget,
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
  const failures: AttachFailure[] = [];
  let firstError: unknown;
  for (const slot of slots) {
    if (slot.ok) uploads.push(slot.upload);
    else {
      firstError ??= slot.err;
      failures.push({ file: slot.file, error: errorDetail(slot.err) });
    }
  }
  return { uploads, failures, firstError };
}

/**
 * Best-effort call to `POST /v1/:workspace/github/promote` (server contract,
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

/** Human-mode note for a promotion that actually promoted something. */
function promotionNote(
  promotion: PromoteBranchAttachmentsResult,
  branch: string | undefined,
): string {
  const n = promotion.promoted.length;
  const branchSuffix = branch ? ` from branch ${branch}` : "";
  return `>> promoted ${n} staged attachment${n === 1 ? "" : "s"}${branchSuffix}\n`;
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

  if (parsed.flags.has("--promote")) {
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
    writeCommandHelp(ATTACH_HELP);
    return 2;
  }

  if (branchArg !== undefined) {
    if (parsed.flags.has("--pr")) throw new UsageError("--branch cannot be combined with --pr");
    if (parsed.flags.has("--issue"))
      throw new UsageError("--branch cannot be combined with --issue");
    if (parsed.flags.has("--comment"))
      throw new UsageError("--branch cannot be combined with --comment");
    return runAttachBranch(ctx, parsed, branchArg, run);
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

  const logHuman = !ctx.quiet && !ctx.json;
  if (logHuman) {
    const n = parsed.positionals.length;
    process.stderr.write(`>> uploading ${n} file${n === 1 ? "" : "s"}\n`);
  }

  const { uploads, failures, firstError } = await uploadAttachments({
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
    try {
      promotedBranch = resolveCurrentBranch(run);
    } catch {
      promotedBranch = undefined;
    }
    if (promotedBranch !== undefined) {
      promotion = await attemptPromoteBranch(ctx.client, target, promotedBranch);
    }
  }

  let comment: AttachmentsCommentResult | undefined;
  let commentError: string | undefined;
  // Skip comment refresh when every upload failed — nothing new from this batch.
  if (!parsed.flags.has("--no-comment") && uploads.length > 0) {
    try {
      comment = await syncAttachmentsComment(ctx.client, target, run, ctx.config.workspace);
    } catch (err) {
      commentError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warning: uploads succeeded but the GitHub comment failed (is gh installed and authenticated?): ${commentError}\n`,
      );
    }
  }

  if (ctx.json) {
    await writeJson({
      target,
      uploads,
      failures,
      comment,
      commentError,
      promotion: promotion ?? null,
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
  const branch = resolveCurrentBranch(run);

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
 * The bare-put nudge's wording (issue #393): teaches `--pr`/`attach --branch`
 * as an upgrade from a targetless `put`. `pr` present → names the PR;
 * otherwise a generic variant that still points at `--pr <num>`. Used
 * verbatim for both the human-mode stderr line and the JSON `hint` field.
 */
function putNudgeText(branch: string, pr: number | undefined): string {
  const prClause =
    pr !== undefined ? ` (PR #${pr} open) — rerun with --pr ${pr}` : ` — rerun with --pr <num>`;
  return (
    `note: on branch ${branch}${prClause} for a stable key plus a managed comment ` +
    `that collects this PR's media, or stage pre-PR files with: uploads attach <file> --branch`
  );
}

/**
 * Best-effort bare-put nudge (issue #393): fires only when `put` has no
 * targeting flag at all (`--pr`/`--issue`/`--key`; `--branch` too, though
 * `put` doesn't currently accept it — defensive parity with `attach`), is
 * inside a git repo (reusing `deriveRepoFromGit`, the same detection the
 * default screenshot key's repo segment uses), and the current branch isn't
 * the default one. Never throws — any failure (not a repo, detached HEAD,
 * `gh` missing/unauthenticated/timed out) degrades to "no nudge" or, once a
 * branch is already known, to the generic no-PR wording. Must never affect
 * put's exit code, stdout, or upload behavior.
 */
function resolvePutNudge(opts: {
  ctx: CliContext;
  flags: CommandFlags["flags"];
  ghTarget: GhTarget | undefined;
  keyHint: string | undefined;
  noGit: boolean;
  defaults: PutDefaults;
  run: CommandRunner;
}): string | undefined {
  const { ctx, flags, ghTarget, keyHint, noGit, defaults, run } = opts;
  if (ctx.quiet) return undefined;
  if (defaults.noNudge) return undefined;
  if (ghTarget || keyHint || noGit) return undefined;
  if (flags.has("--branch")) return undefined; // not a real put flag today; defensive only
  try {
    if (deriveRepoFromGit(run) === undefined) return undefined; // not a (usable) git repo
    let branch: string;
    try {
      branch = resolveCurrentBranch(run);
    } catch {
      return undefined; // detached HEAD, or git unavailable
    }
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
      const repoArg = flagString(flags, "--repo") ?? defaults.repo;
      const repo = resolveRepo(repoArg, timed);
      pr = resolveCurrentPullRequest(repo, timed).num;
    } catch {
      pr = undefined; // gh missing/unauthenticated/timed out/no open PR — generic wording
    }
    return putNudgeText(branch, pr);
  } catch {
    return undefined;
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
    let branch: string;
    try {
      branch = resolveCurrentBranch(run);
    } catch {
      return undefined; // detached HEAD, or git unavailable
    }
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
 * The bare-put staging note's wording (issue #403): replaces the #393 nudge
 * for the (now default) case where a bare put on a non-default branch stages
 * to the branch prefix instead of landing on the dated layout. Used verbatim
 * for both the human-mode stderr line and the JSON `hint` field.
 */
export function putStagingNoteText(branch: string): string {
  return (
    `note: staged for branch ${branch} — auto-attaches to this branch's PR when it opens ` +
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
  const prefix = ghBranchKeyPrefix(repo, branch);
  const [list, binding] = await Promise.all([
    client.list({ prefix, metadata: true }),
    resolveStagedBinding(client, repo),
  ]);
  const files: StagedFile[] = list.items.map((item) => ({
    key: item.key,
    filename: item.key.slice(prefix.length),
    size: item.size,
    stagedAt: item.metadata?.["gh.staged-at"],
    url: item.url,
  }));
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
  if (files.length === 0) {
    writeCommandHelp(PUT_HELP);
    return 2;
  }
  const multi = files.length > 1;

  const keyHint = flagString(parsed.flags, "--key");
  const destFlag = flagString(parsed.flags, "--destination");
  const prefixFlag = flagString(parsed.flags, "--prefix");
  const ghTarget = ghTargetFromFlags(parsed.flags, run);
  const wantComment = parsed.flags.has("--comment");
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
  if (wantComment && typeof parsed.flags.get("--comment") === "string") {
    throw new UsageError("--comment takes no value — place it after the file argument");
  }
  if (parsed.flags.has("--auto") && typeof parsed.flags.get("--auto") === "string") {
    throw new UsageError("--auto takes no value");
  }
  if (parsed.flags.has("--no-auto") && typeof parsed.flags.get("--no-auto") === "string") {
    throw new UsageError("--no-auto takes no value");
  }
  if (wantComment && !ghTarget) throw new UsageError("--comment requires --pr or --issue");
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
  if (dryRun) {
    if (wantComment) throw new UsageError("--dry-run cannot be combined with --comment");
    if (galleryId) throw new UsageError("--dry-run cannot be combined with --gallery");
  }
  let resolvedPrefix: string | undefined;
  try {
    resolvedPrefix = resolvePutPrefix({
      destination: destFlag,
      prefix: prefixFlag,
      key: keyHint,
      ghAttachment: Boolean(ghTarget),
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

  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
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

  const noGit = flagBool(parsed.flags, "--no-git") || defaults.noGit === true;

  // Bare-put branch staging (issue #403): a bare put (no --pr/--issue/--key/
  // --ref/--prefix/--destination, not --no-git) on a non-default git branch
  // stages to the branch prefix — identical key/metadata to `attach
  // --branch` — instead of the dated layout. Computed before gh.* metadata
  // resolution below since it takes over that resolution entirely (branch
  // metadata, not PR/issue metadata) and supersedes the #393 nudge for this
  // case.
  const stagingTarget = resolvePutStagingTarget({
    ghTarget,
    keyHint,
    refArg: flagString(parsed.flags, "--ref"),
    prefixArg: prefixFlag,
    destinationArg: destFlag,
    noGit,
    repoArg: flagString(parsed.flags, "--repo") ?? defaults.repo,
    run,
  });

  // gh.* metadata: explicit --pr/--issue target wins over --meta; staging
  // wins over --meta the same way (matches attach --branch); otherwise
  // best-effort auto resolution (on by default) where --meta wins. --no-git,
  // --no-auto, or UPLOADS_NO_AUTO_META disable auto; --auto forces past the
  // config default but never past --no-git (no repo to resolve).
  let metadata = userMeta;
  let attachedRef: string | undefined;
  if (ghTarget) {
    const merged = { ...userMeta, ...ghMetadataFromTargetWithTitle(ghTarget, run) };
    validateMetaMap(merged); // enforce 24-key/8KB caps on the merged map (matches attach)
    metadata = merged;
    attachedRef = merged["gh.ref"];
  } else if (stagingTarget) {
    const merged = {
      ...userMeta,
      ...ghMetadataForBranch(stagingTarget.repo, stagingTarget.branch),
    };
    validateMetaMap(merged); // matches attach --branch's unwrapped call — same builder, same contract
    metadata = merged;
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

  // Bare-put nudge (issue #393): only relevant when staging didn't take over
  // — once `stagingTarget` resolves, staging IS the upgrade the nudge used to
  // point at, so this is skipped entirely rather than firing redundantly.
  // Still fires as before for a bare put that lands on the dated layout with
  // a detectable PR (e.g. an explicit --ref/--prefix opts out of staging).
  // Computed once, used for both the trailing stderr line (human mode) and
  // the JSON `hint` field below. Best-effort — see resolvePutNudge; never
  // affects exit code, stdout, or the upload.
  const nudge = stagingTarget
    ? undefined
    : resolvePutNudge({
        ctx,
        flags: parsed.flags,
        ghTarget,
        keyHint,
        noGit,
        defaults,
        run,
      });

  // Staging note (issue #403): same suppression as the #393 nudge
  // (--quiet, UPLOADS_NO_NUDGE=1 env/config); staging itself is NOT gated by
  // either — only whether the note is printed/hinted.
  const stagingNote =
    stagingTarget && !ctx.quiet && !defaults.noNudge
      ? putStagingNoteText(stagingTarget.branch)
      : undefined;

  const logHuman = !ctx.quiet && format === "human";
  if (logHuman) {
    if (multi) {
      process.stderr.write(`>> ${dryRun ? "dry run for" : "uploading"} ${files.length} files\n`);
    } else {
      const fileArg = files[0]!;
      process.stderr.write(
        `>> ${dryRun ? "dry run" : "uploading"} ${fileArg === "-" ? "stdin" : fileArg}\n`,
      );
    }
    if (attachedRef) process.stderr.write(`>> attached to ${attachedRef}\n`);
  }

  const { uploads, failures, firstError } = await uploadPuts({
    client: ctx.client,
    files,
    nameOverride: nameFlag,
    explicitKey: keyHint,
    ghTarget,
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

  // Single-file total failure: rethrow so CLI exit codes stay auth/network-aware.
  if (uploads.length === 0 && failures.length > 0 && !multi) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  // Stage-time binding warning (issue #398/#400): same check `attach
  // --branch` runs, now also on the bare-put staging path. Best-effort — see
  // resolveStageBindingWarning; never affects exit code or the upload.
  const bindingWarning =
    stagingTarget && uploads.length > 0
      ? await resolveStageBindingWarning({ ctx, defaults, repo: stagingTarget.repo })
      : undefined;
  // One JSON `hint` slot, shared with the #393 nudge (mutually exclusive with
  // it — nudge is undefined whenever staging took over). When staging fires,
  // prefer the more actionable binding warning over the generic staging note
  // (mirrors attach --branch, whose only JSON hint content IS the binding
  // warning); stderr prints the nudge/staging-note and binding-warning lines
  // independently, below.
  const jsonHint = nudge ?? bindingWarning ?? stagingNote;

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
  if (wantComment && ghTarget && uploads.length > 0) {
    try {
      comment = await syncAttachmentsComment(ctx.client, ghTarget, run, ctx.config.workspace);
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
      if (nudge) process.stderr.write(`${nudge}\n`);
      if (stagingNote) process.stderr.write(`${stagingNote}\n`);
      if (bindingWarning) process.stderr.write(`${bindingWarning}\n`);
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
  if (nudge && format !== "json") process.stderr.write(`${nudge}\n`);
  if (stagingNote && format !== "json") process.stderr.write(`${stagingNote}\n`);
  if (bindingWarning && format !== "json") process.stderr.write(`${bindingWarning}\n`);

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
  if (help || parsed.help || !action) {
    writeCommandHelp(GALLERY_HELP);
    return help || parsed.help ? 0 : 2;
  }

  switch (action) {
    case "create": {
      const title = flagString(parsed.flags, "--title");
      if (!title) throw new UsageError("gallery create requires --title");
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
      throw new UsageError(`unknown gallery command: ${action}`);
  }
}

// --- list ---

const LIST_HELP = `uploads list [--prefix <p>] [--pr <num> | --issue <num>] [--repo <owner/name>] [--limit <n>] [--cursor <c>] [--all] [--meta <k=v>]... [--workspace <name>]

Default prefix: UPLOADS_DEFAULT_PREFIX (screenshots if unset).

--meta <k=v> (repeatable, ANDed) switches to the metadata filter endpoint —
returned items include their matched metadata. Combines with --prefix, not
with --pr/--issue/--all. See also: uploads find (positional-pair alias).

Examples:
  uploads list --prefix screenshots/
  uploads list --pr 123
  uploads list --all --json
  uploads list --meta gh.repo=buildinternet/uploads --meta gh.number=123
`;

/** `--meta k=v` (repeatable) filter path, shared by `runList` and `runFind`. */
async function runFindFiles(
  ctx: CliContext,
  filters: Record<string, string>,
  flags: CommandFlags["flags"],
): Promise<number> {
  if (flagString(flags, "--cursor") !== undefined) {
    throw new UsageError("--cursor is not supported with metadata filters");
  }
  const prefix = flagString(flags, "--prefix");
  const limit = flagInt(flags, "--limit", "--limit");
  const result = await ctx.client.findFiles(filters, { prefix, limit });
  if (ctx.json) await writeJson(result);
  else
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
  if (metaPairs.length > 0) {
    if (ghTargetFromFlags(parsed.flags, run)) {
      throw new UsageError("--meta cannot be combined with --pr/--issue");
    }
    if (flagBool(parsed.flags, "--all")) {
      throw new UsageError("--meta cannot be combined with --all");
    }
    return runFindFiles(ctx, parseMetaFlags(metaPairs), parsed.flags);
  }
  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
  const prefixFlag = flagString(parsed.flags, "--prefix");
  let prefix = prefixFlag ?? (defaults.prefix ? `${defaults.prefix}/` : undefined);
  const ghTarget = ghTargetFromFlags(parsed.flags, run);
  if (ghTarget) {
    if (prefixFlag) throw new UsageError("--prefix cannot be combined with --pr/--issue");
    prefix = ghKeyPrefix(ghTarget);
  }
  const limit = flagInt(parsed.flags, "--limit", "--limit");
  const cursor = flagString(parsed.flags, "--cursor");

  if (flagBool(parsed.flags, "--all")) {
    // --all may start from a caller-provided --cursor and drains from there.
    const items = await ctx.client.listAll({ prefix, limit, cursor });
    if (ctx.json) await writeJson({ items, cursor: null });
    else
      for (const item of items)
        await writeStdout(`${item.key}${item.url ? `  ${item.url}` : ""}\n`);
    return 0;
  }

  const result = await ctx.client.list({ prefix, limit, cursor });
  if (ctx.json) await writeJson(result);
  else {
    for (const item of result.items)
      await writeStdout(`${item.key}${item.url ? `  ${item.url}` : ""}\n`);
    if (result.cursor) process.stderr.write(`cursor: ${result.cursor}\n`);
  }
  return 0;
}

// --- find ---

const FIND_HELP = `uploads find k=v [k=v...] [--prefix <p>] [--limit <n>] [--workspace <name>]

Human-friendly alias for \`uploads list --meta k=v...\` — same metadata filter
(ANDed equality), same output; pairs are positional instead of repeated flags.

Examples:
  uploads find gh.repo=buildinternet/uploads gh.number=123
  uploads find path=/settings state=after --prefix screenshots/
`;

export async function runFind(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(FIND_HELP);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    writeCommandHelp(FIND_HELP);
    return 2;
  }
  const filters = parseMetaFlags(parsed.positionals);
  return runFindFiles(ctx, filters, parsed.flags);
}

// --- meta ---

const META_HELP = `uploads meta <command> [args]

Read/write an object's queryable custom metadata (D1-backed key-value pairs;
distinct from the R2 provenance headers put on upload).

Commands:
  get <key>                            Show metadata for an object
  set <key> k=v [k=v...] [--delete k]...   Merge-set and/or delete pairs

Examples:
  uploads meta get screenshots/myapp/42/shot.png
  uploads meta set screenshots/myapp/42/shot.png path=/settings state=after
  uploads meta set screenshots/myapp/42/shot.png --delete path --delete state
`;

export async function runMeta(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  const action = parsed.positionals[0];
  if (help || parsed.help || !action) {
    writeCommandHelp(META_HELP);
    return help || parsed.help ? 0 : 2;
  }

  switch (action) {
    case "get": {
      const key = parsed.positionals[1];
      if (!key) throw new UsageError("meta get requires an object key");
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
      if (!key) throw new UsageError("meta set requires an object key");
      const pairs = parsed.positionals.slice(2);
      const del = flagValues(parsed.flags, "--delete");
      if (pairs.length === 0 && del.length === 0) {
        throw new UsageError("meta set requires k=v pairs and/or --delete <key>");
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
    default:
      throw new UsageError(`unknown meta command: ${action}`);
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
async function resyncCommentAfterMetaSet(
  ctx: CliContext,
  key: string,
  touchedKeys: string[],
): Promise<void> {
  if (!touchedKeys.some((k) => COMMENT_RENDERED_META_KEYS.includes(k))) return;
  const target = parseGhKey(key);
  if (!target) return;
  try {
    const bot = await ctx.client.upsertGithubComment({
      repo: target.repo,
      num: target.num,
      kind: target.kind,
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
    writeCommandHelp(DELETE_HELP);
    return 2;
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
  if (!target) throw new UsageError("comment requires --pr or --issue");

  const result = await syncAttachmentsComment(ctx.client, target, run, ctx.config.workspace);
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

// --- github link ---

const GITHUB_HELP = `uploads github link [--repo <owner/name>] [--status] [--workspace <name>]
uploads github unlink [--repo <owner/name>] [--workspace <name>]
uploads github doctor [--workspace <name>]

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
handler needs (issues, pull_request — see docs/github-app). A missing
subscription is the classic silent failure: the App's ping stays green
while webhook auto-promotion and title-cache invalidation quietly do
nothing.

Examples:
  uploads github link
  uploads github link --repo buildinternet/uploads
  uploads github link --status
  uploads github unlink --repo buildinternet/uploads
  uploads github doctor
`;

/** Older servers' health payload predates recommendedEvents/missingRecommendedEvents — treat as no recommendations rather than crashing. */
function missingRecommendedEventsOf(result: GithubHealthResult): string[] {
  return Array.isArray(result.missingRecommendedEvents) ? result.missingRecommendedEvents : [];
}

function recommendedNoteLine(result: GithubHealthResult): string {
  const missing = missingRecommendedEventsOf(result);
  if (missing.length === 0) return "";
  return `note: not subscribed to ${missing.join(", ")} (recommended) — enables bot-comment self-healing; subscribe under the App's Permissions & events\n`;
}

function formatGithubDoctor(result: GithubHealthResult): string {
  if (!result.configured) {
    return `github app: not configured on this server${result.hint ? ` — ${result.hint}` : ""}\n`;
  }
  if (result.events === null) {
    return `github app: configured, but health check failed${result.hint ? ` — ${result.hint}` : ""}\n`;
  }
  if (result.ok) {
    return (
      `github app: ok — subscribed to ${result.requiredEvents.join(", ")}\n` +
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
  if (action !== "link" && action !== "unlink" && action !== "doctor") {
    throw new UsageError(`unknown github subcommand: ${action}`);
  }

  if (action === "doctor") return runGithubDoctor(ctx);

  const repo = resolveRepo(flagString(parsed.flags, "--repo"), run);

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
  if (report.warning) lines.push(`warning:   ${report.warning}`);
  for (const h of report.hints) if (h !== report.warning) lines.push(`hint:      ${h}`);
  await writeStdout(lines.join("\n") + "\n");
  return report.ok ? 0 : 1;
}
