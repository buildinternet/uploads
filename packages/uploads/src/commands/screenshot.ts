import { readFileSync, writeFileSync } from "node:fs";
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
  branchFromFlags,
  derivedMetaEnabled,
  frameOptionsFromFlags,
  ghTargetFromFlags,
  optimizeOptionsFromFlags,
  stateAppMetaFromFlags,
  warnNearMissMeta,
  syncAttachmentsComment,
  commentViaSuffix,
  heldNote,
  type AttachmentsCommentResult,
  uploadPreparedImage,
  type CliContext,
  resolvePutStagingTarget,
  putStagingNoteText,
  resolveStageBindingWarning,
  mergeStagingMeta,
  registerRenamesBestEffort,
  writeReplacedNote,
  resolveGhPrefixSafe,
  resolveAutoPrTarget,
  resolvePutNudgeContext,
  putNudgeText,
  autoPrNoteText,
  type BranchTarget,
  routeRepoTargetWorkspace,
  routeToRepoWorkspace,
} from "../commands.js";
import { resolvePutDefaults } from "../config.js";
import { loadDefaultsRaw } from "../config-file.js";
import { resolvePutPrefix } from "../destinations.js";
import {
  execRunner,
  ghMetadataFromTargetWithTitle,
  resolveRepo,
  upstreamGone,
  type CommandRunner,
} from "../github-gh.js";
import { deriveRepoSlugFromGit } from "../keys.js";
import { noProjectContextNudge } from "../project-context-nudge.js";
import { safeCaptureFacts } from "../capture-facts.js";
import { parseMetaFlags, validateMetaMap } from "../metadata.js";
import { mergeDerivedMeta } from "../metadata-vocab.js";
import { writeSidecarMeta } from "../sidecar.js";
import { writeJson, writeStdout } from "../io.js";
import {
  assertHideSelector,
  captureScreenshot,
  clipHintText,
  DEFAULT_FULL_PAGE_MAX_HEIGHT,
  parseViewport,
  parseWaitUntil,
  remoteBackendRemovedError,
} from "../screenshot.js";

