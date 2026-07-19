/**
 * The 3A workspace files tab — filter bar, chips ↔ breadcrumbs, a conditional
 * exact-PR-match banner, and the file row grid (thumbnail, size, type,
 * visibility, `⋯` actions). Replaces `WorkspaceFiles` + `AccountFileBrowser` +
 * `MetadataSearchResults` as the single island mounted by
 * `pages/account/workspaces/[name].astro`. See
 * `.superpowers/sdd/task-8-brief.md` for the row grid / thumbnail / chip spec.
 *
 * Data source: `listWorkspaceFolder` when no filters are active (folder
 * browse, URL-synced via `workspace-browse-url`), `searchWorkspaceFiles` when
 * one or more metadata filters are active (URL-synced via
 * `workspace-search-url`) — same split as the components this replaces.
 * After every listing/search resolves, the current row set is pushed to the
 * right-rail "connected work" section (Task 7's
 * `window.__uploadsSetConnectedWork` hook) and checked for an exact
 * single-pull-request match (the banner).
 */
import { Callout } from "@uploads/ui";
import "@uploads/ui/styles.css";
import { Fragment, useEffect, useState } from "react";
import type { ConnectedWorkSetter } from "../lib/workspace-rail";
import { connectedWork, exactPrMatch, type GhWorkItem } from "../lib/gh-context";
import {
  getMyWorkspaces,
  listWorkspaceFolder,
  searchWorkspaceFiles,
  setFileVisibility,
  type FileVisibility,
} from "../lib/api-client";
import { filePath, formatBytes } from "../lib/public-file";
import {
  breadcrumbSegments,
  childName,
  chipKind,
  fileTypeLabel,
  isPrivateFile,
  pickThumbnail,
  resolveWorkspaceInfo,
  type WorkspaceInfoStatus,
} from "../lib/workspace-file-row";
import {
  normalizeBrowsePath,
  readBrowseLocation,
  replaceBrowseLocation,
} from "../lib/workspace-browse-url";
import {
  isValidMetaKey,
  isValidMetaValue,
  readSearchFilters,
  replaceSearchLocation,
  type MetaFilter,
} from "../lib/workspace-search-url";
import { fetchWithTimeout } from "../lib/request";
import { onSession } from "../lib/account-shell";

interface WorkspaceFileTableProps {
  apiOrigin: string;
  workspace: string;
}

/** Unified row shape both `listWorkspaceFolder` and `searchWorkspaceFiles` satisfy. */
interface FileTableRow {
  key: string;
  url: string | null;
  embedUrl: string | null;
  size?: number;
  contentType?: string;
  visibility?: FileVisibility;
  metadata?: Record<string, string>;
}

type ListingState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ok";
      files: FileTableRow[];
      prefixes: string[];
      cursor?: string;
      truncated?: boolean;
    };

// ── Icons ───────────────────────────────────────────────────────────────
// Inline octicons matching the 3A reference verbatim (repo mark + PR glyph
// for chips/banner; lock for private; play for video; folder is this
// component's own addition — the reference's mock starts several levels
// into a folder, so it never shows a folder row).

function GithubMarkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function PullRequestIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="3.5" y="7.5" width="9" height="6" rx="1" />
      <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.5 3.2 12.5 8l-8 4.8v-9.6z" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <path d="M2 4.5A1 1 0 0 1 3 3.5h3.3l1.1 1.4H13a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
    </svg>
  );
}

// ── URL-resolution helpers (open-file / copy-link) ────────────────────────
// Mirrors AccountFileBrowser's hasPublicUrl-branching open logic verbatim:
// a workspace with a stable public domain always opens through the chrome-
// wrapped `/f/` page (issue #135); otherwise (private/BYO without a public
// domain) resolve a short-lived signed URL via the member-gated endpoint.

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

function openFile(apiOrigin: string, workspace: string, hasPublicUrl: boolean, key: string): void {
  if (hasPublicUrl) {
    const tab = window.open(filePath(workspace, key), "_blank");
    if (tab) tab.opener = null;
    return;
  }
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  void resolveSignedFileUrl(apiOrigin, workspace, key).then((url) => {
    if (url) {
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } else {
      tab?.close();
    }
  });
}

// ── Component ──────────────────────────────────────────────────────────

