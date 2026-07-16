import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  flagBool,
  flagInt,
  flagString,
  flagValues,
  parseCommandArgs,
  UsageError,
} from "../cli-args.js";
import { writeCommandHelp } from "../cli-style.js";
import {
  frameOptionsFromFlags,
  ghTargetFromFlags,
  optimizeOptionsFromFlags,
  syncAttachmentsComment,
  uploadPreparedImage,
  type CliContext,
} from "../commands.js";
import { resolvePutDefaults } from "../config.js";
import { loadDefaultsRaw, resolveScreenshotDefaults } from "../config-file.js";
import { resolvePutPrefix } from "../destinations.js";
import { ghMetadataFromTarget } from "../github.js";
import { execRunner, type CommandRunner } from "../github-gh.js";
import { parseMetaFlags, validateMetaMap } from "../metadata.js";
import { writeJson, writeStdout } from "../io.js";
import {
  captureScreenshot,
  parseViewport,
  parseWaitUntil,
  type ScreenshotBackend,
} from "../screenshot.js";

const SCREENSHOT_HELP = `uploads screenshot <target> [options]

Capture a URL or a local .html file and host it — a hosted, PR-embeddable
image in one step. target is an http(s) URL or a path to an .html file.

Two capture backends: "local" drives an already-installed Chrome/Chromium via
playwright-core (no browser download); "remote" renders server-side via the
uploads.sh render endpoint (no local browser needed, counts against the
workspace's monthly upload budget). Default --via auto prefers local when a
browser is found, else remote.

localhost/private-network URLs and .html files are reachable only by the
local backend — with --via remote (or auto falling back to remote) these
fail fast with a clear error instead of sending a doomed request.

After capture, screenshots share the put upload pipeline: optional --frame,
optimize-by-default, --pr/--issue attachment + --comment, --gallery, --meta.

Options:
  --via auto|local|remote   Capture backend (default: auto, or UPLOADS_SCREENSHOT_VIA)
  --browser <path>          Explicit local browser executable (or UPLOADS_CHROME_PATH / CHROME_PATH)
  --cdp <endpoint>          Attach to a running Chrome via CDP (http://host:port or ws://…)
  --viewport <WxH[@Sx]>     Size + device scale factor (default: 1280x800@2)
  --selector <css>          Capture one element instead of the viewport
  --full-page               Capture the full scrollable page
  --dark / --light          Emulate prefers-color-scheme (full media-query emulation on --via local
                            only; --via remote just sets the CSS color-scheme property, so a page's
                            own prefers-color-scheme queries won't flip)
  --wait <load|domcontentloaded|networkidle|ms>  Settle strategy (default: load); a millisecond
                            count is local-only — use --via local
  --out <file>              Also write the PNG to a local file
  --no-upload                Skip hosting; requires --out (local file only)
  --destination <id>        Typed root: screenshots | gh | f
  --prefix <path>           Key prefix (default: screenshots, or UPLOADS_DEFAULT_PREFIX)
  --repo <owner/repo>       Repo segment (default: git remote, or UPLOADS_DEFAULT_REPO)
  --ref <id>                PR/issue/branch segment (default: today, or UPLOADS_DEFAULT_REF)
  --key <key>               Explicit object key; cannot combine with --pr/--issue
  --alt <text>              Alt text (default: derived filename)
  --width <px>              <img width=…> markdown
  --frame <id>              Device/browser frame before optimize (phone|browser|iphone-16-pro)
  --frame-url <url>         Address bar text for --frame browser
  --frame-fit cover|contain How the shot fills the screen (default: cover)
  --no-optimize             Skip client-side image optimization
  --optimize-max-edge <px>  Max long edge when optimizing (default: 2400)
  --optimize-quality <1-100> WebP quality (default: 85)
  --keep-exif               Keep EXIF/XMP/ICC when optimizing
  --pr <num>                Attach to a pull request (stable URL, no hash)
  --issue <num>             Attach to an issue
  --comment                 With --pr/--issue: update the managed attachments comment
  --gallery <id>            Add the uploaded object to this public gallery
  --meta <k=v>              Queryable custom metadata (repeatable)
  --workspace, -w <name>    Override workspace
  --dry-run                 Capture + resolve key/URL without uploading
  --format human|url|markdown|json

Exit codes: 0 ok · 2 usage/no browser found/file · 3 auth/policy/budget · 4 network · 1 other.

Examples:
  uploads screenshot https://uploads.sh
  uploads screenshot ./card.html --out ./card.png
  uploads screenshot https://app.example/settings --selector main --dark
  uploads screenshot http://localhost:3000 --via local --full-page
  uploads screenshot https://uploads.sh --pr 128 --comment
  uploads screenshot ./card.html --no-upload --out ./card.png
`;

