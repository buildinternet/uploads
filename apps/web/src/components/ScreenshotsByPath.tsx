/**
 * Screenshots grouped by `path` metadata (spec:
 * docs/superpowers/specs/2026-08-10-screenshots-by-path-design.md).
 * Overview = one `files/by-path` fetch; drill-in (?path=) = the existing
 * `files/search?meta.path=…` route. Files without `path` metadata never
 * appear here — the empty state says how to get them.
 */
import { Callout } from "@uploads/ui";
import "@uploads/ui/styles.css";
import { useEffect, useState, type CSSProperties } from "react";
import {
  getWorkspaceFilesByPath,
  searchWorkspaceFiles,
  type FilesPathGroup,
  type PathGroupItem,
  type ProjectSummary,
  type SearchFileItem,
} from "../lib/api-client";
import { loadWorkspaces } from "../lib/workspaces-nav";
import { resolveWorkspaceInfo, type WorkspaceInfoStatus } from "../lib/workspace-file-row";
import { onSession } from "../lib/account-shell";
import { filePath } from "../lib/public-file";
import { fetchWithTimeout } from "../lib/request";
import {
  lastUpdatedLabel,
  pairedShotKeys,
  projectLabelFromItemMeta,
  readScreenshotsView,
  screenshotsSearch,
  shotKindFromKey,
} from "../lib/workspace-screenshots";

/** How many path groups a project section previews before "view project →". */
const PREVIEW_PATHS_PER_PROJECT = 3;

interface ScreenshotsByPathProps {
  apiOrigin: string;
  workspace: string;
}

type OverviewState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      groups: FilesPathGroup[];
      projects: ProjectSummary[];
      truncated: boolean;
    };

type DrillState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: SearchFileItem[]; truncated: boolean };

// ── URL-resolution helpers (open-file) ────────────────────────────────────
// Same shape as WorkspaceFileTable's private module helpers (Task 6 brief:
// reimplement rather than export) — prefer a public `/f/` URL, else a
// short-lived signed URL for private/BYO workspaces.

