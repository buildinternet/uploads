/**
 * Shared CLI surface for help text and shell completions.
 * Keep in sync when adding root commands or nested subcommands.
 */

export interface CatalogCommand {
  /** Root command name (no args). */
  name: string;
  summary: string;
  /** Shown in help left column when set (e.g. `put <file>`). */
  usage?: string;
  /** Included in the short essentials help. */
  essential?: boolean;
  subcommands?: readonly { name: string; summary: string }[];
}

/** Global flags accepted before the subcommand. */
export const GLOBAL_FLAGS: readonly { flag: string; summary: string }[] = [
  { flag: "--api-url", summary: "API base URL" },
  { flag: "--token", summary: "Bearer token" },
  { flag: "--workspace", summary: "Workspace name" },
  { flag: "-w", summary: "Workspace name (short)" },
  { flag: "--env-file", summary: "Load env from file" },
  { flag: "--json", summary: "JSON on stdout" },
  { flag: "--quiet", summary: "Suppress stderr progress" },
  { flag: "--version", summary: "Print package version" },
  { flag: "-V", summary: "Print package version (short)" },
  { flag: "--help", summary: "Show help" },
  { flag: "-h", summary: "Show help (short)" },
  { flag: "--all", summary: "Full root help listing" },
];

/** Common flags for put/attach (file-oriented commands). */
export const PUT_LIKE_FLAGS: readonly string[] = [
  "--destination",
  "--prefix",
  "--repo",
  "--ref",
  "--pr",
  "--issue",
  "--branch",
  "--comment",
  "--no-comment",
  "--format",
  "--dry-run",
  "--name",
  "--no-optimize",
  "--frame",
  "--frame-url",
  "--gallery",
  "--meta",
  "--state",
  "--app",
  "--workspace",
  "-w",
  "--help",
  "-h",
];

/**
 * All flags `uploads screenshot` actually reads (verified against
 * commands/screenshot.ts) — kept as its own explicit list rather than
 * spreading PUT_LIKE_FLAGS, which includes `--name`/`--no-comment` that
 * screenshot never parses.
 */
export const SCREENSHOT_FLAGS: readonly string[] = [
  "--via",
  "--browser",
  "--cdp",
  "--viewport",
  "--selector",
  "--full-page",
  "--dark",
  "--light",
  "--wait",
  "--out",
  "--no-sidecar",
  "--no-upload",
  "--destination",
  "--prefix",
  "--repo",
  "--ref",
  "--key",
  "--alt",
  "--width",
  "--frame",
  "--frame-url",
  "--frame-fit",
  "--no-optimize",
  "--optimize-max-edge",
  "--optimize-quality",
  "--keep-exif",
  "--no-git",
  "--pr",
  "--issue",
  "--branch",
  "--comment",
  "--gallery",
  "--meta",
  "--state",
  "--app",
  "--dry-run",
  "--format",
  "--workspace",
  "-w",
  "--help",
  "-h",
];

export const LIST_LIKE_FLAGS: readonly string[] = [
  "--prefix",
  "--limit",
  "--cursor",
  "--meta",
  "--workspace",
  "-w",
  "--help",
  "-h",
];

