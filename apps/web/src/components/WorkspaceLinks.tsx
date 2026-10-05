/**
 * Links tab island: every shareable link in the workspace in one list, live
 * links (change feeds) and galleries, with open, copy, and delete per row
 * (spec "Links tab"). SSR'd with no client directive and hydrated by
 * `links.astro`'s manual mount, the same shape as `WorkspaceFileTable`.
 *
 * PR/issue titles resolve after hydration through the batched
 * `/github/titles` route. Until then `<PrLabel>` shows its `owner/repo #123`
 * fallback, which is also what the server rendered.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@uploads/ui/components/ui/badge";
import { PrLabel } from "@uploads/ui/components/pr-label";
import "@uploads/ui/styles.css";
import { IslandErrorBoundary } from "./IslandErrorBoundary";
import { onSession } from "../lib/account-shell";
import {
  deleteWorkspaceFeed,
  deleteWorkspaceGallery,
  getGithubTitles,
  getMyWorkspaceGalleries,
  listWorkspaceFeeds,
  type GallerySummary,
  type GithubTitleMap,
  type OwnerFeedDto,
} from "../lib/api-client";
import { loadWorkspaceSummary } from "../lib/workspace-summary-source";
import {
  buildLinkRows,
  chunkRefs,
  deleteConfirmText,
  formatLinkDate,
  itemsLabel,
  linkRowKey,
  liveLinkLabel,
  repoScopeLabel,
  sourceLabel,
  titleRefs,
  type GalleryLinkRow,
  type LinkRow,
  type LiveLinkRow,
} from "../lib/workspace-links";

export type LinksState =
  | { status: "loading" }
  | {
      status: "ready";
      feeds: OwnerFeedDto[];
      feedsCursor: string | null;
      galleries: GallerySummary[];
    }
  | { status: "error"; message: string; retry: boolean };

export interface WorkspaceLinksProps {
  apiOrigin: string;
  workspace: string;
  initialState?: LinksState;
}

/** How long an armed "Confirm" stays armed. Same value as the file table's. */
const DELETE_DISARM_MS = 5000;

const ACTION_BTN = "ul-btn ul-btn--ghost px-2 text-xs";

