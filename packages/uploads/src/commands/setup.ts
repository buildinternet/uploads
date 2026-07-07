import { createUploadsClient } from "../client.js";
import {
  DEFAULT_API_URL,
  DEFAULT_WORKSPACE,
  describeConfigSources,
  putDefaultsToConfigValues,
  redactToken,
  resolveApiUrl,
  resolveConfig,
  resolveConfigPath,
  resolvePutDefaults,
  writeConfigKeys,
  workspaceFromToken,
  type UploadsConfigValues,
} from "../config.js";
import {
  flagBool,
  flagInt,
  flagString,
  parseCommandArgs,
  UsageError,
} from "../cli-args.js";
import { UploadsError } from "../errors.js";

const SETUP_HELP = `uploads setup — guided CLI configuration

Writes UPLOADS_* keys to the shared buildinternet config file and prints
step-by-step instructions for anything still missing.

Without flags: shows current status and the next steps to finish setup.
With flags: saves provided values, then optionally verifies with doctor.

Options:
  --api-url <url>       API base (default: ${DEFAULT_API_URL})
  --workspace, -w <name>
  --token <token>       Bearer token (mint via admin endpoint — see below)
  --prefix <path>       Default key prefix for put/list (default: screenshots)
  --repo <owner/repo>   Default repo segment for put
  --ref <id>            Default ref segment for put (PR/issue/branch/date)
  --width <px>          Default markdown image width
  --no-git              Don't derive --repo from git remote
  --path <file>         Config file (default: ~/.config/buildinternet/config)
  --force               Overwrite existing non-empty values
  --check               Run doctor after saving (default when --token is set)
  --no-check            Skip doctor after saving

Examples:
  uploads setup
  uploads setup --token up_default_…
  uploads setup --api-url http://localhost:8787 --workspace default --token up_default_…
  uploads setup --prefix screenshots --repo myorg/myapp --check
`;

interface SetupStatus {
  configPath: string;
  apiUrl: string;
  workspace: string;
  token: string | undefined;
  defaults: ReturnType<typeof resolvePutDefaults>;
  sources: ReturnType<typeof describeConfigSources>;
}

function buildStatus(envFile?: string): SetupStatus {
  const config = resolveConfig({ envFile, requireToken: false });
  return {
    configPath: config.configPath,
    apiUrl: config.apiUrl,
    workspace: config.workspace,
    token: config.token || undefined,
    defaults: resolvePutDefaults({ envFile }),
    sources: describeConfigSources({ envFile }),
  };
}

