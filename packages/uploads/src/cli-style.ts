/**
 * Minimal ANSI styling for CLI help hierarchy.
 * Accent palette matches packages/ui tokens (truecolor when enabled).
 * Honors NO_COLOR / FORCE_COLOR and the target stream's TTY status.
 * @see https://no-color.org/
 * @see packages/ui/src/tokens.css
 */

import { BRAND, type Rgb } from "./cli-brand.js";

export type StyleFn = (text: string) => string;

export interface CliStyle {
  bold: StyleFn;
  dim: StyleFn;
  /** Section headings — brand accent violet */
  heading: StyleFn;
  /** Command / flag names — brand green */
  command: StyleFn;
  /** Muted secondary text — token muted gray */
  muted: StyleFn;
  /** Body / description text */
  body: StyleFn;
  /** High-emphasis title / wordmark */
  title: StyleFn;
  /** Errors / unknown-command banner — brand red */
  error: StyleFn;
  /** Brand accent (links, tips) */
  accent: StyleFn;
  enabled: boolean;
}

const identity: StyleFn = (t) => t;

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";

function fgTrue(c: Rgb): string {
  return `\u001b[38;2;${c.r};${c.g};${c.b}m`;
}

function wrapRgb(c: Rgb, bold = false): StyleFn {
  const open = (bold ? BOLD : "") + fgTrue(c);
  return (text) => `${open}${text}${RESET}`;
}

/** Whether color should be enabled for a given stream. */
export function colorEnabled(
  stream: { isTTY?: boolean } = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  return stream.isTTY === true;
}

export function createStyle(enabled: boolean): CliStyle {
  if (!enabled) {
    return {
      bold: identity,
      dim: identity,
      heading: identity,
      command: identity,
      muted: identity,
      body: identity,
      title: identity,
      error: identity,
      accent: identity,
      enabled: false,
    };
  }
  return {
    bold: (text) => `${BOLD}${fgTrue(BRAND.fg)}${text}${RESET}`,
    dim: (text) => `\u001b[2m${text}${RESET}`,
    heading: wrapRgb(BRAND.accent, true),
    command: wrapRgb(BRAND.green, true),
    muted: wrapRgb(BRAND.muted),
    body: wrapRgb(BRAND.body),
    title: wrapRgb(BRAND.fg, true),
    error: wrapRgb(BRAND.red, true),
    accent: wrapRgb(BRAND.accent),
    enabled: true,
  };
}

/** Pad a left column so descriptions line up (ANSI-aware length). */
export function padCmd(name: string, width: number, style: CliStyle): string {
  const pad = Math.max(0, width - name.length);
  return style.command(name) + " ".repeat(pad);
}

/** Section labels used across command --help blocks. */
const SECTION_RE =
  /^(Options|Examples|Commands|Subcommands|Keys|Shells|Usage|What it does|What runs under the hood|Exit codes|Config|Workspace):\s*$/;

/** Flag column: `  --pr <num>   …` or `  --workspace, -w <name>  …`. */
const FLAG_RE = /^(\s+)(-[\w-]+(?:,\s*-[\w-]+)?(?:\s+<[^>]+>)?)(\s{2,})(.*)$/;

/** Example / invocation line starting with the CLI name. */
const EXAMPLE_RE = /^(\s*)(uploads(?:\s+\S+)*)(.*)$/;

/**
 * Apply root-help visual hierarchy to a plain multi-line command help string:
 * accent section headers, green flags/commands, muted body.
 * No-op when color is disabled (returns text unchanged aside from trailing newline).
 */
export function formatCommandHelp(
  text: string,
  style: CliStyle = createStyle(colorEnabled(process.stderr)),
): string {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!style.enabled) return `${normalized}\n`;

  const lines = normalized.split("\n");
  let firstContent = true;
  const out = lines.map((line) => {
    if (line.trim() === "") return line;

    // Synopsis line (first non-empty): high emphasis
    if (firstContent) {
      firstContent = false;
      return style.title(line);
    }

    if (SECTION_RE.test(line)) return style.heading(line);

    const flag = FLAG_RE.exec(line);
    if (flag) {
      const [, indent, name, gap, desc] = flag;
      return `${indent}${style.command(name)}${gap}${style.body(desc)}`;
    }

    const example = EXAMPLE_RE.exec(line);
    if (example && line.trimStart().startsWith("uploads")) {
      const [, indent, cmd, rest] = example;
      return `${indent}${style.command(cmd)}${style.body(rest)}`;
    }

    // Indented continuation / option prose → body; top-level prose → muted-ish body
    if (line.startsWith("  ") || line.startsWith("\t")) return style.body(line);
    return style.body(line);
  });

  return `${out.join("\n")}\n`;
}

/** Write styled command help to stderr (or a custom writer). */
export function writeCommandHelp(
  text: string,
  write: (chunk: string) => void = (c) => {
    process.stderr.write(c);
  },
): void {
  write(formatCommandHelp(text));
}
