import { execSync } from "node:child_process";

export function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

export async function sha256Short(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
}

/**
 * `run` is optional and structurally matches `CommandRunner` (github-gh.ts)
 * without importing it — callers that already have an injected runner (e.g.
 * the put nudge, issue #393) can pass it through for testability; the
 * default (no `run`) preserves the original direct-`execSync` behavior for
 * every existing caller.
 */
export function deriveRepoFromGit(
  run?: (cmd: string, args: string[], input?: string) => string,
): string | undefined {
  try {
    const url = run
      ? run("git", ["config", "--get", "remote.origin.url"]).trim()
      : execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
    const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export async function buildScreenshotKey(opts: {
  filename: string;
  fileBytes: Uint8Array;
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
}): Promise<string> {
  const dot = opts.filename.lastIndexOf(".");
  const ext = dot >= 0 ? opts.filename.slice(dot + 1) : "";
  const stem = dot >= 0 ? opts.filename.slice(0, dot) : opts.filename;

  let repo = opts.repo;
  if (!repo && opts.deriveRepoFromGit) repo = deriveRepoFromGit();
  repo = sanitizeKeySegment(repo ?? "misc");
  const ref = sanitizeKeySegment(opts.ref ?? new Date().toISOString().slice(0, 10));
  const short = await sha256Short(opts.fileBytes);

  const prefix = sanitizeKeySegment(opts.prefix ?? "screenshots");
  return `${prefix}/${repo}/${ref}/${sanitizeKeySegment(stem)}-${short}${ext ? `.${sanitizeKeySegment(ext)}` : ""}`;
}
