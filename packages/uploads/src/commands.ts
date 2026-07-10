import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createUploadsClient, type UploadsClient } from "./client.js";
import {
  parseCommandArgs,
  flagString,
  flagBool,
  flagInt,
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
import { UploadsError } from "./errors.js";
import { writeJson, writeStdout } from "./io.js";
import {
  ghAttachmentKey,
  ghKeyPrefix,
  attachmentsCommentBody,
  type GhTarget,
  type AttachmentItem,
} from "./github.js";
import {
  resolveRepo,
  resolveCurrentPullRequest,
  execRunner,
  upsertAttachmentsComment,
  type CommandRunner,
} from "./github-gh.js";

export interface CliContext {
  config: ResolvedConfig;
  client: UploadsClient;
  json: boolean;
  quiet: boolean;
  envFile?: string;
}

// --- put ---

const PUT_HELP = `uploads put <file> [options]

Upload an image for GitHub embeds. Use "-" for stdin.

Options:
  --key <key>           Object key (default: <prefix>/<repo>/<ref>/<name>-<hash>.<ext>)
  --prefix <path>       Key prefix (default: screenshots, or UPLOADS_DEFAULT_PREFIX)
  --repo <owner/repo>   Repo segment (default: git remote, or UPLOADS_DEFAULT_REPO)
  --ref <id>            PR/issue/branch segment (default: today, or UPLOADS_DEFAULT_REF)
  --alt <text>          Alt text (default: filename)
  --width <px>          <img width=…> markdown (or UPLOADS_DEFAULT_WIDTH)
  --content-type <mime> Override Content-Type
  --no-git              Don't derive --repo from git (or UPLOADS_NO_GIT=1)
  --workspace, -w <name>  Override workspace (wins over UPLOADS_WORKSPACE and token inference)
  --format human|url|markdown|json
  --pr <num>            Attach to a pull request: key gh/<owner>/<repo>/pull/<num>/<name> (stable URL, no hash)
  --issue <num>         Attach to an issue: key gh/<owner>/<repo>/issues/<num>/<name>
  --comment             With --pr/--issue: create/update the attachments comment via your local gh auth

Examples:
  uploads put ./shot.png --repo myorg/myapp --ref 1722 --alt "New cards" --width 700
  uploads --env-file .env put ./shot.png
  uploads --env-file .env put ./after.png --pr 123 --comment
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
function ghTargetFromFlags(flags: CommandFlags["flags"], run: CommandRunner): GhTarget | undefined {
  return makeGhTarget(
    flagInt(flags, "--pr", "--pr"),
    flagInt(flags, "--issue", "--issue"),
    flagString(flags, "--repo"),
    run,
  );
}

/**
 * List every attachment under the target's prefix and create/update the
 * managed comment. Throws on gh failure — callers decide whether that is
 * fatal (`comment` command) or a warning (`put --comment`).
 */
export async function syncAttachmentsComment(
  client: UploadsClient,
  target: GhTarget,
  run: CommandRunner,
): Promise<{ action: "created" | "updated" | "skipped"; count: number }> {
  const items: AttachmentItem[] = (await client.listAll({ prefix: ghKeyPrefix(target) })).map(
    ({ key, url }) => ({ key, url }),
  );

  if (items.length === 0) return { action: "skipped", count: 0 };

  const body = attachmentsCommentBody(items);
  const { created } = upsertAttachmentsComment(target, body, run);
  return { action: created ? "created" : "updated", count: items.length };
}

// --- attach ---

const ATTACH_HELP = `uploads attach <file...> [options]

Upload one or more stable PR/issue attachments and maintain a single GitHub
comment. With no target, uses the pull request for the current branch.

Options:
  --pr <num>            Attach to this pull request
  --issue <num>         Attach to this issue
  --repo <owner/repo>   Repository (default: gh/git inference)
  --no-comment          Upload only; don't create/update the managed comment
  --content-type <mime> Override Content-Type (applied to every file)
  --workspace, -w <name>  Override workspace

Examples:
  uploads attach ./before.png ./after.png
  uploads attach ./shot.png --pr 123 --repo myorg/myapp
  uploads attach ./artifact.zip --issue 45 --no-comment
`;

export async function runAttach(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(ATTACH_HELP);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    process.stderr.write(ATTACH_HELP);
    return 2;
  }
  if (parsed.flags.has("--no-comment") && typeof parsed.flags.get("--no-comment") === "string") {
    throw new UsageError("--no-comment takes no value — place it after the file arguments");
  }

  const explicitTarget = ghTargetFromFlags(parsed.flags, run);
  const target =
    explicitTarget ??
    resolveCurrentPullRequest(resolveRepo(flagString(parsed.flags, "--repo"), run), run);
  const results = [];
  for (const file of parsed.positionals) {
    if (file === "-")
      throw new UsageError("attach does not support stdin; pass one or more file paths");
    const filename = basename(file);
    if (!ctx.quiet && !ctx.json) process.stderr.write(`>> uploading ${file}\n`);
    const result = await ctx.client.put(new Uint8Array(readFileSync(file)), {
      filename,
      key: ghAttachmentKey(target, filename),
      contentType: flagString(parsed.flags, "--content-type"),
    });
    results.push({ ...result, markdown: buildMarkdown(result.url, { alt: filename }) });
  }

  let comment: { action: "created" | "updated" | "skipped"; count: number } | undefined;
  let commentError: string | undefined;
  if (!parsed.flags.has("--no-comment")) {
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
    await writeJson({ target, uploads: results, comment, commentError });
  } else {
    for (const result of results) {
      await writeStdout(`URL: ${result.url}\nMARKDOWN: ${result.markdown}\n`);
    }
    if (!ctx.quiet && comment) process.stderr.write(`>> attachments comment ${comment.action}\n`);
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
    process.stderr.write(PUT_HELP);
    return 0;
  }
  const parsed = parseCommandArgs(args);
  if (parsed.help) {
    process.stderr.write(PUT_HELP);
    return 0;
  }

  const fileArg = parsed.positionals[0];
  if (!fileArg) {
    process.stderr.write(PUT_HELP);
    return 2;
  }

  const keyHint = flagString(parsed.flags, "--key");
  const ghTarget = ghTargetFromFlags(parsed.flags, run);
  const wantComment = parsed.flags.has("--comment");
  if (wantComment && typeof parsed.flags.get("--comment") === "string") {
    throw new UsageError("--comment takes no value — place it after the file argument");
  }
  if (wantComment && !ghTarget) throw new UsageError("--comment requires --pr or --issue");
  if (ghTarget) {
    if (keyHint) throw new UsageError("--key cannot be combined with --pr/--issue");
    if (flagString(parsed.flags, "--ref")) {
      throw new UsageError("--ref cannot be combined with --pr/--issue");
    }
    if (flagString(parsed.flags, "--prefix")) {
      throw new UsageError("--prefix cannot be combined with --pr/--issue");
    }
  }
  const bytes =
    fileArg === "-" ? new Uint8Array(readFileSync(0)) : new Uint8Array(readFileSync(fileArg));
  const filename =
    fileArg === "-" ? (keyHint ? basename(keyHint) : "stdin.bin") : basename(fileArg);

  const format = ctx.json
    ? "json"
    : (() => {
        const raw = flagString(parsed.flags, "--format");
        if (!raw || raw === "human") return "human" as const;
        if (raw === "url" || raw === "markdown" || raw === "json") return raw;
        throw new UsageError(`invalid --format: ${raw}`);
      })();

  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
  const alt = flagString(parsed.flags, "--alt") ?? basename(filename);
  const widthRaw = flagString(parsed.flags, "--width");
  const width =
    widthRaw && /^\d+$/.test(widthRaw) && Number(widthRaw) > 0
      ? Number.parseInt(widthRaw, 10)
      : widthRaw
        ? (() => {
            throw new UsageError(`invalid --width: ${widthRaw}`);
          })()
        : defaults.width;

  if (!ctx.quiet && format === "human") {
    process.stderr.write(`>> uploading ${fileArg === "-" ? "stdin" : fileArg}\n`);
  }

  const noGit = flagBool(parsed.flags, "--no-git") || defaults.noGit === true;
  const result = await ctx.client.put(bytes, {
    filename,
    key: ghTarget ? ghAttachmentKey(ghTarget, filename) : keyHint,
    prefix: flagString(parsed.flags, "--prefix") ?? defaults.prefix,
    repo: flagString(parsed.flags, "--repo") ?? defaults.repo,
    ref: flagString(parsed.flags, "--ref") ?? defaults.ref,
    contentType: flagString(parsed.flags, "--content-type"),
    deriveRepoFromGit: !noGit,
  });

  const markdown = buildMarkdown(result.url, { alt, width });

  if (!ctx.quiet && format === "human") {
    process.stderr.write(`>> key: ${result.key}\n\n`);
  }

  switch (format) {
    case "json":
      await writeJson({ ...result, markdown });
      break;
    case "url":
      await writeStdout(`${result.url}\n`);
      break;
    case "markdown":
      await writeStdout(`${markdown}\n`);
      break;
    default:
      await writeStdout(`URL: ${result.url}\nMARKDOWN: ${markdown}\n`);
  }

  if (wantComment && ghTarget) {
    try {
      const sync = await syncAttachmentsComment(ctx.client, ghTarget, run);
      if (!ctx.quiet && format === "human") {
        process.stderr.write(`>> attachments comment ${sync.action}\n`);
      }
    } catch (err) {
      // Upload already succeeded; the comment is best-effort by design.
      process.stderr.write(
        `warning: upload succeeded but the GitHub comment failed (is gh installed and authenticated?): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return 0;
}