export function WorkspaceFileTable({ apiOrigin, workspace }: WorkspaceFileTableProps) {
  const [info, setInfo] = useState<WorkspaceInfoStatus | { status: "loading" }>({
    status: "loading",
  });
  // Bumped by the "Try again" affordance on the unavailable state to re-run
  // the workspace-info effect below without a full page reload.
  const [infoRetryNonce, setInfoRetryNonce] = useState(0);

  const [prefix, setPrefix] = useState(
    () => readBrowseLocation(window.location.search, window.location.pathname).path,
  );
  const [filters, setFilters] = useState<MetaFilter[]>(() =>
    readSearchFilters(window.location.search),
  );
  const [draft, setDraft] = useState("");
  const [filterError, setFilterError] = useState<string | null>(null);
  const [state, setState] = useState<ListingState>({ status: "loading" });
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [togglingKeys, setTogglingKeys] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const filtersKey = filters.map((f) => `${f.key}=${f.value}`).join("&");
  const filtered = filters.length > 0;

  // Resolve workspace-level facts once (communal / public-domain-configured),
  // gated behind the layout's session resolution like the rail (workspace-rail.ts).
  useEffect(() => {
    let cancelled = false;
    setInfo({ status: "loading" });
    onSession(() => {
      void getMyWorkspaces(apiOrigin).then((result) => {
        if (cancelled) return;
        setInfo(resolveWorkspaceInfo(result, workspace));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, infoRetryNonce]);

  // Folder/search listing — only once we know this isn't the communal
  // workspace, and only once workspace-info actually resolved (an outage or
  // lost-access status renders in place of the table instead — see below).
  useEffect(() => {
    if (info.status !== "ready" || info.communal) return;
    let cancelled = false;
    setState({ status: "loading" });
    async function run() {
      if (filtered) {
        const result = await searchWorkspaceFiles(apiOrigin, workspace, filters);
        if (cancelled) return;
        setState(
          result.kind === "ok"
            ? { status: "ok", files: result.items, prefixes: [], truncated: result.truncated }
            : { status: "error" },
        );
        return;
      }
      const listing = await listWorkspaceFolder(apiOrigin, workspace, {
        prefix: prefix || undefined,
      });
      if (cancelled) return;
      setState({
        status: "ok",
        files: listing.files,
        prefixes: listing.prefixes,
        cursor: listing.cursor,
      });
    }
    void run();
    return () => {
      cancelled = true;
    };
    // filtersKey stands in for `filters` (serialized) — same convention as
    // the MetadataSearchResults component this replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOrigin, workspace, info, filtered, filtersKey, prefix]);

  // Push the current row set to the rail + banner on every resolved listing.
  useEffect(() => {
    if (state.status !== "ok") return;
    const setter = (window as unknown as { __uploadsSetConnectedWork?: ConnectedWorkSetter })
      .__uploadsSetConnectedWork;
    setter?.(connectedWork(state.files));
  }, [state]);

  // Close the open `⋯` menu on outside click / Escape.
  useEffect(() => {
    if (!openMenuKey) return;
    const onDocClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".wft-menu")) {
        setOpenMenuKey(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuKey(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuKey]);

  const commitFilters = (next: MetaFilter[]) => {
    setFilters(next);
    replaceSearchLocation(workspace, next);
  };

  const navigate = (nextPrefix: string) => {
    const normalized = normalizeBrowsePath(nextPrefix);
    if (normalized === prefix) return;
    setOpenMenuKey(null);
    setPrefix(normalized);
    replaceBrowseLocation({ workspace, path: normalized });
  };

  const addFilter = () => {
    const raw = draft.trim();
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      setFilterError("Use key=value (e.g. gh.repo=uploads).");
      return;
    }
    const k = raw.slice(0, eq).trim();
    const v = raw.slice(eq + 1).trim();
    if (!isValidMetaKey(k)) {
      setFilterError("Key must be lowercase letters/digits/._- and start with a letter.");
      return;
    }
    if (!isValidMetaValue(v)) {
      setFilterError("Value must be 1–512 printable ASCII characters.");
      return;
    }
    if (filters.some((f) => f.key === k)) {
      setFilterError(`Already filtering on "${k}".`);
      return;
    }
    if (filters.length >= 24) {
      setFilterError("At most 24 filters.");
      return;
    }
    setFilterError(null);
    setDraft("");
    commitFilters([...filters, { key: k, value: v }]);
  };

  const removeFilter = (key: string) => {
    setFilterError(null);
    commitFilters(filters.filter((f) => f.key !== key));
  };

  const patchVisibility = (key: string, visibility: FileVisibility) => {
    setState((prev) =>
      prev.status === "ok"
        ? { ...prev, files: prev.files.map((f) => (f.key === key ? { ...f, visibility } : f)) }
        : prev,
    );
  };

  const toggleVisibility = async (file: FileTableRow) => {
    const next: FileVisibility = isPrivateFile(file) ? "public" : "private";
    setTogglingKeys((prev) => new Set(prev).add(file.key));
    setActionError(null);
    try {
      const result = await setFileVisibility(apiOrigin, workspace, file.key, next);
      if (result.kind === "success") {
        patchVisibility(file.key, result.visibility);
        setOpenMenuKey(null);
      } else {
        setActionError(
          `Couldn't make "${childName(file.key, prefix)}" ${next}. Try again shortly.`,
        );
      }
    } finally {
      setTogglingKeys((prev) => {
        const copy = new Set(prev);
        copy.delete(file.key);
        return copy;
      });
    }
  };

  const copyLink = async (file: FileTableRow, button: HTMLButtonElement) => {
    const url = file.url ?? (await resolveSignedFileUrl(apiOrigin, workspace, file.key));
    if (!url) {
      setActionError(`Couldn't get a link for "${childName(file.key, prefix)}".`);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      const previous = button.textContent;
      button.textContent = "copied ✓";
      setTimeout(() => {
        button.textContent = previous;
      }, 1200);
    } catch {
      // clipboard blocked — leave the label
    }
  };

  const loadMore = async () => {
    if (state.status !== "ok" || !state.cursor) return;
    const listing = await listWorkspaceFolder(apiOrigin, workspace, {
      prefix: prefix || undefined,
      cursor: state.cursor,
    });
    setState((prev) =>
      prev.status === "ok"
        ? {
            status: "ok",
            files: [...prev.files, ...listing.files],
            prefixes: [...new Set([...prev.prefixes, ...listing.prefixes])],
            cursor: listing.cursor,
          }
        : prev,
    );
  };

  if (info.status === "loading") {
    return <p className="wft-status">Loading workspace…</p>;
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

  if (info.communal) {
    return (
      <div className="wft-communal">
        <h2 className="ws-section-head">Shared space</h2>
        <p className="ws-note">
          Shared, public space — world-readable at <code>storage.uploads.sh</code>. Browse and
          upload with the CLI.
        </p>
      </div>
    );
  }

  const match: GhWorkItem | null = state.status === "ok" ? exactPrMatch(state.files) : null;
  const count = state.status === "ok" ? state.files.length : 0;
  const folderCount = state.status === "ok" ? state.prefixes.length : 0;
  const topLabel =
    state.status === "loading"
      ? ""
      : filtered
        ? `${count} match${count === 1 ? "" : "es"}`
        : `${count} file${count === 1 ? "" : "s"}`;
  const endLabel = (() => {
    if (state.status === "loading") return "Loading…";
    if (state.status === "error")
      return filtered
        ? "Search is temporarily unavailable. Try again."
        : "Files are temporarily unavailable. Try again.";
    if (filtered) {
      if (count === 0) return "No files match these filters.";
      return state.truncated
        ? `${count} match${count === 1 ? "" : "es"} — showing the first 100. Add a filter to narrow.`
        : `${count} match${count === 1 ? "" : "es"}`;
    }
    if (count === 0 && folderCount === 0) return "No files yet.";
    const parts: string[] = [];
    if (folderCount) parts.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
    parts.push(`${count} file${count === 1 ? "" : "s"}`);
    return parts.join(" · ");
  })();

  return (
    <div className="wft">
      <form
        className="wft-filterbar input-group"
        onSubmit={(e) => {
          e.preventDefault();
          addFilter();
        }}
      >
        <span className="input-group__field">
          <input
            aria-label="Metadata filter"
            placeholder="filter key=value  (e.g. gh.repo=uploads)"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
        </span>
        <button type="submit" className="input-group__action">
          [add]
        </button>
      </form>
      {filterError && (
        <p className="wft-error" role="alert">
          {filterError}
        </p>
      )}
      {actionError && (
        <Callout tone="error" role="alert">
          {actionError}
        </Callout>
      )}

      <div className="wft-sectionhead">
        <span className="wft-sectionhead__rule wft-sectionhead__rule--lead" />
        <span className="wft-sectionhead__label">files</span>
        <span className="wft-sectionhead__rule" />
        <span className="wft-sectionhead__count">{topLabel}</span>
      </div>

      {filtered ? (
        <div className="wft-chips">
          {filters.map((f) => {
            const kind = chipKind(f.key);
            return (
              <span className="wft-chip" key={f.key}>
                {kind === "repo" && <GithubMarkIcon className="wft-chip__icon" />}
                {kind === "pr" && <PullRequestIcon className="wft-chip__icon" />}
                {kind === "plain" && (
                  <>
                    <span className="wft-chip__key">{f.key}</span>
                    <span className="wft-chip__eq">=</span>
                  </>
                )}
                <span className="wft-chip__value">{f.value}</span>
                <button
                  type="button"
                  className="wft-chip__remove"
                  aria-label={`Remove filter ${f.key}`}
                  onClick={() => removeFilter(f.key)}
                >
                  ×
                </button>
              </span>
            );
          })}
          <span className="wft-clearall">
            metadata search ·{" "}
            <button type="button" onClick={() => commitFilters([])}>
              clear all
            </button>
          </span>
        </div>
      ) : (
        <nav className="wft-crumbs" aria-label="Current folder">
          <button
            type="button"
            onClick={() => navigate("")}
            aria-current={prefix === "" ? "location" : undefined}
          >
            ~
          </button>
          {breadcrumbSegments(prefix).map((segment, index, all) => (
            <Fragment key={segment.prefix}>
              <span className="wft-crumbs__sep">/</span>
              {index === all.length - 1 ? (
                <span className="wft-crumbs__current">{segment.label}</span>
              ) : (
                <button type="button" onClick={() => navigate(segment.prefix)}>
                  {segment.label}
                </button>
              )}
            </Fragment>
          ))}
        </nav>
      )}

      {match && (
        <div className="wft-banner">
          <GithubMarkIcon className="wft-banner__icon" />
          <span className="wft-banner__kind">{match.kindLabel}</span>
          <a className="wft-banner__ref" href={match.url} target="_blank" rel="noopener noreferrer">
            {match.label}
          </a>
          <span className="wft-banner__spacer" />
          <a
            className="wft-banner__open"
            href={match.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            [open on github ↗]
          </a>
        </div>
      )}

      <div className="wft-grid">
        <div className="wft-head">
          <span>name</span>
          <span>size</span>
          <span>type</span>
          <span>visibility</span>
          <span />
        </div>

        {state.status === "ok" &&
          !filtered &&
          state.prefixes.map((folder) => (
            <button
              key={folder}
              type="button"
              className="wft-row wft-row--folder"
              onClick={() => navigate(folder)}
            >
              <span className="wft-name">
                <span className="wft-thumb wft-thumb--tile" aria-hidden="true">
                  <FolderIcon />
                </span>
                <span className="wft-filename">{childName(folder, prefix)}/</span>
              </span>
              <span className="wft-size" />
              <span className="wft-type" />
              <span className="wft-vis" />
              <span />
            </button>
          ))}

        {state.status === "ok" &&
          state.files.map((file) => {
            const name = filtered ? childName(file.key, "") : childName(file.key, prefix);
            const thumb = pickThumbnail(file);
            const type = fileTypeLabel(file);
            const priv = isPrivateFile(file);
            const menuOpen = openMenuKey === file.key;
            const busy = togglingKeys.has(file.key);

            return (
              <div className="wft-row" key={file.key}>
                <button
                  type="button"
                  className="wft-name wft-name--btn"
                  onClick={() => openFile(apiOrigin, workspace, info.hasPublicUrl, file.key)}
                >
                  {thumb.kind === "image" && (
                    <span
                      className="wft-thumb"
                      style={{ backgroundImage: `url(${thumb.src})` }}
                      aria-hidden="true"
                    />
                  )}
                  {thumb.kind === "video" && (
                    <span className="wft-thumb wft-thumb--tile" aria-hidden="true">
                      <PlayIcon />
                    </span>
                  )}
                  {thumb.kind === "lock" && (
                    <span className="wft-thumb wft-thumb--tile" aria-hidden="true">
                      <LockIcon />
                    </span>
                  )}
                  <span className="wft-filename">{name}</span>
                </button>
                <span className="wft-size">
                  {typeof file.size === "number" ? formatBytes(file.size) : "—"}
                </span>
                <span className="wft-type">{type}</span>
                <span className={`wft-vis ${priv ? "wft-vis--private" : "wft-vis--public"}`}>
                  {priv ? (
                    <LockIcon className="wft-vis__icon" />
                  ) : (
                    <span className="wft-vis__dot" aria-hidden="true" />
                  )}
                  {priv ? "private" : "public"}
                </span>
                <div className="wft-menu">
                  <button
                    type="button"
                    className="wft-menu__trigger"
                    aria-expanded={menuOpen}
                    aria-label="File actions"
                    onClick={() => setOpenMenuKey((prev) => (prev === file.key ? null : file.key))}
                  >
                    ⋯
                  </button>
                  {menuOpen && (
                    <div role="menu" className="wft-menu__popover">
                      <button
                        type="button"
                        role="menuitem"
                        className="wft-menu__item"
                        onClick={(e) => void copyLink(file, e.currentTarget)}
                      >
                        copy link
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="wft-menu__item"
                        disabled={busy}
                        onClick={() => void toggleVisibility(file)}
                      >
                        {priv ? "make public" : "make private"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

        <div className="wft-end">{endLabel}</div>
      </div>

      {state.status === "ok" && state.cursor && (
        <button type="button" className="wft-loadmore text-btn" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </div>
  );
}
