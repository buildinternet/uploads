/**
 * Files tab, By pull request view (spec: "Files views > By pull request").
 * SSR-first like ScreenshotsByPath: files.astro server-fetches the first
 * page and the repo options and renders this with no client directive; the
 * manual hydrateRoot mount attaches interactivity and skips the first fetch.
 * Filters (type, repo, state) live in the URL and are rewritten in place
 * with replaceState, so Back leaves the page instead of undoing filters.
 * Type narrows each row's thumbnails (server-side), never the rows. Only PRs
 * with media in the last 90 days load by default; "Show older pull requests"
 * at the end of the list reloads with all=1.
 * Rows say "updated 2h ago", never a count: the rollup's media_count includes
 * promoted copies and never decrements.
 */
import { Callout } from "@uploads/ui";
import { PrLabel } from "@uploads/ui/components/pr-label";
import "@uploads/ui/styles.css";
import { useEffect, useState } from "react";
import { IslandErrorBoundary } from "../IslandErrorBoundary";
import { onSession } from "../../lib/account-shell";
import type { PullRow } from "../../lib/api-client";
import { makeFileOpener, type FileOpener } from "../../lib/file-opener";
import { loadPulls, loadRepos } from "../../lib/files-api";
import { thumbToTile } from "../../lib/files-scope";
import {
  filesPrHref,
  filesSearch,
  filesViewHref,
  readFilesQuery,
  type FilesQuery,
} from "../../lib/files-view-state";
import { githubUrl } from "../../lib/gh-context";
import type { WorkspaceInfoStatus } from "../../lib/workspace-file-row";
import { lastUpdatedLabel } from "../../lib/workspace-screenshots";
import { CommandEmpty, InlineEmpty, RowsSkeleton } from "./FilesEmpty";
import { PrStateSelect, RepoSelect, TypeSelect } from "./FilterControls";
import { RowOverflowMenu, useLiveLink, type LiveLinkControls } from "./LiveLink";
import { ShotThumb, type PreviewHandlers } from "./ShotThumb";
import { useCursorList } from "./useCursorList";
import { useShotPreview } from "./useShotPreview";
import { InfoBlocked, useWorkspaceInfo } from "./useWorkspaceInfo";

export interface PullsPage {
  rows: PullRow[];
  nextCursor: string | null;
}

export interface PullsViewProps {
  apiOrigin: string;
  workspace: string;
  /** `Astro.url.search` at render time; seeds the filters on server and client alike. */
  initialSearch: string;
  initialInfo?: WorkspaceInfoStatus;
  initialPage?: PullsPage;
  /** Repo select options (first page of /repos). Fetched client-side when absent. */
  initialRepoOptions?: string[];
}

