/**
 * The 3A workspace files tab — filter bar, chips ↔ breadcrumbs, a conditional
 * exact-PR-match banner, and the file listing (list or grid view: thumbnail,
 * size, type, visibility, `⋯` actions). Replaces `WorkspaceFiles` +
 * `AccountFileBrowser` + `MetadataSearchResults` as the single island mounted
 * by `pages/account/workspaces/[name].astro`. See
 * `.superpowers/sdd/task-8-brief.md` for the row / thumbnail / chip spec.
 *
 * Data source: `listWorkspaceFolder` when no filters are active (folder
 * browse, URL-synced via `workspace-browse-url`), `searchWorkspaceFiles` when
 * one or more metadata filters are active (URL-synced via
 * `workspace-search-url`) — same split as the components this replaces.
 * After every listing/search resolves, the current row set is pushed to the
 * right-rail "connected work" section (Task 7's
 * `window.__uploadsSetConnectedWork` hook) and checked for an exact
 * single-pull-request match (the banner).
 *
 * List vs grid is a soft client preference: `?view=list|grid` in the URL
 * (wins when present), else `uploads:filesView` in localStorage, else list.
 * Browse/search URL writers leave `view` alone, so folder/filter nav keeps it.
 */
import { Callout } from "@uploads/ui";
import "@uploads/ui/styles.css";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ConnectedWorkSetter } from "../lib/workspace-rail";
import { applyGhTitles, connectedWork, exactPrMatch, type GhWorkItem } from "../lib/gh-context";
import {
  GITHUB_TITLES_MAX_REFS,
  getGithubTitles,
  getMyWorkspaces,
  listWorkspaceFolder,
  searchWorkspaceFiles,
  setFileVisibility,
  type FileVisibility,
  type GithubTitleMap,
} from "../lib/api-client";
import { filePath, formatBytes } from "../lib/public-file";
import {
  breadcrumbSegments,
  childName,
  chipKind,
  fileTypeLabel,
  isPrivateFile,
  leafName,
  pickThumbnail,
  resolveWorkspaceInfo,
  type WorkspaceInfoStatus,
} from "../lib/workspace-file-row";
import {
  normalizeBrowsePath,
  readBrowseLocation,
  replaceBrowseLocation,
} from "../lib/workspace-browse-url";
import { replaceFilesView, resolveFilesView, type FilesView } from "../lib/workspace-files-view";
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

function PullRequestIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
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

function ListViewIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

function GridViewIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.5" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="0.5" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="0.5" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="0.5" />
    </svg>
  );
}

function FileThumb({ thumb }: { thumb: ReturnType<typeof pickThumbnail> }) {
  if (thumb.kind === "image") {
    return (
      <span
        className="wft-thumb"
        style={{ backgroundImage: `url(${thumb.src})` }}
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="wft-thumb wft-thumb--tile" aria-hidden="true">
      {thumb.kind === "video" && <PlayIcon />}
      {thumb.kind === "lock" && <LockIcon />}
    </span>
  );
}

function VisibilityBadge({ private: priv }: { private: boolean }) {
  return (
    <span
      className={`wft-vis ${priv ? "wft-vis--private" : "wft-vis--public"}`}
      title={
        priv
          ? "Unlisted: hidden from listings and the /f/ page unless signed in. The raw file URL still works for anyone who has it."
          : "Public: listed and reachable by anyone with the URL."
      }
    >
      {priv ? (
        <LockIcon className="wft-vis__icon" />
      ) : (
        <span className="wft-vis__dot" aria-hidden="true" />
      )}
      {priv ? "unlisted" : "public"}
    </span>
  );
}

function FileActionsMenu({
  open,
  busy,
  isPrivate,
  onToggle,
  onCopy,
  onToggleVisibility,
}: {
  open: boolean;
  busy: boolean;
  isPrivate: boolean;
  onToggle: () => void;
  onCopy: (button: HTMLButtonElement) => void;
  onToggleVisibility: () => void;
}) {
  return (
    <div className="wft-menu">
      <button
        type="button"
        className="wft-menu__trigger"
        aria-expanded={open}
        aria-label="File actions"
        onClick={onToggle}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="wft-menu__popover">
          <button
            type="button"
            role="menuitem"
            className="wft-menu__item"
            onClick={(e) => onCopy(e.currentTarget)}
          >
            copy link
          </button>
          <button
            type="button"
            role="menuitem"
            className="wft-menu__item"
            disabled={busy}
            onClick={onToggleVisibility}
          >
            {isPrivate ? "make public" : "unlist"}
          </button>
        </div>
      )}
    </div>
  );
}

