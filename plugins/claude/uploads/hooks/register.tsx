import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Attached, BandRow, Binding, FileRef, Staged } from "../types";

const staged = atom({ plugin: "uploads", key: "staged" } as const, null);
const attached = atom({ plugin: "uploads", key: "attached" } as const, null);
const isExpanded = atom({ plugin: "uploads", key: "isExpanded" } as const, false);
// Desktop: JPEG data URIs of the staged images (storage URL -> URI; "" = failed).
const thumbs = atom({ plugin: "uploads", key: "thumbs" } as const, {});
const large = atom({ plugin: "uploads", key: "large" } as const, {});
// The row the pane's detail view shows; null shows the grid.
const preview = atom({ plugin: "uploads", key: "preview" } as const, null);
// The open PR for the session branch, for the pane's feed link.
const openPr = atom({ plugin: "uploads", key: "openPr" } as const, null);
const feedUrl = atom({ plugin: "uploads", key: "feedUrl" } as const, null);
// The staged set the desktop band is hidden for; a change shows it again.
const dismissed = atom({ plugin: "uploads", key: "dismissed" } as const, null);

const PANE = "uploads-staged";
const PANE_TITLE = "Staged attachments";

// Bash commands that can change what is staged for the branch, or which branch it is.
const REFRESH_AFTER =
  /\buploads\s+(attach|put|screenshot|shot|delete)\b|\bgit\s+(checkout|switch|branch\s+-m)\b|\bgh\s+pr\s+create\b/;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const IDLE_REFRESH_MS = 2 * 60 * 1000;
// Long enough for the GitHub App's webhook to promote the files after a PR opens.
const AFTER_PR_REFRESH_MS = 15_000;

const BINDINGS: readonly Binding[] = ["self", "none", "other", "unknown"];

// Before/after pairing, mirroring the attachments comment (comment-render's
// pairAttachments): images only; same `path` metadata with one `state=before`
// and one `state=after`, else filename stems that differ only by the token.
// The band shows each pair as one row, so a missing half shows as a gap.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
const STEM_TOKEN = /(^|[-_.])(before|after)($|[-_.])/i;

type RawFile = {
  key?: unknown;
  filename: string;
  state?: unknown;
  path?: unknown;
  url?: unknown;
  size?: unknown;
  stagedAt?: unknown;
};
type Role = "before" | "after";

/** The uploads.sh file page (preview and details) for a storage URL; else the URL itself. */
const filePage = (url: string): string => {
  const match = /^https:\/\/storage\.uploads\.sh\/(.+)$/.exec(url);
  return match ? `https://uploads.sh/f/${match[1]}` : url;
};

const fileRef = (file: RawFile): FileRef => ({
  key: typeof file.key === "string" ? file.key : file.filename,
  name: file.filename,
  url: typeof file.url === "string" ? filePage(file.url) : null,
  src: typeof file.url === "string" ? file.url : null,
  size: typeof file.size === "number" ? file.size : null,
  stagedAt: typeof file.stagedAt === "string" ? file.stagedAt : null,
});

/** A file's before/after role and the key its other half shares, or null for neither. */
const roleOf = (file: RawFile): { role: Role; key: string; label: string } | null => {
  if (!IMAGE_EXT.test(file.filename)) {
    return null;
  }
  const dot = file.filename.lastIndexOf(".");
  const stem = file.filename.slice(0, dot);
  const meta = typeof file.state === "string" ? file.state.trim().toLowerCase() : "";
  const path = typeof file.path === "string" ? file.path.trim() : "";
  const token = STEM_TOKEN.exec(stem);
  const role: Role | null =
    meta === "before" || meta === "after" ? meta : token ? (token[2]!.toLowerCase() as Role) : null;
  if (role === null) {
    return null;
  }
  // Only a file with nothing to pair on stands alone under its own name.
  const solo = { role, key: `solo:${file.filename}`, label: stem };
  if (path && path !== "/") {
    return meta === role ? { role, key: `path:${path}`, label: path } : solo;
  }
  if (!token) {
    return solo;
  }
  const end = token.index + token[1]!.length + token[2]!.length;
  const base =
    token[1]!.length > 0
      ? stem.slice(0, token.index) + stem.slice(end)
      : stem.slice(end + token[3]!.length);
  return {
    role,
    key: `stem:${base.toLowerCase()}${file.filename.slice(dot).toLowerCase()}`,
    label: base,
  };
};

