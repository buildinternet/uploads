/**
 * Links tab island: every shareable link in the workspace in one list, live
 * links (change feeds) and galleries, with open, copy, and delete in a
 * per-row overflow menu (spec "Links tab"). Live links are the common case,
 * so only galleries carry a badge, and a filter appears once both kinds
 * are present. SSR'd with no client directive and hydrated by
 * `links.astro`'s manual mount, the same shape as `WorkspaceFileTable`.
 *
 * PR/issue titles resolve after hydration through the batched
 * `/github/titles` route. Until then `<PrLabel>` shows its `owner/repo #123`
 * fallback, which is also what the server rendered.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@uploads/ui/components/ui/alert-dialog";
import { Badge } from "@uploads/ui/components/ui/badge";
import { Button } from "@uploads/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@uploads/ui/components/ui/dropdown-menu";
import { PrLabel } from "@uploads/ui/components/pr-label";
import { EllipsisIcon, ImagesIcon } from "lucide-react";
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
  linkRowName,
  liveLinkLabel,
  repoScopeLabel,
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

type LinkFilter = "all" | "live" | "gallery";

const FILTERS: Array<{ value: LinkFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "live", label: "Live links" },
  { value: "gallery", label: "Galleries" },
];

/**
 * Overflow menu per row: Open, Copy link, Delete…. Delete confirms in an
 * AlertDialog whose copy comes from `deleteConfirmText`. "Copied" shows
 * beside the trigger for a moment, with a polite live region for screen
 * readers.
 */
function RowActions({
  row,
  busy,
  onDelete,
}: {
  row: LinkRow;
  busy: boolean;
  /** Resolves true when the row was deleted, false when the delete failed. */
  onDelete: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [confirming, setConfirming] = useState(false);
  const canDelete = row.type === "live" || row.version !== null;
  const name = linkRowName(row);
  const copyLabel = copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "";
  const kindLabel = row.type === "live" ? "live link" : "gallery";

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(row.url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
        {copyLabel}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${kindLabel} ${name}`}>
              <EllipsisIcon aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem render={<a href={row.url} target="_blank" rel="noopener noreferrer" />}>
            Open
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copy()}>Copy link</DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                {row.type === "live" ? "Revoke…" : "Delete…"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {row.type === "live" ? `Revoke live link for ${name}?` : `Delete ${row.title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>{deleteConfirmText(row)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="outline" size="default">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void onDelete();
              }}
            >
              {row.type === "live" ? "Revoke link" : "Delete gallery"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LiveLinkBody({ row, titles }: { row: LiveLinkRow; titles: GithubTitleMap }) {
  const label = liveLinkLabel(row, titles);
  // A live feed row's updated_at only changes when it is revoked, so for a
  // listed link it is the creation date.
  // The repo only when the title is known: the no-title fallback already
  // reads "owner/repo #n".
  const meta = [label?.title ? row.repo : "", formatLinkDate(row.updatedAt)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label ? (
        <PrLabel {...label} size="md" />
      ) : (
        <span className="font-mono text-sm">{repoScopeLabel(row)}</span>
      )}
      <p className="m-0 text-xs text-muted-foreground">{meta}</p>
    </div>
  );
}

function GalleryBody({ row }: { row: GalleryLinkRow }) {
  const shown = row.references.slice(0, 3);
  const extra = row.references.length - shown.length;
  // Same shape as a live-link row: icon + title line, then the meta line.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <a
          href={row.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 text-(length:--text-meta) text-fg no-underline! hover:text-primary focus-visible:text-primary focus-visible:outline-none"
        >
          <ImagesIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{row.title}</span>
        </a>
        <Badge variant="outline">Gallery</Badge>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        {[row.description, itemsLabel(row.itemCount), formatLinkDate(row.updatedAt)]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {shown.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
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
    <li className="grid grid-cols-[1fr_auto] items-center gap-3 py-2.5" data-link-type={row.type}>
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
        onDelete={async () => {
          setBusy(true);
          setError(null);
          const message = await onDelete(row);
          setBusy(false);
          if (message) setError(message);
          return message === null;
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
  const [filter, setFilter] = useState<LinkFilter>("all");
  const alive = useRef(true);
  // Refs already sent to the titles route, so "Load more" only asks for new ones.
  const requestedRefs = useRef(new Set<string>());
  // Refs whose failed batch was already re-armed once, so a dead route can't loop.
  const retriedRefs = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function load(): Promise<void> {
    setState({ status: "loading" });
    const [summary, feeds, galleries] = await Promise.all([
      loadWorkspaceSummary(apiOrigin, workspace),
      listWorkspaceFeeds(apiOrigin, workspace),
      getMyWorkspaceGalleries(apiOrigin, workspace),
    ]);
    if (!alive.current) return;
    if (summary.kind !== "success") {
      setState(
        summary.reason === "not_found"
          ? { status: "error", message: "You don’t have access to this workspace.", retry: false }
          : { status: "error", message: "Links are temporarily unavailable.", retry: true },
      );
      return;
    }
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
  const hasBothKinds =
    rows.some((r) => r.type === "live") && rows.some((r) => r.type === "gallery");
  const shownRows = hasBothKinds && filter !== "all" ? rows.filter((r) => r.type === filter) : rows;
  const refs = useMemo(() => titleRefs(rows), [rows]);
  const refsKey = refs.join(",");

  useEffect(() => {
    const fresh = refs.filter((ref) => !requestedRefs.current.has(ref));
    if (!fresh.length) return;
    for (const ref of fresh) requestedRefs.current.add(ref);
    // No per-run cancel: a later run asks only for newer refs, so dropping
    // this run's answer would leave its rows on the fallback label for good.
    const batches = chunkRefs(fresh);
    void Promise.all(batches.map((batch) => getGithubTitles(apiOrigin, workspace, batch))).then(
      (maps) => {
        if (!alive.current) return;
        // A failed batch (null) un-marks its refs so a later render or "Load
        // more" asks again, once per ref: refs that succeeded stay marked (R5).
        maps.forEach((map, i) => {
          if (map) return;
          for (const ref of batches[i] ?? []) {
            if (retriedRefs.current.has(ref)) continue;
            retriedRefs.current.add(ref);
            requestedRefs.current.delete(ref);
          }
        });
        setTitles((prev) => {
          const next: GithubTitleMap = { ...prev };
          for (const map of maps) if (map) Object.assign(next, map);
          return next;
        });
      },
    );
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
          {hasBothKinds ? (
            <div
              className="wsp-toggle flex items-stretch overflow-hidden rounded-[6px] border border-line box-border"
              role="group"
              aria-label="Show"
            >
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className="wsp-toggle__opt min-h-[34px] whitespace-nowrap border-0 bg-none px-3 text-[13px] text-muted-foreground cursor-pointer [&+&]:border-l [&+&]:border-line aria-pressed:bg-panel aria-pressed:text-fg hover:text-fg focus-visible:text-fg"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          ) : null}
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
            {shownRows.map((row) => (
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