function sizeLabel(size: number | undefined): string {
  return typeof size === "number" ? formatBytes(size) : "—";
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

/** "1 file" / "2 files" — `plural` defaults to `${singular}s`, override for irregulars (e.g. "match" → "matches"). */
function pluralCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
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
  const [githubTitles, setGithubTitles] = useState<GithubTitleMap | null>(null);
  const [view, setView] = useState<FilesView>(() => resolveFilesView(window.location.search));
  const githubTitlesGeneration = useRef(0);

  const setFilesView = (next: FilesView) => {
    setView(next);
    replaceFilesView(next);
    setOpenMenuKey(null);
  };

  const filtersKey = filters.map((f) => `${f.key}=${f.value}`).join("&");
  const filtered = filters.length > 0;

  // Resolve workspace-level facts once (public-domain-configured),
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

  // Folder/search listing starts once workspace-info resolves (an outage or
  // lost-access status renders in place of the table instead — see below).
  useEffect(() => {
    if (info.status !== "ready") return;
    let cancelled = false;
    githubTitlesGeneration.current += 1;
    setGithubTitles(null);
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

  // Resolve connected-work titles once per listing. The generation guard keeps
  // a slower, superseded listing from repainting the current banner or rail.
  useEffect(() => {
    if (state.status !== "ok") return;
    const generation = githubTitlesGeneration.current;
    let cancelled = false;
    const items = connectedWork(state.files);
    const refs = [...new Set(items.map((item) => item.ref))].slice(0, GITHUB_TITLES_MAX_REFS);
    if (!refs.length) {
      return () => {
        cancelled = true;
      };
    }
    void getGithubTitles(apiOrigin, workspace, refs).then((titles) => {
      if (cancelled || generation !== githubTitlesGeneration.current) return;
      setGithubTitles(titles);
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, state]);

  // Share the table's title resolution with the rail so both surfaces paint
  // the same label without the rail issuing a second request.
  useEffect(() => {
    if (state.status !== "ok") return;
    const setter = (window as unknown as { __uploadsSetConnectedWork?: ConnectedWorkSetter })
      .__uploadsSetConnectedWork;
    setter?.(connectedWork(state.files), githubTitles ?? undefined);
  }, [githubTitles, state]);

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
        setActionError(`Couldn't make "${leafName(file.key)}" ${next}. Try again shortly.`);
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
      setActionError(`Couldn't get a link for "${leafName(file.key)}".`);
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

  const bareMatch: GhWorkItem | null = state.status === "ok" ? exactPrMatch(state.files) : null;
  const match = bareMatch && githubTitles ? applyGhTitles([bareMatch], githubTitles)[0] : bareMatch;
  // Folders only in browse mode (search has no prefix tree). Empty while loading/error.
  const folders = state.status === "ok" && !filtered ? state.prefixes : [];
  const files = state.status === "ok" ? state.files : [];
  const count = files.length;
  const folderCount = folders.length;
  const topLabel =
    state.status === "loading"
      ? ""
      : filtered
        ? pluralCount(count, "match", "matches")
        : pluralCount(count, "file");
  const endLabel = (() => {
    if (state.status === "loading") return "Loading…";
    if (state.status === "error")
      return filtered
        ? "Search is temporarily unavailable. Try again."
        : "Files are temporarily unavailable. Try again.";
    if (filtered) {
      if (count === 0) return "No files match these filters.";
      return state.truncated
        ? `${pluralCount(count, "match", "matches")} — showing the first 100. Add a filter to narrow.`
        : pluralCount(count, "match", "matches");
    }
    if (count === 0 && folderCount === 0) return "No files yet.";
    const parts: string[] = [];
    if (folderCount) parts.push(pluralCount(folderCount, "folder"));
    parts.push(pluralCount(count, "file"));
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
          add
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
        <div className="wft-view" role="group" aria-label="File layout">
          {(
            [
              ["list", "List view", ListViewIcon],
              ["grid", "Grid view", GridViewIcon],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              className="wft-view__btn"
              aria-pressed={view === id}
              aria-label={label}
              title={label}
              onClick={() => setFilesView(id)}
            >
              <Icon />
            </button>
          ))}
        </div>
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
          <PullRequestIcon className="wft-banner__icon" title={match.kindLabel} />
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
            open on github ↗
          </a>
        </div>
      )}

      {view === "list" ? (
        <div className="wft-grid">
          <div className="wft-head">
            <span>name</span>
            <span className="wft-head__size">size</span>
            <span className="wft-head__type">type</span>
            <span>visibility</span>
            <span />
          </div>

          {folders.map((folder) => (
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

          {files.map((file) => {
            // Leaf name only — at the flat root the key is `screenshots/…/x.png`,
            // and ellipsis would otherwise hide the distinctive tail.
            const name = leafName(file.key);
            const thumb = pickThumbnail(file);
            const type = fileTypeLabel(file);
            const priv = isPrivateFile(file);

            return (
              <div className="wft-row" key={file.key}>
                <button
                  type="button"
                  className="wft-name wft-name--btn"
                  onClick={() => openFile(apiOrigin, workspace, info.hasPublicUrl, file.key)}
                >
                  {thumb.kind !== "none" && <FileThumb thumb={thumb} />}
                  <span className="wft-filename">{name}</span>
                </button>
                <span className="wft-size">{sizeLabel(file.size)}</span>
                <span className="wft-type">{type}</span>
                <VisibilityBadge private={priv} />
                <FileActionsMenu
                  open={openMenuKey === file.key}
                  busy={togglingKeys.has(file.key)}
                  isPrivate={priv}
                  onToggle={() => setOpenMenuKey((prev) => (prev === file.key ? null : file.key))}
                  onCopy={(btn) => void copyLink(file, btn)}
                  onToggleVisibility={() => void toggleVisibility(file)}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="wft-cards">
          {folders.map((folder) => (
            <button
              key={folder}
              type="button"
              className="wft-card wft-card--folder"
              onClick={() => navigate(folder)}
            >
              <span className="wft-card__media" aria-hidden="true">
                <span className="wft-card__placeholder">
                  <FolderIcon />
                </span>
              </span>
              <span className="wft-card__body">
                <span className="wft-card__name">{childName(folder, prefix)}/</span>
                <span className="wft-card__meta">folder</span>
              </span>
            </button>
          ))}

          {files.map((file) => {
            const name = leafName(file.key);
            const thumb = pickThumbnail(file);
            const type = fileTypeLabel(file);
            const priv = isPrivateFile(file);
            const open = () => openFile(apiOrigin, workspace, info.hasPublicUrl, file.key);

            return (
              <div className="wft-card" key={file.key}>
                <button
                  type="button"
                  className="wft-card__media"
                  onClick={open}
                  aria-label={`Open ${name}`}
                >
                  {thumb.kind === "image" ? (
                    <span
                      className="wft-card__img"
                      style={{ backgroundImage: `url(${thumb.src})` }}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="wft-card__placeholder" aria-hidden="true">
                      {thumb.kind === "video" && <PlayIcon />}
                      {thumb.kind === "lock" && <LockIcon />}
                      {thumb.kind === "none" && <span className="wft-card__ext">{type}</span>}
                    </span>
                  )}
                </button>
                <div className="wft-card__body">
                  <div className="wft-card__title">
                    <button type="button" className="wft-card__name" title={name} onClick={open}>
                      {name}
                    </button>
                    <FileActionsMenu
                      open={openMenuKey === file.key}
                      busy={togglingKeys.has(file.key)}
                      isPrivate={priv}
                      onToggle={() =>
                        setOpenMenuKey((prev) => (prev === file.key ? null : file.key))
                      }
                      onCopy={(btn) => void copyLink(file, btn)}
                      onToggleVisibility={() => void toggleVisibility(file)}
                    />
                  </div>
                  <div className="wft-card__meta">
                    <span>
                      {sizeLabel(file.size)} · {type}
                    </span>
                    <span className="wft-card__spacer" />
                    <VisibilityBadge private={priv} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="wft-end">{endLabel}</div>

      {state.status === "ok" && state.cursor && (
        <button type="button" className="wft-loadmore text-btn" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </div>
  );
}
