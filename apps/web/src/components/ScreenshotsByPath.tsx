/**
 * Screenshots grouped by `path` metadata (spec:
 * docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md).
 * Overview = one `files/by-path` fetch; `?project=` / `?q=` filter that
 * payload in the toolbar (project select + path input). Drill-in (?path=)
 * = the existing `files/search?meta.path=…` route. Files without `path`
 * metadata never appear here — the empty state says how to get them.
 *
 * SSR-first (plan 006, following plan 005's `WorkspaceFileTable` shape):
 * when the request carries a session, `screenshots.astro` server-fetches the
 * by-path overview + workspace summary and renders this component with no
 * `client:*` directive, so first paint has real groups instead of the
 * loading skeleton. A manual `hydrateRoot` mount (same lifecycle every
 * sibling workspace tab uses) attaches interactivity afterwards. Only the
 * OVERVIEW is server-seeded — the GitHub-mirrored section and the `?path=`
 * drill-in still fetch client-side, unchanged.
 */
import { Callout, Input, Select } from "@uploads/ui";
import "@uploads/ui/styles.css";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { IslandErrorBoundary } from "./IslandErrorBoundary";
import {
  getWorkspaceFilesByPath,
  searchWorkspaceFiles,
  type FilesPathGroup,
  type LatestShotItem,
  type PathCatalogEntry,
  type PathGroupItem,
  type ProjectSummary,
  type SearchFileItem,
} from "../lib/api-client";
import { loadWorkspaces } from "../lib/workspaces-nav";
import { resolveWorkspaceInfo, type WorkspaceInfoStatus } from "../lib/workspace-file-row";
import { thumbUrl } from "../lib/thumb-url";
import { onSession } from "../lib/account-shell";
import { makeFileOpener, newTabLinkProps, type FileOpener } from "../lib/file-opener";
import {
  backfillTargets,
  filterCatalog,
  groupsFromCatalog,
  isRepoLabel,
  lastUpdatedLabel,
  leafName,
  pairedShotKeys,
  pathQueryMatches,
  pathSuggestions,
  projectLabelFromItemMeta,
  readScreenshotsView,
  screenshotsSearch,
  shotKindFromKey,
  shotPreviewCaption,
  shotPreviewPosition,
  shotsFromSearchItems,
  type ScreenshotsFeed,
  type ScreenshotsView,
} from "../lib/workspace-screenshots";

/** How many path groups a project section previews before "view project →". */
const PREVIEW_PATHS_PER_PROJECT = 3;

const EMPTY_CTA_CMD = "uploads screenshot https://app.example/settings";

/**
 * Gallery-style empty state (renderGalleriesEmptyHtml's markup, React-side):
 * a title and ONE copyable command, nothing else competing for attention —
 * the rail tip carries the how-grouping-works detail.
 */
function EmptyShotsCta({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(EMPTY_CTA_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked — leave the label
    }
  };
  return (
    <div className="ws-empty-state ws-empty-state--cta">
      <p className="ws-empty-state__title">{title}</p>
      <div className="command ws-empty__command">
        <code>{EMPTY_CTA_CMD}</code>
        <button type="button" aria-live="polite" onClick={() => void copy()}>
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
    </div>
  );
}

interface ScreenshotsByPathProps {
  apiOrigin: string;
  workspace: string;
  /**
   * `location.search` at server-render time (plan 006) — seeds the
   * `?project=`/`?path=` `view` state the same way `window.location.search`
   * does client-side. Pass `Astro.url.search` from the frontmatter so the
   * server's render and the client's very first render agree; omit for the
   * pre-existing client-only-mount behavior (falls back to `window`).
   */
  initialSearch?: string;
  /** Server-fetched by-path overview, when available. */
  initialOverview?: OverviewState;
  /** Server-resolved workspace-info status, when available. */
  initialInfo?: WorkspaceInfoStatus;
}

export type OverviewState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      groups: FilesPathGroup[];
      catalog: PathCatalogEntry[];
      projects: ProjectSummary[];
      latest: LatestShotItem[];
      truncated: boolean;
      catalogTruncated: boolean;
    };

type DrillState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: SearchFileItem[]; truncated: boolean };

/** Extension label for a generic (non-image, non-embeddable) tile. */
function extLabel(key: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  return match ? match[1].toLowerCase() : "file";
}

// ── Small GitHub glyphs (Octicons, 16-grid paths at 12px) ──────────────

