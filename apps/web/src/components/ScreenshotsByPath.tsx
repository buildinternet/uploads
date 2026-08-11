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
  type SearchFileItem,
} from "../lib/api-client";
import { loadWorkspaces } from "../lib/workspaces-nav";
import { resolveWorkspaceInfo, type WorkspaceInfoStatus } from "../lib/workspace-file-row";
import { onSession } from "../lib/account-shell";
import { filePath } from "../lib/public-file";
import { fetchWithTimeout } from "../lib/request";
import {
  lastUpdatedLabel,
  readScreenshotsPath,
  screenshotsSearch,
  shotKindFromKey,
} from "../lib/workspace-screenshots";

interface ScreenshotsByPathProps {
  apiOrigin: string;
  workspace: string;
}

type OverviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; groups: FilesPathGroup[]; truncated: boolean };

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
    `${apiOrigin.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/file-url?key=${encodeURIComponent(key)}`,
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
  const kindLabel = kind === "pull" ? "PR" : kind === "issues" ? "Issue" : kind;
  const base = kindLabel && number ? `${kindLabel} #${number}` : kindLabel || number || "GitHub";
  const author = item.metadata["gh.author"];
  return author ? `${base} · ${author}` : base;
}

// ── Thumb tile ─────────────────────────────────────────────────────────

function ShotThumb({
  item,
  onOpen,
}: {
  item: { key: string; url: string | null; embedUrl: string | null; state?: string };
  onOpen: () => void;
}) {
  const name = leafName(item.key);
  const kind = shotKindFromKey(item.key);
  const showLock = kind === "image" && item.url === null;
  const showImage = kind === "image" && !!item.embedUrl;

  return (
    <button type="button" className="wsp-tile" aria-label={`Open ${name}`} onClick={onOpen}>
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
      {item.state && <span className="wsp-state">{item.state}</span>}
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
  const [drillPath, setDrillPath] = useState<string>(() =>
    readScreenshotsPath(window.location.search),
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
            ? { status: "ready", groups: result.groups, truncated: result.truncated }
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
  // same path. Clearing drillPath ("") goes back to the overview without a
  // search fetch.
  useEffect(() => {
    history.replaceState(null, "", window.location.pathname + screenshotsSearch(drillPath));
    if (!drillPath) {
      setDrill({ status: "idle" });
      return;
    }
    let cancelled = false;
    setDrill({ status: "loading" });
    onSession(() => {
      void searchWorkspaceFiles(apiOrigin, workspace, [{ key: "path", value: drillPath }]).then(
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
  }, [apiOrigin, workspace, drillPath, drillRetryNonce]);

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

  // Drill-in view.
  if (drillPath) {
    return (
      <div className="wsp">
        <button type="button" className="text-btn" onClick={() => setDrillPath("")}>
          ← all paths
        </button>
        <h2 className="wsp-drill__heading">{drillPath}</h2>
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
              {drill.items.map((item) => (
                <ShotThumb
                  key={item.key}
                  item={{ ...item, state: item.metadata?.state }}
                  onOpen={() => open(item)}
                />
              ))}
            </div>
            {drill.items.length === 0 && <p className="wft-end">No screenshots at this path.</p>}
            {drill.truncated && (
              <p className="wft-end">Showing the first 100 — narrow the path to see more.</p>
            )}
          </>
        )}
      </div>
    );
  }

  // Overview: empty state when no path-tagged screenshots exist at all.
  if (overview.groups.length === 0) {
    return (
      <div className="ws-empty-state">
        <p className="ws-empty-state__title">No screenshots with a path yet</p>
        <p className="ws-empty-state__body">
          <code>uploads screenshot</code> records the page it captured automatically, and any upload
          can pass <code>--meta path=/settings</code> to group here. See{" "}
          <a href="/docs">the docs</a> for details.
        </p>
      </div>
    );
  }

  return (
    <div className="wsp">
      {overview.groups.map((group) => (
        <PathGroupSection key={group.path} group={group} onDrill={setDrillPath} onOpen={open} />
      ))}
      {overview.truncated && (
        <p className="wft-end">Showing the most active paths — narrow with a specific path.</p>
      )}
      {ghState.status === "ready" && ghState.items.length > 0 && (
        <GitHubSection items={ghState.items} onOpen={open} />
      )}
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
            item={{ ...item, state: ghLabel(item) }}
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
  onDrill: (path: string) => void;
  onOpen: (file: PathGroupItem) => void;
}) {
  return (
    <div className="wsp-group">
      <button type="button" className="wsp-group__head" onClick={() => onDrill(group.path)}>
        <span className="wsp-group__path">{group.path}</span>
        <span className="wsp-group__meta">
          {group.count} {group.count === 1 ? "file" : "files"} ·{" "}
          {lastUpdatedLabel(group.lastUpdated, new Date())}
        </span>
        <span className="wsp-group__viewall">view all →</span>
      </button>
      <div className="wsp-strip">
        {group.recent.map((item) => (
          <ShotThumb key={item.key} item={item} onOpen={() => onOpen(item)} />
        ))}
      </div>
    </div>
  );
}
