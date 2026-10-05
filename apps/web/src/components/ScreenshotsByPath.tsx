/**
 * Files tab, By page view (`?view=pages`): uploads grouped by `path` metadata (spec:
 * docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md).
 * Overview = one `files/by-path` fetch; `?project=` / `?q=` filter that
 * payload in the toolbar (project select + path input). Drill-in (?path=)
 * = the existing `files/search?meta.path=…` route. Project labels and page
 * paths both contain slashes, so folder state stays on the query string;
 * `project`/`path` changes push a history entry so Back returns to the
 * previous folder instead of leaving the page. Files without `path`
 * metadata never appear here — the empty state points at `uploads put`
 * with `--meta path=`.
 *
 * Every rendered group's thumb strip comes from that one overview response:
 * its `catalog` carries a short strip per (project, path), so filtering past
 * the thumbed-group cap no longer fans out into one search request per group.
 *
 * SSR-first (plan 006, following plan 005's `WorkspaceFileTable` shape):
 * when the request carries a session, `files.astro` server-fetches the
 * by-path overview + workspace summary and renders this component with no
 * `client:*` directive, so first paint has real groups instead of the
 * loading skeleton. A manual `hydrateRoot` mount (same lifecycle every
 * sibling workspace tab uses) attaches interactivity afterwards. Only the
 * OVERVIEW is server-seeded — the GitHub-mirrored section and the `?path=`
 * drill-in still fetch client-side, unchanged.
 */
import { Callout } from "@uploads/ui";
import type { FileTypeClass } from "@uploads/comment-render/scope";
import "@uploads/ui/styles.css";
import { PrLabel } from "@uploads/ui/components/pr-label";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IslandErrorBoundary } from "./IslandErrorBoundary";
import { CommandEmpty, InlineEmpty } from "./files/FilesEmpty";
import { GhKindIcon, GitHubMark } from "./files/gh-glyphs";
import { PathFilterBar } from "./files/PathFilterBar";
import { ShotThumb, type PreviewHandlers } from "./files/ShotThumb";
import { useShotPreview } from "./files/useShotPreview";
import { InfoBlocked, useWorkspaceInfo } from "./files/useWorkspaceInfo";
import {
  getWorkspaceFilesByPath,
  searchWorkspaceFiles,
  type FilesPathGroup,
  type GithubTitleMap,
  type LatestShotItem,
  type PathCatalogEntry,
  type ProjectSummary,
  type SearchFileItem,
} from "../lib/api-client";
import type { WorkspaceInfoStatus } from "../lib/workspace-file-row";
import { onSession } from "../lib/account-shell";
import { makeFileOpener, type FileOpener } from "../lib/file-opener";
import { matchesTypeFilter, typeEmptyNoun } from "../lib/files-view-state";
import {
  filterCatalog,
  formatShotCount,
  groupsFromCatalog,
  isPagesLocation,
  isRepoLabel,
  isScreenshotsNavState,
  lastUpdatedLabel,
  pairedShotKeys,
  pathQueryMatches,
  projectLabelFromItemMeta,
  readScreenshotsView,
  screenshotsHistoryMode,
  screenshotsSearchFromView,
  screenshotsViewHref,
  screenshotsViewsEqual,
  SHOT_COUNT_DISPLAY_CAP,
  shotPrLabelInput,
  ghKindFallbackLabel,
  writeScreenshotsLocation,
  type RecentView,
  type ScreenshotsView,
} from "../lib/workspace-screenshots";

/** How many path groups a project section previews before "view project →". */
const PREVIEW_PATHS_PER_PROJECT = 3;

const EMPTY_CTA_CMD = "uploads put ./shot.png --meta path=/settings";

/** By page empty state: `--meta path=` is what groups a file here. */
function EmptyShotsCta({ title }: { title: string }) {
  return (
    <CommandEmpty
      title={title}
      description="Upload a file with a page path and it groups here."
      command={EMPTY_CTA_CMD}
    />
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

/**
 * Left-click without a modifier stays on this page (`setView` + history).
 * Middle/cmd/ctrl-click keeps the real `href` so a folder opens in a new tab.
 */
function sameDocumentClick(
  event: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    button: number;
    preventDefault(): void;
  },
  go: () => void,
): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  go();
}