/** The band's rows in staged order: a pair (either half may be missing), or a plain file. */
const toRows = (files: readonly RawFile[]): BandRow[] => {
  const order: (string | RawFile)[] = [];
  const groups = new Map<string, { label: string; before: RawFile[]; after: RawFile[] }>();
  for (const file of files) {
    const found = roleOf(file);
    if (found === null) {
      order.push(file);
      continue;
    }
    let group = groups.get(found.key);
    if (!group) {
      group = { label: found.label, before: [], after: [] };
      groups.set(found.key, group);
      order.push(found.key);
    }
    group[found.role].push(file);
  }
  return order.flatMap((entry): BandRow[] => {
    if (typeof entry !== "string") {
      return [{ kind: "file", file: fileRef(entry) }];
    }
    const { label, before, after } = groups.get(entry)!;
    // More than one of a side is ambiguous, as in the comment: no pairing, one row each.
    if (before.length > 1 || after.length > 1) {
      return [
        ...before.map((f): BandRow => ({ kind: "pair", label, before: fileRef(f), after: null })),
        ...after.map((f): BandRow => ({ kind: "pair", label, before: null, after: fileRef(f) })),
      ];
    }
    return [
      {
        kind: "pair",
        label,
        before: before[0] ? fileRef(before[0]) : null,
        after: after[0] ? fileRef(after[0]) : null,
      },
    ];
  });
};

/** How many staged files a row stands for. */
const filesIn = (row: BandRow): number =>
  row.kind === "file" ? 1 : (row.before ? 1 : 0) + (row.after ? 1 : 0);

// The terminal's expanded band lists at most this many rows.
const MAX_ROWS = 8;

const formatSize = (bytes: number | null): string =>
  bytes === null ? "" : bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

const parseStaged = (stdout: string): Staged | null => {
  try {
    const doc = JSON.parse(stdout);
    if (
      typeof doc?.repo !== "string" ||
      typeof doc?.branch !== "string" ||
      !Array.isArray(doc?.files)
    ) {
      return null;
    }
    const state = doc.binding?.state;
    const files: RawFile[] = doc.files.filter(
      (f: { filename?: unknown }) => typeof f?.filename === "string",
    );
    return {
      repo: doc.repo,
      branch: doc.branch,
      count: doc.files.length,
      rows: toRows(files),
      binding: BINDINGS.includes(state) ? state : "unknown",
      autoAttach: doc.binding?.autoAttach === true,
    };
  } catch {
    return null;
  }
};

/**
 * What `uploads attach --promote --json` promoted and skipped, or null when it
 * printed nothing usable (the server call failed, or the output isn't JSON).
 */
const parsePromotion = (stdout: string | null): { promoted: number; skipped: number } | null => {
  try {
    const promotion = JSON.parse(stdout ?? "")?.promotion;
    if (!Array.isArray(promotion?.promoted) || !Array.isArray(promotion?.skipped)) {
      return null;
    }
    return { promoted: promotion.promoted.length, skipped: promotion.skipped.length };
  } catch {
    return null;
  }
};

/** The last PR URL in `gh pr create` output, which prints it on success. */
const parsePrUrl = (text: string | undefined): { repo: string; pr: number } | null => {
  const matches = [...(text ?? "").matchAll(PR_URL)];
  const [, repo, pr] = matches.at(-1) ?? [];
  return repo && pr ? { repo, pr: Number(pr) } : null;
};

// The uploads.sh accent (#c27eff) mixed half and half with the site's muted
// text (#b3b3ad): a faded purple that marks the row without shouting.
const BRAND = "#bb98d6";
// An unpaired before or after: a missing half the reader should notice.
const WARN = "#e5b567";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63]! : "=";
  }
  return out;
};

// The favicon's mark: three stacked pixel chevrons fading downward, drawn as
// 16×16 RGBA from favicon.svg's 32-unit grid (one pixel per two units).
const MARK = (() => {
  const size = 16;
  const pixels = new Uint8Array(size * size * 4);
  const blocks = [
    [7, 2],
    [5, 3],
    [9, 3],
    [3, 4],
    [11, 4],
  ] as const;
  const rows = [
    [0, 255],
    [4, 140],
    [8, 71],
  ] as const;
  for (const [dy, alpha] of rows) {
    for (const [x, y] of blocks) {
      for (const [i, j] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        pixels.set([0xbb, 0x98, 0xd6, alpha], ((y + dy + j) * size + x + i) * 4);
      }
    }
  }
  return { rgba: toBase64(pixels), width: size, height: size };
})();

const attachments = (n: number) => (n === 1 ? "1 attachment" : `${n} attachments`);

type Line = { text: string; warn: boolean };