const SCREENSHOT_HELP = `uploads screenshot <target> [options]

Capture a URL or a local .html file and host it — a hosted, PR-embeddable
image in one step. target is an http(s) URL or a path to an .html file.

Captures run in an already-installed Chrome/Chromium via playwright-core (no
browser download), so localhost and private-network URLs work.

The object name is derived from the target URL (host + path), not chosen by
you — e.g. https://app.example/settings becomes app.example-settings.png.
--state folds into that derived name (a -before/-after/... suffix), so
capturing the same URL with --state before then --state after produces two
distinct objects instead of the second silently overwriting the first.
Re-capturing the same URL + --state on a PR or branch-staged (gh/) key
replaces that object in place — the intended idempotency for repeat
captures. --key bypasses all of this and sets the whole object key verbatim
(no folding). A --key or dated screenshots/ key that already exists is
refused unless you pass --replace (or set UPLOADS_OVERWRITE=1), same as put.

After capture, screenshots share the put upload pipeline: optional --frame,
optimize-by-default, --pr/--issue attachment + --comment, --gallery, --meta.

Auto-PR context (issue #700): with no --pr/--issue/--branch/--key/--ref/
--prefix/--destination, a screenshot taken on a branch that maps to exactly
one open PR behaves as if --pr <n> had been passed — stable gh/ key, managed
comment sync (with --comment) — instead of branch staging below. A one-line
note announces this. Opt out with --no-pr, UPLOADS_NO_AUTO_PR=1, or config
UPLOADS_NO_AUTO_PR=1; never fires outside a git repo, on the default branch,
with --no-git, or when no single open PR can be resolved.

Branch staging by default (pre-PR): when auto-PR above doesn't apply and none
of --pr/--issue/--branch/--key/--ref/--prefix/--destination is given, a
screenshot taken on a non-default git branch stages under
gh/<owner>/<repo>/branch/<branch>/<name> instead of the dated
screenshots/<repo>/<date>/... layout — same key/metadata as an explicit
--branch, carrying every derived fact (path/url/env/viewport, --state) along.
Staged files auto-attach with full metadata the first time you attach to that
branch's PR once it opens (or run "uploads attach --promote"). Use --no-git,
or an explicit --ref/--prefix, to opt back into the dated layout.

Options:
  --browser <path>          Explicit local browser executable (or UPLOADS_CHROME_PATH / CHROME_PATH)
  --cdp <endpoint>          Attach to a running Chrome via CDP (http://host:port or ws://…)
  --viewport <WxH[@Sx]>     Size + device scale factor (default: 1280x800@2)
  --selector <css>          Capture one element instead of the viewport
  --full-page               Capture the full scrollable page
  --max-height <px>         Cap on full-page capture height in CSS px (default: ${DEFAULT_FULL_PAGE_MAX_HEIGHT},
                            or 0 for uncapped). A page over the cap is clipped, with a note printed
                            to stderr and a --format json \`hint\`. Requires --full-page.
  --dark / --light          Emulate prefers-color-scheme
  --wait <load|domcontentloaded|networkidle|ms>  Settle strategy (default: load), or a
                            millisecond delay
  --hide <css>              Hide matching elements before capture (repeatable)
  --redact <css>            Black out matching elements before capture (repeatable), e.g. an API
                            key or an email address. Fails if a selector matches nothing.
  --no-hide-dev-tools       Don't auto-hide framework dev toolbars (auto-hidden on localhost/private)
  --reduced-motion          Emulate prefers-reduced-motion: reduce so animations settle
  --wait-for <js>           Poll this JS expression in the page until truthy before --eval and
                            capture. Bridges framework hydration: load/
                            networkidle settle before React/Next attach handlers, so a synthetic
                            click in --eval hits the inert server-rendered DOM. Express the app's
                            own "interactive" signal, e.g. --wait-for 'window.__hydrated===true' or
                            --wait-for 'document.querySelector("[data-hydrated]")'. Times out with
                            the capture timeout if it never becomes truthy.
  --eval <js>               Run JS in the page after settle, before capture.
                            Note: synthetic events (el.click()) won't reach framework handlers
                            until the app hydrates — pair with --wait-for on React/Next apps.
  --init-script <file>      Inject a JS file before navigation
  --out <file>              Also write the PNG to a local file. Also writes a sidecar manifest,
                            <file>.uploads.json, recording this capture's derived metadata
                            (path/url/env/viewport, plus --state if given) with a content hash; a
                            later \`put\`/\`attach\` of this exact file picks the metadata back up
                            automatically (explicit --meta/--state still win). See --no-sidecar.
  --no-sidecar              Don't write the <file>.uploads.json sidecar alongside --out
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
  --no-pr                   Skip auto-PR context (or UPLOADS_NO_AUTO_PR=1) — see above
  --pr <num>                Attach to a pull request (stable URL, no hash)
  --issue <num>             Attach to an issue
  --branch [name]           Stage against a branch, pre-PR (default: current git branch):
                             key gh/<owner>/<repo>/branch/<branch>/<name>; not with
                             --pr/--issue/--comment/--key/--ref/--prefix. No managed
                             comment exists yet — promoting into the PR's comment once
                             one opens ships in a later phase.
  --comment                 With --pr/--issue: update the managed attachments comment.
                             Posts as uploads-sh[bot] when the GitHub App is installed;
                             otherwise via local gh.
  --gallery <id>            Add the uploaded object to this public gallery
  --meta <k=v>              Queryable custom metadata (repeatable)
  --state <s>               before|after|empty|error|loading — the UI state shown
  --app <name>              Surface shown: web, ios, android, cli
  --screen <name>           App screen shown when there's no route, e.g. "Chat"
  --caption <text>          What the shot shows, up to 140 characters (PR comment caption)
  --workspace, -w <name>    Override workspace
  --replace                 Allow overwriting an existing object on a strict (--key/default) key
                            (or UPLOADS_OVERWRITE=1). No effect on --pr/--issue/--branch keys,
                            which always overwrite.
  --dry-run                 Capture + resolve key/URL without uploading
  --format human|url|markdown|json

Exit codes: 0 ok · 2 usage/no browser found/file · 3 auth/policy/budget · 4 network · 1 other.

Examples:
  uploads screenshot https://uploads.sh
  uploads screenshot ./card.html --out ./card.png
  uploads screenshot https://app.example/settings --selector main --dark
  uploads screenshot http://localhost:3000 --full-page
  uploads screenshot https://uploads.sh --pr 128 --comment
  uploads screenshot ./card.html --no-upload --out ./card.png
  uploads screenshot https://app.example/settings --branch
  uploads screenshot http://localhost:3000/settings --redact '[data-testid=api-key]'
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

function assertViaFlag(flags: ReturnType<typeof parseCommandArgs>["flags"]): void {
  const raw = flagString(flags, "--via");
  if (raw === undefined || raw === "auto" || raw === "local") return;
  if (raw === "remote") throw remoteBackendRemovedError();
  throw new UsageError(`invalid --via: ${raw} (use auto or local)`);
}

export async function runScreenshot(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
  /** Injectable for tests — avoids launching a real browser. */
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
    throw new UsageError("screenshot requires a target URL or .html file", {
      example: "uploads screenshot http://localhost:4321/settings --out settings.png",
    });
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError("screenshot takes exactly one target");
  }

  const rawDefaults = loadDefaultsRaw({ envFile: ctx.envFile });
  // --via is validated only: the local browser is the sole backend now, and
  // `--via remote` fails with a pointer to install Chrome.
  assertViaFlag(parsed.flags);
  const browserPath = flagString(parsed.flags, "--browser");
  const cdp = flagString(parsed.flags, "--cdp");
  const viewport = parseViewport(flagString(parsed.flags, "--viewport"));
  const selector = flagString(parsed.flags, "--selector");
  const fullPage = flagBool(parsed.flags, "--full-page");
  // Unlike every other --…-px flag, 0 is a valid (uncapped) value here, not
  // an error — flagInt's allowZero option covers it.
  const maxHeightFlag = flagInt(parsed.flags, "--max-height", "--max-height", {
    allowZero: true,
  });
  if (maxHeightFlag !== undefined && !fullPage) {
    throw new UsageError("--max-height requires --full-page");
  }
  const colorScheme = colorSchemeFromFlags(parsed.flags);
  const waitUntil = parseWaitUntil(flagString(parsed.flags, "--wait"));

  const hide = flagValues(parsed.flags, "--hide");
  // Fail fast before capture, using the shared policy (throws UploadsError
  // code USAGE → exit 2, same as UsageError) so there's one source of truth.
  for (const sel of hide) assertHideSelector(sel);
  const redact = flagValues(parsed.flags, "--redact");
  for (const sel of redact) assertHideSelector(sel, "redact");
  // --no-hide-dev-tools opts out of auto-hiding framework toolbars; undefined
  // lets captureScreenshot apply its localhost-aware default.
  const hideDevTools = flagBool(parsed.flags, "--no-hide-dev-tools") ? false : undefined;
  const reducedMotion = flagBool(parsed.flags, "--reduced-motion");
  const waitForExpr = flagString(parsed.flags, "--wait-for");
  const evalJs = flagString(parsed.flags, "--eval");
  const initScriptPath = flagString(parsed.flags, "--init-script");
  let initScript: string | undefined;
  if (initScriptPath !== undefined) {
    try {
      initScript = readFileSync(initScriptPath, "utf8");
    } catch (err) {
      throw new UsageError(
        `could not read --init-script ${initScriptPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const outFile = flagString(parsed.flags, "--out");
  const noUpload = flagBool(parsed.flags, "--no-upload");
  if (noUpload && !outFile) throw new UsageError("--no-upload requires --out");
  const noSidecar = flagBool(parsed.flags, "--no-sidecar");
  if (noSidecar && !outFile) throw new UsageError("--no-sidecar requires --out");

  const keyHint = flagString(parsed.flags, "--key");
  const destFlag = flagString(parsed.flags, "--destination");
  const prefixFlag = flagString(parsed.flags, "--prefix");
  const ghTarget = ghTargetFromFlags(parsed.flags, run);
  const branchArg = branchFromFlags(parsed.flags, run);
  const wantComment = parsed.flags.has("--comment");
  const galleryId = flagString(parsed.flags, "--gallery");
  const dryRun = flagBool(parsed.flags, "--dry-run");
  // Strict-overwrite escape hatch (issue #174), same as put: only matters on
  // non-gh/ keys (--key or the dated default) — managed gh/ paths always
  // hot-swap server-side regardless (issue #1029).
  const replaceFlag = flagBool(parsed.flags, "--replace") || process.env.UPLOADS_OVERWRITE === "1";

  if (branchArg !== undefined && ghTarget) {
    throw new UsageError("--branch cannot be combined with --pr/--issue");
  }
  if (wantComment && !ghTarget) throw new UsageError("--comment requires --pr or --issue");
  if (ghTarget) {
    if (keyHint) throw new UsageError("--key cannot be combined with --pr/--issue");
    if (flagString(parsed.flags, "--ref"))
      throw new UsageError("--ref cannot be combined with --pr/--issue");
    if (prefixFlag) throw new UsageError("--prefix cannot be combined with --pr/--issue");
  }
  if (branchArg !== undefined) {
    if (wantComment) throw new UsageError("--branch cannot be combined with --comment");
    if (keyHint) throw new UsageError("--key cannot be combined with --branch");
    if (flagString(parsed.flags, "--ref"))
      throw new UsageError("--ref cannot be combined with --branch");
    if (prefixFlag) throw new UsageError("--prefix cannot be combined with --branch");
  }
  if (dryRun) {
    if (wantComment) throw new UsageError("--dry-run cannot be combined with --comment");
    if (galleryId) throw new UsageError("--dry-run cannot be combined with --gallery");
    if (noUpload) throw new UsageError("--dry-run cannot be combined with --no-upload");
  }

  const putDefaults = resolvePutDefaults({ envFile: ctx.envFile }, rawDefaults);
  const noGit = flagBool(parsed.flags, "--no-git") || putDefaults.noGit === true;
  if (parsed.flags.has("--no-pr") && typeof parsed.flags.get("--no-pr") === "string") {
    throw new UsageError("--no-pr takes no value");
  }
  const noAutoPr = flagBool(parsed.flags, "--no-pr") || putDefaults.noAutoPr === true;

  const branchRepo =
    branchArg !== undefined ? resolveRepo(flagString(parsed.flags, "--repo"), run) : undefined;

  // Auto-PR context (issue #700): when no --branch/--pr/--issue/--key/--ref/
  // --prefix/--destination is given, git use isn't disabled, and --no-pr/
  // UPLOADS_NO_AUTO_PR hasn't opted out, a screenshot taken on a branch that
  // maps to exactly one open PR behaves as if --pr <n> had been passed —
  // stable key + managed comment sync — instead of the #469 auto-staging
  // default below. Mirrors put's #700 handling exactly (resolveAutoPrTarget).
  const autoPrMatch =
    ghTarget || branchArg !== undefined
      ? undefined
      : resolveAutoPrTarget({
          ghTarget,
          keyHint,
          refArg: flagString(parsed.flags, "--ref"),
          prefixArg: prefixFlag,
          destinationArg: destFlag,
          branchArg,
          noGit,
          noAutoPr,
          repoArg: flagString(parsed.flags, "--repo") ?? putDefaults.repo,
          run,
        });
  const autoPrTarget = autoPrMatch?.target;
  const effectiveGhTarget = ghTarget ?? autoPrTarget;

  // Auto branch staging (issue #469 lever 1): mirrors bare `put`'s auto-staging
  // (issue #403). When no --branch/--pr/--issue/--key/--ref/--prefix/--destination
  // is given and git use isn't disabled, a screenshot taken on a non-default
  // git branch stages the same way explicit `--branch`/bare `put` do — same
  // key shape, same gh.* metadata — instead of landing on the dated
  // `screenshots/<repo>/<date>/...` layout. This is what lets derived
  // metadata (path/url/env/viewport, --state) ride through to PR-open
  // promotion when the capture happens before the PR exists. Skipped
  // entirely when --branch was given explicitly (already handled above), or
  // when the #700 auto-PR match above already took over.
  const autoStagingTarget: BranchTarget | undefined =
    branchArg === undefined
      ? resolvePutStagingTarget({
          ghTarget: effectiveGhTarget,
          keyHint,
          refArg: flagString(parsed.flags, "--ref"),
          prefixArg: prefixFlag,
          destinationArg: destFlag,
          noGit,
          repoArg: flagString(parsed.flags, "--repo") ?? putDefaults.repo,
          run,
        })
      : undefined;
  const stagingTarget: BranchTarget | undefined =
    branchArg !== undefined ? { repo: branchRepo!, branch: branchArg } : autoStagingTarget;

  let resolvedPrefix: string | undefined;
  try {
    resolvedPrefix = resolvePutPrefix({
      destination: destFlag,
      prefix: prefixFlag,
      key: keyHint,
      ghAttachment: Boolean(effectiveGhTarget) || stagingTarget !== undefined,
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

  const optimizeOpts = optimizeOptionsFromFlags(parsed.flags, putDefaults);
  const frameOpts = frameOptionsFromFlags(parsed.flags);
  const altFlag = flagString(parsed.flags, "--alt");
  const width = flagInt(parsed.flags, "--width", "--width") ?? putDefaults.width;

  const metaExtras = warnNearMissMeta(ctx, parseMetaFlags(flagValues(parsed.flags, "--meta")));
  // Explicit input (--meta plus the dedicated flags) wins over capture facts.
  const explicitMeta = { ...metaExtras, ...stateAppMetaFromFlags(parsed.flags) };
  const deriveMeta = derivedMetaEnabled(parsed.flags, putDefaults);
  const repoSlug = deriveMeta && !noGit ? deriveRepoSlugFromGit(run) : undefined;
  const withFacts = mergeDerivedMeta(explicitMeta, {
    ...(deriveMeta ? safeCaptureFacts(target, viewport, colorScheme) : {}),
    ...(repoSlug ? { repo: repoSlug } : {}),
  });

  // Same routing as `put`: repo captures go to the repo's workspace when this
  // account can reach it, and `--comment` refuses when it can't.
  if (!dryRun && !noUpload) {
    if (effectiveGhTarget && wantComment) await routeRepoTargetWorkspace(ctx, effectiveGhTarget);
    else {
      const repo = effectiveGhTarget?.repo ?? stagingTarget?.repo;
      if (repo) await routeToRepoWorkspace(ctx, repo);
    }
  }

  let metadata: Record<string, string> | undefined = withFacts;
  if (effectiveGhTarget) {
    metadata = { ...withFacts, ...ghMetadataFromTargetWithTitle(effectiveGhTarget, run) };
    validateMetaMap(metadata);
    // The #700 auto-PR match suppresses staging, so the staging branch below
    // never runs — but this capture still comes from a branch that may have
    // been renamed while files were staged under the old name. Register the
    // lineage here too (issue #920), reusing the branch the match already
    // resolved. Only for the auto-PR match: an explicit --pr/--issue names
    // no branch of its own.
    if (autoPrMatch && !dryRun && !noUpload) {
      await registerRenamesBestEffort(ctx.client, run, autoPrMatch.target.repo, autoPrMatch.branch);
    }
  } else if (stagingTarget !== undefined) {
    metadata = mergeStagingMeta(withFacts, stagingTarget);
    // Same rename registration as `put`/`attach --branch` staging (issue
    // #920): best-effort, never fails the capture.
    if (!dryRun && !noUpload) {
      await registerRenamesBestEffort(ctx.client, run, stagingTarget.repo, stagingTarget.branch);
    }
  } else if (Object.keys(withFacts).length > 0) {
    validateMetaMap(withFacts);
  }

  // #692 follow-up: same advisory as put — a capture with no repo/app context
  // and only a local origin lands in the screenshots page's fallback buckets.
  const contextNudge =
    !ctx.quiet && !putDefaults.noNudge && !noGit ? noProjectContextNudge(metadata) : undefined;

  const logHuman = !ctx.quiet && format === "human";
  if (logHuman) process.stderr.write(`>> capturing ${target}\n`);

  const captured = await captureImpl({
    target,
    browserPath,
    cdp,
    viewport,
    selector,
    fullPage,
    maxHeight: maxHeightFlag,
    colorScheme,
    waitUntil,
    hide,
    redact,
    hideDevTools,
    reducedMotion,
    waitForExpr,
    evalJs,
    initScript,
    // Skip folding when an explicit --key was given — --key sets the whole
    // key, so there's no auto-derived name to fold state into.
    state: keyHint ? undefined : explicitMeta.state,
  });

  if (logHuman) process.stderr.write(">> captured\n");

  // Full-page height cap note (issue #652): printed regardless of --format
  // (only --quiet suppresses it) since it's directly actionable info about
  // the image that was just captured, same as the upload-tail warnings below.
  const clipHint = captured.capped?.clipped
    ? clipHintText(captured.capped.maxHeightPx, "--max-height")
    : undefined;
  if (clipHint && !ctx.quiet) process.stderr.write(`${clipHint}\n`);

  const finalPng: Uint8Array = captured.png;

  if (outFile) {
    writeFileSync(outFile, finalPng);
    if (logHuman) process.stderr.write(`>> wrote ${outFile}\n`);
    if (!noSidecar) writeSidecarMeta(outFile, finalPng, withFacts);
  }

  if (noUpload) {
    if (ctx.json) {
      await writeJson({ file: outFile, backend: captured.backend, size: finalPng.byteLength });
    } else {
      await writeStdout(`FILE: ${outFile}\n`);
    }
    return 0;
  }

  const repo = flagString(parsed.flags, "--repo") ?? putDefaults.repo;
  const ref = flagString(parsed.flags, "--ref") ?? putDefaults.ref;
  // Resolved once (issue #631), only when it's actually needed for the
  // upload about to happen (never for the noUpload/no-target bailouts
  // above) — never per file (screenshot only ever uploads one).
  const ghPrefix = effectiveGhTarget
    ? await resolveGhPrefixSafe(ctx.client, {
        repo: effectiveGhTarget.repo,
        target: { kind: effectiveGhTarget.kind, num: effectiveGhTarget.num },
      })
    : stagingTarget !== undefined
      ? await resolveGhPrefixSafe(ctx.client, {
          repo: stagingTarget.repo,
          branch: stagingTarget.branch,
        })
      : undefined;

  // Bare-screenshot nudge context (issue #393/#700): only relevant when
  // neither auto-PR nor staging took over — mirrors put's handling exactly.
  // Resolved before upload; finished into text below once the key is known.
  const nudgeContext =
    effectiveGhTarget || stagingTarget
      ? undefined
      : resolvePutNudgeContext({
          quiet: ctx.quiet,
          noNudge: putDefaults.noNudge === true,
          ghTarget,
          keyHint,
          hasBranchFlag: branchArg !== undefined,
          noGit,
          repoArg: flagString(parsed.flags, "--repo") ?? putDefaults.repo,
          run,
        });
  const autoPrNote =
    autoPrTarget && !ctx.quiet && !putDefaults.noNudge
      ? autoPrNoteText(autoPrTarget.num)
      : undefined;

  const alt = altFlag ?? basename(captured.filename);
  const { result, prepared, markdown } = await uploadPreparedImage(
    ctx.client,
    finalPng,
    captured.filename,
    {
      frame: frameOpts,
      optimize: optimizeOpts,
      ghTarget: effectiveGhTarget,
      ghBranchTarget: stagingTarget,
      ghPrefix,
      key: keyHint,
      prefix: resolvedPrefix ?? putDefaults.prefix,
      repo,
      ref,
      deriveRepoFromGit: !noGit,
      dryRun,
      replace: replaceFlag,
      metadata,
      provenanceClient: "uploads-cli-screenshot",
      alt: () => alt,
      width,
    },
  );

  // Staging note (issue #469 lever 1, mirrors #403's bare-put note): only for
  // the auto-staged case — explicit `--branch` keeps its own "staged: these
  // auto-attach..." wording below. Same suppression as put's note (--quiet,
  // UPLOADS_NO_NUDGE=1).
  const stagingNote =
    autoStagingTarget && !ctx.quiet && !putDefaults.noNudge
      ? putStagingNoteText(autoStagingTarget.branch, upstreamGone(run, autoStagingTarget.branch))
      : undefined;
  // Stage-time binding warning (issue #398), same check bare put/attach
  // --branch run, now also reachable from screenshot's staging paths
  // (explicit --branch and auto-staging alike).
  const bindingWarning =
    stagingTarget !== undefined
      ? await resolveStageBindingWarning({ ctx, defaults: putDefaults, repo: stagingTarget.repo })
      : undefined;

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

  // Concrete bare-screenshot nudge text (issue #700): built once the upload
  // key exists, so the ready-made follow-up names it verbatim.
  const nudge = nudgeContext
    ? putNudgeText(nudgeContext.branch, nudgeContext.pr, [result.key])
    : undefined;

  let comment: AttachmentsCommentResult | undefined;
  let commentError: string | undefined;
  if (wantComment && effectiveGhTarget) {
    try {
      comment = await syncAttachmentsComment(
        ctx.client,
        effectiveGhTarget,
        run,
        ctx.config.workspace,
      );
      if (logHuman)
        process.stderr.write(
          `>> attachments comment ${comment.action}${commentViaSuffix(comment.via)}\n${heldNote(comment)}`,
        );
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
    writeReplacedNote(result.replaced, ctx.quiet, dryRun, result.wouldRefuse);
    process.stderr.write(`>> key: ${result.key}${dryRun ? " (dry run — not uploaded)" : ""}\n`);
    if (stagingTarget !== undefined) {
      process.stderr.write(
        `>> find these later: uploads find gh.branch=${stagingTarget.branch.toLowerCase()}\n`,
      );
      if (autoStagingTarget) {
        if (stagingNote) process.stderr.write(`${stagingNote}\n`);
      } else {
        process.stderr.write(
          `>> staged: these auto-attach to this branch's PR when it opens ` +
            `(or run \`uploads attach --promote\` after opening)\n`,
        );
      }
    }
    if (autoPrNote) process.stderr.write(`${autoPrNote}\n`);
    if (nudge) process.stderr.write(`${nudge}\n`);
    if (bindingWarning) process.stderr.write(`${bindingWarning}\n`);
    if (contextNudge) process.stderr.write(`${contextNudge}\n`);
    process.stderr.write("\n");
  }

  // One JSON `hint` slot (mirrors bare put): the clip note (issue #652) wins
  // first — it's about the just-captured image itself, more immediately
  // actionable than the other three, which are about upload/staging
  // mechanics. Then the auto-PR note and the #393/#700 nudge (issue #700),
  // then the binding warning, more actionable than the generic staging note;
  // a replaced-object note (issue #618) is lowest priority — it only
  // surfaces when nothing else already claimed the slot. Since state folds
  // into the derived key, replaced + state means a same-side re-capture,
  // which is the intended replace-in-place flow — word it as informational,
  // not as a problem.
  const replacedHint =
    result.replaced && explicitMeta.state
      ? `re-capture replaced the previous state=${explicitMeta.state} object at ${result.key} — expected for repeat captures of the same URL + state`
      : undefined;
  const jsonHint =
    clipHint ??
    autoPrNote ??
    nudge ??
    bindingWarning ??
    stagingNote ??
    replacedHint ??
    contextNudge;

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
        ...(jsonHint ? { hint: jsonHint } : {}),
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