// --- list ---

const LIST_HELP = `uploads list [--prefix <p>] [--pr <num> | --issue <num>] [--repo <owner/name>] [--limit <n>] [--cursor <c>] [--all] [--workspace <name>]

Default prefix: UPLOADS_DEFAULT_PREFIX (screenshots if unset).

Examples:
  uploads list --prefix screenshots/
  uploads list --pr 123
  uploads list --all --json
`;

export async function runList(
  ctx: CliContext,
  args: string[],
  help = false,
  run: CommandRunner = execRunner,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(LIST_HELP);
    return 0;
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

// --- delete ---

const DELETE_HELP = `uploads delete <key> [--dry-run] [--workspace <name>]

Examples:
  uploads delete screenshots/myapp/42/shot-a1b2c3.png
`;

export async function runDelete(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(DELETE_HELP);
    return 0;
  }
  const key = parsed.positionals[0];
  if (!key) {
    process.stderr.write(DELETE_HELP);
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
listing everything uploaded for it. Uses your local gh auth. Finds its own
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
    process.stderr.write(COMMENT_HELP);
    return 0;
  }
  const target = ghTargetFromFlags(parsed.flags, run);
  if (!target) throw new UsageError("comment requires --pr or --issue");

  const result = await syncAttachmentsComment(ctx.client, target, run);
  if (ctx.json) {
    await writeJson({ ...target, ...result });
  } else if (!ctx.quiet) {
    process.stderr.write(
      result.action === "skipped"
        ? `no attachments under ${ghKeyPrefix(target)} — nothing to do\n`
        : `${result.action} attachments comment on ${target.repo}#${target.num} (${result.count} file${result.count === 1 ? "" : "s"})\n`,
    );
  }
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
    process.stderr.write(HEALTH_HELP);
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
`;

export interface DoctorReport {
  ok: boolean;
  apiUrl: string;
  workspace: string;
  workspaceSource: ResolvedConfig["workspaceSource"];
  workspaceFromToken: string | undefined;
  configPath: string;
  configExists: boolean;
  health: { ok: boolean };
  auth: { ok: boolean; error: string | undefined };
  /** Workspace/token mismatch warning (also present in hints). */
  warning?: string;
  hints: string[];
}

/** Doctor's health + auth + workspace checks, shared by the CLI and the MCP tool. */
export async function buildDoctorReport(
  config: ResolvedConfig,
  client: UploadsClient,
): Promise<DoctorReport> {
  const mismatch = workspaceMismatch(config);
  const hints: string[] = [];
  if (mismatch) hints.push(mismatch);
  if (config.apiUrl.includes("localhost") || config.apiUrl.includes("127.0.0.1")) {
    hints.push("local API uses dev KV — prod tokens won't work unless minted with --local");
  }

  const health = await client.health();
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

  if (!config.configExists && !config.token) {
    hints.push(`run uploads setup to configure ${config.configPath}`);
  }

  return {
    ok: health.ok && authOk,
    apiUrl: config.apiUrl,
    workspace: config.workspace,
    workspaceSource: config.workspaceSource,
    workspaceFromToken: workspaceFromToken(config.token),
    configPath: config.configPath,
    configExists: config.configExists,
    health,
    auth: { ok: authOk, error: authError },
    warning: mismatch,
    hints,
  };
}

export async function runDoctor(ctx: CliContext, args: string[], help = false): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    process.stderr.write(DOCTOR_HELP);
    return 0;
  }

  const report = await buildDoctorReport(ctx.config, ctx.client);

  if (ctx.json) {
    await writeJson(report);
    return report.ok ? 0 : 1;
  }

  const lines = [
    `config:    ${report.configPath}${report.configExists ? "" : " (missing)"}`,
    `api:       ${report.apiUrl} (${report.health.ok ? "ok" : "failed"})`,
    `workspace: ${report.workspace}`,
    `auth:      ${report.auth.ok ? "ok" : `failed — ${report.auth.error ?? "no token"}`}`,
  ];
  if (report.warning) lines.push(`warning:   ${report.warning}`);
  for (const h of report.hints) if (h !== report.warning) lines.push(`hint:      ${h}`);
  await writeStdout(lines.join("\n") + "\n");
  return report.ok ? 0 : 1;
}