function GitHubMark({ size = 12 }: { size?: number }) {
  return (
    <svg
      className="wsp-ghicon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** Pull-request or issue-opened Octicon for a `gh.kind` value; null otherwise. */
function GhKindIcon({ kind, size = 10 }: { kind: string | undefined; size?: number }) {
  if (kind === "pull") {
    return (
      <svg
        className="wsp-ghicon"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      </svg>
    );
  }
  if (kind === "issue" || kind === "issues") {
    return (
      <svg
        className="wsp-ghicon"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
        <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
      </svg>
    );
  }
  return null;
}

/** "PR #7" / "Issue #3", plus the author when present. */
function ghLabel(item: SearchFileItem): string {
  const kind = item.metadata["gh.kind"];
  const number = item.metadata["gh.number"];
  // Stored vocabulary is singular ("issue"), matching the CLI and
  // deriveGithubContext (routes/public-files.ts) — "issues" is kept too for
  // robustness against any pre-migration row still carrying the old value.
  const kindLabel = kind === "pull" ? "PR" : kind === "issue" || kind === "issues" ? "Issue" : kind;
  const numberLabel = number ? `#${number}` : "";
  const base = [kindLabel, numberLabel].filter(Boolean).join(" ") || "GitHub";
  const author = item.metadata["gh.author"];
  return author ? `${base} · ${author}` : base;
}

// ── Thumb tile ─────────────────────────────────────────────────────────

/** Strip thumbs size from the image's intrinsic ratio (cached + onLoad). */
function applyShotThumbAspect(img: HTMLImageElement | null) {
  if (!img?.naturalWidth || !img.naturalHeight) return;
  img.parentElement?.style.setProperty("--wsp-ar", `${img.naturalWidth} / ${img.naturalHeight}`);
}

function ShotThumb({
  item,
  paired,
  contextLabel,
  href,
  onOpen,
  onPreviewEnter,
  onPreviewLeave,
}: {
  item: {
    key: string;
    url: string | null;
    embedUrl: string | null;
    state?: string;
    ghKind?: string;
    ghNumber?: string;
    metadata?: Record<string, string>;
  };
  /** True when a before/after counterpart sits in the same strip/grid. */
  paired?: boolean;
  /** Optional pill (GitHub "PR #7 · author" context) — not the state. */
  contextLabel?: ReactNode;
  /** Known destination; when null the tile falls back to a button + `onOpen`. */
  href: string | null;
  onOpen: () => void;
  onPreviewEnter?: (el: HTMLElement, src: string, caption: PreviewCaption) => void;
  onPreviewLeave?: () => void;
}) {
  const name = leafName(item.key);
  const kind = shotKindFromKey(item.key);
  const [broken, setBroken] = useState(false);
  const showLock = kind === "image" && item.url === null;
  const showImage = kind === "image" && !!item.embedUrl && !broken;
  // State stays in the accessible name, not a native `title` tooltip — that
  // tooltip sat on top of the hover preview.
  const stateSuffix = item.state ? ` (${item.state})` : "";
  const ghKindValue = item.ghKind ?? item.metadata?.["gh.kind"];
  const base = shotPreviewCaption(item);
  const caption: PreviewCaption = base.pr ? { ...base, kind: ghKindValue } : base;

  const previewSrc = showImage ? thumbUrl(item.embedUrl!, 1120) : null;
  const shared = {
    className: "wsp-tile",
    "aria-label": `Open ${name}${stateSuffix}${caption.pr ? ` — ${caption.pr}` : ""}${paired ? " — has before/after pair" : ""}`,
    onMouseEnter: (event: { currentTarget: HTMLElement }) => {
      if (previewSrc) onPreviewEnter?.(event.currentTarget, previewSrc, caption);
    },
    onMouseLeave: () => onPreviewLeave?.(),
  };
  const body = (
    <>
      {showImage ? (
        <span className="wsp-thumb" aria-hidden="true">
          <img
            src={thumbUrl(item.embedUrl!, 560)}
            alt=""
            loading="lazy"
            decoding="async"
            ref={applyShotThumbAspect}
            onLoad={(event) => applyShotThumbAspect(event.currentTarget)}
            onError={() => setBroken(true)}
          />
        </span>
      ) : (
        <span className="wsp-thumb wsp-thumb--tile" aria-hidden="true">
          {showLock ? "🔒" : extLabel(item.key)}
        </span>
      )}
      {contextLabel && <span className="wsp-state">{contextLabel}</span>}
      {paired && (
        <span className="wsp-pair" aria-hidden="true" title="Has a before/after pair">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1" y="1" width="4.5" height="10" rx="1" fill="currentColor" opacity="0.45" />
            <rect
              x="6.5"
              y="1"
              width="4.5"
              height="10"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </span>
      )}
    </>
  );

  return href ? (
    <a {...shared} {...newTabLinkProps} href={href}>
      {body}
    </a>
  ) : (
    <button {...shared} type="button" onClick={onOpen}>
      {body}
    </button>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────
//
// Plan 006: `screenshots.astro` now renders this component itself
// (server-side, via its own `initialInfo`/`initialOverview` props) instead of
// a separate `set:html` placeholder — so this is also what a cookie-less
// request's *server* render shows, not just the client's pre-fetch gap.
// `renderScreenshotsPlaceholderHtml` in workspace-ui.ts (still tested, no
// longer wired into this page) mirrors this markup 1:1 for that old
// hand-off — left alone here since `workspace-ui.ts` is out of this plan's
// scope.

function SkelBar({ width }: { width: string }) {
  return (
    <span
      className="ws-skel"
      aria-hidden="true"
      style={{ "--ws-skel-w": width } as CSSProperties}
    />
  );
}

function OverviewLoadingSkeleton() {
  return (
    <div className="wsp" aria-busy="true">
      <div className="wsp-filter">
        <span className="wsp-filter__project wsp-filter__skel">
          <SkelBar width="120px" />
        </span>
        <span className="wsp-filter__q wsp-filter__skel">
          <SkelBar width="60%" />
        </span>
      </div>
      {[0, 1, 2].map((row) => (
        <div className="wsp-group" key={row}>
          <div className="wsp-group__head">
            <SkelBar width="140px" />
          </div>
          <div className="wsp-strip">
            {[0, 1, 2, 3].map((i) => (
              <span className="wsp-thumb wsp-thumb--skel" key={i} aria-hidden="true" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FilterBar({
  project,
  q,
  path,
  feed,
  projects,
  catalog,
  onProject,
  onQuery,
  onFeed,
  onPickPath,
}: {
  project: string;
  q: string;
  /** Exact drill-in path, shown in the input so editing it widens the filter. */
  path: string;
  feed: ScreenshotsFeed;
  projects: string[];
  /** Path catalog backing the input's autocomplete suggestions. */
  catalog: PathCatalogEntry[];
  onProject: (project: string) => void;
  onQuery: (q: string) => void;
  onFeed: (feed: ScreenshotsFeed) => void;
  onPickPath: (path: string) => void;
}) {
  const options = project && !projects.includes(project) ? [...projects, project] : projects;
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const value = path || q;
  // Exact drill-in state means the value already IS a suggestion — nothing
  // useful to offer until the user edits it back into a query.
  const suggestions = path ? [] : pathSuggestions(catalog, { project, q });
  const open = suggestOpen && suggestions.length > 0;

  const pick = (picked: string) => {
    setSuggestOpen(false);
    setActive(-1);
    onPickPath(picked);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" && suggestions.length > 0) {
        event.preventDefault();
        setSuggestOpen(true);
        setActive(0);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter" && active >= 0 && suggestions[active]) {
      event.preventDefault();
      pick(suggestions[active].path);
    } else if (event.key === "Escape") {
      setSuggestOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className="wsp-filter">
      <Select
        className="ul-select--sm wsp-filter__project"
        aria-label="Filter by project"
        value={project}
        onChange={(event) => onProject(event.target.value)}
      >
        <option value="">All projects</option>
        {options.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
      </Select>
      <div className="wsp-filter__qwrap">
        <Input
          id="wsp-path-filter"
          type="search"
          className="wsp-filter__q"
          aria-label="Filter by path"
          aria-keyshortcuts="Meta+K Control+K Slash"
          aria-expanded={open}
          aria-controls="wsp-path-suggest"
          aria-activedescendant={active >= 0 ? `wsp-path-suggest-${active}` : undefined}
          role="combobox"
          placeholder="Filter path  e.g. /catalog"
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => {
            setSuggestOpen(true);
            setActive(-1);
            onQuery(event.target.value);
          }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => {
            // Delay so a mousedown on an option can land first.
            window.setTimeout(() => setSuggestOpen(false), 120);
          }}
          onKeyDown={onKeyDown}
        />
        {open && (
          <ul className="wsp-suggest" id="wsp-path-suggest" role="listbox" aria-label="Paths">
            {suggestions.map((entry, index) => (
              <li key={entry.path} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`wsp-path-suggest-${index}`}
                  aria-selected={index === active}
                  className={index === active ? "wsp-suggest__opt is-active" : "wsp-suggest__opt"}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(entry.path);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="wsp-suggest__path">{entry.path}</span>
                  <span className="wsp-suggest__count">
                    {entry.count} {entry.count === 1 ? "file" : "files"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="wsp-toggle" role="group" aria-label="Layout">
        <button
          type="button"
          className="wsp-toggle__opt"
          aria-pressed={feed === "grouped"}
          onClick={() => onFeed("grouped")}
        >
          Grouped
        </button>
        <button
          type="button"
          className="wsp-toggle__opt"
          aria-pressed={feed === "recent"}
          onClick={() => onFeed("recent")}
        >
          Recent
        </button>
      </div>
    </div>
  );
}

type PreviewCaption = { name: string; pr?: string; kind?: string };

type PreviewHandlers = {
  onPreviewEnter: (el: HTMLElement, src: string, caption: PreviewCaption) => void;
  onPreviewLeave: () => void;
};

// ── Component ──────────────────────────────────────────────────────────

/**
 * The actual interactive overview + drill-in. Not exported directly — see
 * `ScreenshotsByPath` below for why.
 */
function ScreenshotsByPathInner({
  apiOrigin,
  workspace,
  initialSearch,
  initialOverview,
  initialInfo,
}: ScreenshotsByPathProps) {
  // Seed source for URL-derived initial state: the server-fetched
  // `initialSearch` prop when present (SSR, and the client's first
  // hydration-parity render), else the live location for the pre-existing
  // client-only-mount path. `window` doesn't exist during SSR, so this must
  // never be read unconditionally at the top of the component body.
  const seedSearch = initialSearch ?? (typeof window !== "undefined" ? window.location.search : "");

  const [info, setInfo] = useState<WorkspaceInfoStatus | { status: "loading" }>(
    () => initialInfo ?? { status: "loading" },
  );
  const [infoRetryNonce, setInfoRetryNonce] = useState(0);
  const [overview, setOverview] = useState<OverviewState>(
    () => initialOverview ?? { status: "loading" },
  );
  const [overviewRetryNonce, setOverviewRetryNonce] = useState(0);
  // `readScreenshotsView` derives purely from the URL search string (no
  // localStorage involved anywhere in this module — unlike the files tab's
  // `resolveFilesView`), so there's no stored-preference divergence to guard
  // against here: the server and the client's first render already agree as
  // long as both read the same `seedSearch`, which is exactly what this does.
  const [view, setView] = useState<ScreenshotsView>(() => readScreenshotsView(seedSearch));
  const previewTimer = useRef<number | null>(null);
  const [preview, setPreview] = useState<{
    src: string;
    left: number;
    top: number;
    name: string;
    pr?: string;
    kind?: string;
  } | null>(null);
  const [drill, setDrill] = useState<DrillState>({ status: "idle" });
  const [drillRetryNonce, setDrillRetryNonce] = useState(0);
  const [ghState, setGhState] = useState<DrillState>({ status: "loading" });
  // Thumb strips fetched for groups past the overview's thumbed cap, keyed
  // `project\0path`. In-flight keys live in the ref so a re-render mid-fetch
  // doesn't fire a duplicate search.
  const [backfill, setBackfill] = useState<Record<string, PathGroupItem[]>>({});
  const backfillStarted = useRef(new Set<string>());

  // Workspace-level facts (hasPublicUrl), gated behind session resolution —
  // same pattern as WorkspaceFileTable.
  useEffect(() => {
    let cancelled = false;
    setInfo({ status: "loading" });
    onSession(() => {
      void loadWorkspaces(apiOrigin).then((result) => {
        if (cancelled) return;
        setInfo(resolveWorkspaceInfo(result, workspace));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, infoRetryNonce]);

  // Overview fetch, once per mount/workspace/retry.
  useEffect(() => {
    let cancelled = false;
    setOverview({ status: "loading" });
    onSession(() => {
      void getWorkspaceFilesByPath(apiOrigin, workspace).then((result) => {
        if (cancelled) return;
        setOverview(
          result.kind === "ok"
            ? {
                status: "ready",
                groups: result.groups,
                catalog: result.catalog,
                projects: result.projects,
                latest: result.latest,
                truncated: result.truncated,
                catalogTruncated: result.catalogTruncated,
              }
            : { status: "error" },
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, overviewRetryNonce]);

  // GitHub-mirrored screenshots ("From GitHub" section), fetched in parallel
  // with the by-path overview. A failure here must never block or break the
  // by-path view — it just renders nothing.
  useEffect(() => {
    let cancelled = false;
    onSession(() => {
      void searchWorkspaceFiles(apiOrigin, workspace, [
        { key: "gh.origin", value: "github" },
        { key: "gh.detached", value: "false" },
      ]).then((result) => {
        if (cancelled) return;
        setGhState(
          result.kind === "ok"
            ? { status: "ready", items: result.items, truncated: result.truncated }
            : { status: "error" },
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace]);

  // Drill-in fetch — URL-synced so a reload or shared link lands on the
  // same view. Clearing view.path ("") goes back to the overview/project
  // view without a search fetch. Bare legacy `?path=` links keep working —
  // they simply carry an empty view.project, so no project filter applies.
  useEffect(() => {
    history.replaceState(
      null,
      "",
      window.location.pathname + screenshotsSearch(view.project, view.path, view.q, view.feed),
    );
    if (!view.path) {
      setDrill({ status: "idle" });
      return;
    }
    let cancelled = false;
    setDrill({ status: "loading" });
    onSession(() => {
      void searchWorkspaceFiles(apiOrigin, workspace, [{ key: "path", value: view.path }]).then(
        (result) => {
          if (cancelled) return;
          setDrill(
            result.kind === "ok"
              ? { status: "ready", items: result.items, truncated: result.truncated }
              : { status: "error" },
          );
        },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, view.project, view.path, view.q, view.feed, drillRetryNonce]);

  // Thumb backfill for groups past the overview's 50-group thumbed cap:
  // filtering (especially by project) surfaces catalog paths whose group got
  // no `recent` strip, which used to render as bare headings. Fetch those
  // strips lazily through the same search route the drill-in uses, capped
  // per pass and cached per (project, path) for the life of the mount. A
  // failed search caches an empty strip — the heading-only fallback — rather
  // than retrying on every keystroke.
  useEffect(() => {
    if (overview.status !== "ready" || view.feed !== "grouped" || view.path) return;
    const matching = groupsFromCatalog(
      filterCatalog(overview.catalog, { project: view.project, q: view.q }),
      overview.groups,
    );
    const targets = backfillTargets(matching, backfillStarted.current);
    if (targets.length === 0) return;
    const projectsByPath = new Map<string, string[]>();
    for (const target of targets) {
      backfillStarted.current.add(`${target.project}\0${target.path}`);
      const projects = projectsByPath.get(target.path);
      if (projects) projects.push(target.project);
      else projectsByPath.set(target.path, [target.project]);
    }
    onSession(() => {
      for (const [path, projects] of projectsByPath) {
        void searchWorkspaceFiles(apiOrigin, workspace, [{ key: "path", value: path }]).then(
          (result) => {
            // No cancellation guard: the cache is keyed by (project, path)
            // independent of the current view, so a late response is never
            // stale — dropping it would strand its group (started, no strip).
            const items = result.kind === "ok" ? result.items : [];
            setBackfill((prev) => {
              const next = { ...prev };
              for (const project of projects) {
                next[`${project}\0${path}`] = shotsFromSearchItems(items, project);
              }
              return next;
            });
          },
        );
      }
    });
    // `backfill` in the deps chains passes: each resolved batch re-runs the
    // effect for the next ≤12 targets until none remain (the started set
    // keeps every pass strictly new, so the chain terminates).
  }, [apiOrigin, workspace, overview, backfill, view.project, view.q, view.feed, view.path]);

  useEffect(() => {
    const dismiss = () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
      setPreview(null);
    };
    const typingInField = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest("input, textarea, select") || target.isContentEditable);
    };
    const focusPathFilter = () => {
      const input = document.getElementById("wsp-path-filter");
      if (!(input instanceof HTMLInputElement)) return;
      input.focus();
      input.select();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (event.isComposing) return;
      if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        focusPathFilter();
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (typingInField(event)) return;
        event.preventDefault();
        focusPathFilter();
      }
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const onPreviewLeave = () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    setPreview(null);
  };
  const onPreviewEnter = (el: HTMLElement, src: string, caption: PreviewCaption) => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;
    previewTimer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const width = Math.min(560, window.innerWidth - 24);
      const height = Math.min(width * 0.7, window.innerHeight * 0.7) + 40;
      const pos = shotPreviewPosition(
        { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        { width: window.innerWidth, height: window.innerHeight },
        { width, height },
      );
      setPreview({
        src,
        left: pos.left,
        top: pos.top,
        name: caption.name,
        pr: caption.pr,
        kind: caption.kind,
      });
    }, delay);
  };
  const previewHandlers: PreviewHandlers = { onPreviewEnter, onPreviewLeave };

  if (info.status === "loading" || overview.status === "loading") {
    return <OverviewLoadingSkeleton />;
  }

  if (info.status === "unavailable") {
    return (
      <div className="wft-status-block">
        <p className="wft-error" role="alert">
          Workspaces are temporarily unavailable. Check the local stack or try again.
        </p>
        <button type="button" className="text-btn" onClick={() => setInfoRetryNonce((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }

  if (info.status === "no-access") {
    return (
      <p className="wft-error" role="alert">
        You don’t have access to this workspace.
      </p>
    );
  }

  if (overview.status === "error") {
    return (
      <Callout tone="error" role="alert">
        Screenshots are temporarily unavailable.{" "}
        <button
          type="button"
          className="text-btn"
          onClick={() => setOverviewRetryNonce((n) => n + 1)}
        >
          Try again
        </button>
      </Callout>
    );
  }

  const opener = makeFileOpener(apiOrigin, workspace, info.hasPublicUrl);
  const onDrill = (group: { project: string; path: string }) =>
    setView({ ...view, project: group.project, path: group.path });
  const setProject = (project: string) => setView({ ...view, project, path: "" });
  const setQuery = (q: string) => setView({ ...view, path: "", q });
  const setFeed = (feed: ScreenshotsFeed) => setView({ ...view, path: "", feed });

  // GitHub items bucketed by project label, for both the overview's
  // per-project strips and the project view's full "From GitHub" section.
  const ghByProject = new Map<string, SearchFileItem[]>();
  if (ghState.status === "ready") {
    for (const item of ghState.items) {
      const label = projectLabelFromItemMeta(item.metadata);
      ghByProject.set(label, [...(ghByProject.get(label) ?? []), item]);
    }
  }

  const ghOnlyLabels = [...ghByProject.keys()].filter(
    (label) => !overview.projects.some((p) => p.label === label),
  );
  const projectLabels = [...overview.projects.map((p) => p.label), ...ghOnlyLabels];
  const showFilter = projectLabels.length > 0 || overview.catalog.length > 0;
  const filterBar = showFilter ? (
    <FilterBar
      project={view.project}
      q={view.q}
      path={view.path}
      feed={view.feed}
      projects={projectLabels}
      catalog={overview.catalog}
      onProject={setProject}
      onQuery={setQuery}
      onFeed={setFeed}
      onPickPath={(path) => setView({ ...view, path })}
    />
  ) : null;
  const previewLayer = preview ? (
    <div
      className="wsp-preview"
      style={{ left: preview.left, top: preview.top }}
      role="presentation"
    >
      <img src={preview.src} alt="" />
      <div className="wsp-preview__meta">
        <div className="wsp-preview__name">{preview.name}</div>
        {preview.pr && (
          <div className="wsp-preview__pr">
            <GhKindIcon kind={preview.kind} /> {preview.pr}
          </div>
        )}
      </div>
    </div>
  ) : null;

  // Drill-in view (?path=, optionally scoped to ?project=).
  if (view.path) {
    let drillItems: SearchFileItem[] = [];
    if (drill.status === "ready") {
      drillItems = drill.items;
      if (view.project) {
        drillItems = drillItems.filter(
          (item) => projectLabelFromItemMeta(item.metadata) === view.project,
        );
      }
    }
    const drillPaired = pairedShotKeys(
      drillItems.map((item) => ({ key: item.key, state: item.metadata?.state })),
    );
    let drillEmptyMessage = "No screenshots at this path.";
    if (view.project && drill.status === "ready" && drill.truncated) {
      drillEmptyMessage = `None of the first 100 at this path belong to ${view.project} — there may be more beyond that.`;
    } else if (view.project) {
      drillEmptyMessage = "No screenshots at this path for this project.";
    }

    return (
      <div className="wsp">
        {filterBar}
        <button type="button" className="text-btn" onClick={() => setView({ ...view, path: "" })}>
          {view.project ? `← ${view.project}` : "← all projects"}
        </button>
        <h2 className="wsp-drill__heading">{view.path}</h2>
        {drill.status === "loading" && (
          <div className="wsp-grid" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <span className="wsp-thumb wsp-thumb--skel" key={i} aria-hidden="true" />
            ))}
          </div>
        )}
        {drill.status === "error" && (
          <Callout tone="error" role="alert">
            Couldn't load this path.{" "}
            <button
              type="button"
              className="text-btn"
              onClick={() => setDrillRetryNonce((n) => n + 1)}
            >
              Try again
            </button>
          </Callout>
        )}
        {drill.status === "ready" && (
          <>
            <div className="wsp-grid">
              {drillItems.map((item) => (
                <ShotThumb
                  key={item.key}
                  item={{ ...item, state: item.metadata?.state }}
                  paired={drillPaired.has(item.key)}
                  href={opener.href(item)}
                  onOpen={() => opener.activate(item)}
                  {...previewHandlers}
                />
              ))}
            </div>
            {/* The project scope is applied client-side AFTER the search's
                100-item cap (the origin-labeled fallback can't be expressed
                as a metadata filter — spec keeps URL-prefix search out of
                scope), so a truncated response may hide project matches: say
                so rather than claiming an empty/complete result. */}
            {drillItems.length === 0 && <p className="wft-end">{drillEmptyMessage}</p>}
            {drillItems.length > 0 && drill.truncated && (
              <p className="wft-end">
                {view.project
                  ? "Project filter applied to the first 100 at this path — there may be more."
                  : "Showing the first 100 — narrow the path to see more."}
              </p>
            )}
          </>
        )}
        {previewLayer}
      </div>
    );
  }

  // Flat newest-first feed (?view=recent) — same filters, no grouping.
  if (view.feed === "recent") {
    const qTrimmed = view.q.trim();
    const latestItems = overview.latest.filter((item) => {
      if (view.project && item.project !== view.project) return false;
      return pathQueryMatches(item.path, qTrimmed);
    });
    const latestPaired = pairedShotKeys(latestItems);
    return (
      <div className="wsp">
        {filterBar}
        {latestItems.length === 0 ? (
          overview.latest.length === 0 && overview.catalog.length === 0 ? (
            <EmptyShotsCta title="No screenshots yet" />
          ) : (
            <p className="wft-end">
              {overview.latest.length === 0
                ? "No recent uploads to show."
                : "No recent uploads match this filter."}
            </p>
          )
        ) : (
          <>
            <div className="wsp-grid">
              {latestItems.map((item) => (
                <ShotThumb
                  key={item.key}
                  item={item}
                  paired={latestPaired.has(item.key)}
                  contextLabel={
                    item.ghNumber ? (
                      <>
                        <GhKindIcon kind={item.ghKind} />{" "}
                        {item.ghKind === "pull" ? `PR #${item.ghNumber}` : `#${item.ghNumber}`}
                      </>
                    ) : undefined
                  }
                  href={opener.href(item)}
                  onOpen={() => opener.activate(item)}
                  {...previewHandlers}
                />
              ))}
            </div>
            <p className="wft-end">
              Showing the {latestItems.length === 1 ? "newest upload" : "newest uploads"} — switch
              to Grouped to browse by page.
            </p>
          </>
        )}
        {previewLayer}
      </div>
    );
  }

  const matchingCatalog = filterCatalog(overview.catalog, {
    project: view.project,
    q: view.q,
  });
  const matchingGroups = groupsFromCatalog(matchingCatalog, overview.groups).map((group) =>
    group.recent.length > 0
      ? group
      : { ...group, recent: backfill[`${group.project}\0${group.path}`] ?? [] },
  );
  const qTrim = view.q.trim();
  const filtering = qTrim !== "" || view.project !== "";
  // Path query hides GitHub strips that aren't path-grouped; project-only
  // still shows that project's GitHub items.
  const showGh = qTrim === "";

  const sectionHasContent = (label: string) =>
    matchingGroups.some((group) => group.project === label) || (showGh && ghByProject.has(label));
  let sectionLabels: string[];
  if (view.project) {
    sectionLabels = sectionHasContent(view.project) ? [view.project] : [];
  } else {
    sectionLabels = [
      ...overview.projects.map((p) => p.label),
      ...(showGh ? ghOnlyLabels : []),
    ].filter(sectionHasContent);
  }

  const isEmptyWorkspace = overview.catalog.length === 0 && ghByProject.size === 0;
  const isEmptyFilter = !isEmptyWorkspace && sectionLabels.length === 0;
  let emptyFilterMessage = "No screenshots for this project.";
  if (qTrim) {
    emptyFilterMessage = overview.catalogTruncated
      ? `No paths matching ${qTrim} in the most active set.`
      : `No paths matching ${qTrim}.`;
  }

  return (
    <div className="wsp">
      {filterBar}
      {isEmptyWorkspace ? (
        <EmptyShotsCta title="No screenshots yet" />
      ) : isEmptyFilter ? (
        <p className="wft-end">{emptyFilterMessage}</p>
      ) : (
        <>
          {sectionLabels.map((label) => {
            const projectSummary = overview.projects.find((p) => p.label === label);
            const groups = matchingGroups.filter((group) => group.project === label);
            const previewGroups = filtering ? groups : groups.slice(0, PREVIEW_PATHS_PER_PROJECT);
            const ghItems = showGh ? ghByProject.get(label) : undefined;
            return (
              <ProjectSection
                key={label}
                label={label}
                summary={projectSummary}
                groups={previewGroups}
                ghItems={ghItems}
                showViewProject={!view.project}
                onViewProject={() => setView({ ...view, project: label, path: "" })}
                onDrill={onDrill}
                opener={opener}
                preview={previewHandlers}
              />
            );
          })}
          {!filtering && overview.truncated && (
            <p className="wft-end">Showing the most active paths — filter by path to see more.</p>
          )}
          {filtering && overview.catalogTruncated && (
            <p className="wft-end">Showing the most active paths — there may be more.</p>
          )}
        </>
      )}
      {previewLayer}
    </div>
  );
}

/**
 * The exported island. Wraps `ScreenshotsByPathInner` in `IslandErrorBoundary`
 * *inside* this same component's own render (plan 006, following plan 005's
 * `WorkspaceFileTable`) — composing the boundary here means Astro sees
 * exactly one component when `screenshots.astro` renders `<ScreenshotsByPath
 * ... />` with no client directive, so the manual `hydrateRoot` mount (which
 * imports this same exported name) hydrates the whole subtree, boundary
 * included, as a single React root that matches the server-rendered tree
 * exactly — no extra wrapper the server didn't also render.
 */
export function ScreenshotsByPath(props: ScreenshotsByPathProps) {
  return (
    <IslandErrorBoundary>
      <ScreenshotsByPathInner {...props} />
    </IslandErrorBoundary>
  );
}

function ProjectSection({
  label,
  summary,
  groups,
  ghItems,
  showViewProject,
  onViewProject,
  onDrill,
  opener,
  preview,
}: {
  label: string;
  summary: ProjectSummary | undefined;
  groups: FilesPathGroup[];
  ghItems: SearchFileItem[] | undefined;
  showViewProject: boolean;
  onViewProject: () => void;
  onDrill: (group: { project: string; path: string }) => void;
  opener: FileOpener;
  preview: PreviewHandlers;
}) {
  // A GH-only label (no by-path groups) has no ProjectSummary — fall back to
  // the GitHub items' count so the header still reads sensibly.
  const count = summary?.count ?? ghItems?.length ?? 0;
  const lastUpdated = summary?.lastUpdated;

  return (
    <div className="wsp-project">
      <div className="wsp-project__head">
        <span className="wsp-project__label">
          {isRepoLabel(label) && <GitHubMark />}
          {label}
        </span>
        <span className="wsp-group__meta">
          {count} {count === 1 ? "file" : "files"}
          {lastUpdated ? ` · ${lastUpdatedLabel(lastUpdated, new Date())}` : ""}
        </span>
        {showViewProject && (
          <button type="button" className="text-btn wsp-project__viewall" onClick={onViewProject}>
            view project →
          </button>
        )}
      </div>
      {groups.map((group) => (
        <PathGroupSection
          key={group.path}
          group={group}
          onDrill={onDrill}
          opener={opener}
          preview={preview}
        />
      ))}
      {ghItems && <GitHubSection items={ghItems} opener={opener} preview={preview} />}
    </div>
  );
}

function GitHubSection({
  items,
  opener,
  preview,
}: {
  items: SearchFileItem[];
  opener: FileOpener;
  preview: PreviewHandlers;
}) {
  return (
    <div className="wsp-group">
      <div className="wsp-group__head">
        <span className="wsp-group__path">From GitHub</span>
        <span className="wsp-group__meta">
          {items.length} {items.length === 1 ? "file" : "files"}
        </span>
      </div>
      <div className="wsp-strip">
        {items.map((item) => (
          <ShotThumb
            key={item.key}
            item={item}
            contextLabel={
              <>
                <GhKindIcon kind={item.metadata["gh.kind"]} /> {ghLabel(item)}
              </>
            }
            href={opener.href(item)}
            onOpen={() => opener.activate(item)}
            {...preview}
          />
        ))}
      </div>
    </div>
  );
}

function PathGroupSection({
  group,
  onDrill,
  opener,
  preview,
}: {
  group: FilesPathGroup;
  onDrill: (group: { project: string; path: string }) => void;
  opener: FileOpener;
  preview: PreviewHandlers;
}) {
  const paired = pairedShotKeys(group.recent);
  return (
    <div className="wsp-group">
      <button type="button" className="wsp-group__head" onClick={() => onDrill(group)}>
        <span className="wsp-group__path">{group.path}</span>
        <span className="wsp-group__meta">
          {group.count} {group.count === 1 ? "file" : "files"} ·{" "}
          {lastUpdatedLabel(group.lastUpdated, new Date())}
        </span>
        <span className="wsp-group__viewall">view all →</span>
      </button>
      {group.recent.length > 0 && (
        <div className="wsp-strip">
          {group.recent.map((item) => (
            <ShotThumb
              key={item.key}
              item={item}
              paired={paired.has(item.key)}
              href={opener.href(item)}
              onOpen={() => opener.activate(item)}
              {...preview}
            />
          ))}
        </div>
      )}
    </div>
  );
}