/** What the staged attachments are waiting for, by the repo's link to a workspace. */
const headline = (view: Staged): Line => {
  const n = attachments(view.count);
  if (view.binding === "other") {
    return { text: `${n} won't attach: repo linked to another workspace`, warn: true };
  }
  if (view.binding === "none") {
    return { text: `${n} waiting for a PR · link the repo to auto-attach`, warn: false };
  }
  return { text: `${n} waiting for a PR`, warn: false };
};

/** The band's one line for the session branch, or null to show nothing. */
const bandLine = (view: Staged, done: Attached | null): Line | null => {
  if (view.count > 0) {
    return headline(view);
  }
  if (done?.branch !== view.branch || done.repo !== view.repo) {
    return null;
  }
  const n = attachments(done.count);
  return {
    text:
      done.via === "app"
        ? `${n} sent to PR #${done.pr} via the uploads-sh bot`
        : `${n} added to PR #${done.pr}`,
    warn: false,
  };
};

// ---- desktop thumbnails and the pane ------------------------------------------

const STORAGE = "https://storage.uploads.sh/";

/** The files in a row, before first. */
const filesOf = (row: BandRow): FileRef[] =>
  row.kind === "file" ? [row.file] : [row.before, row.after].filter((f): f is FileRef => !!f);

/** Identifies a staged set: the desktop band hides for it and returns when it changes. */
const setKey = (view: Staged): string =>
  `${view.repo}#${view.branch}#${(Array.isArray(view.rows) ? view.rows : [])
    .flatMap((row) => filesOf(row).map((f) => f.key))
    .join(",")}`;

// A resized JPEG of a storage image, through Cloudflare's image transform.
const transformed = (src: string, width: number, quality: number): string =>
  src.startsWith(STORAGE) && !src.toLowerCase().endsWith(".svg")
    ? `${STORAGE}cdn-cgi/image/width=${width},fit=scale-down,format=jpeg,quality=${quality}/${src.slice(STORAGE.length)}`
    : src;

const embedUrl = (src: string): string =>
  src.startsWith(STORAGE) ? `https://embed.uploads.sh/${src.slice(STORAGE.length)}` : src;

// A JPEG of `src` as a data URI: the desktop draws Svg as an isolated image, so
// it can't load a remote URL. Null when the fetch fails or the result is too big.
async function fetchUri(
  $: EngineInterface,
  src: string,
  width: number,
  quality: number,
): Promise<string | null> {
  const b64 = await run(
    $,
    ["sh", "-c", 'curl -sfL --max-time 15 "$1" | base64', "sh", transformed(src, width, quality)],
    20_000,
  );
  const body = b64?.replace(/\s+/g, "") ?? "";
  return body && body.length <= 120_000 ? `data:image/jpeg;base64,${body}` : null;
}

const imageFiles = (rows: readonly BandRow[]): FileRef[] =>
  rows.flatMap(filesOf).filter((f) => !!f.src && IMAGE_EXT.test(f.name));

// Fetches thumbnails not yet cached; a failure is remembered as "" (drawn as a file card).
async function loadThumbs($: EngineInterface, rows: readonly BandRow[]): Promise<void> {
  for (const file of imageFiles(rows)) {
    if (file.src! in (await read($, thumbs))) {
      continue;
    }
    const uri = await fetchUri($, file.src!, 360, 70);
    await update($, thumbs, (t) => ({ ...t, [file.src!]: uri ?? "" }));
  }
}