function RowActions({
  row,
  busy,
  onDelete,
}: {
  row: LinkRow;
  busy: boolean;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [confirm, setConfirm] = useState<"closed" | "confirm" | "armed">("closed");
  const canDelete = row.type === "live" || row.version !== null;

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (confirm !== "armed") return;
    const timer = window.setTimeout(() => setConfirm("confirm"), DELETE_DISARM_MS);
    return () => window.clearTimeout(timer);
  }, [confirm]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(row.url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1">
        <a className={ACTION_BTN} href={row.url} target="_blank" rel="noopener noreferrer">
          Open
        </a>
        <button type="button" className={ACTION_BTN} onClick={() => void copy()}>
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
        </button>
        {canDelete && confirm === "closed" && (
          <button
            type="button"
            className={`${ACTION_BTN} text-destructive`}
            onClick={() => setConfirm("confirm")}
          >
            Delete…
          </button>
        )}
      </div>
      {confirm !== "closed" && (
        <div
          role="alertdialog"
          aria-label={row.type === "live" ? "Revoke live link" : `Delete ${row.title}`}
          className="w-[260px] rounded-md border border-border bg-popover p-2.5 text-xs shadow-lg"
        >
          <p className="m-0 mb-2">{deleteConfirmText(row)}</p>
          <div className="flex justify-end gap-1.5">
            <button type="button" className={ACTION_BTN} onClick={() => setConfirm("closed")}>
              Cancel
            </button>
            {confirm === "confirm" ? (
              <button
                type="button"
                className={`${ACTION_BTN} text-destructive`}
                disabled={busy}
                onClick={() => setConfirm("armed")}
              >
                {row.type === "live" ? "Revoke link" : "Delete gallery"}
              </button>
            ) : (
              <button
                type="button"
                className="ul-btn ul-btn--solid bg-destructive px-2 text-xs text-white"
                disabled={busy}
                onClick={() => {
                  // Back to a fresh two-step confirm first: a failed delete
                  // keeps the row, and the next click must re-confirm.
                  setConfirm("confirm");
                  onDelete();
                }}
              >
                Confirm
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LiveLinkBody({ row, titles }: { row: LiveLinkRow; titles: GithubTitleMap }) {
  const label = liveLinkLabel(row, titles);
  const source = sourceLabel(row);
  // A live feed row's updated_at only changes when it is revoked, so for a
  // listed link it is the creation date.
  const meta = [label ? row.repo : "", source, `Created ${formatLinkDate(row.updatedAt)}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label ? (
        <PrLabel {...label} size="sm" />
      ) : (
        <span className="font-mono text-sm">{repoScopeLabel(row)}</span>
      )}
      <p className="m-0 text-xs text-muted-foreground">{meta}</p>
    </div>
  );
}

function GalleryBody({ row }: { row: GalleryLinkRow }) {
  const [coverFailed, setCoverFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The SSR'd <img> can fail before hydration attaches onError, so check the
  // already-failed case once on mount (the gotcha media-load.ts documents).
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setCoverFailed(true);
  }, []);
  const shown = row.references.slice(0, 3);
  const extra = row.references.length - shown.length;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <a
        href={row.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${row.title}`}
        className="size-10 flex-none overflow-hidden rounded-md border border-border bg-muted"
      >
        {row.previewUrl && !coverFailed ? (
          <img
            ref={imgRef}
            src={row.previewUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
            onError={() => setCoverFailed(true)}
          />
        ) : null}
      </a>
      <div className="min-w-0">
        <a
          href={row.url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground hover:underline"
        >
          {row.title}
        </a>
        {row.description ? (
          <p className="m-0 truncate text-xs text-muted-foreground">{row.description}</p>
        ) : null}
        <p className="m-0 text-xs text-muted-foreground">
          {itemsLabel(row.itemCount)} · Updated {formatLinkDate(row.updatedAt)}
        </p>
        {shown.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {shown.map((ref) =>
              ref.canonicalUrl ? (
                <a
                  key={ref.coordinate}
                  className="ws-gallery-link"
                  href={ref.canonicalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {ref.coordinate}
                </a>
              ) : (
                <span key={ref.coordinate} className="ws-gallery-link ws-gallery-link--plain">
                  {ref.coordinate}
                </span>
              ),
            )}
            {extra > 0 ? <span className="text-xs text-muted-foreground">+{extra}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinkRowItem({
  row,
  titles,
  onDelete,
}: {
  row: LinkRow;
  titles: GithubTitleMap;
  onDelete: (row: LinkRow) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-3" data-link-type={row.type}>
      <Badge variant={row.type === "live" ? "secondary" : "outline"}>
        {row.type === "live" ? "Live link" : "Gallery"}
      </Badge>
      <div className="min-w-0">
        {row.type === "live" ? (
          <LiveLinkBody row={row} titles={titles} />
        ) : (
          <GalleryBody row={row} />
        )}
        {error ? (
          <p className="m-0 mt-1 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <RowActions
        row={row}
        busy={busy}
        onDelete={() => {
          setBusy(true);
          setError(null);
          void onDelete(row).then((message) => {
            setBusy(false);
            if (message) setError(message);
          });
        }}
      />
    </li>
  );
}

function LinksEmpty() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-6 text-center text-sm">
      <p className="m-0 font-medium">No links yet</p>
      <p className="m-0 max-w-md text-muted-foreground">
        A PR comment from the GitHub App adds a live link for that pull request. You can also run{" "}
        <code>uploads feed create --github owner/repo#123</code> or{" "}
        <code>uploads gallery create --title "Release screenshots"</code>.
      </p>
    </div>
  );
}

function WorkspaceLinksInner({ apiOrigin, workspace, initialState }: WorkspaceLinksProps) {
  const [state, setState] = useState<LinksState>(() => initialState ?? { status: "loading" });
  const [titles, setTitles] = useState<GithubTitleMap>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  // Refs already sent to the titles route, so "Load more" only asks for new ones.
  const requestedRefs = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function load(): Promise<void> {
    setState({ status: "loading" });
    const summary = await loadWorkspaceSummary(apiOrigin, workspace);
    if (!alive.current) return;
    if (summary.kind !== "success") {
      setState(
        summary.reason === "not_found"
          ? { status: "error", message: "You don’t have access to this workspace.", retry: false }
          : { status: "error", message: "Links are temporarily unavailable.", retry: true },
      );
      return;
    }
    const [feeds, galleries] = await Promise.all([
      listWorkspaceFeeds(apiOrigin, workspace),
      getMyWorkspaceGalleries(apiOrigin, workspace),
    ]);
    if (!alive.current) return;
    if (feeds.kind !== "ok") {
      setState({ status: "error", message: "Live links couldn’t load.", retry: true });
      return;
    }
    setState({
      status: "ready",
      feeds: feeds.data.feeds,
      feedsCursor: feeds.data.nextCursor,
      galleries,
    });
  }

  useEffect(() => {
    document.title = `Links · ${workspace} · uploads.sh`;
    if (state.status !== "loading") return;
    onSession(() => {
      void load();
    });
    // Mount-only: the seed decides whether a client load is needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(
    () => (state.status === "ready" ? buildLinkRows(state.feeds, state.galleries) : []),
    [state],
  );
  const refs = useMemo(() => titleRefs(rows), [rows]);
  const refsKey = refs.join(",");

  useEffect(() => {
    const fresh = refs.filter((ref) => !requestedRefs.current.has(ref));
    if (!fresh.length) return;
    for (const ref of fresh) requestedRefs.current.add(ref);
    // No per-run cancel: a later run asks only for newer refs, so dropping
    // this run's answer would leave its rows on the fallback label for good.
    void Promise.all(
      chunkRefs(fresh).map((batch) => getGithubTitles(apiOrigin, workspace, batch)),
    ).then((maps) => {
      if (!alive.current) return;
      setTitles((prev) => {
        const next: GithubTitleMap = { ...prev };
        for (const map of maps) if (map) Object.assign(next, map);
        return next;
      });
    });
    // refsKey stands in for refs: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOrigin, workspace, refsKey]);

  async function loadMoreFeeds(): Promise<void> {
    if (state.status !== "ready" || !state.feedsCursor) return;
    setLoadingMore(true);
    setNotice(null);
    const page = await listWorkspaceFeeds(apiOrigin, workspace, state.feedsCursor);
    if (!alive.current) return;
    setLoadingMore(false);
    if (page.kind !== "ok") {
      setNotice("More live links couldn’t load. Try again.");
      return;
    }
    setState((prev) =>
      prev.status === "ready"
        ? {
            ...prev,
            feeds: [...prev.feeds, ...page.data.feeds],
            feedsCursor: page.data.nextCursor,
          }
        : prev,
    );
  }

  async function deleteRow(row: LinkRow): Promise<string | null> {
    if (row.type === "live") {
      const result = await deleteWorkspaceFeed(apiOrigin, workspace, row.id);
      if (result.kind !== "ok") return "Couldn’t revoke this link. Try again.";
    } else {
      if (row.version === null) return "Reload the page to delete this gallery.";
      const result = await deleteWorkspaceGallery(apiOrigin, workspace, row.id, row.version);
      if (result.kind === "conflict") {
        return "This gallery changed since the page loaded. Reload and try again.";
      }
      if (result.kind !== "success") return "Couldn’t delete this gallery. Try again.";
    }
    if (!alive.current) return null;
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      return row.type === "live"
        ? { ...prev, feeds: prev.feeds.filter((f) => f.id !== row.id) }
        : { ...prev, galleries: prev.galleries.filter((g) => g.id !== row.id) };
    });
    return null;
  }

  return (
    <section className="card settings-page">
      <div className="settings-section">
        <div className="ws-page-header">
          <div className="ws-title-block">
            <h2>Links</h2>
            <p className="settings-note muted">
              Live links follow a pull request or repo as files arrive. Galleries are hand-picked
              sets.
            </p>
          </div>
        </div>

        {state.status === "loading" ? (
          <div aria-busy="true" aria-label="Loading links" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : state.status === "error" ? (
          <div className="ul-callout" data-state="error" role="alert">
            <p className="m-0">{state.message}</p>
            {state.retry ? (
              <button type="button" className="ul-btn mt-2" onClick={() => void load()}>
                Try again
              </button>
            ) : null}
          </div>
        ) : rows.length === 0 ? (
          <LinksEmpty />
        ) : (
          <ul className="m-0 list-none divide-y divide-border p-0" aria-label="Links">
            {rows.map((row) => (
              <LinkRowItem key={linkRowKey(row)} row={row} titles={titles} onDelete={deleteRow} />
            ))}
          </ul>
        )}

        {notice ? (
          <p className="muted settings-note" role="status">
            {notice}
          </p>
        ) : null}
        {state.status === "ready" && state.feedsCursor ? (
          <button
            type="button"
            className="ul-btn mt-3"
            disabled={loadingMore}
            onClick={() => void loadMoreFeeds()}
          >
            {loadingMore ? "Loading…" : "Load more live links"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function WorkspaceLinks(props: WorkspaceLinksProps) {
  return (
    <IslandErrorBoundary>
      <WorkspaceLinksInner {...props} />
    </IslandErrorBoundary>
  );
}
