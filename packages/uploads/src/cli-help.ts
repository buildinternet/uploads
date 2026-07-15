import {
  DEFAULT_TAGLINE,
  formatAuthBanner,
  formatBrandHeader,
  formatUpdateBanner,
} from "./cli-brand.js";
import { ROOT_COMMANDS } from "./cli-catalog.js";
import { colorEnabled, createStyle, padCmd, type CliStyle } from "./cli-style.js";
import { packageVersion } from "./package-version.js";

const CMD_WIDTH = 22;

type CmdRow = readonly [name: string, desc: string];

function toRow(c: (typeof ROOT_COMMANDS)[number]): CmdRow {
  return [c.usage ?? c.name, c.summary];
}

/** Preferred order for the short essentials help (subset of ROOT_COMMANDS). */
const ESSENTIAL_ORDER = ["put", "attach", "login", "list", "delete", "doctor", "install"] as const;

/** Day-to-day commands shown on bare `uploads` / `uploads help`. */
const ESSENTIALS: CmdRow[] = ESSENTIAL_ORDER.map((name) => {
  const cmd = ROOT_COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new Error(`cli-catalog missing essential command: ${name}`);
  return toRow(cmd);
});

/** Full catalog (same surface as before, still discoverable via help --all). */
const ALL_COMMANDS: CmdRow[] = ROOT_COMMANDS.map(toRow);

export interface RootHelpOptions {
  /** Full command list + config layers. Default: curated essentials. */
  full?: boolean;
  /** Force color on/off; default is TTY + env detection on stderr. */
  color?: boolean;
  style?: CliStyle;
  /** Include pixel brand mark in the header (default true). */
  brandMark?: boolean;
  /** Override package version shown in the header. */
  version?: string;
  /** When set, show a noticeable update banner under the header. */
  latestVersion?: string;
  /**
   * When true, show a loud "not signed in" banner at the very top with
   * `uploads login`. Callers should set this when no token is configured.
   */
  needsAuth?: boolean;
}

function rows(style: CliStyle, items: CmdRow[]): string {
  return items
    .map(([name, desc]) => `  ${padCmd(name, CMD_WIDTH, style)}${style.body(desc)}`)
    .join("\n");
}

function section(style: CliStyle, title: string): string {
  return style.heading(title);
}

function header(style: CliStyle, opts: RootHelpOptions): string {
  const version = opts.version ?? packageVersion();
  const brandMark = opts.brandMark !== false;
  const parts: string[] = [];

  // Auth first — loud and above everything when there's no token yet.
  if (opts.needsAuth) {
    parts.push(formatAuthBanner({ color: style.enabled }));
  }

  // Half-block mark when color is on. Plain three-line title otherwise so
  // piped/agent output stays compact and greppable.
  if (!brandMark || !style.enabled) {
    parts.push(
      `${style.title("uploads.sh")}\n` +
        `${style.muted(DEFAULT_TAGLINE)}\n` +
        `${style.muted(`v${version}`)}\n`,
    );
  } else {
    parts.push(
      formatBrandHeader({
        color: true,
        label: "uploads.sh",
        tagline: DEFAULT_TAGLINE,
        version,
      }),
    );
  }

  if (opts.latestVersion && opts.latestVersion !== version) {
    parts.push(
      formatUpdateBanner({
        current: version,
        latest: opts.latestVersion,
        color: style.enabled,
      }),
    );
  }

  return parts.join("");
}

function essentialsBody(style: CliStyle, opts: RootHelpOptions): string {
  return `${header(style, opts)}
${section(style, "Usage:")}
  uploads [globals] <command> [args]

${section(style, "Essentials:")}
${rows(style, ESSENTIALS)}

${section(style, "More help:")}
  ${padCmd("uploads help --all", CMD_WIDTH, style)}${style.body("Full command list, globals, and config")}
  ${padCmd("uploads <cmd> --help", CMD_WIDTH, style)}${style.body("Per-command options and examples")}

${section(style, "Globals (before command):")}
  ${style.muted("--api-url, --token, --workspace/-w, --env-file, --json, --quiet, --version/-V")}

${section(style, "Examples:")}
  ${style.command("uploads login")}
  ${style.command("uploads put")} ./shot.png --pr 123 --name hero.png
  ${style.command("uploads put")} ./after.png --pr 123 --comment
  ${style.command("uploads put")} ./bug.png --issue 45
  ${style.command("uploads attach")} ./before.png ./after.png
  ${style.command("uploads attach")} ./shot.png --pr 123 --repo myorg/myapp
  ${style.command("uploads doctor")}
  ${style.command("uploads install")}
`;
}

