import {
  flagBool,
  flagString,
  parseCommandArgs,
  UsageError,
  type GlobalFlags,
} from "../cli-args.js";
import { resolveConfig } from "../config.js";
import { execRunner, type CommandRunner } from "../github-gh.js";
import { writeCommandHelp } from "../cli-style.js";
import {
  HOOK_COMMAND,
  HOOK_INVOCATION,
  installHookManifests,
  type HookWriteResult,
} from "../hooks-install.js";

export const DEFAULT_MCP_URL = "https://agents.uploads.sh/mcp";
const SKILL_SOURCE = "buildinternet/uploads";
const SKILL_NAMES = ["uploads-cli", "github-screenshots", "annotate-screenshots"];

type McpClientId = "claude" | "codex" | "grok";

interface McpClient {
  id: McpClientId;
  label: string;
  command: (name: string, url: string, bearer: string) => string[];
}

/** `mcp add --transport http` with an Authorization header. */
function httpMcpAdd(binary: McpClientId, name: string, url: string, bearer: string): string[] {
  return [
    binary,
    "mcp",
    "add",
    "--transport",
    "http",
    name,
    url,
    "--header",
    `Authorization: Bearer ${bearer}`,
  ];
}

/**
 * Agent CLIs that can register the hosted MCP server. Each is attempted
 * independently; a missing binary is skipped so the others can still install.
 */
export const MCP_CLIENTS: readonly McpClient[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: (name, url, bearer) => httpMcpAdd("claude", name, url, bearer),
  },
  {
    id: "codex",
    label: "Codex",
    // Codex HTTP MCP has no --header; auth is OAuth on first use (same as the
    // plugin's .mcp.json). Passing --bearer-token-env-var UPLOADS_TOKEN would
    // break machines that signed in via `uploads login` (token lives in the
    // config file, not the environment).
    command: (name, url) => ["codex", "mcp", "add", name, "--url", url],
  },
  {
    id: "grok",
    label: "Grok",
    command: (name, url, bearer) => httpMcpAdd("grok", name, url, bearer),
  },
];

const MCP_CLIENT_BINARIES = MCP_CLIENTS.map((c) => c.id).join(", ");

const INSTALL_HELP = `uploads install — set up agent integrations (skills + remote MCP + hooks)

Installs the github-screenshots, uploads-cli, and annotate-screenshots agent
skills, registers the hosted MCP server with whichever of Claude Code, Codex,
and Grok are on PATH, and installs the PR screenshot reminder hook for
Grok / Cursor when those tools are present. A missing agent CLI is skipped —
it does not fail the rest of the install. The remote MCP endpoint infers your
workspace from the bearer token, so only the token is needed.

Claude Code and Codex ship the same reminder via their plugins (same command:
\`${HOOK_INVOCATION}\`) — install those plugins instead of relying on this step.

Safe to re-run. An MCP server already registered under this name is reported
as \`already configured\` and left as-is — including the token it was created
with. To point it at a new token: \`<cli> mcp remove <name>\` first
(e.g. \`claude mcp remove uploads\`).

Usage:
  uploads install [skill|mcp|hooks|all]     (default: all)

What it does:
  skill   Agent skills (via npx skills) — github-screenshots: visuals into
          PRs/issues; uploads-cli: full CLI reference; annotate-screenshots:
          hand-drawn callouts and redaction on screenshots
  mcp     Hosted MCP server in Claude Code, Codex, and Grok — each CLI that
          is installed is registered; missing ones are skipped
  hooks   PR screenshot reminder for Grok / Cursor (user-global manifests)

What runs under the hood:
  skill   npx -y skills add ${SKILL_SOURCE} --skill <name> -g -y -a '*'
          (once per skill: ${SKILL_NAMES.join(", ")}; needs Node 22+ / npm 7+
          with npx on PATH — missing tooling fails once with install guidance)
  mcp     claude mcp add --transport http uploads ${DEFAULT_MCP_URL} \\
            --header "Authorization: Bearer <token>"
          codex mcp add uploads --url ${DEFAULT_MCP_URL}
          grok mcp add --transport http uploads ${DEFAULT_MCP_URL} \\
            --header "Authorization: Bearer <token>"
          (each is skipped when that CLI is not on PATH)
  hooks   write/merge ~/.grok/hooks/… and ~/.cursor/hooks.json when present

Options:
  --url <endpoint>    Remote MCP endpoint (default: ${DEFAULT_MCP_URL})
  --name <name>       MCP server name in the client (default: uploads)
  --dry-run           Print the plan without running anything
  --verbose           Show underlying command output (default: errors only)

Examples:
  uploads install
  uploads install skill
  uploads install mcp
  uploads install hooks
  uploads install --dry-run
`;

