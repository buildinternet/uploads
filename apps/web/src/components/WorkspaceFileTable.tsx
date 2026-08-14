/**
 * The 3A workspace files tab — filter bar, chips ↔ breadcrumbs, a conditional
 * exact-PR-match banner, and the file listing (list or grid view: thumbnail,
 * size, type, visibility, `⋯` actions). The single island mounted by
 * `pages/account/workspaces/[name].astro`.
 *
 * Data source: `listWorkspaceFolder` when nothing is being filtered (folder
 * browse, URL-synced via `workspace-browse-url`), `searchWorkspaceFiles` when
 * a name term or one or more metadata filters are active (URL-synced via
 * `workspace-search-url`).
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
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ConnectedWorkSetter } from "../lib/workspace-rail";
import { applyGhTitles, connectedWork, exactPrMatch, type GhWorkItem } from "../lib/gh-context";
import {
  deleteWorkspaceFile,
  GITHUB_TITLES_MAX_REFS,
  getGithubTitles,
  getMyWorkspaces,
  getWorkspaceFacetValues,
  getWorkspaceFacets,
  listWorkspaceFolder,
  searchWorkspaceFiles,
  setFileVisibility,
  type FacetKey,
  type FacetValue,
  type FileVisibility,
  type GithubTitleMap,
} from "../lib/api-client";
import { formatBytes } from "../lib/public-file";
import {
  makeFileOpener,
  newTabLinkProps,
  type FileOpener,
  type OpenableFile,
} from "../lib/file-opener";
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
  readSearchName,
  replaceSearchLocation,
  type MetaFilter,
} from "../lib/workspace-search-url";
import {
  buildSuggestions,
  clampActiveIndex,
  firstSelectableIndex,
  isSelectableSuggestion,
  parseDraft,
  stepActiveIndex,
  type Suggestion,
} from "../lib/workspace-search-suggest";
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
  /** Public `/f/` file-page URL when present (issue #308). */
  pageUrl?: string;
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

/** How long an armed "Confirm delete" stays armed before auto-disarming. */
const DELETE_DISARM_MS = 5000;