function PullsViewInner({
  apiOrigin,
  workspace,
  initialSearch,
  initialInfo,
  initialPage,
  initialRepoOptions,
}: PullsViewProps) {
  const [query, setQuery] = useState<FilesQuery>(() => readFilesQuery(initialSearch));
  const { info, retry: retryInfo } = useWorkspaceInfo(apiOrigin, workspace, initialInfo);
  const [repoOptions, setRepoOptions] = useState<string[]>(() => initialRepoOptions ?? []);
  // The API lists PRs with media in the last 90 days. "Show older pull requests"
  // switches to all=1. Component state only: a reload returns to the window,
  // which is also what the SSR seed holds.
  const [showOlder, setShowOlder] = useState(false);
  const preview = useShotPreview(apiOrigin, workspace);
  const liveLink = useLiveLink(apiOrigin, workspace);
  const {
    state: list,
    loadMore,
    retry,
  } = useCursorList<PullRow>({
    queryKey: filesSearch(query) + (showOlder ? "|all" : ""),
    seed: initialPage,
    keyOf: (row) => row.ref,
    load: (cursor) =>
      loadPulls(apiOrigin, workspace, {
        type: query.type,
        repo: query.repo,
        state: query.state,
        all: showOlder,
        cursor,
      }).then((result) =>
        result.ok
          ? {
              ok: true as const,
              value: { rows: result.value.pulls, nextCursor: result.value.nextCursor },
            }
          : { ok: false as const },
      ),
  });

  useEffect(() => {
    document.title = `Files · ${workspace} · uploads.sh`;
  }, [workspace]);

  useEffect(() => {
    const target = window.location.pathname + filesSearch(query);
    if (target === window.location.pathname + window.location.search) return;
    window.history.replaceState(window.history.state, "", target);
  }, [query]);

  useEffect(() => {
    if (initialRepoOptions !== undefined) return;
    let cancelled = false;
    onSession(() => {
      void loadRepos(apiOrigin, workspace, { type: null }).then((result) => {
        if (!cancelled && result.ok) setRepoOptions(result.value.repos.map((row) => row.repo));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, initialRepoOptions]);

  if (info.status === "loading") return <RowsSkeleton rows={4} />;
  if (info.status !== "ready") return <InfoBlocked info={info} retry={retryInfo} />;

  const opener = makeFileOpener(apiOrigin, workspace, info.hasPublicUrl);
  // Type never empties the list (it narrows thumbnails), so only repo and state count.
  const filtering = query.repo !== "" || query.state !== null;

  return (
    <div className="wsp grid gap-6" aria-busy={list.status === "loading" || undefined}>
      <div className="wsp-filter flex flex-wrap items-stretch gap-2">
        <TypeSelect value={query.type} onChange={(type) => setQuery({ ...query, type })} />
        <RepoSelect
          value={query.repo}
          options={repoOptions}
          onChange={(repo) => setQuery({ ...query, repo })}
        />
        <PrStateSelect value={query.state} onChange={(state) => setQuery({ ...query, state })} />
      </div>

      {list.status === "loading" && <RowsSkeleton rows={4} />}
      {list.status === "error" && (
        <Callout tone="error" role="alert">
          Pull requests are temporarily unavailable.{" "}
          <button type="button" className="text-btn" onClick={retry}>
            Try again
          </button>
        </Callout>
      )}
      {list.status === "ready" &&
        list.rows.length === 0 &&
        (filtering ? (
          <InlineEmpty title="No pull requests match these filters." />
        ) : (
          <CommandEmpty
            title="No pull request files yet"
            description="Files attached to a pull request show up here, newest first."
            command="uploads put ./shot.png --pr 123"
            footer={
              <a className="text-btn" href={filesViewHref(workspace, "pages")}>
                Browse by page →
              </a>
            }
          />
        ))}
      {list.status === "ready" && list.rows.length > 0 && (
        <ul className="m-0 grid list-none p-0">
          {list.rows.map((row) => (
            <PullRowItem
              key={row.ref}
              row={row}
              workspace={workspace}
              opener={opener}
              preview={preview.handlers}
              liveLink={liveLink}
            />
          ))}
        </ul>
      )}
      {list.status === "ready" && list.nextCursor && (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            className="text-btn text-btn--boxed"
            onClick={loadMore}
            disabled={list.more === "loading"}
          >
            {list.more === "loading" ? "Loading…" : "Load more"}
          </button>
          {list.more === "error" && (
            <span role="alert" className="text-[12px] text-muted-foreground">
              Couldn’t load more. Try again.
            </span>
          )}
        </div>
      )}
      {list.status === "ready" && !list.nextCursor && !showOlder && (
        <div className="flex items-center justify-center">
          <button
            type="button"
            className="text-btn text-btn--boxed"
            onClick={() => setShowOlder(true)}
          >
            Show older pull requests
          </button>
        </div>
      )}
      {preview.layer}
      {liveLink.dialog}
      {liveLink.toast}
    </div>
  );
}

function PullRowItem({
  row,
  workspace,
  opener,
  preview,
  liveLink,
}: {
  row: PullRow;
  workspace: string;
  opener: FileOpener;
  preview: PreviewHandlers;
  liveLink: LiveLinkControls;
}) {
  const scope = { repo: row.repo, pr: row.number };
  return (
    <li className="grid gap-2.5 border-t border-line py-4 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <PrLabel
            ghRef={row.ref}
            title={row.title}
            state={row.state}
            kind="pull"
            size="md"
            href={filesPrHref(workspace, row.repo, row.number)}
          />
          <div className="flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
            <span>{row.repo}</span>
            {row.branch && <span>· {row.branch}</span>}
            <span>· updated {lastUpdatedLabel(row.lastMediaAt, new Date())}</span>
          </div>
        </div>
        {/* copy() runs straight from the menu click (no await first) so the
            clipboard write starts inside the gesture; one copy at a time
            disables every row's menu. */}
        <RowOverflowMenu
          label={`${row.repo}#${row.number}`}
          githubUrl={githubUrl(row.repo, "pull", String(row.number))}
          busy={liveLink.busy}
          onCopyLiveLink={() => void liveLink.copy(scope)}
        />
      </div>
      {row.thumbnails.length > 0 && (
        <div className="wsp-strip">
          {row.thumbnails.map((thumb) => {
            const tile = thumbToTile(thumb);
            return (
              <ShotThumb
                key={tile.key}
                item={tile}
                href={opener.href(tile)}
                onOpen={() => opener.activate(tile)}
                {...preview}
              />
            );
          })}
        </div>
      )}
    </li>
  );
}

export function PullsView(props: PullsViewProps) {
  return (
    <IslandErrorBoundary>
      <PullsViewInner {...props} />
    </IslandErrorBoundary>
  );
}