// ── Loading skeleton ───────────────────────────────────────────────────
//
// Plan 006: `files.astro` (with `view=pages`) renders this component itself
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
    <div className="wsp grid gap-8" aria-busy="true">
      <div className="wsp-filter flex flex-wrap items-stretch gap-2">
        <span className="wsp-filter__project wsp-filter__skel flex min-h-9 items-center rounded-[6px] border border-line bg-bg px-3 box-border">
          <SkelBar width="120px" />
        </span>
        <span className="wsp-filter__q wsp-filter__skel flex min-h-9 items-center rounded-[6px] border border-line bg-bg px-3 box-border">
          <SkelBar width="60%" />
        </span>
      </div>
      {[0, 1, 2].map((row) => (
        <div className="wsp-group grid gap-2.5" key={row}>
          <div className="wsp-group__head flex w-full items-baseline gap-2.5">
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
  useEffect(() => {
    document.title = `Files · ${workspace} · uploads.sh`;
  }, [workspace]);
  // Seed source for URL-derived initial state: the server-fetched
  // `initialSearch` prop when present (SSR, and the client's first
  // hydration-parity render), else the live location for the pre-existing
  // client-only-mount path. `window` doesn't exist during SSR, so this must
  // never be read unconditionally at the top of the component body.
  const seedSearch = initialSearch ?? (typeof window !== "undefined" ? window.location.search : "");

  const { info, retry: retryInfo } = useWorkspaceInfo(apiOrigin, workspace, initialInfo);
  const {
    handlers: previewHandlers,
    layer: previewLayer,
    titles,
  } = useShotPreview(apiOrigin, workspace);
  const [overview, setOverview] = useState<OverviewState>(
    () => initialOverview ?? { status: "loading" },
  );
  const [overviewRetryNonce, setOverviewRetryNonce] = useState(0);
  // In-place refetch (Merged only) — keeps the last ready overview so the
  // filter bar stays mounted. Distinct from `overview.status === "loading"`,
  // which is the full-page skeleton for workspace/retry.
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  // `readScreenshotsView` derives purely from the URL search string (no
  // localStorage involved anywhere in this module — unlike the files tab's
  // `resolveFilesView`), so there's no stored-preference divergence to guard
  // against here: the server and the client's first render already agree as
  // long as both read the same `seedSearch`, which is exactly what this does.
  const [view, setView] = useState<ScreenshotsView>(() => readScreenshotsView(seedSearch));
  // Previous view for history mode (push vs replace). Seeded to `view` so
  // the first URL-sync effect is a no-op when the address bar already matches.
  const viewRef = useRef(view);
  // One-shot override: in-page back from a shared drill-in link replaces
  // instead of pushing, so Back then leaves the page rather than returning
  // to the same drill-in.
  const locationWriteRef = useRef<"auto" | "replace">("auto");
  const [drill, setDrill] = useState<DrillState>({ status: "idle" });
  const [drillRetryNonce, setDrillRetryNonce] = useState(0);
  const [ghState, setGhState] = useState<DrillState>({ status: "loading" });
  // Scope of the last overview fetch that is allowed to replace the page with
  // the full-page skeleton. `view.merged` and `view.type` are deliberately excluded: toggling
  // Merged only or the type filter refetches the same workspace, and dropping a ready overview
  // unmounts the filter bar (Grouped/Recent is a client-side layout switch
  // on the same payload, so it never hits this path).
  const overviewScopeRef = useRef(`${apiOrigin}\0${workspace}\0${overviewRetryNonce}`);
  // SSR already fetched the overview for this search string (including
  // `?merged=1`). Skip the first client fetch so hydrate doesn't mark the
  // seeded groups busy and immediately replace them with the same payload.
  const skipSeededOverviewFetch = useRef(initialOverview?.status === "ready");

  // Overview fetch, once per mount/workspace/retry/merged-or-type change.
  useEffect(() => {
    let cancelled = false;
    const scope = `${apiOrigin}\0${workspace}\0${overviewRetryNonce}`;
    const scopeChanged = overviewScopeRef.current !== scope;
    overviewScopeRef.current = scope;
    if (skipSeededOverviewFetch.current) {
      skipSeededOverviewFetch.current = false;
      return;
    }
    if (scopeChanged) {
      setOverview({ status: "loading" });
      setOverviewRefreshing(false);
    } else {
      setOverviewRefreshing(true);
    }
    onSession(() => {
      void getWorkspaceFilesByPath(apiOrigin, workspace, {
        merged: view.merged,
        type: view.type ?? undefined,
      }).then((result) => {
        if (cancelled) return;
        setOverviewRefreshing(false);
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
  }, [apiOrigin, workspace, overviewRetryNonce, view.merged, view.type]);

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

  // Keep the address bar in sync. Project/path changes push so Back returns
  // to the previous folder; q/sort/merged/type replace the current entry. Skip
  // when the URL already matches (popstate, first paint). Preserve
  // ClientRouter's history.state — a `replaceState(null)` here used to wipe
  // it, which is part of why Back left the page.
  useEffect(() => {
    const prev = viewRef.current;
    viewRef.current = view;
    const forced = locationWriteRef.current;
    locationWriteRef.current = "auto";
    const target = window.location.pathname + screenshotsSearchFromView(view);
    const current = window.location.pathname + window.location.search;
    if (target === current) return;
    const mode = forced === "replace" ? "replace" : screenshotsHistoryMode(prev, view);
    writeScreenshotsLocation(target, mode);
  }, [view]);

  // ClientRouter also listens for popstate and would treat a query-only
  // change as a full page swap. While this island is mounted and the
  // destination is still the Files By page view, steal the event in capture
  // and update `view` in place. Leaving the page (sidebar, another Files
  // view, browser Back off the overview) does not match, so ClientRouter
  // handles that swap.
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      if (!isPagesLocation(workspace, window.location.pathname, window.location.search)) return;
      event.stopImmediatePropagation();
      const next = readScreenshotsView(window.location.search);
      setView((prev) => (screenshotsViewsEqual(prev, next) ? prev : next));
    };
    window.addEventListener("popstate", onPop, true);
    return () => window.removeEventListener("popstate", onPop, true);
  }, [workspace]);

  // Drill-in fetch — URL-synced so a reload or shared link lands on the
  // same view. Clearing view.path ("") goes back to the overview/project
  // view without a search fetch. Bare legacy `?path=` links keep working —
  // they simply carry an empty view.project, so no project filter applies.
  useEffect(() => {
    if (!view.path) {
      setDrill({ status: "idle" });
      return;
    }
    let cancelled = false;
    setDrill({ status: "loading" });
    onSession(() => {
      void searchWorkspaceFiles(
        apiOrigin,
        workspace,
        [
          { key: "path", value: view.path },
          // "Merged only" toggle (persisted PR merge-state tagging): gh.merged
          // is a normal ANDed metadata filter, same as any other meta.* term.
          ...(view.merged ? [{ key: "gh.merged", value: "true" }] : []),
        ],
        { collapsePromoted: true },
      ).then((result) => {
        if (cancelled) return;
        setDrill(
          result.kind === "ok"
            ? { status: "ready", items: result.items, truncated: result.truncated }
            : { status: "error" },
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, view.path, view.merged, drillRetryNonce]);

  // Cmd/Ctrl-K and "/" focus the path filter. Escape and scroll dismissal of
  // the hover preview live in useShotPreview.
  useEffect(() => {
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (info.status === "loading" || overview.status === "loading") {
    return <OverviewLoadingSkeleton />;
  }

  if (info.status === "unavailable" || info.status === "no-access") {
    return <InfoBlocked info={info} retry={retryInfo} />;
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
  const setSort = (sort: RecentView) => setView({ ...view, path: "", sort });
  const setType = (type: FileTypeClass | null) => setView({ ...view, type });
  const setMerged = (merged: boolean) => setView({ ...view, merged });

  // GitHub items bucketed by project label, for both the overview's
  // per-project strips and the project view's full "From GitHub" section.
  const ghByProject = new Map<string, SearchFileItem[]>();
  if (ghState.status === "ready") {
    for (const item of ghState.items) {
      if (!matchesTypeFilter(item.key, view.type)) continue;
      const label = projectLabelFromItemMeta(item.metadata);
      ghByProject.set(label, [...(ghByProject.get(label) ?? []), item]);
    }
  }

  const ghOnlyLabels = [...ghByProject.keys()].filter(
    (label) => !overview.projects.some((p) => p.label === label),
  );
  const projectLabels = [...overview.projects.map((p) => p.label), ...ghOnlyLabels];
  // `view.merged` keeps the bar (and its toggle) visible even when the
  // merged-only filter itself narrows the catalog to nothing — otherwise a
  // workspace with no merged shots would hide the only control that can turn
  // the filter back off.
  const showFilter =
    projectLabels.length > 0 || overview.catalog.length > 0 || view.merged || view.type !== null;
  const filterBar = showFilter ? (
    <PathFilterBar
      project={view.project}
      q={view.q}
      path={view.path}
      sort={view.sort}
      type={view.type}
      merged={view.merged}
      projects={projectLabels}
      catalog={overview.catalog}
      onProject={setProject}
      onQuery={setQuery}
      onSort={setSort}
      onType={setType}
      onPickPath={(path) => setView({ ...view, path })}
      onMerged={setMerged}
    />
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
      // The type filter runs client-side AFTER files/search's 100-item cap
      // (it is not paginated), so a truncated response may hide matches past
      // the cap; the empty state and the footer note say so below.
      drillItems = drillItems.filter((item) => matchesTypeFilter(item.key, view.type));
    }
    const drillPaired = pairedShotKeys(
      drillItems.map((item) => ({ key: item.key, state: item.metadata?.state })),
    );
    const noun = view.type ? typeEmptyNoun(view.type) : "screenshots";
    const scopeFiltered = Boolean(view.project) || view.type !== null;
    let drillEmptyMessage = `No ${noun} at this path.`;
    if (scopeFiltered && drill.status === "ready" && drill.truncated) {
      drillEmptyMessage = view.type
        ? `None of the first 100 files at this path are ${noun}${view.project ? ` from ${view.project}` : ""} — there may be more beyond that.`
        : `None of the first 100 at this path belong to ${view.project} — there may be more beyond that.`;
    } else if (view.project) {
      drillEmptyMessage = `No ${noun} at this path for this project.`;
    }

    const parentView = { ...view, path: "" };
    return (
      <div className="wsp grid gap-8" aria-busy={overviewRefreshing || undefined}>
        {filterBar}
        <div className="wsp-drill__head grid gap-2 justify-items-start">
          <a
            href={screenshotsViewHref(workspace, parentView)}
            className="text-btn"
            onClick={(event) =>
              sameDocumentClick(event, () => {
                if (isScreenshotsNavState(window.history.state)) {
                  window.history.back();
                  return;
                }
                locationWriteRef.current = "replace";
                setView(parentView);
              })
            }
          >
            {view.project ? `← ${view.project}` : "← all projects"}
          </a>
          <h2 className="wsp-drill__heading m-0 text-base font-semibold [overflow-wrap:anywhere]">
            {view.path}
          </h2>
        </div>
        {drill.status === "loading" && (
          <div
            className="wsp-grid grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]"
            aria-busy="true"
          >
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
            <div className="wsp-grid grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
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
            {/* The project scope and the type filter are applied client-side
                AFTER the search's 100-item cap (the origin-labeled fallback
                can't be expressed as a metadata filter — spec keeps URL-prefix
                search out of scope), so a truncated response may hide matches:
                say so rather than claiming an empty/complete result. */}
            {drillItems.length === 0 && <InlineEmpty title={drillEmptyMessage} />}
            {drillItems.length > 0 && drill.truncated && (
              <p className="wft-end">
                {scopeFiltered
                  ? `${view.project && view.type ? "Project and type filters" : view.project ? "Project filter" : "Type filter"} applied to the first 100 at this path — there may be more.`
                  : "Showing the first 100 — narrow the path to see more."}
              </p>
            )}
          </>
        )}
        {previewLayer}
      </div>
    );
  }

  // Flat newest-first list (?sort=recent) — same filters, no grouping.
  if (view.sort === "recent") {
    const qTrimmed = view.q.trim();
    const latestItems = overview.latest.filter((item) => {
      if (view.project && item.project !== view.project) return false;
      return pathQueryMatches(item.path, qTrimmed);
    });
    const latestPaired = pairedShotKeys(latestItems);
    return (
      <div className="wsp grid gap-8" aria-busy={overviewRefreshing || undefined}>
        {filterBar}
        {latestItems.length === 0 ? (
          !view.merged &&
          view.type === null &&
          overview.latest.length === 0 &&
          overview.catalog.length === 0 ? (
            <EmptyShotsCta title="No screenshots yet" />
          ) : (
            <InlineEmpty
              title={
                overview.latest.length === 0
                  ? view.merged
                    ? "No merged uploads to show."
                    : "No recent uploads to show."
                  : "No recent uploads match this filter."
              }
            />
          )
        ) : (
          <>
            <div className="wsp-grid grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
              {latestItems.map((item) => {
                const prLabel = shotPrLabelInput(item, titles);
                return (
                  <ShotThumb
                    key={item.key}
                    item={item}
                    paired={latestPaired.has(item.key)}
                    contextLabel={prLabel ? <PrLabel size="sm" compact {...prLabel} /> : undefined}
                    href={opener.href(item)}
                    onOpen={() => opener.activate(item)}
                    {...previewHandlers}
                  />
                );
              })}
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

  // `view.merged` and `view.type` excluded from `isEmptyWorkspace`: an empty
  // catalog under the merged-only or type filter means "no merged shots yet", not "no screenshots
  // ever uploaded" — that's the filtered-empty message below, not the CLI CTA.
  const isEmptyWorkspace =
    !view.merged && view.type === null && overview.catalog.length === 0 && ghByProject.size === 0;
  const isEmptyFilter = !isEmptyWorkspace && sectionLabels.length === 0;
  const emptyNoun = view.type ? typeEmptyNoun(view.type) : "screenshots";
  const emptyScope = view.project ? " for this project" : "";
  let emptyFilterMessage = view.merged
    ? `No merged ${emptyNoun}${emptyScope} yet.`
    : `No ${emptyNoun}${emptyScope}.`;
  if (qTrim) {
    emptyFilterMessage = overview.catalogTruncated
      ? `No paths matching ${qTrim} in the most active set.`
      : `No paths matching ${qTrim}.`;
  }

  return (
    <div className="wsp grid gap-8" aria-busy={overviewRefreshing || undefined}>
      {filterBar}
      {isEmptyWorkspace ? (
        <EmptyShotsCta title="No screenshots yet" />
      ) : isEmptyFilter ? (
        <InlineEmpty title={emptyFilterMessage} />
      ) : (
        <>
          {sectionLabels.map((label, index) => {
            const projectSummary = overview.projects.find((p) => p.label === label);
            const groups = matchingGroups.filter((group) => group.project === label);
            const previewGroups = filtering ? groups : groups.slice(0, PREVIEW_PATHS_PER_PROJECT);
            const ghItems = showGh ? ghByProject.get(label) : undefined;
            const ghTruncated = showGh && ghState.status === "ready" && ghState.truncated;
            return (
              <ProjectSection
                key={label}
                label={label}
                summary={projectSummary}
                groups={previewGroups}
                ghItems={ghItems}
                ghTruncated={ghTruncated}
                typeFiltered={view.type !== null}
                showViewProject={!view.project}
                // Each subsequent project opens with a full-width hairline —
                // the section boundary is structural, not just whitespace —
                // so a project head can't be misread as one more path row.
                bordered={index > 0}
                projectHref={screenshotsViewHref(workspace, {
                  ...view,
                  project: label,
                  path: "",
                })}
                onViewProject={() => setView({ ...view, project: label, path: "" })}
                onDrill={onDrill}
                drillHref={(group) =>
                  screenshotsViewHref(workspace, {
                    ...view,
                    project: group.project,
                    path: group.path,
                  })
                }
                opener={opener}
                preview={previewHandlers}
                titles={titles}
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
 * exactly one component when `files.astro` renders `<ScreenshotsByPath
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

/**
 * Count label for GitHub-mirrored items. Unfiltered, a capped search page
 * reads "100+ files". Under a type filter the visible count is a subset of
 * that page, so the truncation flag (not the filtered count) drives the
 * marker, and it reads "N+ files" rather than claiming 100.
 */
function ghCountLabel(count: number, truncated: boolean, typeFiltered: boolean): string {
  if (typeFiltered && truncated) return `${count}+ files`;
  return formatShotCount(count, { truncated: truncated && count >= SHOT_COUNT_DISPLAY_CAP });
}

function ProjectSection({
  label,
  summary,
  groups,
  ghItems,
  ghTruncated,
  typeFiltered,
  showViewProject,
  bordered,
  projectHref,
  onViewProject,
  onDrill,
  drillHref,
  opener,
  preview,
  titles,
}: {
  label: string;
  summary: ProjectSummary | undefined;
  groups: FilesPathGroup[];
  ghItems: SearchFileItem[] | undefined;
  /** GitHub search page hit its cap — only affects a GH-only heading. */
  ghTruncated: boolean;
  /** A type filter is active, so GitHub counts are post-cap-filter counts. */
  typeFiltered: boolean;
  showViewProject: boolean;
  /** True for every project section after the first — see call site. */
  bordered: boolean;
  projectHref: string;
  onViewProject: () => void;
  onDrill: (group: { project: string; path: string }) => void;
  drillHref: (group: { project: string; path: string }) => string;
  opener: FileOpener;
  preview: PreviewHandlers;
  titles: GithubTitleMap;
}) {
  // A GH-only label (no by-path groups) has no ProjectSummary — fall back to
  // the GitHub items' count so the header still reads sensibly.
  const count = summary?.count ?? ghItems?.length ?? 0;
  const lastUpdated = summary?.lastUpdated;

  const labelBody = (
    <>
      {/* 15px to sit proportionally beside the --text-h3 label; the default
          12 was scaled for the old body-size head. */}
      {isRepoLabel(label) && <GitHubMark size={15} />}
      {label}
    </>
  );

  return (
    <div className={`wsp-project grid gap-4${bordered ? " border-t border-line pt-7" : ""}`}>
      <div className="wsp-project__head flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 w-full sm:flex-nowrap">
        {/* The project name IS the "view project" control — a standing
            "view project →" beside every section repeated the same text
            down the page. The arrow affordance discloses on hover/focus
            (always visible on hover-less devices). */}
        {showViewProject ? (
          <a
            href={projectHref}
            className="wsp-project__label flex-[1_0_100%] sm:flex-none bg-none border-0 p-0 text-left cursor-pointer text-fg font-semibold text-[19px] leading-[1.3] [overflow-wrap:anywhere] hover:underline focus-visible:underline [text-underline-offset:4px] hover:decoration-muted-foreground focus-visible:decoration-muted-foreground [text-decoration-thickness:1px]"
            onClick={(event) => sameDocumentClick(event, onViewProject)}
          >
            {labelBody}
            <span
              className="wsp-project__go hidden ml-2 text-muted-foreground [@media(hover:none)]:inline"
              aria-hidden="true"
            >
              →
            </span>
          </a>
        ) : (
          <span className="wsp-project__label flex-[1_0_100%] sm:flex-none text-fg font-semibold text-[19px] leading-[1.3] [overflow-wrap:anywhere]">
            {labelBody}
          </span>
        )}
        <span className="wsp-group__meta text-muted-foreground text-[12px] whitespace-nowrap">
          {summary ? formatShotCount(count) : ghCountLabel(count, ghTruncated, typeFiltered)}
          {lastUpdated ? ` · ${lastUpdatedLabel(lastUpdated, new Date())}` : ""}
        </span>
      </div>
      {groups.map((group) => (
        <PathGroupSection
          key={group.path}
          group={group}
          href={drillHref(group)}
          onDrill={onDrill}
          opener={opener}
          preview={preview}
        />
      ))}
      {ghItems && (
        <GitHubSection
          items={ghItems}
          truncated={ghTruncated}
          typeFiltered={typeFiltered}
          opener={opener}
          preview={preview}
          titles={titles}
        />
      )}
    </div>
  );
}

function GitHubSection({
  items,
  truncated,
  typeFiltered,
  opener,
  preview,
  titles,
}: {
  items: SearchFileItem[];
  truncated: boolean;
  typeFiltered: boolean;
  opener: FileOpener;
  preview: PreviewHandlers;
  titles: GithubTitleMap;
}) {
  return (
    <div className="wsp-group grid gap-2.5">
      <div className="wsp-group__head flex items-baseline gap-2.5 w-full">
        <span className="wsp-group__path font-semibold text-[13px] [overflow-wrap:anywhere]">
          From GitHub
        </span>
        <span className="wsp-group__meta text-muted-foreground text-[12px] whitespace-nowrap">
          {ghCountLabel(items.length, truncated, typeFiltered)}
        </span>
      </div>
      <div className="wsp-strip">
        {items.map((item) => {
          const prLabel = shotPrLabelInput(item, titles);
          const author = item.metadata["gh.author"];
          return (
            <ShotThumb
              key={item.key}
              item={item}
              contextLabel={
                <>
                  {prLabel ? (
                    <PrLabel size="sm" compact {...prLabel} />
                  ) : (
                    <>
                      <GhKindIcon kind={item.metadata["gh.kind"]} />{" "}
                      {ghKindFallbackLabel(item.metadata["gh.kind"])}
                    </>
                  )}
                  {author ? ` · ${author}` : ""}
                </>
              }
              href={opener.href(item)}
              onOpen={() => opener.activate(item)}
              {...preview}
            />
          );
        })}
      </div>
    </div>
  );
}

function PathGroupSection({
  group,
  href,
  onDrill,
  opener,
  preview,
}: {
  group: FilesPathGroup;
  href: string;
  onDrill: (group: { project: string; path: string }) => void;
  opener: FileOpener;
  preview: PreviewHandlers;
}) {
  const paired = pairedShotKeys(group.recent);
  return (
    <div className="wsp-group grid gap-2.5">
      <a
        href={href}
        className="wsp-group__head group flex items-baseline gap-2.5 w-full bg-none border-0 p-0 text-left cursor-pointer text-inherit font-[inherit]"
        onClick={(event) => sameDocumentClick(event, () => onDrill(group))}
      >
        <span className="wsp-group__path font-semibold text-[13px] [overflow-wrap:anywhere]">
          {group.path}
        </span>
        <span className="wsp-group__meta text-muted-foreground text-[12px] whitespace-nowrap">
          {formatShotCount(group.count)} · {lastUpdatedLabel(group.lastUpdated, new Date())}
        </span>
        {/* Hint, not a control (the whole head is the drill-in link) — disclosed
            on hover/focus; opacity (not display) keeps it in the accessible name
            and keeps the row's layout stable. Hover-less devices keep a compact
            trailing chevron always visible instead (no hover reveal moment). */}
        <span className="wsp-group__viewall ml-auto text-muted-foreground text-[12px] whitespace-nowrap opacity-0 transition-opacity duration-[120ms] ease-linear group-hover:opacity-100 group-hover:text-fg group-focus-visible:opacity-100 group-focus-visible:text-fg [@media(hover:none)]:opacity-100">
          <span className="wsp-group__viewall-text [@media(hover:none)]:hidden">view all </span>→
        </span>
      </a>
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
