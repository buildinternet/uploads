import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { mapBounded } from "./async.js";
import {
  createUploadsClient,
  type GalleryItem,
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
import { parseMetaFlags, validateMetaMap } from "./metadata.js";
import {
  ghAttachmentKey,
  ghKeyPrefix,
  ghMetadataFromTarget,
  attachmentsCommentBody,
  type GhTarget,
  type AttachmentItem,
  type GalleryCommentItem,
  normalizeGithubCoordinate,
} from "./github.js";
import {
  resolveRepo,
  resolveCurrentPullRequest,
  classifyGhNumber,
  execRunner,
  ghMetadataFromTargetWithTitle,
  upsertAttachmentsComment,
  type CommandRunner,
} from "./github-gh.js";
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

Uploads are public. --pr/--issue keys include the repo, number, and filename and
remain public even for private/internal GitHub repositories. Upload only media
that is safe at a predictable public URL.

Re-uploading the same key overwrites in place (no prompt) so embeds hot-swap;
human mode prints ">> replaced existing object (same URL)" after a real put,
or ">> would replace existing object (same URL)" on --dry-run when the key
already exists.

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
  --dry-run             Print key + public URL without uploading; reports if the key would replace an existing object. Not with --comment/--gallery

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
  uploads put ./shot.png --meta app=myapp --meta page=settings
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

function writeReplacedNote(replaced: boolean | undefined, quiet: boolean, dryRun = false): void {
  if (!quiet && replaced) {
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

export interface UploadPreparedImageOptions {
  frame: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
  };
  optimize: OptimizeImageOptions;
  /** gh attachment key wins over `key` when both are set (matches every call site). */
  ghTarget?: GhTarget;
  key?: string;
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
  contentType?: string;
  dryRun?: boolean;
  metadata?: Record<string, string>;
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
  const prepared = await prepareImageForUpload(bytes, sourceName, {
    frameId: opts.frame.frameId,
    frameUrl: opts.frame.frameUrl,
    frameFit: opts.frame.frameFit,
    optimize: opts.optimize,
  });
  let key = opts.ghTarget ? ghAttachmentKey(opts.ghTarget, prepared.filename) : opts.key;
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
    provenance: buildCliProvenance({
      sourceName,
      client: opts.provenanceClient,
      optimized: prepared.optimized,
      frameId: prepared.frame?.framed ? prepared.frame.frameId : undefined,
      keepExif: opts.optimize.keepExif === true,
    }),
    metadata: opts.metadata,
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

export async function syncAttachmentsComment(
  client: UploadsClient,
  target: GhTarget,
  run: CommandRunner,
): Promise<AttachmentsCommentResult> {
  try {
    const bot = await client.upsertGithubComment({
      repo: target.repo,
      num: target.num,
      kind: target.kind,
    });
    if (bot.posted) return { action: bot.action, count: bot.count, via: "bot" };
    // Installed-but-unapproved is a fixable misconfiguration, not a silent
    // degrade: tell the user (and how to fix it) before falling back to gh.
    if (bot.reason === "forbidden" && bot.message) {
      process.stderr.write(
        `note: ${bot.message}${bot.fixUrl ? `\n  ${bot.fixUrl}` : ""}\n` +
          `Posting via local gh in the meantime.\n`,
      );
    }
  } catch {
    // Endpoint absent/unreachable (self-hosted, network, older worker) — fall
    // through to the gh path below.
  }

  // gh fallback: gather from this workspace's own data and post via local `gh`.
  const items: AttachmentItem[] = (await client.listAll({ prefix: ghKeyPrefix(target) })).map(
    ({ key, url, embedUrl }) => ({ key, url, embedUrl }),
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

  if (items.length === 0 && previewGalleries.length === 0)
    return { action: "skipped", count: 0, via: "gh" };

  const body = attachmentsCommentBody(items, previewGalleries);
  const { created } = upsertAttachmentsComment(target, body, run);
  return {
    action: created ? "created" : "updated",
    count: items.length + previewGalleries.length,
    via: "gh",
  };
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

Options:
  --pr <num>            Attach to this pull request
  --issue <num>         Attach to this issue
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
                        target — a --meta pair with the same key is overridden by it.
                        Because attach always sends its own gh.* pairs, re-attaching to
                        the same key always replaces that file's entire metadata set
                        (never preserves) — use "uploads meta set" to add to it instead.

Examples:
  uploads attach ./before.png ./after.png
  uploads attach ./mobile.png --frame phone
  uploads attach ./shot.png --pr 123 --repo myorg/myapp
  uploads attach ./artifact.zip --issue 45 --no-comment
  uploads attach ./shot.png --meta app=myapp --meta page=settings
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
  /** Provenance `client` field (default uploads-cli). */
  provenanceClient?: string;
  concurrency?: number;
}): Promise<{ uploads: AttachUploadItem[]; failures: AttachFailure[]; firstError?: unknown }> {
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
        const prepared = await prepareImageForUpload(readFileArg(file), sourceName, {
          ...opts.frame,
          optimize: opts.optimize,
        });
        const result = await opts.client.put(prepared.bytes, {
          filename: prepared.filename,
          key: ghAttachmentKey(opts.target, prepared.filename),
          contentType: prepared.optimized ? prepared.contentType : opts.contentType,
          provenance: buildCliProvenance({
            sourceName,
            client: opts.provenanceClient,
            optimized: prepared.optimized,
            frameId: prepared.frame?.framed ? prepared.frame.frameId : undefined,
            keepExif: opts.optimize.keepExif === true,
          }),
          metadata: opts.metadata,
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
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
  contentType?: string;
  dryRun?: boolean;
  optimize: OptimizeImageOptions;
  frame: {
    frameId?: string;
    frameUrl?: string;
    frameFit?: "cover" | "contain";
  };
  metadata?: Record<string, string>;
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
        const { result, prepared, markdown } = await uploadPreparedImage(
          opts.client,
          readFileArg(file),
          sourceName,
          {
            frame: opts.frame,
            optimize: opts.optimize,
            ghTarget: opts.ghTarget,
            key: opts.explicitKey,
            prefix: opts.prefix,
            repo: opts.repo,
            ref: opts.ref,
            deriveRepoFromGit: opts.deriveRepoFromGit,
            contentType: opts.contentType,
            dryRun: opts.dryRun,
            metadata: opts.metadata,
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
  if (parsed.positionals.length === 0) {
    writeCommandHelp(ATTACH_HELP);
    return 2;
  }
  if (parsed.flags.has("--no-comment") && typeof parsed.flags.get("--no-comment") === "string") {
    throw new UsageError("--no-comment takes no value — place it after the file arguments");
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
  const metaExtras = parseMetaFlags(flagValues(parsed.flags, "--meta"));
  const metadata = { ...metaExtras, ...ghMetadataFromTargetWithTitle(target, run) };
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
  });

  // Single-file total failure: rethrow so CLI exit codes stay auth/network-aware.
  if (uploads.length === 0 && failures.length === 1 && parsed.positionals.length === 1) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  let comment: AttachmentsCommentResult | undefined;
  let commentError: string | undefined;
  // Skip comment refresh when every upload failed — nothing new from this batch.
  if (!parsed.flags.has("--no-comment") && uploads.length > 0) {
    try {
      comment = await syncAttachmentsComment(ctx.client, target, run);
    } catch (err) {
      commentError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warning: uploads succeeded but the GitHub comment failed (is gh installed and authenticated?): ${commentError}\n`,
      );
    }
  }

  if (ctx.json) {
    await writeJson({ target, uploads, failures, comment, commentError });
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
  // Validate --meta up front (fail fast, before reading/optimizing the file).
  const userMeta = ((): Record<string, string> | undefined => {
    const pairs = flagValues(parsed.flags, "--meta");
    return pairs.length > 0 ? parseMetaFlags(pairs) : undefined;
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
  // gh.* metadata: explicit --pr/--issue target wins over --meta; otherwise
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
  } else {
    const autoEnabled =
      !noGit &&
      !flagBool(parsed.flags, "--no-auto") &&
      (flagBool(parsed.flags, "--auto") || defaults.noAutoMeta !== true);
    if (autoEnabled) {
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
    prefix: resolvedPrefix ?? defaults.prefix,
    repo: flagString(parsed.flags, "--repo") ?? defaults.repo,
    ref: flagString(parsed.flags, "--ref") ?? defaults.ref,
    deriveRepoFromGit: !noGit,
    contentType: contentTypeOverride,
    dryRun,
    optimize: optimizeOpts,
    frame: frameOpts,
    metadata,
    alt: altFlag,
    width,
  });

  // Single-file total failure: rethrow so CLI exit codes stay auth/network-aware.
  if (uploads.length === 0 && failures.length > 0 && !multi) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

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
      comment = await syncAttachmentsComment(ctx.client, ghTarget, run);
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
          writeReplacedNote(result.replaced, false, dryRun);
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
    writeReplacedNote(result.replaced, ctx.quiet, dryRun);
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
  uploads find app=myapp page=settings --prefix screenshots/
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
  uploads meta set screenshots/myapp/42/shot.png app=myapp page=settings
  uploads meta set screenshots/myapp/42/shot.png --delete app --delete page
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
      return 0;
    }
    default:
      throw new UsageError(`unknown meta command: ${action}`);
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

  const result = await syncAttachmentsComment(ctx.client, target, run);
  if (ctx.json) {
    await writeJson({ ...target, ...result });
  } else if (!ctx.quiet) {
    const via = commentViaSuffix(result.via);
    process.stderr.write(
      result.action === "skipped"
        ? `no attachments under ${ghKeyPrefix(target)} — nothing to do\n`
        : `${result.action} attachments comment on ${target.repo}#${target.num} (${result.count} file${result.count === 1 ? "" : "s"})${via}\n`,
    );
  }
  return 0;
}

// --- usage / reconcile / purge ---

const USAGE_HELP = `uploads usage [--workspace <name>]

Show workspace storage and monthly upload counters.

When the API reports workspace quotas (typical on uploads.sh cloud /
self-serve plans), human output includes progress bars toward those caps.
Self-hosted or unlimited operator workspaces get usage totals only, plus a
short unmetered note — no invented limits.

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
  if (authOk) {
    try {
      const snap = await client.usage();
      usage = {
        ok: true,
        bytes: snap.bytes,
        objects: snap.objects,
        uploadsInPeriod: snap.uploadsInPeriod,
      };
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
