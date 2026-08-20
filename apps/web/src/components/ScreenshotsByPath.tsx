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
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IslandErrorBoundary } from "./IslandErrorBoundary";
import {
  getWorkspaceFilesByPath,
  searchWorkspaceFiles,
  type FilesPathGroup,
  type PathCatalogEntry,
  type ProjectSummary,
  type SearchFileItem,
} from "../lib/api-client";
import { loadWorkspaces } from "../lib/workspaces-nav";
import { resolveWorkspaceInfo, type WorkspaceInfoStatus } from "../lib/workspace-file-row";
import { onSession } from "../lib/account-shell";
import { makeFileOpener, newTabLinkProps, type FileOpener } from "../lib/file-opener";
import {
  filterCatalog,
  groupsFromCatalog,
  lastUpdatedLabel,
  pairedShotKeys,
  projectLabelFromItemMeta,
  readScreenshotsView,
  screenshotsSearch,
  shotKindFromKey,
  shotPreviewPosition,
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
      truncated: boolean;
      catalogTruncated: boolean;
    };

type DrillState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: SearchFileItem[]; truncated: boolean };

/** Leaf name for an aria-label / alt text — "a/b/c.png" → "c.png". */
function leafName(key: string): string {
  const trimmed = key.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  return (slash === -1 ? trimmed : trimmed.slice(slash + 1)) || key;
}

/** Extension label for a generic (non-image, non-embeddable) tile. */
function extLabel(key: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  return match ? match[1].toLowerCase() : "file";
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

function ShotThumb({
  item,
  paired,
  contextLabel,
  href,
  onOpen,
  onPreviewEnter,
  onPreviewLeave,
}: {
  item: { key: string; url: string | null; embedUrl: string | null; state?: string };
  /** True when a before/after counterpart sits in the same strip/grid. */
  paired?: boolean;
  /** Optional pill (GitHub "PR #7 · author" context) — not the state. */
  contextLabel?: string;
  /** Known destination; when null the tile falls back to a button + `onOpen`. */
  href: string | null;
  onOpen: () => void;
  onPreviewEnter?: (el: HTMLElement, src: string) => void;
  onPreviewLeave?: () => void;
}) {
  const name = leafName(item.key);
  const kind = shotKindFromKey(item.key);
  const [broken, setBroken] = useState(false);
  const showLock = kind === "image" && item.url === null;
  const showImage = kind === "image" && !!item.embedUrl && !broken;
  // The state stays in the accessible name (and hover title) even though the
  // tile no longer wears a BEFORE/AFTER pill — the pair badge covers the
  // visual signal, and only when a counterpart actually exists.
  const stateSuffix = item.state ? ` (${item.state})` : "";

  const previewSrc = showImage ? item.embedUrl : null;
  const shared = {
    className: "wsp-tile",
    "aria-label": `Open ${name}${stateSuffix}${paired ? " — has before/after pair" : ""}`,
    title: item.state ? `${name}${stateSuffix}` : undefined,
    onMouseEnter: (event: { currentTarget: HTMLElement }) => {
      if (previewSrc) onPreviewEnter?.(event.currentTarget, previewSrc);
    },
    onMouseLeave: () => onPreviewLeave?.(),
  };
  const body = (
    <>
      {showImage ? (
        <span className="wsp-thumb" aria-hidden="true">
          <img
            src={item.embedUrl!}
            alt=""
            loading="lazy"
            decoding="async"
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
  projects,
  onProject,
  onQuery,
}: {
  project: string;
  q: string;
  /** Exact drill-in path, shown in the input so editing it widens the filter. */
  path: string;
  projects: string[];
  onProject: (project: string) => void;
  onQuery: (q: string) => void;
}) {
  const options = project && !projects.includes(project) ? [...projects, project] : projects;
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
      <Input
        type="search"
        className="wsp-filter__q"
        aria-label="Filter by path"
        placeholder="Filter path  e.g. /catalog"
        value={path || q}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(event) => onQuery(event.target.value)}
      />
    </div>
  );
}

type PreviewHandlers = {
  onPreviewEnter: (el: HTMLElement, src: string) => void;
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
  const [view, setView] = useState<{ project: string; path: string; q: string }>(() =>
    readScreenshotsView(seedSearch),
  );
  const previewTimer = useRef<number | null>(null);
  const [preview, setPreview] = useState<{
    src: string;
    left: number;
    top: number;
  } | null>(null);
  const [drill, setDrill] = useState<DrillState>({ status: "idle" });
  const [drillRetryNonce, setDrillRetryNonce] = useState(0);
  const [ghState, setGhState] = useState<DrillState>({ status: "loading" });

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
      window.location.pathname + screenshotsSearch(view.project, view.path, view.q),
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
  }, [apiOrigin, workspace, view.project, view.path, drillRetryNonce]);

  useEffect(() => {
    const dismiss = () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
      setPreview(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
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
  const onPreviewEnter = (el: HTMLElement, src: string) => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;
    previewTimer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const width = Math.min(560, window.innerWidth - 24);
      const height = Math.min(width * 0.7, window.innerHeight * 0.7);
      const pos = shotPreviewPosition(
        { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        { width: window.innerWidth, height: window.innerHeight },
        { width, height },
      );
      setPreview({ src, left: pos.left, top: pos.top });
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
    setView({ project: group.project, path: group.path, q: view.q });
  const setProject = (project: string) => setView({ project, path: "", q: view.q });
  const setQuery = (q: string) => setView({ project: view.project, path: "", q });

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
      projects={projectLabels}
      onProject={setProject}
      onQuery={setQuery}
    />
  ) : null;
  const previewLayer = preview ? (
    <div
      className="wsp-preview"
      style={{ left: preview.left, top: preview.top }}
      role="presentation"
    >
      <img src={preview.src} alt="" />
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
        <button
          type="button"
          className="text-btn"
          onClick={() => setView({ project: view.project, path: "", q: view.q })}
        >
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

  const matchingCatalog = filterCatalog(overview.catalog, {
    project: view.project,
    q: view.q,
  });
  const matchingGroups = groupsFromCatalog(matchingCatalog, overview.groups);
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
                onViewProject={() => setView({ project: label, path: "", q: view.q })}
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
        <span className="wsp-project__label">{label}</span>
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
            contextLabel={ghLabel(item)}
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