export interface StepResult {
  command: string[];
  ok: boolean;
  skipped?: "dry-run" | "sign-in" | "already-configured" | "missing-cli";
  error?: string;
  output?: string;
}

/** npm 7+ for `npx -y`. Node 22 ships npm 10+; this catches ancient/system npm. */
export const MIN_NPM_MAJOR_FOR_SKILLS = 7;

/** Mask Bearer credentials and the configured token in any printed text. */
function redactor(token: string | undefined): (text: string) => string {
  return (text) => {
    let out = text.replace(/Bearer \S+/g, "Bearer ***");
    if (token) out = out.split(token).join("***");
    return out;
  };
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Install guidance when a host binary is missing (not "run manually: <same binary>"). */
export function missingBinaryHint(binary: string): string {
  switch (binary) {
    case "npx":
    case "npm":
      return (
        `${binary} not found on PATH — skill install needs Node.js (npm includes npx). ` +
        `Install Node 22+ from https://nodejs.org (or your package manager), open a new shell, ` +
        `confirm \`${binary} --version\` works, then re-run \`uploads install skill\`.`
      );
    case "claude":
      return (
        `claude not found on PATH — MCP install for Claude Code needs the Claude Code CLI. ` +
        `Install it from https://docs.anthropic.com/en/docs/claude-code, ensure \`claude\` is on PATH, ` +
        `then re-run \`uploads install mcp\`. Other agent CLIs (and skills/hooks) still work without it.`
      );
    case "codex":
      return (
        `codex not found on PATH — MCP install for Codex needs the Codex CLI. ` +
        `Install it, ensure \`codex\` is on PATH, then re-run \`uploads install mcp\`.`
      );
    case "grok":
      return (
        `grok not found on PATH — MCP install for Grok needs the Grok CLI. ` +
        `Install it, ensure \`grok\` is on PATH, then re-run \`uploads install mcp\`.`
      );
    default:
      return `${binary} not found on PATH — install it and ensure it is available in this shell.`;
  }
}

export function npmTooOldHint(version: string): string {
  return (
    `npm ${version} is too old for skill install (need npm ${MIN_NPM_MAJOR_FOR_SKILLS}+ for \`npx -y\`). ` +
    `Upgrade Node/npm (Node 22+ recommended: https://nodejs.org), confirm \`npm --version\`, ` +
    `then re-run \`uploads install skill\`.`
  );
}

/**
 * Probe npx/npm once before the per-skill loop. Returns an error string when
 * tooling is missing/too old; undefined means skill steps should proceed.
 * Non-ENOENT npx failures are left for the real `skills add` to surface.
 */
export function probeSkillTooling(run: CommandRunner): string | undefined {
  try {
    run("npx", ["--version"]);
  } catch (err) {
    return isEnoent(err) ? missingBinaryHint("npx") : undefined;
  }
  try {
    const out = run("npm", ["--version"]).trim();
    const major = Number.parseInt(out.split(".")[0] ?? "", 10);
    if (Number.isFinite(major) && major < MIN_NPM_MAJOR_FOR_SKILLS) {
      return npmTooOldHint(out);
    }
  } catch (err) {
    if (isEnoent(err)) return missingBinaryHint("npm");
  }
  return undefined;
}

export function runStep(run: CommandRunner, command: string[]): StepResult {
  try {
    const output = run(command[0], command.slice(1)).trim();
    return { command, ok: true, output: output || undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      command,
      ok: false,
      error: isEnoent(err) ? missingBinaryHint(command[0]) : message,
    };
  }
}

function skillCommand(skill: string): string[] {
  // -g global, -y non-interactive, -a '*' every agent (skips the multi-select TUI)
  return ["npx", "-y", "skills", "add", SKILL_SOURCE, "--skill", skill, "-g", "-y", "-a", "*"];
}

/** `mcp add` exits non-zero when the name is already registered; treat that as success. */
function isAlreadyConfigured(error: string): boolean {
  return /already exists|already (configured|registered|present)|duplicate/i.test(error);
}

function mcpStepKey(client: McpClient): string {
  return `mcp:${client.id}`;
}

function mcpClientForStep(step: string): McpClient | undefined {
  return MCP_CLIENTS.find((c) => mcpStepKey(c) === step);
}

function stepFamily(key: string): string {
  if (key.startsWith("skill:")) return "skills";
  if (key.startsWith("mcp:")) return "mcp";
  return key;
}

function partitionSteps(results: Record<string, StepResult>): {
  skills: [string, StepResult][];
  mcp: [string, StepResult][];
  other: [string, StepResult][];
} {
  const skills: [string, StepResult][] = [];
  const mcp: [string, StepResult][] = [];
  const other: [string, StepResult][] = [];
  for (const entry of Object.entries(results)) {
    const key = entry[0];
    if (key.startsWith("skill:")) skills.push(entry);
    else if (key.startsWith("mcp:")) mcp.push(entry);
    else other.push(entry);
  }
  return { skills, mcp, other };
}

/** Run one client's `mcp add`; missing binaries skip, duplicates are already-configured. */
function runMcpClientStep(run: CommandRunner, command: string[]): StepResult {
  try {
    const output = run(command[0], command.slice(1)).trim();
    return { command, ok: true, output: output || undefined };
  } catch (err) {
    if (isEnoent(err)) {
      return {
        command,
        ok: true,
        skipped: "missing-cli",
        error: `${command[0]} not found on PATH`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isAlreadyConfigured(message)) {
      return { command, ok: true, skipped: "already-configured", output: message };
    }
    return { command, ok: false, error: message };
  }
}

function peekToken(globals: GlobalFlags): string | undefined {
  try {
    const config = resolveConfig({
      apiUrl: globals.apiUrl,
      workspace: globals.workspace,
      token: globals.token,
      envFile: globals.envFile,
      requireToken: false,
    });
    return config.token || undefined;
  } catch {
    return undefined;
  }
}

function printOneHumanStep(
  step: string,
  r: StepResult,
  redact: (s: string) => string,
  verbose: boolean,
  mcpName: string,
): void {
  const cmd = redact(r.command.join(" "));
  switch (r.skipped) {
    case "dry-run":
      process.stdout.write(`${step}: would run — ${cmd}\n`);
      return;
    case "sign-in":
      process.stdout.write(`${step}: skipped — ${redact(r.error ?? "needs sign-in")}\n`);
      return;
    case "missing-cli":
      process.stdout.write(
        `${step}: skipped — ${r.error ?? `${r.command[0]} not found on PATH`}\n`,
      );
      return;
    case "already-configured": {
      const client = mcpClientForStep(step);
      const label = client?.label ?? "the client";
      const remove = `${client?.id ?? "<cli>"} mcp remove ${mcpName}`;
      process.stdout.write(
        `${step}: already configured — "${mcpName}" is registered in ${label} (nothing to do)\n` +
          `  To re-register (e.g. with a new token): ${remove} && uploads install mcp\n`,
      );
      return;
    }
  }
  if (r.ok) {
    process.stdout.write(`${step}: ok\n`);
    if (verbose && r.output) {
      process.stdout.write(`  ${redact(r.output).split("\n").join("\n  ")}\n`);
    }
    return;
  }
  process.stderr.write(`${step}: failed — ${redact(r.error ?? "")}\n`);
  if (verbose) process.stderr.write(`  command: ${cmd}\n`);
}

/** Shared error when every skill step failed identically; otherwise undefined. */
function identicalSkillFailure(skillEntries: [string, StepResult][]): string | undefined {
  if (skillEntries.length < 2) return undefined;
  const error = skillEntries[0]?.[1].error;
  if (!error) return undefined;
  const allSame = skillEntries.every(([, r]) => !r.ok && !r.skipped && r.error === error);
  return allSame ? error : undefined;
}

function printMcpHumanSteps(
  mcp: [string, StepResult][],
  redact: (s: string) => string,
  verbose: boolean,
  mcpName: string,
): void {
  const first = mcp[0];
  if (!first) return;
  if (mcp.every(([, r]) => r.skipped === "sign-in")) {
    printOneHumanStep("mcp", first[1], redact, verbose, mcpName);
    return;
  }
  if (mcp.every(([, r]) => r.skipped === "missing-cli")) {
    process.stdout.write(
      `mcp: skipped — no agent CLI on PATH (${MCP_CLIENT_BINARIES}). Skills and hooks still work.\n`,
    );
    return;
  }
  for (const [step, r] of mcp) {
    printOneHumanStep(step, r, redact, verbose, mcpName);
  }
}

/** Collapse identical skill failures to one `skills:` line (missing npx, old npm, …). */
function printHumanSteps(
  results: Record<string, StepResult>,
  redact: (s: string) => string,
  verbose: boolean,
  mcpName: string,
): void {
  const { skills, mcp, other } = partitionSteps(results);
  const sharedError = identicalSkillFailure(skills);

  if (sharedError !== undefined) {
    process.stderr.write(`skills: failed — ${redact(sharedError)}\n`);
    if (verbose) {
      for (const [step, r] of skills) {
        process.stderr.write(`  ${step}: ${redact(r.command.join(" "))}\n`);
      }
    }
  } else {
    for (const [step, r] of skills) {
      printOneHumanStep(step, r, redact, verbose, mcpName);
    }
  }

  printMcpHumanSteps(mcp, redact, verbose, mcpName);

  for (const [step, r] of other) {
    printOneHumanStep(step, r, redact, verbose, mcpName);
  }
}

function printSuccessFooter(steps: string[], signedIn: boolean): void {
  process.stdout.write(
    `\nDone — ${steps.join(" and ")} ready.\n` +
      "Restart your agent session so it picks up the new skill/server.\n" +
      "Then ask it to host a screenshot or attach images to a PR — for example:\n" +
      '  "upload this screenshot and put it in the PR description"\n' +
      '  "attach before.png and after.png to this PR"\n',
  );
  if (!signedIn) {
    process.stdout.write(
      "\nNot signed in yet? Run `uploads login` once so put/attach/MCP can authenticate.\n",
    );
  }
}

function printHookResults(writes: HookWriteResult[]): void {
  if (writes.length === 0) {
    process.stdout.write(
      "hooks: nothing to do (no ~/.grok or ~/.cursor; Claude/Codex use their plugins)\n",
    );
    return;
  }
  for (const w of writes) {
    if (w.error) process.stderr.write(`hooks:${w.path}: skipped — ${w.error}\n`);
    else process.stdout.write(`hooks:${w.path}: ${w.action}\n`);
  }
}

export async function runInstall(
  args: string[],
  opts: {
    globals: GlobalFlags;
    json?: boolean;
    runner?: CommandRunner;
    /** Override home for hook installs (tests). */
    home?: string;
  },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(INSTALL_HELP);
    return 0;
  }

  const target = parsed.positionals[0] ?? "all";
  if (!["skill", "mcp", "hooks", "all"].includes(target)) {
    throw new UsageError(`unknown install target: ${target} (expected skill, mcp, hooks, or all)`);
  }

  const url = flagString(parsed.flags, "--url") ?? DEFAULT_MCP_URL;
  const name = flagString(parsed.flags, "--name") ?? "uploads";
  const dryRun = flagBool(parsed.flags, "--dry-run");
  const verbose = flagBool(parsed.flags, "--verbose");
  const run = opts.runner ?? execRunner;
  const human = !opts.json && !dryRun;

  const token = peekToken(opts.globals);
  const signedIn = Boolean(token);
  const redact = redactor(token);
  const results: Record<string, StepResult> = {};
  let hookWrites: HookWriteResult[] = [];

  if (target === "skill" || target === "all") {
    if (human) process.stdout.write("Installing skills…\n");
    const toolingError = dryRun ? undefined : probeSkillTooling(run);
    for (const skill of SKILL_NAMES) {
      const command = skillCommand(skill);
      if (dryRun) {
        results[`skill:${skill}`] = { command, ok: true, skipped: "dry-run" };
      } else if (toolingError) {
        results[`skill:${skill}`] = { command, ok: false, error: toolingError };
      } else {
        results[`skill:${skill}`] = runStep(run, command);
      }
    }
  }

  if (target === "mcp" || target === "all") {
    const bearer = token || "<token>";
    const skipSignIn = !dryRun && !token;
    if (human && !skipSignIn) process.stdout.write("Installing MCP server…\n");
    for (const client of MCP_CLIENTS) {
      const command = client.command(name, url, bearer);
      const key = mcpStepKey(client);
      if (skipSignIn) {
        results[key] = {
          command,
          ok: false,
          skipped: "sign-in",
          error: "needs sign-in — run `uploads login`, then `uploads install mcp`",
        };
      } else if (dryRun) {
        results[key] = { command, ok: true, skipped: "dry-run" };
      } else {
        results[key] = runMcpClientStep(run, command);
      }
    }
  }

  if (target === "hooks" || target === "all") {
    if (human) process.stdout.write("Installing agent hooks…\n");
    hookWrites = installHookManifests({ home: opts.home, dryRun });
    // Surface as a synthetic step so --json / failure accounting stay simple.
    const hookErrors = hookWrites.filter((w) => w.error);
    results.hooks = {
      command: [HOOK_COMMAND],
      ok: hookErrors.length === 0,
      skipped: dryRun ? "dry-run" : undefined,
      output: hookWrites
        .map((w) => `${w.path}: ${w.action}${w.error ? ` (${w.error})` : ""}`)
        .join("\n"),
      error: hookErrors.length > 0 ? hookErrors.map((w) => w.error).join("; ") : undefined,
    };
  }

  const failed = Object.values(results).some((r) => !r.ok);

  if (opts.json) {
    const steps = Object.fromEntries(
      Object.entries(results).map(([key, r]) => [
        key,
        {
          command: r.command.map(redact),
          ok: r.ok,
          skipped: r.skipped,
          output: r.output === undefined ? undefined : redact(r.output),
          error: r.error === undefined ? undefined : redact(r.error),
        },
      ]),
    );
    process.stdout.write(JSON.stringify({ ok: !failed, steps }, null, 2) + "\n");
    return failed ? 1 : 0;
  }

  printHumanSteps(results, redact, verbose, name);
  // Path-level detail for hooks (printHumanSteps only shows the synthetic step).
  if (
    (target === "hooks" || target === "all") &&
    (dryRun || (human && (verbose || hookWrites.some((w) => w.action !== "skipped"))))
  ) {
    printHookResults(hookWrites);
  }

  const { skills: skillEntries, mcp: mcpEntries } = partitionSteps(results);
  const skillResults = skillEntries.map(([, r]) => r);
  const skillsOk = skillResults.length > 0 && skillResults.every((r) => r.ok);
  const skillsFailed = skillResults.some((r) => !r.ok);
  const mcpResults = mcpEntries.map(([, r]) => r);
  const mcpFailed = mcpResults.some((r) => !r.ok);

  if (!failed && !dryRun) {
    const stepLabels = [
      ...new Set(
        Object.entries(results)
          .filter(([, r]) => r.ok && r.skipped !== "missing-cli" && r.skipped !== "sign-in")
          .map(([k]) => stepFamily(k)),
      ),
    ];
    if (stepLabels.length > 0) printSuccessFooter(stepLabels, signedIn);
  } else if (failed && !dryRun && skillsOk && mcpFailed) {
    const next = mcpResults.every((r) => r.skipped === "sign-in")
      ? "Sign in with `uploads login`, then re-run `uploads install mcp`."
      : "Fix the MCP step above, then re-run `uploads install mcp`.";
    process.stdout.write(`\nSkills are installed. ${next}\n`);
  } else if (failed && !dryRun && skillsFailed) {
    // Closing guidance when skills fail (issue #191: used to be per-step only).
    const skillErrText = skillResults.map((r) => r.error ?? "").join("\n");
    const toolingMissing = /npx not found|npm not found|too old for skill install/i.test(
      skillErrText,
    );
    process.stdout.write(
      toolingMissing
        ? "\nSkill install needs a working Node.js toolchain (npx + npm 7+ on PATH). " +
            "Fix that, then re-run `uploads install skill`.\n"
        : "\nSkill install incomplete. Fix the errors above, then re-run `uploads install skill`.\n",
    );
  }

  return failed ? 1 : 0;
}