function FileActionsMenu({
  open,
  busy,
  isPrivate,
  filename,
  onToggle,
  onCopy,
  onToggleVisibility,
  onDelete,
}: {
  open: boolean;
  busy: boolean;
  isPrivate: boolean;
  filename: string;
  onToggle: () => void;
  onCopy: (button: HTMLButtonElement) => void;
  onToggleVisibility: () => void;
  onDelete: () => void;
}) {
  // Two-step destructive confirm (spec 2026-07-30): "delete…" swaps the menu
  // for a warning panel; its button arms a red confirm that auto-disarms.
  // The /f/ file page carries a vanilla twin of this state machine (public
  // pages ship no framework JS) — keep DELETE_DISARM_MS and the arm/disarm
  // semantics in sync with apps/web/src/pages/f/[workspace]/[...key].astro.
  const [confirm, setConfirm] = useState<"closed" | "confirm" | "armed">("closed");
  const disarmTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) setConfirm("closed");
  }, [open]);
  useEffect(() => {
    if (confirm !== "armed") return;
    disarmTimer.current = window.setTimeout(() => setConfirm("confirm"), DELETE_DISARM_MS);
    return () => {
      if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    };
  }, [confirm]);

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
      {open && confirm === "closed" && (
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
          <button
            type="button"
            role="menuitem"
            className="wft-menu__item wft-menu__item--danger"
            onClick={() => setConfirm("confirm")}
          >
            delete…
          </button>
        </div>
      )}
      {open && confirm !== "closed" && (
        <div
          className="wft-menu__popover wft-confirm"
          role="alertdialog"
          aria-label={`Delete ${filename}`}
        >
          <p className="wft-confirm__text">
            Permanently delete <strong>{filename}</strong> for everyone? Links and embeds will
            break.
          </p>
          {confirm === "confirm" ? (
            <button
              type="button"
              className="wft-menu__item wft-menu__item--danger"
              disabled={busy}
              onClick={() => setConfirm("armed")}
            >
              Delete file
            </button>
          ) : (
            <button
              type="button"
              className="wft-menu__item wft-confirm__armed"
              disabled={busy}
              onClick={() => {
                // Reset to a fresh two-step confirm immediately: if the
                // delete fails, the menu stays open (see the parent's
                // `deleteFile`) but the very next click must re-confirm
                // rather than delete instantly.
                setConfirm("confirm");
                onDelete();
              }}
            >
              Confirm delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A control that opens one file. Renders a real anchor whenever the
 * destination is known at render time, and falls back to a button for the
 * private/BYO signed-URL path — see `lib/file-opener`.
 */
function FileOpenTrigger({
  opener,
  file,
  className,
  title,
  children,
  ...rest
}: {
  opener: FileOpener;
  file: OpenableFile;
  className: string;
  title?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const href = opener.href(file);
  const shared = { className, title, ...rest };
  return href ? (
    <a {...shared} {...newTabLinkProps} href={href}>
      {children}
    </a>
  ) : (
    <button {...shared} type="button" onClick={() => opener.activate(file)}>
      {children}
    </button>
  );
}

function sizeLabel(size: number | undefined): string {
  return typeof size === "number" ? formatBytes(size) : "—";
}

// ── URL-resolution helpers (open-file / copy-link) ────────────────────────
// Open-file resolution lives in `lib/file-opener` (shared with
// ScreenshotsByPath); copy-link keeps its own signed-URL call because it needs
// the raw URL for the clipboard rather than a navigation.

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

/** "1 file" / "2 files" — `plural` defaults to `${singular}s`, override for irregulars (e.g. "match" → "matches"). */
function pluralCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ── Loading skeleton ───────────────────────────────────────────────────
// Same idea as `workspace-ui.ts`'s HTML-string placeholders (three-tier
// loading, PR #526): occupy the exact box the real content will occupy so
// landing data doesn't shift the page. Kept as JSX here (not the HTML-string
// builders) because this component's loading states render mid-tree, not as
// a `set:html` swap — but `renderFilesPlaceholderHtml` in workspace-ui.ts
// mirrors this markup 1:1 for the pre-mount gap in `[name].astro`, so the
// two hand-offs (static HTML → this component's own loading render → real
// data) are visually seamless throughout.

/** One masked bar — `--ws-skel-w` drives width, same custom property `.ws-skel` reads. */
function SkelBar({ width }: { width: string }) {
  return (
    <span
      className="ws-skel"
      aria-hidden="true"
      style={{ "--ws-skel-w": width } as CSSProperties}
    />
  );
}

const SKEL_ROW_WIDTHS = ["62%", "48%", "70%", "40%", "55%", "35%"];

/** `wft-row`-shaped skeleton rows — same grid columns as a real row. */
function FileRowsSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div className="wft-row" key={i}>
          <span className="wft-name">
            <SkelBar width={SKEL_ROW_WIDTHS[i % SKEL_ROW_WIDTHS.length]} />
          </span>
          <span className="wft-size">
            <SkelBar width="32px" />
          </span>
          <span className="wft-type">
            <SkelBar width="28px" />
          </span>
          <span className="wft-vis">
            <SkelBar width="52px" />
          </span>
          <span />
        </div>
      ))}
    </>
  );
}

/**
 * Full toolbar-and-table skeleton for the initial `info.status === "loading"`
 * render, when nothing about the workspace (so nothing about the real
 * filterbar or section head) is known yet. `wft-field-skel` (account-content
 * .css) gives the filter input/button their real height, since
 * `.input-group__field`/`__action` normally size themselves from the
 * `<input>`/`<button>` they wrap. The table head's labels are real text, not
 * skeleton bars — "name/size/type/visibility" never depend on data.
 */
