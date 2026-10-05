/**
 * Files tab, By repo view (spec: "Files views > By repo"). Same SSR-first
 * lifecycle and URL handling as PullsView; Type is the only filter (a repo
 * filter on the repo list is a no-op). Type narrows each row's thumbnails
 * server-side and never drops a repo, so the empty state has one variant.
 */
import { Callout } from "@uploads/ui";
import "@uploads/ui/styles.css";
import { useEffect, useState } from "react";
import { IslandErrorBoundary } from "../IslandErrorBoundary";
import type { RepoRow } from "../../lib/api-client";
import { makeFileOpener, type FileOpener } from "../../lib/file-opener";
import { loadRepos } from "../../lib/files-api";
import { openPullsLabel } from "../../lib/files-scope";
import {
  filesRepoHref,
  filesSearch,
  readFilesQuery,
  type FilesQuery,
} from "../../lib/files-view-state";
import type { WorkspaceInfoStatus } from "../../lib/workspace-file-row";
import { lastUpdatedLabel } from "../../lib/workspace-screenshots";
import { CommandEmpty, RowsSkeleton } from "./FilesEmpty";
import { TypeSelect } from "./FilterControls";
import { GitHubMark } from "./gh-glyphs";
import { LoadMoreFooter } from "./LoadMoreFooter";
import { RowOverflowMenu, useLiveLink, type LiveLinkControls } from "./LiveLink";
import type { PreviewHandlers } from "./ShotThumb";
import { ThumbStrip } from "./ThumbStrip";
import { useCursorList } from "./useCursorList";
import { useReplaceSearch } from "./useReplaceSearch";
import { useShotPreview } from "./useShotPreview";
import { InfoBlocked, useWorkspaceInfo } from "./useWorkspaceInfo";

export interface ReposPage {
  rows: RepoRow[];
  nextCursor: string | null;
}

export interface ReposViewProps {
  apiOrigin: string;
  workspace: string;
  /** `Astro.url.search` at render time; seeds the Type filter on server and client alike. */
  initialSearch: string;
  initialInfo?: WorkspaceInfoStatus;
  initialPage?: ReposPage;
}

function ReposViewInner({
  apiOrigin,
  workspace,
  initialSearch,
  initialInfo,
  initialPage,
}: ReposViewProps) {
  const [query, setQuery] = useState<FilesQuery>(() => readFilesQuery(initialSearch));
  const { info, retry: retryInfo } = useWorkspaceInfo(apiOrigin, workspace, initialInfo);
  const preview = useShotPreview(apiOrigin, workspace);
  const liveLink = useLiveLink(apiOrigin, workspace);
  const {
    state: list,
    loadMore,
    retry,
  } = useCursorList<RepoRow>({
    queryKey: filesSearch(query),
    seed: initialPage,
    keyOf: (row) => row.repo,
    load: (cursor) =>
      loadRepos(apiOrigin, workspace, { type: query.type, cursor }).then((result) =>
        result.ok
          ? {
              ok: true as const,
              value: { rows: result.value.repos, nextCursor: result.value.nextCursor },
            }
          : { ok: false as const },
      ),
  });

  useEffect(() => {
    document.title = `Files · ${workspace} · uploads.sh`;
  }, [workspace]);

  // filesSearch keeps `?view=repos`, so hydration never rewrites the URL to the default view.
  useReplaceSearch(filesSearch(query));

  if (info.status === "loading") return <RowsSkeleton rows={4} />;
  if (info.status !== "ready") return <InfoBlocked info={info} retry={retryInfo} />;
  const opener = makeFileOpener(apiOrigin, workspace, info.hasPublicUrl);

  return (
    <div className="wsp grid gap-6" aria-busy={list.status === "loading" || undefined}>
      <div className="wsp-filter flex flex-wrap items-stretch gap-2">
        <TypeSelect value={query.type} onChange={(type) => setQuery({ ...query, type })} />
      </div>
      {list.status === "loading" && <RowsSkeleton rows={4} />}
      {list.status === "error" && (
        <Callout tone="error" role="alert">
          Repos are temporarily unavailable.{" "}
          <button type="button" className="text-btn" onClick={retry}>
            Try again
          </button>
        </Callout>
      )}
      {list.status === "ready" && list.rows.length === 0 && (
        <CommandEmpty
          title="No repos with files yet"
          description="Files with GitHub repo context group here by repo."
          command="uploads put ./shot.png --pr 123"
        />
      )}
      {list.status === "ready" && list.rows.length > 0 && (
        <ul className="m-0 grid list-none p-0">
          {list.rows.map((row) => (
            <RepoRowItem
              key={row.repo}
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
        <LoadMoreFooter more={list.more} onLoadMore={loadMore} />
      )}
      {preview.layer}
      {liveLink.dialog}
      {liveLink.toast}
    </div>
  );
}

function RepoRowItem({
  row,
  workspace,
  opener,
  preview,
  liveLink,
}: {
  row: RepoRow;
  workspace: string;
  opener: FileOpener;
  preview: PreviewHandlers;
  liveLink: LiveLinkControls;
}) {
  const scope = { repo: row.repo };
  return (
    <li className="grid gap-2.5 border-t border-line py-4 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <a
            className="flex items-center gap-2 text-[15px] font-semibold text-fg no-underline hover:underline [overflow-wrap:anywhere]"
            href={filesRepoHref(workspace, row.repo)}
          >
            <GitHubMark size={14} />
            {row.repo}
          </a>
          <div className="flex flex-wrap gap-x-2 text-[12px] text-muted-foreground">
            {/* Relative to render time; SSR and hydrate can straddle a minute boundary. */}
            <span suppressHydrationWarning>
              {`updated ${lastUpdatedLabel(row.lastUpdatedAt, new Date())}`}
            </span>
            <span>· {openPullsLabel(row.openPullCount)}</span>
          </div>
        </div>
        {/* copy() runs straight from the menu click (no await first) so the
            clipboard write starts inside the gesture; one copy at a time
            disables every row's menu. */}
        <RowOverflowMenu
          label={row.repo}
          githubUrl={`https://github.com/${row.repo}`}
          busy={liveLink.busy}
          onCopyLiveLink={() => void liveLink.copy(scope)}
        />
      </div>
      <ThumbStrip thumbnails={row.thumbnails} opener={opener} preview={preview} />
    </li>
  );
}

export function ReposView(props: ReposViewProps) {
  return (
    <IslandErrorBoundary>
      <ReposViewInner {...props} />
    </IslandErrorBoundary>
  );
}
