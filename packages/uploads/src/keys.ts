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

export function deriveRepoFromGit(): string | undefined {
  try {
    const url = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
    const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export async function buildScreenshotKey(opts: {
  filename: string;
  fileBytes: Uint8Array;
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

  return `screenshots/${repo}/${ref}/${sanitizeKeySegment(stem)}-${short}${ext ? `.${sanitizeKeySegment(ext)}` : ""}`;
}