function FilesLoadingSkeleton() {
  return (
    <div className="wft" aria-busy="true">
      <div className="wft-filter">
        <div className="wft-filterbar input-group">
          <span className="input-group__field wft-field-skel">
            <SkelBar width="60%" />
          </span>
          <span className="input-group__action wft-field-skel">
            <SkelBar width="28px" />
          </span>
        </div>
      </div>
      <div className="wft-sectionhead">
        <span className="wft-sectionhead__rule wft-sectionhead__rule--lead" />
        <span className="wft-sectionhead__label">files</span>
        <span className="wft-sectionhead__rule" />
        <span className="wft-sectionhead__count">
          <SkelBar width="44px" />
        </span>
      </div>
      <div className="wft-grid">
        <div className="wft-head">
          <span>name</span>
          <span className="wft-head__size">size</span>
          <span className="wft-head__type">type</span>
          <span>visibility</span>
          <span />
        </div>
        <FileRowsSkeleton rows={6} />
      </div>
    </div>
  );
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
  const [nameTerm, setNameTerm] = useState<string>(
    () => readSearchName(window.location.search) ?? "",
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [facets, setFacets] = useState<FacetKey[] | null>(null);
  const [facetsTruncated, setFacetsTruncated] = useState(false);
  const [facetValues, setFacetValues] = useState<Record<string, FacetValue[]>>({});
  const [facetValuesTruncated, setFacetValuesTruncated] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<ListingState>({ status: "loading" });
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [togglingKeys, setTogglingKeys] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [githubTitles, setGithubTitles] = useState<GithubTitleMap | null>(null);
  const [view, setView] = useState<FilesView>(() => resolveFilesView(window.location.search));
  const githubTitlesGeneration = useRef(0);
  // In-flight guards (refs, not state — must not trigger re-renders) so a
  // second call issued while the first is still pending (every keystroke on
  // a `key=` draft, or a rapid blur/refocus) doesn't re-request the same key.
  const facetsInFlightRef = useRef(false);
  const facetValuesInFlightRef = useRef<Set<string>>(new Set());
  // Tracks the pending `onBlur` close so a quick refocus can cancel it —
  // otherwise the earlier timeout still fires and closes the reopened menu.
  const blurTimeoutRef = useRef<number | null>(null);

  const setFilesView = (next: FilesView) => {
    setView(next);
    replaceFilesView(next);
    setOpenMenuKey(null);
  };

  const filtersKey = filters.map((f) => `${f.key}=${f.value}`).join("&");
  const filtered = filters.length > 0 || nameTerm.length > 0;

  // Fetched lazily on first focus rather than on mount: most visits to this tab
  // browse folders and never open the menu, and the query is pure overhead for
  // them. Cached for the session — `facets` is only ever set once.
  const loadFacets = async () => {
    if (facets !== null || facetsInFlightRef.current) return;
    facetsInFlightRef.current = true;
    try {
      const result = await getWorkspaceFacets(apiOrigin, workspace);
      setFacets(result.kind === "ok" ? result.keys : null);
      setFacetsTruncated(result.kind === "ok" && result.truncated);
    } finally {
      facetsInFlightRef.current = false;
    }
  };

  const loadFacetValues = async (key: string) => {
    if (facetValues[key] || facetValuesInFlightRef.current.has(key)) return;
    facetValuesInFlightRef.current.add(key);
    try {
      const result = await getWorkspaceFacetValues(apiOrigin, workspace, key);
      if (result.kind === "ok") {
        setFacetValues((prev) => ({ ...prev, [key]: result.values }));
        setFacetValuesTruncated((prev) => ({ ...prev, [key]: result.truncated }));
      }
    } finally {
      facetValuesInFlightRef.current.delete(key);
    }
  };

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
        const result = await searchWorkspaceFiles(apiOrigin, workspace, filters, {
          name: nameTerm || undefined,
        });
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
    // filtersKey stands in for `filters` (serialized): the array identity
    // changes on every render, so depending on it directly would refetch in a
    // loop. The serialized key changes only when a filter actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOrigin, workspace, info, filtered, filtersKey, nameTerm, prefix]);

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

  // The blur-close timeout must not outlive the component.
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current !== null) window.clearTimeout(blurTimeoutRef.current);
    };
  }, []);

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
    replaceSearchLocation(workspace, next, nameTerm || undefined);
  };

  const commitNameTerm = (next: string) => {
    setNameTerm(next);
    replaceSearchLocation(workspace, filters, next || undefined);
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

  const deleteFile = async (file: FileTableRow) => {
    setTogglingKeys((prev) => new Set(prev).add(file.key));
    setActionError(null);
    try {
      const result = await deleteWorkspaceFile(apiOrigin, workspace, file.key);
      if (result.kind === "success") {
        setState((prev) =>
          prev.status === "ok"
            ? { ...prev, files: prev.files.filter((f) => f.key !== file.key) }
            : prev,
        );
        setOpenMenuKey(null);
      } else {
        setActionError(`Couldn't delete "${leafName(file.key)}". Try again shortly.`);
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
    // Prefer pageUrl (file page), then storage URL, then signed link.
    const url =
      file.pageUrl ?? file.url ?? (await resolveSignedFileUrl(apiOrigin, workspace, file.key));
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
    return <FilesLoadingSkeleton />;
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

  const opener = makeFileOpener(apiOrigin, workspace, info.hasPublicUrl);
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

  const parsedDraft = parseDraft(draft);
  // Only treat the parsed key as "selected" once it's a valid (lowercase) key —
  // otherwise `buildSuggestions` would sit in its `loading` branch forever,
  // since a request for an invalid key is never fired (see the `onChange`
  // handler below).
  const selectedKey = parsedDraft && isValidMetaKey(parsedDraft.key) ? parsedDraft.key : null;

  const currentSuggestions = (): Suggestion[] =>
    buildSuggestions({
      draft,
      facets,
      values: selectedKey ? (facetValues[selectedKey] ?? null) : null,
      selectedKey,
      activeKeys: filters.map((f) => f.key),
      keysTruncated: facetsTruncated,
      valuesTruncated: selectedKey ? (facetValuesTruncated[selectedKey] ?? false) : false,
    });

  // The stored `activeIndex` can point at a non-selectable row (hint/loading/
  // empty-facets) or past the end of a list that shrank while the menu was
  // closed. Every render re-derives the row that's actually safe to highlight
  // and reference from `aria-activedescendant`, rather than trusting the raw
  // state — see review findings on aria-activedescendant and stale activeIndex.
  const effectiveActiveIndex = clampActiveIndex(currentSuggestions(), activeIndex);

  /** Commit a highlighted row: a name row searches, a key row drills in, a value row filters. */
  const applySuggestion = (suggestion: Suggestion) => {
    if (suggestion.kind === "name") {
      commitNameTerm(suggestion.term);
      setDraft("");
      setMenuOpen(false);
      return;
    }
    if (suggestion.kind === "key") {
      // Drill in rather than commit: `key=` alone is not a filter, and this is
      // the step that loads the key's values for the next menu.
      setDraft(`${suggestion.key}=`);
      setActiveIndex(0);
      void loadFacetValues(suggestion.key);
      return;
    }
    if (suggestion.kind === "value") {
      setFilterError(null);
      setDraft("");
      setMenuOpen(false);
      commitFilters([...filters, { key: suggestion.key, value: suggestion.value }]);
    }
  };

  // A plain function, not a nested component: declaring a component inside
  // another creates a new component type on every render, which would remount
  // the menu (and drop its DOM state) on every keystroke.
  const renderSuggestionMenu = () => {
    const suggestions = currentSuggestions();
    if (suggestions.length === 0) return null;
    // A listbox may only own options (or groups) — the static hint/loading/
    // empty-facets/truncated rows carry no `role="option"` and don't belong
    // inside `role="listbox"`, or they're exposed to assistive tech as bare,
    // unexplained list items (see review finding). So the `<ul>` here holds
    // only real options; the static rows render as siblings in the
    // surrounding `.wft-suggest` container. `buildSuggestions` always groups
    // its output as `[...options, ...staticRows]`, so splitting by
    // `isSelectableSuggestion` and rendering options first, then static rows,
    // reproduces the exact original order — static rows read as footers below
    // the options, or stand alone when there are no options at all.
    const staticRow = (id: string, content: ReactNode) => (
      <div className="wft-suggest__hint" key={id} id={id} aria-disabled="true">
        {content}
      </div>
    );
    return (
      <div className="wft-suggest">
        <ul
          id="wft-suggest"
          role="listbox"
          aria-label="Filter suggestions"
          className="wft-suggest__list"
        >
          {suggestions.map((suggestion, index) => {
            if (!isSelectableSuggestion(suggestion)) return null;
            const id = `wft-suggest-${index}`;
            const unique =
              suggestion.kind === "key" && suggestion.count === suggestion.distinctValues;
            return (
              <li
                key={id}
                id={id}
                role="option"
                aria-selected={index === effectiveActiveIndex}
                className={`wft-suggest__row${index === effectiveActiveIndex ? " is-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus so onBlur doesn't close first
                  applySuggestion(suggestion);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                {suggestion.kind === "name" ? (
                  <>
                    <span className="wft-suggest__label">name contains “{suggestion.term}”</span>
                  </>
                ) : suggestion.kind === "key" ? (
                  <>
                    <span className="wft-suggest__label">{suggestion.key}</span>
                    <span className="wft-suggest__meta">
                      {pluralCount(suggestion.count, "file")} ·{" "}
                      {unique ? "unique per file" : pluralCount(suggestion.distinctValues, "value")}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="wft-suggest__label">{suggestion.value}</span>
                    <span className="wft-suggest__meta">
                      {pluralCount(suggestion.count, "file")}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {suggestions.map((suggestion, index) => {
          const id = `wft-suggest-${index}`;
          if (suggestion.kind === "hint") {
            return staticRow(
              id,
              <>
                or type <code>key=value</code> to filter directly
              </>,
            );
          }
          if (suggestion.kind === "loading") {
            return staticRow(id, "Loading values…");
          }
          if (suggestion.kind === "empty-facets") {
            return staticRow(
              id,
              <>
                No metadata yet — filters appear once files are uploaded with tags.{" "}
                <a href="/docs/attach-pull-request-images">How to tag uploads</a>
              </>,
            );
          }
          if (suggestion.kind === "truncated") {
            return staticRow(id, "Showing the first 50 — type to narrow.");
          }
          return null;
        })}
      </div>
    );
  };

  return (
    <div className="wft">
      <div className="wft-filter">
        <form
          className="wft-filterbar input-group"
          onSubmit={(e) => {
            e.preventDefault();
            // `effectiveActiveIndex` is already guaranteed to be either -1 or a
            // selectable (name/key/value) row, so no `kind` check is needed here.
            const active =
              effectiveActiveIndex >= 0 ? currentSuggestions()[effectiveActiveIndex] : undefined;
            if (active) {
              applySuggestion(active);
              return;
            }
            addFilter();
          }}
        >
          <span className="input-group__field">
            <input
              role="combobox"
              aria-expanded={menuOpen}
              aria-controls="wft-suggest"
              aria-autocomplete="list"
              aria-activedescendant={
                menuOpen && effectiveActiveIndex >= 0
                  ? `wft-suggest-${effectiveActiveIndex}`
                  : undefined
              }
              aria-label="Filter files"
              placeholder="Filter by name, or key=value…"
              value={draft}
              onFocus={() => {
                // Cancel a still-armed blur-close from a quick refocus — otherwise
                // it fires ~120ms later and closes the menu we just reopened.
                if (blurTimeoutRef.current !== null) {
                  window.clearTimeout(blurTimeoutRef.current);
                  blurTimeoutRef.current = null;
                }
                setMenuOpen(true);
                setActiveIndex(firstSelectableIndex(currentSuggestions()));
                void loadFacets();
              }}
              onBlur={() => {
                blurTimeoutRef.current = window.setTimeout(() => {
                  blurTimeoutRef.current = null;
                  setMenuOpen(false);
                }, 120);
              }}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setDraft(value);
                setMenuOpen(true);
                const parsed = parseDraft(value);
                if (parsed && !isValidMetaKey(parsed.key)) {
                  // Case/format mismatch (e.g. `GH.repo=`): the API requires a
                  // lowercase key, so fetching would only 400 and the menu would be
                  // stuck showing "Loading values…" forever. Surface the same
                  // guidance `addFilter` gives for a bad key instead.
                  setFilterError(
                    "Key must be lowercase letters/digits/._- and start with a letter.",
                  );
                } else {
                  setFilterError(null);
                  if (parsed) void loadFacetValues(parsed.key);
                }
                const nextSelectedKey = parsed && isValidMetaKey(parsed.key) ? parsed.key : null;
                const nextSuggestions = buildSuggestions({
                  draft: value,
                  facets,
                  values: nextSelectedKey ? (facetValues[nextSelectedKey] ?? null) : null,
                  selectedKey: nextSelectedKey,
                  activeKeys: filters.map((f) => f.key),
                  keysTruncated: facetsTruncated,
                  valuesTruncated: nextSelectedKey
                    ? (facetValuesTruncated[nextSelectedKey] ?? false)
                    : false,
                });
                setActiveIndex(firstSelectableIndex(nextSuggestions));
              }}
              onKeyDown={(e) => {
                const suggestions = currentSuggestions();
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((i) =>
                    stepActiveIndex(suggestions, clampActiveIndex(suggestions, i), 1),
                  );
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((i) =>
                    stepActiveIndex(suggestions, clampActiveIndex(suggestions, i), -1),
                  );
                } else if (e.key === "Escape") {
                  setMenuOpen(false);
                }
              }}
            />
          </span>
          <button type="submit" className="input-group__action">
            add
          </button>
        </form>
        {menuOpen && renderSuggestionMenu()}
      </div>
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
          {nameTerm && (
            <span className="wft-chip">
              <span className="wft-chip__key">name</span>
              <span className="wft-chip__eq">~</span>
              <span className="wft-chip__value">{nameTerm}</span>
              <button
                type="button"
                className="wft-chip__remove"
                aria-label="Remove name filter"
                onClick={() => commitNameTerm("")}
              >
                ×
              </button>
            </span>
          )}
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
            <button
              type="button"
              onClick={() => {
                setNameTerm("");
                setFilters([]);
                replaceSearchLocation(workspace, [], undefined);
              }}
            >
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
        <div className="wft-grid" aria-busy={state.status === "loading" || undefined}>
          <div className="wft-head">
            <span>name</span>
            <span className="wft-head__size">size</span>
            <span className="wft-head__type">type</span>
            <span>visibility</span>
            <span />
          </div>

          {/* `folders`/`files` are already `[]` while `state.status ===
              "loading"` (see above), so this doesn't double up with the
              real rows below — it's the only content in the grid until the
              fetch resolves. */}
          {state.status === "loading" && <FileRowsSkeleton rows={6} />}

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
                <FileOpenTrigger opener={opener} file={file} className="wft-name wft-name--btn">
                  {thumb.kind !== "none" && <FileThumb thumb={thumb} />}
                  <span className="wft-filename">{name}</span>
                </FileOpenTrigger>
                <span className="wft-size">{sizeLabel(file.size)}</span>
                <span className="wft-type">{type}</span>
                <VisibilityBadge private={priv} />
                <FileActionsMenu
                  open={openMenuKey === file.key}
                  busy={togglingKeys.has(file.key)}
                  isPrivate={priv}
                  filename={name}
                  onToggle={() => setOpenMenuKey((prev) => (prev === file.key ? null : file.key))}
                  onCopy={(btn) => void copyLink(file, btn)}
                  onToggleVisibility={() => void toggleVisibility(file)}
                  onDelete={() => void deleteFile(file)}
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
            return (
              <div className="wft-card" key={file.key}>
                <FileOpenTrigger
                  opener={opener}
                  file={file}
                  className="wft-card__media"
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
                </FileOpenTrigger>
                <div className="wft-card__body">
                  <div className="wft-card__title">
                    <FileOpenTrigger
                      opener={opener}
                      file={file}
                      className="wft-card__name"
                      title={name}
                    >
                      {name}
                    </FileOpenTrigger>
                    <FileActionsMenu
                      open={openMenuKey === file.key}
                      busy={togglingKeys.has(file.key)}
                      isPrivate={priv}
                      filename={name}
                      onToggle={() =>
                        setOpenMenuKey((prev) => (prev === file.key ? null : file.key))
                      }
                      onCopy={(btn) => void copyLink(file, btn)}
                      onToggleVisibility={() => void toggleVisibility(file)}
                      onDelete={() => void deleteFile(file)}
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