function fullBody(style: CliStyle, opts: RootHelpOptions): string {
  return `${header(style, opts)}
${section(style, "Usage:")}
  uploads [globals] <command> [args]

${section(style, "Config")} ${style.muted("(first match wins, per key):")}
  CLI flags           --api-url, --token, --workspace
  environment         UPLOADS_API_URL, UPLOADS_TOKEN, UPLOADS_WORKSPACE
  --env-file <path>
  $BUILDINTERNET_CONFIG
  ~/.config/buildinternet/config

${section(style, "Workspace")} ${style.muted("(within config layers):")}
  --workspace, -w     override — global (before command) or per-command (after)
  UPLOADS_WORKSPACE   env / config file
  (else inferred from token up_<name>_…, else "default")

${section(style, "Other globals")} ${style.muted("(before command):")}
  --api-url <url>     default: https://api.uploads.sh
  --token <token>     or UPLOADS_TOKEN
  --env-file <path>
  --json              JSON on stdout
  --quiet             Suppress stderr progress and update hints
  --version, -V       Print package version and exit

${section(style, "Commands:")}
${rows(style, ALL_COMMANDS)}

${section(style, "Put/list defaults")} ${style.muted("(config file or env):")}
  UPLOADS_DEFAULT_PREFIX, UPLOADS_DEFAULT_REPO, UPLOADS_DEFAULT_REF
  UPLOADS_DEFAULT_WIDTH, UPLOADS_NO_GIT

${section(style, "Update hints")} ${style.muted("(stderr, once/day):")} silence with --quiet / UPLOADS_NO_UPDATE=1 / NO_UPDATE_NOTIFIER=1

${section(style, "Examples:")}
  ${style.command("uploads login")}
  ${style.command("uploads put")} ./shot.png --pr 123 --name hero.png
  ${style.command("uploads put")} ./after.png --pr 123 --comment
  ${style.command("uploads put")} ./bug.png --issue 45 --repo myorg/myapp
  ${style.command("uploads put")} ./shot.png --dry-run --format url
  ${style.command("uploads attach")} ./before.png ./after.png
  ${style.command("uploads attach")} ./shot.png --pr 123 --repo myorg/myapp
  ${style.command("uploads attach")} ./artifact.zip --issue 45 --no-comment
  ${style.command("uploads gallery")} create --title "Release screenshots"
  ${style.command("uploads doctor")}
  ${style.command("uploads --version")}

${section(style, "Agent/MCP:")} ${style.body("`uploads install` sets up the agent skill and the hosted MCP server")}
${style.body("(https://agents.uploads.sh/mcp, workspace inferred from the token). Run")}
${style.body("`uploads mcp` for local stdio, or use createUploadsWorkerFileTools()")}
${style.body("from @buildinternet/uploads/agent on the Worker.")}

${style.muted("Tip: uploads help          essentials only")}
${style.muted("     uploads help --all    this full listing")}
`;
}

/**
 * Root help text. Default is a short essentials view; pass `full: true` for
 * the complete command + config dump (`uploads help --all`).
 */
export function formatRootHelp(options: RootHelpOptions = {}): string {
  const style =
    options.style ??
    createStyle(options.color !== undefined ? options.color : colorEnabled(process.stderr));
  const body = options.full ? fullBody(style, options) : essentialsBody(style, options);
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** True when argv for the `help` command requests the full listing. */
export function wantsFullHelp(args: string[]): boolean {
  for (const a of args) {
    if (a === "--all" || a === "-a" || a === "all") return true;
  }
  return false;
}