async function loadLarge($: EngineInterface, row: BandRow): Promise<void> {
  for (const file of imageFiles([row])) {
    if (file.src! in (await read($, large))) {
      continue;
    }
    const uri = (await fetchUri($, file.src!, 1100, 72)) ?? (await fetchUri($, file.src!, 760, 60));
    if (uri) {
      await update($, large, (t) => ({ ...t, [file.src!]: uri }));
    }
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The mark as vector art, for the desktop band: the same chevrons as MARK.
const MARK_SVG = (() => {
  const blocks = [
    [7, 2],
    [5, 3],
    [9, 3],
    [3, 4],
    [11, 4],
  ] as const;
  const rows = [
    [0, 1],
    [4, 0.55],
    [8, 0.28],
  ] as const;
  const rects = rows
    .flatMap(([dy, a]) =>
      blocks.map(
        ([x, y]) =>
          `<rect x="${x}" y="${y + dy}" width="2" height="2" fill="${BRAND}" fill-opacity="${a}"/>`,
      ),
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${rects}</svg>`;
})();

// `uri`: a data URI to draw; null while loading; "" when there is no inline
// preview (not an image, or the thumbnail failed), drawn as a file card.
type Slot = { uri: string | null; chip: string | null; ext: string };

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 5)
    : "FILE";
};

// A file card: a page glyph with a folded corner and the extension under it.
const fileCard = (x: number, w: number, h: number, ext: string, path: string): string => {
  const g = Math.min(h * 0.34, w * 0.3);
  const gx = x + w / 2 - g * 0.4;
  const gy = h / 2 - g * 0.75;
  const f = g * 0.28;
  const small = h < 40;
  const glyph = small
    ? ""
    : `<path d="M${gx},${gy} h${g * 0.8 - f} l${f},${f} v${g - f} h${-g * 0.8} Z M${gx + g * 0.8 - f},${gy} v${f} h${f}" fill="none" stroke="#8889" stroke-width="1.5" stroke-linejoin="round"/>`;
  const label = `<text x="${x + w / 2}" y="${small ? h / 2 + 3.5 : gy + g + 18}" text-anchor="middle" font-size="${small ? 9 : 12}" font-weight="600" letter-spacing="0.5" font-family="system-ui,-apple-system,sans-serif" fill="#888">${esc(ext)}</text>`;
  return `<path d="${path}" fill="#8881"/>${glyph}${label}`;
};

// Images side by side with a hairline gap, each clipped to a rounded frame, so a
// pair reads as one card. A chip names each half when `chips` is set.
const tileSvg = (slots: readonly Slot[], w: number, h: number, chips: boolean): string => {
  const gap = 2;
  const total = slots.length * w + (slots.length - 1) * gap;
  const r = h > 40 ? 6 : 3;
  const body = slots
    .map((s, i) => {
      const x = i * (w + gap);
      const left = i === 0;
      const right = i === slots.length - 1;
      // Outer corners rounded, inner edges square.
      const path =
        `M${x + (left ? r : 0)},0 H${x + w - (right ? r : 0)} ` +
        (right
          ? `A${r},${r} 0 0 1 ${x + w},${r} V${h - r} A${r},${r} 0 0 1 ${x + w - r},${h} `
          : `V${h} `) +
        `H${x + (left ? r : 0)} ` +
        (left ? `A${r},${r} 0 0 1 ${x},${h - r} V${r} A${r},${r} 0 0 1 ${x + r},0 Z` : `V0 Z`);
      const img =
        s.uri === ""
          ? fileCard(x, w, h, s.ext, path)
          : s.uri
            ? `<image href="${esc(s.uri)}" x="${x}" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMin slice" clip-path="url(#k${i})"/>`
            : `<path d="${path}" fill="#8882"/>`;
      const chip =
        chips && s.chip
          ? `<rect x="${x + 6}" y="${h - 22}" width="${s.chip.length * 6.4 + 12}" height="16" rx="8" fill="#000b"/>` +
            `<text x="${x + 12}" y="${h - 10.5}" font-size="10" font-family="system-ui,-apple-system,sans-serif" font-weight="600" fill="#fff">${s.chip}</text>`
          : "";
      return `<clipPath id="k${i}"><path d="${path}"/></clipPath>${img}<path d="${path}" fill="none" stroke="#8884"/>${chip}`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${h}" width="${total}" height="${h}">${body}</svg>`;
};

const roleName = (row: BandRow, file: FileRef): "Before" | "After" | null =>
  row.kind === "pair" ? (file === row.before ? "Before" : "After") : null;

const slotsOf = (row: BandRow, t: Record<string, string>): Slot[] =>
  filesOf(row).map((f) => ({
    uri: !f.src || !IMAGE_EXT.test(f.name) ? "" : (t[f.src] ?? null),
    chip: roleName(row, f),
    ext: extOf(f.name),
  }));

const labelOf = (row: BandRow): string => (row.kind === "file" ? row.file.name : row.label);

// Shortens the middle of a name to `max` characters, keeping the extension end.
const fit = (name: string, max: number): string => {
  if (name.length <= max) {
    return name;
  }
  const tail = Math.min(8, Math.floor((max - 1) / 2));
  return `${name.slice(0, max - 1 - tail)}…${name.slice(name.length - tail)}`;
};
// Characters that fit beside the staged time under a tile of this many images.
const captionRoom = (row: BandRow): number => (filesOf(row).length > 1 ? 40 : 17);

// When the row's newest file was staged, as "5m ago".
const agoOf = (row: BandRow, now: number): string => {
  const times = filesOf(row)
    .map((f) => (f.stagedAt ? Date.parse(f.stagedAt) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (times.length === 0) {
    return "";
  }
  const s = Math.max(0, Math.round((now - Math.max(...times)) / 1000));
  if (s < 60) {
    return "just now";
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  return s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

const markdownOf = (rows: readonly BandRow[]): string =>
  rows
    .flatMap((row) =>
      filesOf(row).map((f) => {
        const role = roleName(row, f);
        const alt = role ? `${labelOf(row)} (${role.toLowerCase()})` : labelOf(row);
        return f.src ? `![${alt}](${embedUrl(f.src)})` : "";
      }),
    )
    .filter(Boolean)
    .join("\n");

const BAND_TILES = 4;
const TILE_W = 168;
const TILE_H = 105;

async function openPane($: EngineInterface, title = PANE_TITLE): Promise<void> {
  await $.ui.open({ id: PANE, title });
}

// Shows the pane's grid, fetching the thumbnails it will draw.
async function showGrid($: EngineInterface): Promise<void> {
  await update($, preview, () => null);
  await openPane($);
  const view = await read($, staged);
  if (view && Array.isArray(view.rows)) {
    void loadThumbs($, view.rows).catch(() => undefined);
  }
}

// The pane swaps its grid for one row, large; "All attachments" returns to the grid.
async function showRow($: EngineInterface, row: BandRow): Promise<void> {
  await update($, preview, () => row);
  await openPane($, labelOf(row));
  void loadLarge($, row).catch(() => undefined);
}

async function removeRow($: EngineInterface, row: BandRow): Promise<void> {
  for (const file of filesOf(row)) {
    await run($, ["uploads", "delete", file.key], 30_000);
  }
  await refreshBand($);
}

async function copyText(
  $: EngineInterface,
  surface: Parameters<EngineInterface["ui"]["copy"]>[0]["surface"],
  text: string,
  what: string,
): Promise<void> {
  await $.ui.copy({ text, surface });
  $.ui.toast(`Copied ${what}`);
}

// The PR's live feed link: created on first use through the CLI, then kept.
async function copyFeedLink(
  $: EngineInterface,
  surface: Parameters<EngineInterface["ui"]["copy"]>[0]["surface"],
  view: Staged,
  pr: { number: number },
): Promise<void> {
  let url = await read($, feedUrl);
  if (!url) {
    const out = await run(
      $,
      ["uploads", "feed", "create", "--repo", view.repo, "--pr", String(pr.number)],
      30_000,
    );
    url = out?.trim().split("\n")[0] || null;
    if (!url) {
      $.ui.toast("Couldn't get the PR feed link");
      return;
    }
    await update($, feedUrl, () => url);
  }
  await copyText($, surface, url, "the PR feed link");
}

let lastRefresh = 0;

// Runs a command; null when it can't start, times out, or exits non-zero.
async function run(
  $: EngineInterface,
  argv: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { timeoutMs });
    return ran.exitCode === 0 ? ran.stdout : null;
  } catch {
    return null;
  }
}

// Reads staged files through the CLI; a missing CLI, a directory outside a
// git repo, or a signed-out CLI all read as null. With no `scope` the CLI
// resolves the session directory's branch and repo.
async function fetchStaged(
  $: EngineInterface,
  scope: { branch: string; repo: string } | null,
): Promise<Staged | null> {
  const argv = ["uploads", "staged", "--format", "json"];
  if (scope) {
    argv.push("--branch", scope.branch, "--repo", scope.repo);
  }
  const stdout = await run($, argv, 15_000);
  return stdout === null ? null : parseStaged(stdout);
}

// The open PR for the session directory's branch, for the pane's feed link.
async function fetchOpenPr($: EngineInterface): Promise<{ number: number; url: string } | null> {
  const stdout = await run($, ["gh", "pr", "view", "--json", "number,url,state"], 15_000);
  try {
    const doc = JSON.parse(stdout ?? "");
    return typeof doc?.number === "number" && doc.state === "OPEN"
      ? { number: doc.number, url: String(doc.url) }
      : null;
  } catch {
    return null;
  }
}

// Refreshes what the band shows: the session directory's branch.
async function refreshBand($: EngineInterface): Promise<void> {
  const view = await fetchStaged($, null);
  await update($, staged, () => view);
  const pr = view && view.count > 0 ? await fetchOpenPr($) : null;
  if ((await read($, openPr))?.number !== pr?.number) {
    await update($, feedUrl, () => null);
  }
  await update($, openPr, () => pr);
  if (view) {
    await loadThumbs($, view.rows.slice(0, BAND_TILES));
  }
}

// Schedules a band refresh outside the current dispatch, so no tool result waits on it.
async function kick($: EngineInterface, ms = 0): Promise<void> {
  lastRefresh = await $.clock.now();
  $.clock.after(ms, () => void refreshBand($).catch(() => undefined));
}

// The PR's head branch. The Bash call may have run in another directory
// (a `cd`, or a subagent's worktree), so the session's branch can't stand in.
async function prHead($: EngineInterface, repo: string, pr: number): Promise<string | null> {
  const argv = [
    "gh",
    "pr",
    "view",
    String(pr),
    "--repo",
    repo,
    "--json",
    "headRefName",
    "-q",
    ".headRefName",
  ];
  const head = (await run($, argv, 15_000))?.trim();
  return head ? head : null;
}

type Outcome = {
  toast: string;
  context?: string;
  record?: Omit<Attached, "pr" | "repo" | "branch">;
};

export const register: Register = (on, options) => {
  const autoPromote = options.autoPromote !== false;

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "uploads-staged",
      description: "Show the attachments staged on uploads.sh for this branch",
    });
    await kick($);
    return next(e);
  });

  on("command.run", { command: "uploads-staged" }, async ($) => {
    await refreshBand($);
    await showGrid($);
    return { text: "Opened the staged attachments pane." };
  });

  on("turn.complete", async ($, e, next) => {
    if ((await $.clock.now()) - lastRefresh > IDLE_REFRESH_MS) {
      await kick($);
    }
    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const ran = await next(e);
    if (!REFRESH_AFTER.test(e.command)) {
      return ran;
    }
    if (!PR_CREATE.test(e.command) || ran.deny !== undefined || ran.isError === true) {
      await kick($);
      return ran;
    }

    const target = parsePrUrl(ran.text);
    await kick($, AFTER_PR_REFRESH_MS);
    if (!target) {
      return ran;
    }
    const head = await prHead($, target.repo, target.pr);
    if (!head) {
      return ran;
    }

    // What the band last saw for this branch, before the GitHub App could act.
    const before = await read($, staged);
    const prior = before?.repo === target.repo && before.branch === head ? before.count : 0;
    const view = await fetchStaged($, { branch: head, repo: target.repo });
    if (!view) {
      return ran;
    }

    const pr = `PR #${target.pr}`;
    const promoteArgv = [
      "uploads",
      "attach",
      "--promote",
      "--pr",
      String(target.pr),
      "--repo",
      target.repo,
      "--from-branch",
      head,
    ];
    const command = promoteArgv.join(" ");
    const files = attachments(view.count);

    let outcome: Outcome | null = null;
    if (view.count === 0) {
      // The App's webhook already promoted them between the PR opening and this read.
      if (prior > 0 && view.autoAttach) {
        outcome = {
          toast: `uploads: ${attachments(prior)} added to ${pr} by the uploads-sh bot`,
          context: `uploads: the GitHub App added the ${attachments(prior)} for ${head} to ${pr}. Don't re-upload them.`,
          record: { count: prior, via: "app" },
        };
      }
    } else if (view.binding === "other") {
      outcome = {
        toast: `uploads: ${files} won't attach to ${pr}: this repo is linked to another workspace`,
      };
    } else if (view.autoAttach) {
      outcome = {
        toast: `uploads: ${files} will attach to ${pr} via the uploads-sh bot`,
        context: `uploads: the GitHub App attaches the ${files} for ${head} to ${pr}. Don't re-upload them.`,
        record: { count: view.count, via: "app" },
      };
    } else if (!autoPromote) {
      outcome = {
        toast: `uploads: ${files} waiting for ${pr}; run ${command}`,
        context: `uploads: ${files} for ${head} are staged but not attached to ${pr}. To attach them, run \`${command}\`.`,
      };
    } else {
      // The command exits 0 even when the server call failed, so trust only
      // the `promotion` it reports: what moved, and what it skipped.
      const result = parsePromotion(await run($, [...promoteArgv, "--json"], 60_000));
      if (result === null || result.promoted === 0) {
        outcome = {
          toast: `uploads: couldn't add ${files} to ${pr}; run uploads attach --promote`,
          context: `uploads: ${files} for ${head} did not attach to ${pr}. Run \`${command}\`.`,
        };
      } else if (result.skipped > 0) {
        const moved = attachments(result.promoted);
        outcome = {
          toast: `uploads: added ${moved} to ${pr}; ${result.skipped} skipped`,
          context: `uploads: added ${moved} for ${head} to ${pr}; ${result.skipped} ${result.skipped === 1 ? "was" : "were"} skipped. Run \`${command}\` to retry them.`,
          record: { count: result.promoted, via: "cli" },
        };
      } else {
        outcome = {
          toast: `uploads: added ${attachments(result.promoted)} to ${pr}`,
          context: `uploads: added ${attachments(result.promoted)} for ${head} to ${pr}'s attachments comment. Don't re-upload them.`,
          record: { count: result.promoted, via: "cli" },
        };
        // Nothing is left staged for the head; the scheduled refresh confirms it.
        await update($, staged, (s) =>
          s?.repo === target.repo && s.branch === head ? { ...s, count: 0, rows: [] } : s,
        );
      }
    }
    if (outcome === null) {
      return ran;
    }

    $.ui.toast(outcome.toast);
    const { record } = outcome;
    if (record) {
      await update(
        $,
        attached,
        (): Attached => ({ ...record, repo: target.repo, branch: head, pr: target.pr }),
      );
    }
    return outcome.context ? { ...ran, context: [...(ran.context ?? []), outcome.context] } : ran;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const view = await read($, staged);
    if (e.props.hasSurvey || view === null) {
      return next(e);
    }
    const line = bandLine(view, await read($, attached));
    if (line === null) {
      return next(e);
    }
    // State saved by an older version of this module has no `rows`.
    const rows = Array.isArray(view.rows) ? view.rows : [];

    if (e.surface === "desktop") {
      const { Box, Button, Svg, Text } = $.ui.resolve(e);
      // Hidden until the staged set changes.
      if (view.count > 0 && (await read($, dismissed)) === setKey(view)) {
        return next(e);
      }
      const t = await read($, thumbs);
      return (
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={MARK_SVG} alt="uploads" width={14} height={14} />
            <Text color={BRAND} bold>
              uploads
            </Text>
            <Text color={line.warn ? WARN : undefined} dimColor={!line.warn}>
              {line.text}
            </Text>
          </Box>
          {view.count > 0 && (
            <Box flexDirection="row" alignItems="center" gap={1}>
              {rows.slice(0, BAND_TILES).map((row, i) => (
                <Svg
                  key={`tile-${i}`}
                  source={tileSvg(slotsOf(row, t), 40, 25, false)}
                  alt={labelOf(row)}
                  height={25}
                />
              ))}
              {rows.length > BAND_TILES && <Text dimColor>+{rows.length - BAND_TILES}</Text>}
              <Button key="view" label="View" plain dimColor onPress={() => void showGrid($)} />
              <Button
                key="hide"
                label="Hide"
                role="dismiss"
                onPress={() => void update($, dismissed, () => setKey(view))}
              />
            </Box>
          )}
        </Box>
      );
    }

    const els = $.ui.resolve(e);
    const { Box, Button, Link, Text } = els;
    const Image = "Image" in els ? els.Image : null;
    const canExpand = rows.length > 0;
    const expanded = canExpand && (await read($, isExpanded));
    // The header row takes one line, and a "+N more" row may take another.
    const shown = expanded
      ? rows.slice(0, Math.min(MAX_ROWS, Math.max(1, e.props.maxRows - 2)))
      : [];
    const more = view.count - shown.reduce((sum, row) => sum + filesIn(row), 0);

    // A file as a link named by `label`, or plain text when the CLI gave no URL.
    const fileLink = (file: FileRef, label: string) =>
      file.url ? <Link href={file.url} label={label} /> : <Text>{label}</Text>;
    // One side of a pair: a link to that file, or an amber dash where it's missing.
    const half = (file: FileRef | null, role: "before" | "after") =>
      file ? fileLink(file, role) : <Text color={WARN}>—</Text>;

    // The engine's own `[-]` at the row's end collapses the band, so it needs no hide control.
    return (
      <Box flexDirection="column">
        <Box>
          {Image ? (
            <Image key="mark" source={MARK} columns={2} rows={1} alt="⇡" />
          ) : (
            <Text color={BRAND}>⇡</Text>
          )}
          <Text color={BRAND} bold>
            {" uploads "}
          </Text>
          {canExpand && (
            <Button
              key="files"
              plain
              label={expanded ? "▾" : "▸"}
              onPress={() => update($, isExpanded, (open) => !open)}
            />
          )}
          <Text color={line.warn ? WARN : undefined} dimColor={!line.warn}>
            {" "}
            {line.text}
          </Text>
        </Box>
        {shown.map((row, i) =>
          row.kind === "file" ? (
            <Box key={`file-${i}`}>
              <Text dimColor>{"  · "}</Text>
              {fileLink(row.file, row.file.name)}
              <Text dimColor> {formatSize(row.file.size)}</Text>
            </Box>
          ) : (
            <Box key={`pair-${i}`}>
              <Text dimColor>{"  · "}</Text>
              <Text>{row.label} </Text>
              {half(row.before, "before")}
              <Text dimColor>{" → "}</Text>
              {half(row.after, "after")}
              {/* A lone half's size; a full pair needs none. */}
              {(row.before === null) !== (row.after === null) && (
                <Text dimColor> {formatSize((row.before ?? row.after)!.size)}</Text>
              )}
            </Box>
          ),
        )}
        {expanded && more > 0 && <Text dimColor>{`  + ${more} more (uploads staged)`}</Text>}
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e);
    const { Box, Button, Link, Text } = els;
    const Svg = "Svg" in els ? els.Svg : null;
    const desktop = e.surface === "desktop" && Svg !== null;
    const chosen = await read($, preview);

    // One row, large, in the same pane as the grid.
    if (chosen) {
      const big = await read($, large);
      const small = await read($, thumbs);
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Button
              key="back"
              label="← All attachments"
              plain
              dimColor
              onPress={() => void showGrid($)}
            />
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Button
                key="copy-row"
                label="Copy markdown"
                onPress={(p) => void copyText($, p.surface, markdownOf([chosen]), "markdown")}
              />
              <Button
                key="remove"
                label="Remove"
                onPress={async () => {
                  await removeRow($, chosen);
                  await showGrid($);
                }}
              />
            </Box>
          </Box>
          <Text bold>{labelOf(chosen)}</Text>
          {filesOf(chosen).map((f) => {
            const link = f.url ? <Link href={f.url} label="Open on uploads.sh" /> : null;
            const previewable = !!f.src && IMAGE_EXT.test(f.name) && small[f.src] !== "";
            if (!previewable) {
              return (
                <Box key={f.key} flexDirection="column" gap={1}>
                  {desktop && (
                    <Svg
                      source={tileSvg(
                        [{ uri: "", chip: null, ext: extOf(f.name) }],
                        480,
                        200,
                        false,
                      )}
                      alt={f.name}
                    />
                  )}
                  <Box flexDirection="row" alignItems="center" gap={1}>
                    <Text dimColor>{f.name} can't be previewed here.</Text>
                    {link}
                  </Box>
                </Box>
              );
            }
            const uri = big[f.src!] ?? small[f.src!] ?? null;
            const role = roleName(chosen, f);
            return (
              <Box key={f.key} flexDirection="column">
                <Box flexDirection="row" alignItems="center" gap={1}>
                  {role ? <Text bold>{role}</Text> : null}
                  {link}
                </Box>
                {desktop && (
                  <Svg
                    source={tileSvg([{ uri, chip: null, ext: extOf(f.name) }], 1000, 625, false)}
                    alt={f.name}
                  />
                )}
              </Box>
            );
          })}
        </Box>
      );
    }

    const view = await read($, staged);
    const rows = view && Array.isArray(view.rows) ? view.rows : [];
    if (!view || view.count === 0) {
      return <Text dimColor>Nothing staged for this branch.</Text>;
    }
    const t = await read($, thumbs);
    const pr = await read($, openPr);
    const feed = await read($, feedUrl);
    const line = headline(view);
    const now = await $.clock.now();

    return (
      <Box flexDirection="column" gap={1}>
        {/* Header: where these go, and the links worth sharing. */}
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold color={line.warn ? WARN : undefined}>
              {line.text}
            </Text>
            <Text dimColor>
              {view.repo} · {view.branch}
            </Text>
          </Box>
          {pr ? (
            <Button
              key="feed"
              label="Copy link"
              variant="primary"
              onPress={(p) => void copyFeedLink($, p.surface, view, pr)}
            />
          ) : null}
          <Button
            key="copy-all"
            label="Copy markdown"
            onPress={(p) =>
              void copyText($, p.surface, markdownOf(rows), "markdown for all attachments")
            }
          />
        </Box>
        {pr && feed ? <Link href={feed} label={feed} /> : null}

        {/* Tiles: a pair is one card, before and after side by side. */}
        <Box flexDirection="row" flexWrap="wrap" gap={2}>
          {rows.map((row, i) => (
            <Box key={`tile-${i}`} flexDirection="column" gap={0}>
              {desktop && (
                <Svg source={tileSvg(slotsOf(row, t), TILE_W, TILE_H, true)} alt={labelOf(row)} />
              )}
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Button
                  key={`name-${i}`}
                  label={fit(labelOf(row), captionRoom(row))}
                  plain
                  onPress={() => void showRow($, row)}
                />
                <Text dimColor>{agoOf(row, now)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={2} gap={0}>
          <Text dimColor>Hosted on uploads.sh, not committed to the repo.</Text>
          <Text dimColor>They will appear in a comment on the pull request once opened.</Text>
        </Box>
      </Box>
    );
  });
};