function colorSchemeFromFlags(
  flags: ReturnType<typeof parseCommandArgs>["flags"],
): "dark" | "light" | undefined {
  const dark = flagBool(flags, "--dark");
  const light = flagBool(flags, "--light");
  if (dark && light) throw new UsageError("--dark and --light are mutually exclusive");
  if (dark) return "dark";
  if (light) return "light";
  return undefined;
}

function viaFromFlags(
  flags: ReturnType<typeof parseCommandArgs>["flags"],
  fallback: ScreenshotBackend,
): ScreenshotBackend {
  const raw = flagString(flags, "--via");
  if (!raw) return fallback;
  if (raw === "auto" || raw === "local" || raw === "remote") return raw;
  throw new UsageError(`invalid --via: ${raw} (use auto, local, or remote)`);
}

export async function runScreenshot(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
  /** Injectable for tests — avoids launching a real browser or hitting the network. */
  captureImpl: typeof captureScreenshot = captureScreenshot,
): Promise<number> {
  if (help) {
    writeCommandHelp(SCREENSHOT_HELP);
    return 0;
  }
  const parsed = parseCommandArgs(args);
  if (parsed.help) {
    writeCommandHelp(SCREENSHOT_HELP);
    return 0;
  }

  const target = parsed.positionals[0];
  if (!target) {
    writeCommandHelp(SCREENSHOT_HELP);
    return 2;
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError("screenshot takes exactly one target");
  }

  // Read the on-disk config once and share it between the screenshot and
  // put-style default resolvers (both would otherwise read the same file).
  const rawDefaults = loadDefaultsRaw({ envFile: ctx.envFile });
  const screenshotDefaults = resolveScreenshotDefaults({ envFile: ctx.envFile }, rawDefaults);
  const via = viaFromFlags(parsed.flags, screenshotDefaults.via ?? "auto");
  const browserPath = flagString(parsed.flags, "--browser");
  const cdp = flagString(parsed.flags, "--cdp");
  const viewport = parseViewport(flagString(parsed.flags, "--viewport"));
  const selector = flagString(parsed.flags, "--selector");
  const fullPage = flagBool(parsed.flags, "--full-page");
  const colorScheme = colorSchemeFromFlags(parsed.flags);
  const waitUntil = parseWaitUntil(flagString(parsed.flags, "--wait"));
  const outFile = flagString(parsed.flags, "--out");
  const noUpload = flagBool(parsed.flags, "--no-upload");
  if (noUpload && !outFile) throw new UsageError("--no-upload requires --out");

  const keyHint = flagString(parsed.flags, "--key");
  const destFlag = flagString(parsed.flags, "--destination");
  const prefixFlag = flagString(parsed.flags, "--prefix");
  const ghTarget = ghTargetFromFlags(parsed.flags, run);
  const wantComment = parsed.flags.has("--comment");
  const galleryId = flagString(parsed.flags, "--gallery");
  const dryRun = flagBool(parsed.flags, "--dry-run");

  if (wantComment && !ghTarget) throw new UsageError("--comment requires --pr or --issue");
  if (ghTarget) {
    if (keyHint) throw new UsageError("--key cannot be combined with --pr/--issue");
    if (flagString(parsed.flags, "--ref"))
      throw new UsageError("--ref cannot be combined with --pr/--issue");
    if (prefixFlag) throw new UsageError("--prefix cannot be combined with --pr/--issue");
  }
  if (dryRun) {
    if (wantComment) throw new UsageError("--dry-run cannot be combined with --comment");
    if (galleryId) throw new UsageError("--dry-run cannot be combined with --gallery");
    if (noUpload) throw new UsageError("--dry-run cannot be combined with --no-upload");
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

  const putDefaults = resolvePutDefaults({ envFile: ctx.envFile }, rawDefaults);
  const optimizeOpts = optimizeOptionsFromFlags(parsed.flags, putDefaults);
  const frameOpts = frameOptionsFromFlags(parsed.flags);
  const altFlag = flagString(parsed.flags, "--alt");
  const width = flagInt(parsed.flags, "--width", "--width") ?? putDefaults.width;

  const metaExtras = parseMetaFlags(flagValues(parsed.flags, "--meta"));
  let metadata: Record<string, string> | undefined = metaExtras;
  if (ghTarget) {
    metadata = { ...metaExtras, ...ghMetadataFromTarget(ghTarget) };
    validateMetaMap(metadata);
  } else if (Object.keys(metaExtras).length > 0) {
    validateMetaMap(metaExtras);
  }

  const logHuman = !ctx.quiet && format === "human";
  if (logHuman) process.stderr.write(`>> capturing ${target}\n`);

  const captured = await captureImpl({
    target,
    via,
    browserPath,
    cdp,
    viewport,
    selector,
    fullPage,
    colorScheme,
    waitUntil,
    apiUrl: ctx.config.apiUrl,
    token: ctx.config.token,
  });

  if (logHuman) process.stderr.write(`>> captured via ${captured.backend} backend\n`);

  if (outFile) {
    writeFileSync(outFile, captured.png);
    if (logHuman) process.stderr.write(`>> wrote ${outFile}\n`);
  }

  if (noUpload) {
    if (ctx.json) {
      await writeJson({ file: outFile, backend: captured.backend, size: captured.png.byteLength });
    } else {
      await writeStdout(`FILE: ${outFile}\n`);
    }
    return 0;
  }

  const repo = flagString(parsed.flags, "--repo") ?? putDefaults.repo;
  const ref = flagString(parsed.flags, "--ref") ?? putDefaults.ref;

  const alt = altFlag ?? basename(captured.filename);
  const { result, prepared, markdown } = await uploadPreparedImage(
    ctx.client,
    captured.png,
    captured.filename,
    {
      frame: frameOpts,
      optimize: optimizeOpts,
      ghTarget,
      key: keyHint,
      prefix: resolvedPrefix ?? putDefaults.prefix,
      repo,
      ref,
      deriveRepoFromGit: !(flagBool(parsed.flags, "--no-git") || putDefaults.noGit === true),
      dryRun,
      metadata,
      provenanceClient: "uploads-cli-screenshot",
      alt: () => alt,
      width,
    },
  );

  let gallery: { id: string; url?: string; error?: string } | undefined;
  if (galleryId) {
    try {
      const current = await ctx.client.getGallery(galleryId);
      const item = await ctx.client.addGalleryItem(galleryId, result.key, {
        expectedVersion: current.version,
        altText: alt,
      });
      gallery = { id: galleryId, url: current.url };
      void item;
    } catch (err) {
      gallery = { id: galleryId, error: err instanceof Error ? err.message : String(err) };
    }
  }

  let comment: { action: "created" | "updated" | "skipped"; count: number } | undefined;
  let commentError: string | undefined;
  if (wantComment && ghTarget) {
    try {
      comment = await syncAttachmentsComment(ctx.client, ghTarget, run);
      if (logHuman) process.stderr.write(`>> attachments comment ${comment.action}\n`);
    } catch (err) {
      commentError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warning: upload succeeded but the GitHub comment failed (is gh installed and authenticated?): ${commentError}\n`,
      );
    }
  }

  if (logHuman) {
    if (prepared.frame?.framed) process.stderr.write(`>> framed with ${prepared.frame.frameId}\n`);
    if (prepared.optimized) {
      process.stderr.write(
        `>> optimized ${prepared.originalBytes} → ${prepared.outputBytes} bytes\n`,
      );
    }
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
        markdown,
        backend: captured.backend,
        gallery,
        ...(dryRun ? { dryRun: true } : {}),
      });
      break;
    case "url":
      await writeStdout(`${result.url}\n`);
      break;
    case "markdown":
      await writeStdout(`${markdown}\n`);
      break;
    default: {
      const embedLine = result.embedUrl ? `EMBED: ${result.embedUrl}\n` : "";
      await writeStdout(
        `URL: ${result.url}\n${embedLine}MARKDOWN: ${markdown}${gallery?.url ? `\nGALLERY: ${gallery.url}` : ""}\n`,
      );
    }
  }

  if (gallery?.error) {
    process.stderr.write(
      `warning: upload succeeded but adding it to gallery ${gallery.id} failed: ${gallery.error}\n`,
    );
  }
  if (commentError && ctx.json) {
    // already reported to stderr above; json output stays upload-focused.
  }

  return gallery?.error ? 1 : 0;
}
