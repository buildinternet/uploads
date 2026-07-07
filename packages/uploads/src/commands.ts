import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createUploadsClient, type UploadsClient } from "./client.js";
import {
  parseCommandArgs,
  flagString,
  flagBool,
  flagInt,
  UsageError,
} from "./cli-args.js";
import {
  resolvePutDefaults,
  workspaceMismatch,
  workspaceFromToken,
  type ResolvedConfig,
} from "./config.js";
import { buildMarkdown } from "./embed.js";
import { UploadsError } from "./errors.js";

export interface CliContext {
  config: ResolvedConfig;
  client: UploadsClient;
  json: boolean;
  quiet: boolean;
  envFile?: string;
}

async function writeStdout(text: string): Promise<void> {
  if (!process.stdout.write(text)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
}

async function writeJson(value: unknown): Promise<void> {
  await writeStdout(JSON.stringify(value, null, 2) + "\n");
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

Examples:
  uploads put ./shot.png --repo myorg/myapp --ref 1722 --alt "New cards" --width 700
  uploads --env-file .env put ./shot.png
`;

export async function runPut(ctx: CliContext, args: string[], help = false): Promise<number> {
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
  const bytes =
    fileArg === "-"
      ? new Uint8Array(readFileSync(0))
      : new Uint8Array(readFileSync(fileArg));
  const filename = fileArg === "-" ? (keyHint ? basename(keyHint) : "stdin.bin") : basename(fileArg);

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
    key: keyHint,
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
  return 0;
}

// --- list ---

const LIST_HELP = `uploads list [--prefix <p>] [--limit <n>] [--cursor <c>] [--all] [--workspace <name>]

Default prefix: UPLOADS_DEFAULT_PREFIX (screenshots if unset).

Examples:
  uploads list --prefix screenshots/
  uploads list --all --json
`;

export async function runList(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(LIST_HELP);
    return 0;
  }
  const defaults = resolvePutDefaults({ envFile: ctx.envFile });
  const prefixFlag = flagString(parsed.flags, "--prefix");
  const prefix = prefixFlag ?? (defaults.prefix ? `${defaults.prefix}/` : undefined);
  const limit = flagInt(parsed.flags, "--limit", "--limit");
  const cursor = flagString(parsed.flags, "--cursor");

  if (flagBool(parsed.flags, "--all")) {
    const items = [];
    let next: string | null | undefined = cursor;
    do {
      const page = await ctx.client.list({ prefix, limit, cursor: next ?? undefined });
      items.push(...page.items);
      next = page.cursor;
    } while (next);
    if (ctx.json) await writeJson({ items, cursor: null });
    else for (const item of items) await writeStdout(`${item.key}${item.url ? `  ${item.url}` : ""}\n`);
    return 0;
  }

  const result = await ctx.client.list({ prefix, limit, cursor });
  if (ctx.json) await writeJson(result);
  else {
    for (const item of result.items) await writeStdout(`${item.key}${item.url ? `  ${item.url}` : ""}\n`);
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

export async function runDoctor(ctx: CliContext, args: string[], help = false): Promise<number> {
  if (help || parseCommandArgs(args).help) {
    process.stderr.write(DOCTOR_HELP);
    return 0;
  }

  const mismatch = workspaceMismatch(ctx.config);
  const hints: string[] = [];
  if (mismatch) hints.push(mismatch);
  if (ctx.config.apiUrl.includes("localhost") || ctx.config.apiUrl.includes("127.0.0.1")) {
    hints.push("local API uses dev KV — prod tokens won't work unless minted with --local");
  }

  const health = await ctx.client.health();
  let authOk = false;
  let authError: string | undefined;
  try {
    await ctx.client.list({ limit: 1 });
    authOk = true;
  } catch (err) {
    authError = err instanceof UploadsError ? err.message : String(err);
    if (err instanceof UploadsError && err.code === "UNAUTHORIZED") {
      hints.push("if this token works on api.uploads.sh, set UPLOADS_API_URL=https://api.uploads.sh");
    }
  }

  if (!ctx.config.configExists && !ctx.config.token) {
    hints.push(`run uploads setup to configure ${ctx.config.configPath}`);
  }

  const report = {
    ok: health.ok && authOk,
    apiUrl: ctx.config.apiUrl,
    workspace: ctx.config.workspace,
    workspaceSource: ctx.config.workspaceSource,
    workspaceFromToken: workspaceFromToken(ctx.config.token),
    configPath: ctx.config.configPath,
    configExists: ctx.config.configExists,
    health,
    auth: { ok: authOk, error: authError },
    hints,
  };

  if (ctx.json) {
    await writeJson(report);
    return report.ok ? 0 : 1;
  }

  const lines = [
    `config:    ${ctx.config.configPath}${ctx.config.configExists ? "" : " (missing)"}`,
    `api:       ${ctx.config.apiUrl} (${health.ok ? "ok" : "failed"})`,
    `workspace: ${ctx.config.workspace}`,
    `auth:      ${authOk ? "ok" : `failed — ${authError ?? "no token"}`}`,
  ];
  if (mismatch) lines.push(`warning:   ${mismatch}`);
  for (const h of hints) if (h !== mismatch) lines.push(`hint:      ${h}`);
  await writeStdout(lines.join("\n") + "\n");
  return report.ok ? 0 : 1;
}