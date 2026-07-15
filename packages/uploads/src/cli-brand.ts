/**
 * uploads.sh brand tokens + terminal chevron mark for root help.
 * Colors mirror packages/ui/src/tokens.css; geometry from Brand.tsx / favicon.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Design tokens from packages/ui (dark scheme). */
export const BRAND = {
  bg: { r: 0x0a, g: 0x0a, b: 0x0b },
  panel: { r: 0x12, g: 0x12, b: 0x14 },
  line: { r: 0x23, g: 0x23, b: 0x27 },
  fg: { r: 0xec, g: 0xec, b: 0xea },
  body: { r: 0xb3, g: 0xb3, b: 0xad },
  muted: { r: 0x8a, g: 0x8a, b: 0x83 },
  accent: { r: 0xc2, g: 0x7e, b: 0xff },
  green: { r: 0x8f, g: 0xae, b: 0x62 },
  red: { r: 0xd9, g: 0x8a, b: 0x9c },
} as const satisfies Record<string, Rgb>;

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.min(1, Math.max(0, t));
  return {
    r: Math.round(a.r * u + b.r * (1 - u)),
    g: Math.round(a.g * u + b.g * (1 - u)),
    b: Math.round(a.b * u + b.b * (1 - u)),
  };
}

export function accentAt(opacity: number, over: Rgb = BRAND.panel): Rgb {
  return mixRgb(BRAND.accent, over, opacity);
}

/**
 * Thin stacked chevrons (1-cell stroke, 5×9) with brand opacities 1 / 0.55 / 0.28.
 * Mirrors the three fading Λ shapes from the favicon without fat 4×4 fills.
 */
const THIN_CHEVRON: (number | null)[][] = (() => {
  const rows = ["  #  ", " # # ", "#   #", "  #  ", " # # ", "#   #", "  #  ", " # # ", "#   #"];
  const opacities = [1, 1, 1, 0.55, 0.55, 0.55, 0.28, 0.28, 0.28];
  return rows.map((row, y) => [...row].map((ch) => (ch === "#" ? opacities[y]! : null)));
})();

/** Deep-copy the thin chevron opacity grid. */
export function rasterizeMark(): (number | null)[][] {
  return THIN_CHEVRON.map((row) => row.slice());
}

function cellColor(v: number | null): Rgb | null {
  if (v === null || v <= 0) return null;
  return accentAt(v);
}

function ansiFg(c: Rgb): string {
  return `\u001b[38;2;${c.r};${c.g};${c.b}m`;
}

function ansiBg(c: Rgb): string {
  return `\u001b[48;2;${c.r};${c.g};${c.b}m`;
}

const ANSI_RESET = "\u001b[0m";

/**
 * Half-block render of the mark (▀/▄/█). Two pixel rows → one terminal row.
 */
export function renderBrandMarkLines(options: { color?: boolean } = {}): string[] {
  const grid = rasterizeMark();
  const color = options.color ?? false;
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const lines: string[] = [];

  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = grid[y]?.[x] ?? null;
      const bot = grid[y + 1]?.[x] ?? null;
      const tc = cellColor(top);
      const bc = cellColor(bot);

      if (!color) {
        const strength = Math.max(top ?? 0, bot ?? 0);
        if (strength <= 0) line += " ";
        else if (top && bot) line += strength >= 0.8 ? "█" : strength >= 0.4 ? "▓" : "░";
        else if (top) line += "▀";
        else line += "▄";
        continue;
      }

      if (tc && bc) {
        if (top === bot) line += ansiFg(tc) + "█" + ANSI_RESET;
        else line += ansiFg(tc) + ansiBg(bc) + "▀" + ANSI_RESET;
      } else if (tc) line += ansiFg(tc) + "▀" + ANSI_RESET;
      else if (bc) line += ansiFg(bc) + "▄" + ANSI_RESET;
      else line += " ";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

/** Default CLI tagline. */
export const DEFAULT_TAGLINE = "GitHub screenshot + recording uploads for agents";

/**
 * Brand lockup:
 *   [mark]  uploads.sh
 *   [mark]  GitHub screenshot + recording uploads for agents
 *   [mark]  v0.9.0
 */
export function formatBrandHeader(
  options: {
    color?: boolean;
    label?: string;
    tagline?: string;
    version?: string;
  } = {},
): string {
  const color = options.color ?? false;
  const label = options.label ?? "uploads.sh";
  const tagline = options.tagline ?? DEFAULT_TAGLINE;
  const markLines = renderBrandMarkLines({ color });
  const markWidth = Math.max(...markLines.map((l) => visibleWidth(l)), 1);
  const gap = "  ";

  const paint = (text: string, rgb: Rgb, bold = false) =>
    color
      ? `${bold ? "\u001b[1m" : ""}\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\u001b[0m`
      : text;

  const extras = [
    paint(label, BRAND.fg, true),
    paint(tagline, BRAND.muted),
    options.version ? paint(`v${options.version}`, BRAND.muted) : "",
  ];

  const out: string[] = [];
  const rows = Math.max(markLines.length, extras.filter(Boolean).length);
  for (let i = 0; i < rows; i++) {
    const mark = (markLines[i] ?? "").padEnd(markWidth, " ");
    const extra = extras[i] ? gap + extras[i] : "";
    out.push(mark + extra);
  }
  return out.join("\n") + "\n";
}

/** Strip CSI sequences for display-width (ESC is matched as \x1b for the linter). */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex -- intentional: strip ANSI CSI
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function boxLines(lines: string[], options: { color?: boolean; tone?: Rgb } = {}): string {
  const color = options.color ?? false;
  const tone = options.tone ?? BRAND.accent;
  const width = Math.max(...lines.map((l) => l.length), 1) + 4;
  const bar = "─".repeat(width);
  const pad = (s: string) => s.padEnd(width - 2);

  if (!color) {
    return [`┌${bar}┐`, ...lines.map((l) => `│  ${pad(l)}│`), `└${bar}┘`, ""].join("\n");
  }

  const edge = (s: string) => `\u001b[38;2;${tone.r};${tone.g};${tone.b}m${s}\u001b[0m`;
  const title = (s: string) => `\u001b[1m\u001b[38;2;${tone.r};${tone.g};${tone.b}m${s}\u001b[0m`;
  const cmd = (s: string) =>
    `\u001b[1m\u001b[38;2;${BRAND.fg.r};${BRAND.fg.g};${BRAND.fg.b}m${s}\u001b[0m`;
  const muted = (s: string) =>
    `\u001b[38;2;${BRAND.muted.r};${BRAND.muted.g};${BRAND.muted.b}m${s}\u001b[0m`;

  return [
    edge(`┌${bar}┐`),
    ...lines.map((l, i) => {
      const body = i === 0 ? title(pad(l)) : i === 1 ? cmd(pad(l)) : muted(pad(l));
      return `${edge("│  ")}${body}${edge("│")}`;
    }),
    edge(`└${bar}┘`),
    "",
  ].join("\n");
}

export function formatUpdateBanner(options: {
  current: string;
  latest: string;
  color?: boolean;
}): string {
  return boxLines(
    [`Update available  ${options.current} → ${options.latest}`, `npm i -g @buildinternet/uploads`],
    { color: options.color, tone: BRAND.accent },
  );
}

export function formatAuthBanner(options: { color?: boolean } = {}): string {
  return boxLines(["Sign in via browser", "uploads login"], {
    color: options.color,
    tone: BRAND.red,
  });
}