export const ROOT_COMMANDS: readonly CatalogCommand[] = [
  {
    name: "attach",
    usage: "attach <file...>",
    summary: "Attach media to the current PR (stable URLs + managed comment)",
    essential: true,
  },
  {
    name: "put",
    usage: "put <file...>",
    summary: "Upload (+ URL + markdown for GitHub)",
    essential: true,
  },
  {
    name: "staged",
    summary: "Show what's staged for a branch, and whether it will auto-attach",
  },
  {
    name: "screenshot",
    usage: "screenshot <target>",
    summary: "Capture a URL or .html file and host it (local browser or remote render)",
    essential: true,
  },
  {
    name: "gallery",
    summary: "Create and organize public media galleries",
    subcommands: [
      { name: "create", summary: "Create a gallery" },
      { name: "show", summary: "Show a gallery" },
      { name: "list", summary: "List galleries" },
      { name: "delete", summary: "Delete a gallery record" },
      { name: "add", summary: "Add objects to a gallery" },
      { name: "link", summary: "Link a gallery to a GitHub issue/PR" },
      { name: "unlink", summary: "Unlink a gallery from GitHub" },
    ],
  },
  {
    name: "comment",
    summary: "Create/update a PR/issue attachments comment (via gh)",
  },
  {
    name: "github",
    summary: "Claim/inspect this workspace's binding to a GitHub repo",
    subcommands: [
      { name: "link", summary: "Claim or inspect the repo binding" },
      { name: "doctor", summary: "Check the GitHub App's webhook event subscriptions" },
    ],
  },
  {
    name: "list",
    summary: "List objects (--meta k=v filters by queryable metadata)",
    essential: true,
  },
  {
    name: "find",
    usage: "find k=v...",
    summary: "List objects matching metadata (alias for list --meta)",
  },
  {
    name: "meta",
    summary: "Get/set an object's queryable metadata",
    subcommands: [
      { name: "get", summary: "Show metadata for an object" },
      { name: "set", summary: "Merge-set and/or delete metadata pairs" },
    ],
  },
  {
    name: "delete",
    usage: "delete <key>",
    summary: "Delete object",
    essential: true,
  },
  { name: "usage", summary: "Workspace storage / upload counters" },
  { name: "reconcile", summary: "Rebuild usage ledger from storage" },
  { name: "purge-expired", summary: "Delete objects past retentionDays" },
  { name: "setup", summary: "Inspect/configure advanced CLI settings" },
  {
    name: "install",
    summary: "Install agent skills, remote MCP, and harness hooks",
    essential: true,
    subcommands: [
      { name: "skill", summary: "Install the agent skills only" },
      { name: "mcp", summary: "Register the remote MCP server only" },
      { name: "hooks", summary: "Install PR screenshot hooks for Grok/Cursor" },
      { name: "all", summary: "Install skills, MCP, and hooks (default)" },
    ],
  },
  {
    name: "hook",
    summary: "Agent harness hook handlers (stdin → advisory JSON)",
    subcommands: [
      {
        name: "pre-pr-screenshot",
        summary: "Remind to stage screenshots before gh pr create",
      },
    ],
  },
  {
    name: "update",
    summary: "Update the CLI, then refresh the agent skills + MCP registration",
    essential: true,
  },
  {
    name: "login",
    summary: "Sign in via browser (or an enrollment code) and save credentials",
    essential: true,
  },
  {
    name: "whoami",
    summary: "Show active workspace and token (alias: status)",
    essential: true,
  },
  {
    name: "logout",
    summary: "Remove the saved UPLOADS_TOKEN from the config file",
  },
  {
    name: "invite",
    summary: "Invite a teammate to a workspace (workspace admin; device login)",
  },
  {
    name: "admin",
    summary: "Site-operator invitation management (ADMIN_TOKEN)",
    subcommands: [
      { name: "invite", summary: "Create a workspace invitation" },
      { name: "enrollment", summary: "Legacy alias for invite" },
    ],
  },
  {
    name: "config",
    summary: "Show path, init, or set shared config",
    subcommands: [
      { name: "path", summary: "Print config file path" },
      { name: "show", summary: "Show effective settings" },
      { name: "init", summary: "Create or update UPLOADS_* keys" },
      { name: "set", summary: "Set one UPLOADS_* key" },
    ],
  },
  {
    name: "telemetry",
    summary: "Manage anonymous usage telemetry (status / enable / disable)",
    subcommands: [
      { name: "status", summary: "Show whether telemetry is enabled" },
      { name: "enable", summary: "Enable anonymous usage telemetry" },
      { name: "disable", summary: "Disable anonymous usage telemetry" },
    ],
  },
  {
    name: "report",
    usage: "report [message]",
    summary: "Send a diagnostic report (optional log attachment; explicit opt-in)",
  },
  {
    name: "doctor",
    summary: "Health + auth + workspace checks",
    essential: true,
  },
  { name: "health", summary: "API liveness (no auth)" },
  { name: "mcp", summary: "Serve MCP over stdio (tools mirror the CLI)" },
  {
    name: "help",
    summary: "Show this help (essentials; use --all for the full list)",
    subcommands: [{ name: "--all", summary: "Full command list and config" }],
  },
  {
    name: "completion",
    summary: "Print shell completion script (bash, zsh, or fish)",
    subcommands: [
      { name: "bash", summary: "Bash completion script" },
      { name: "zsh", summary: "Zsh completion script" },
      { name: "fish", summary: "Fish completion script" },
    ],
  },
];

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

export function rootCommandNames(): string[] {
  return ROOT_COMMANDS.map((c) => c.name);
}

/** Also accept plural alias for the completion command. */
export const COMPLETION_ALIASES = ["completion", "completions"] as const;