function mintTokenCommand(apiUrl: string, workspace?: string): string {
  const body =
    workspace && workspace !== DEFAULT_WORKSPACE
      ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '{"workspace":"${workspace}","label":"cli"}'`
      : "";
  return [
    `curl -XPOST ${apiUrl}/admin/tokens \\`,
    `  -H "Authorization: Bearer $ADMIN_TOKEN"${body}`,
  ].join("\n");
}

function formatWizard(status: SetupStatus): string {
  const lines: string[] = ["uploads setup", ""];

  lines.push(`Config file: ${status.configPath}`);
  lines.push(`API:         ${status.apiUrl} (${status.sources.apiUrl})`);
  lines.push(`Workspace:   ${status.workspace} (${status.sources.workspace})`);
  lines.push(`Token:       ${redactToken(status.token)} (${status.sources.token})`);

  const d = status.defaults;
  if (d.prefix || d.repo || d.ref || d.width != null || d.noGit) {
    lines.push("Defaults:");
    if (d.prefix) lines.push(`  prefix: ${d.prefix}`);
    if (d.repo) lines.push(`  repo:   ${d.repo}`);
    if (d.ref) lines.push(`  ref:    ${d.ref}`);
    if (d.width != null) lines.push(`  width:  ${d.width}`);
    if (d.noGit) lines.push("  no-git: true");
  }
  lines.push("");

  if (!status.token) {
    lines.push("Step 1 — Mint a token");
    lines.push("  You need ADMIN_TOKEN for the API (ask your uploads.sh admin, or set it locally in apps/api/.dev.vars).");
    lines.push("  Mint:");
    lines.push(`    ${mintTokenCommand(status.apiUrl, status.workspace)}`);
    lines.push("  Save:");
    lines.push("    uploads setup --token up_<workspace>_…");
    lines.push("");
  } else {
    lines.push("Step 1 — Token: ok");
    lines.push("");
  }

  if (status.apiUrl.includes("localhost") || status.apiUrl.includes("127.0.0.1")) {
    lines.push("Note — local API");
    lines.push("  Tokens minted with workspace:add --local only work against localhost.");
    lines.push("  Prod tokens need UPLOADS_API_URL=https://api.uploads.sh");
    lines.push("");
  }

  lines.push("Step 2 — Optional put defaults");
  lines.push("  uploads setup --prefix screenshots --repo myorg/myapp");
  lines.push("  uploads config set UPLOADS_DEFAULT_REPO myorg/myapp");
  lines.push("");

  lines.push("Step 3 — Verify");
  lines.push("  uploads doctor");
  lines.push("  uploads put ./shot.png");
  lines.push("");

  if (status.token) {
    lines.push("Quick save (all-in-one):");
    lines.push(
      `  uploads setup --api-url ${status.apiUrl} --workspace ${status.workspace} --token <token> --check`,
    );
  }

  return lines.join("\n");
}

export async function runSetup(
  args: string[],
  opts: { json?: boolean; envFile?: string },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(SETUP_HELP);
    return 0;
  }

  const apiUrl = flagString(parsed.flags, "--api-url");
  const workspace = flagString(parsed.flags, "--workspace") ?? flagString(parsed.flags, "-w");
  const token = flagString(parsed.flags, "--token");
  const prefix = flagString(parsed.flags, "--prefix");
  const repo = flagString(parsed.flags, "--repo");
  const ref = flagString(parsed.flags, "--ref");
  const width = flagInt(parsed.flags, "--width", "--width");
  const noGit = flagBool(parsed.flags, "--no-git");
  const path = flagString(parsed.flags, "--path") ?? resolveConfigPath({ envFile: opts.envFile });
  const force = flagBool(parsed.flags, "--force");
  const checkExplicit = flagBool(parsed.flags, "--check");
  const noCheck = flagBool(parsed.flags, "--no-check");

  const hasWrites =
    apiUrl != null ||
    workspace != null ||
    token != null ||
    prefix != null ||
    repo != null ||
    ref != null ||
    width != null ||
    noGit;

  if (!hasWrites) {
    const status = buildStatus(opts.envFile);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ...status,
            token: redactToken(status.token),
            complete: Boolean(status.token),
            next: status.token ? "doctor" : "mint-token",
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(formatWizard(status));
    }
    return status.token ? 0 : 1;
  }

  const keys: UploadsConfigValues = {};
  if (apiUrl) keys.UPLOADS_API_URL = apiUrl;
  if (workspace) keys.UPLOADS_WORKSPACE = workspace;
  if (token) keys.UPLOADS_TOKEN = token;

  Object.assign(
    keys,
    putDefaultsToConfigValues({
      prefix: prefix ?? undefined,
      repo: repo ?? undefined,
      ref: ref ?? undefined,
      width: width ?? undefined,
      noGit: noGit || undefined,
    }),
  );

  if (Object.keys(keys).length === 0) {
    throw new UsageError("no setup values provided");
  }

  const result = writeConfigKeys(path, keys, { force });
  const savedApiUrl = apiUrl ?? resolveApiUrl({ envFile: opts.envFile });
  const savedWorkspace =
    workspace ??
    (token ? workspaceFromToken(token) : undefined) ??
    DEFAULT_WORKSPACE;

  const shouldCheck = !noCheck && (checkExplicit || Boolean(token));
  let doctorOk: boolean | undefined;
  let doctorError: string | undefined;

  if (shouldCheck) {
    const cfg = resolveConfig({ envFile: opts.envFile, requireToken: false });
    if (!cfg.token) {
      doctorError = "no token configured — run uploads setup --token <token>";
    } else {
      try {
        const client = createUploadsClient({
          apiUrl: cfg.apiUrl,
          workspace: cfg.workspace,
          token: cfg.token,
        });
        const health = await client.health();
        if (!health.ok) throw new UploadsError("API unhealthy", "API_ERROR");
        await client.list({ limit: 1 });
        doctorOk = true;
      } catch (err) {
        doctorOk = false;
        doctorError = err instanceof UploadsError ? err.message : String(err);
      }
    }
  }

  const payload = {
    ...result,
    keys: Object.keys(keys),
    apiUrl: savedApiUrl,
    workspace: savedWorkspace,
    doctor: shouldCheck ? { ok: doctorOk, error: doctorError } : undefined,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return doctorOk === false ? 1 : 0;
  }

  const verb = result.created ? "created" : "updated";
  process.stdout.write(`${verb} ${result.path}\n`);
  if (result.updated.length) process.stdout.write(`keys: ${result.updated.join(", ")}\n`);

  if (shouldCheck) {
    if (doctorOk) process.stdout.write("doctor: ok\n");
    else process.stderr.write(`doctor: failed — ${doctorError}\n`);
  } else if (token || checkExplicit) {
    process.stderr.write("hint: run uploads doctor to verify\n");
  } else {
    process.stderr.write("hint: run uploads setup to see minting instructions\n");
  }

  return doctorOk === false ? 1 : 0;
}