async function resolveSignedFileUrl(
  apiOrigin: string,
  workspace: string,
  key: string,
): Promise<string | null> {
  const result = await fetchWithTimeout(
    `${apiOrigin.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(workspace)}/files/file-url?key=${encodeURIComponent(key)}`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return null;
  const body = (await result.response.json().catch(() => ({}))) as { url?: string };
  return result.response.ok && typeof body.url === "string" ? body.url : null;
}

function openInNewTab(url: string): void {
  const tab = window.open(url, "_blank");
  if (tab) tab.opener = null;
}

function openFile(
  apiOrigin: string,
  workspace: string,
  hasPublicUrl: boolean,
  file: { key: string; pageUrl?: string },
): void {
  if (file.pageUrl) {
    openInNewTab(file.pageUrl);
    return;
  }
  if (hasPublicUrl) {
    openInNewTab(filePath(workspace, file.key));
    return;
  }
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  void resolveSignedFileUrl(apiOrigin, workspace, file.key).then((url) => {
    if (url) {
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } else {
      tab?.close();
    }
  });
}

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
  onOpen,
}: {
  item: { key: string; url: string | null; embedUrl: string | null; state?: string };
  /** True when a before/after counterpart sits in the same strip/grid. */
  paired?: boolean;
  /** Optional pill (GitHub "PR #7 · author" context) — not the state. */
  contextLabel?: string;
  onOpen: () => void;
}) {
  const name = leafName(item.key);
  const kind = shotKindFromKey(item.key);
  const showLock = kind === "image" && item.url === null;
  const showImage = kind === "image" && !!item.embedUrl;
  // The state stays in the accessible name (and hover title) even though the
  // tile no longer wears a BEFORE/AFTER pill — the pair badge covers the
  // visual signal, and only when a counterpart actually exists.
  const stateSuffix = item.state ? ` (${item.state})` : "";

  return (
    <button
      type="button"
      className="wsp-tile"
      aria-label={`Open ${name}${stateSuffix}${paired ? " — has before/after pair" : ""}`}
      title={item.state ? `${name}${stateSuffix}` : undefined}
      onClick={onOpen}
    >
      {showImage ? (
        <span
          className="wsp-thumb"
          style={{ backgroundImage: `url(${item.embedUrl})` }}
          aria-hidden="true"
        />
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
    </button>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────

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

// ── Component ──────────────────────────────────────────────────────────

export function ScreenshotsByPath({ apiOrigin, workspace }: ScreenshotsByPathProps) {
  const [info, setInfo] = useState<WorkspaceInfoStatus | { status: "loading" }>({
    status: "loading",
  });
  const [infoRetryNonce, setInfoRetryNonce] = useState(0);
  const [overview, setOverview] = useState<OverviewState>({ status: "loading" });
  const [overviewRetryNonce, setOverviewRetryNonce] = useState(0);
  const [view, setView] = useState<{ project: string; path: string }>(() =>
    readScreenshotsView(window.location.search),
  );
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
                projects: result.projects,
                truncated: result.truncated,
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
      window.location.pathname + screenshotsSearch(view.project, view.path),
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

  const open = (file: { key: string; pageUrl?: string }) =>
    openFile(apiOrigin, workspace, info.hasPublicUrl, file);
  const onDrill = (group: { project: string; path: string }) =>
    setView({ project: group.project, path: group.path });

  // GitHub items bucketed by project label, for both the overview's
  // per-project strips and the project view's full "From GitHub" section.
  const ghByProject = new Map<string, SearchFileItem[]>();
  if (ghState.status === "ready") {
    for (const item of ghState.items) {
      const label = projectLabelFromItemMeta(item.metadata);
      ghByProject.set(label, [...(ghByProject.get(label) ?? []), item]);
    }
  }

  // Drill-in view (?path=, optionally scoped to ?project=).
  if (view.path) {
    const drillItems =
      drill.status === "ready"
        ? view.project === ""
          ? drill.items
          : drill.items.filter((item) => projectLabelFromItemMeta(item.metadata) === view.project)
        : [];
    return (
      <div className="wsp">
        <button
          type="button"
          className="text-btn"
          onClick={() => setView({ project: view.project, path: "" })}
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
              {(() => {
                const withState = drillItems.map((item) => ({
                  item,
                  state: item.metadata?.state,
                }));
                const paired = pairedShotKeys(
                  withState.map(({ item, state }) => ({ key: item.key, state })),
                );
                return withState.map(({ item, state }) => (
                  <ShotThumb
                    key={item.key}
                    item={{ ...item, state }}
                    paired={paired.has(item.key)}
                    onOpen={() => open(item)}
                  />
                ));
              })()}
            </div>
            {/* The project scope is applied client-side AFTER the search's
                100-item cap (the origin-labeled fallback can't be expressed
                as a metadata filter — spec keeps URL-prefix search out of
                scope), so a truncated response may hide project matches: say
                so rather than claiming an empty/complete result. */}
            {drillItems.length === 0 && (
              <p className="wft-end">
                {view.project && drill.truncated
                  ? `None of the first 100 at this path belong to ${view.project} — there may be more beyond that.`
                  : view.project
                    ? "No screenshots at this path for this project."
                    : "No screenshots at this path."}
              </p>
            )}
            {drillItems.length > 0 && drill.truncated && (
              <p className="wft-end">
                {view.project
                  ? "Project filter applied to the first 100 at this path — there may be more."
                  : "Showing the first 100 — narrow the path to see more."}
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  // Project view (?project=, no ?path=): every path group and the full
  // GitHub strip for a single project, no preview truncation.
  if (view.project) {
    const projectGroups = overview.groups.filter((group) => group.project === view.project);
    const projectGh = ghByProject.get(view.project);
    const isEmpty = projectGroups.length === 0 && !projectGh;
    return (
      <div className="wsp">
        <button
          type="button"
          className="text-btn"
          onClick={() => setView({ project: "", path: "" })}
        >
          ← all projects
        </button>
        <h2 className="wsp-drill__heading">{view.project}</h2>
        {isEmpty ? (
          <div className="ws-empty-state">
            <p className="ws-empty-state__title">No screenshots for this project</p>
            <p className="ws-empty-state__body">
              <code>uploads screenshot</code> records the page it captured automatically, and any
              upload can pass <code>--meta path=/settings</code> to group here. See{" "}
              <a href="/docs">the docs</a> for details.
            </p>
          </div>
        ) : (
          <>
            {projectGroups.map((group) => (
              <PathGroupSection key={group.path} group={group} onDrill={onDrill} onOpen={open} />
            ))}
            {projectGh && <GitHubSection items={projectGh} onOpen={open} />}
          </>
        )}
      </div>
    );
  }

  // Overview: one section per project (recency-ordered API projects, then
  // GH-only labels), each with a preview of its path groups plus its
  // "From GitHub" strip when present. The empty state shows only when there
  // are no sections at all — a project with only GitHub-mirrored files (no
  // `path` metadata) still gets a section via ghByProject.
  const sectionLabels = [
    ...overview.projects.map((p) => p.label),
    ...[...ghByProject.keys()].filter((label) => !overview.projects.some((p) => p.label === label)),
  ];

  return (
    <div className="wsp">
      {sectionLabels.length === 0 ? (
        <div className="ws-empty-state">
          <p className="ws-empty-state__title">No screenshots with a path yet</p>
          <p className="ws-empty-state__body">
            <code>uploads screenshot</code> records the page it captured automatically, and any
            upload can pass <code>--meta path=/settings</code> to group here. See{" "}
            <a href="/docs">the docs</a> for details.
          </p>
        </div>
      ) : (
        <>
          {sectionLabels.map((label) => {
            const projectSummary = overview.projects.find((p) => p.label === label);
            const groups = overview.groups.filter((group) => group.project === label);
            const ghItems = ghByProject.get(label);
            return (
              <ProjectSection
                key={label}
                label={label}
                summary={projectSummary}
                groups={groups.slice(0, PREVIEW_PATHS_PER_PROJECT)}
                ghItems={ghItems}
                onViewProject={() => setView({ project: label, path: "" })}
                onDrill={onDrill}
                onOpen={open}
              />
            );
          })}
          {overview.truncated && (
            <p className="wft-end">Showing the most active paths — narrow with a specific path.</p>
          )}
        </>
      )}
    </div>
  );
}

function ProjectSection({
  label,
  summary,
  groups,
  ghItems,
  onViewProject,
  onDrill,
  onOpen,
}: {
  label: string;
  summary: ProjectSummary | undefined;
  groups: FilesPathGroup[];
  ghItems: SearchFileItem[] | undefined;
  onViewProject: () => void;
  onDrill: (group: { project: string; path: string }) => void;
  onOpen: (file: PathGroupItem | SearchFileItem) => void;
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
        <button type="button" className="text-btn wsp-project__viewall" onClick={onViewProject}>
          view project →
        </button>
      </div>
      {groups.map((group) => (
        <PathGroupSection key={group.path} group={group} onDrill={onDrill} onOpen={onOpen} />
      ))}
      {ghItems && <GitHubSection items={ghItems} onOpen={onOpen} />}
    </div>
  );
}

function GitHubSection({
  items,
  onOpen,
}: {
  items: SearchFileItem[];
  onOpen: (file: SearchFileItem) => void;
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
            onOpen={() => onOpen(item)}
          />
        ))}
      </div>
    </div>
  );
}

function PathGroupSection({
  group,
  onDrill,
  onOpen,
}: {
  group: FilesPathGroup;
  onDrill: (group: { project: string; path: string }) => void;
  onOpen: (file: PathGroupItem) => void;
}) {
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
      <div className="wsp-strip">
        {(() => {
          const paired = pairedShotKeys(group.recent);
          return group.recent.map((item) => (
            <ShotThumb
              key={item.key}
              item={item}
              paired={paired.has(item.key)}
              onOpen={() => onOpen(item)}
            />
          ));
        })()}
      </div>
    </div>
  );
}
