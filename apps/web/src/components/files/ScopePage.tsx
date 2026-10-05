/**
 * Files PR page (`/files/:owner/:repo/pull/:number`) and repo page
 * (`/files/:owner/:repo`), spec "PR page and repo page". Same scope query as
 * the live link (scope endpoint → prScopeQuery), so the page and the shared
 * link show the same objects. Newest first; a before/after pair is one grid
 * cell, side by side; the PR page can group by `path` (`?group=path`). Tiles open through
 * file-opener, never the `/c/` item page.
 *
 * PR header: branch, title, and state come from the scope response's `pull`
 * (the rollup row). The API serves a stored title only for linked repos, so
 * a separate title fetch runs only when the row has no title.
 */
import { Callout } from "@uploads/ui";
import "@uploads/ui/styles.css";
import { PrLabel } from "@uploads/ui/components/pr-label";
import { Button } from "@uploads/ui/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { IslandErrorBoundary } from "../IslandErrorBoundary";
import { onSession } from "../../lib/account-shell";
import {
  getGithubTitles,
  type GithubTitleInfo,
  type PullRow,
  type ScopeFilesResponse,
} from "../../lib/api-client";
import { makeFileOpener, type FileOpener } from "../../lib/file-opener";
import {
  isNotPubliclyServed,
  loadPulls,
  loadScopeFiles,
  shareInfoFromScope,
} from "../../lib/files-api";
import {
  groupScopeItemsByPath,
  pairCells,
  scopeEmptyCopy,
  scopeItemToTile,
  type ScopeTile,
} from "../../lib/files-scope";
import {
  filesBasePath,
  filesPrHref,
  filesRepoHref,
  filesSearch,
  filesViewHref,
  prStateFromTitle,
  readScopePageQuery,
  scopePageSearch,
  type ScopePageQuery,
} from "../../lib/files-view-state";
import { githubUrl } from "../../lib/gh-context";
import {
  liveLinkScopeLabel,
  type LiveLinkScope,
  type ScopeShareInfo,
} from "../../lib/live-link-flow";
import type { WorkspaceInfoStatus } from "../../lib/workspace-file-row";
import { lastUpdatedLabel, pairedShotKeys } from "../../lib/workspace-screenshots";
import { CommandEmpty, InlineEmpty, RowsSkeleton } from "./FilesEmpty";
import { TypeSelect } from "./FilterControls";
import { LoadMoreFooter } from "./LoadMoreFooter";
import { useLiveLink } from "./LiveLink";
import { ShotThumb, type PreviewHandlers } from "./ShotThumb";
import { useCursorList } from "./useCursorList";
import { useReplaceSearch } from "./useReplaceSearch";
import { useShotPreview } from "./useShotPreview";
import { InfoBlocked, useWorkspaceInfo } from "./useWorkspaceInfo";

export interface ScopePageProps {
  apiOrigin: string;
  workspace: string;
  /** Lowercased owner/repo (the page already redirected to the canonical URL). */
  repo: string;
  /** PR number, or null on the repo page. */
  number: number | null;
  /** `Astro.url.search` at render time; seeds the filters on server and client alike. */
  initialSearch: string;
  initialInfo?: WorkspaceInfoStatus;
  initialScope?: ScopeFilesResponse;
  /** Repo page only: recent PRs for the side list. */
  initialPulls?: PullRow[];
}

const GRID_CLASS =
  "wsp-grid grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]";
/** Repo page: how many recent PRs to list before linking to the filtered PR list. */
const RECENT_PULLS_SHOWN = 10;

function ScopePageInner({
  apiOrigin,
  workspace,
  repo,
  number,
  initialSearch,
  initialInfo,
  initialScope,
  initialPulls,
}: ScopePageProps) {
  const [query, setQuery] = useState<ScopePageQuery>(() => readScopePageQuery(initialSearch));
  const { info, retry: retryInfo } = useWorkspaceInfo(apiOrigin, workspace, initialInfo);
  const preview = useShotPreview(apiOrigin, workspace);
  const liveLink = useLiveLink(apiOrigin, workspace);
  const [share, setShare] = useState<ScopeShareInfo | null>(() =>
    initialScope ? shareInfoFromScope(initialScope) : null,
  );
  const [pull, setPull] = useState<ScopeFilesResponse["pull"]>(() => initialScope?.pull ?? null);
  const [fallbackTitle, setFallbackTitle] = useState<GithubTitleInfo | null>(null);
  /** Repo page PR list: null while loading, "error" when the fetch failed. */
  const [pulls, setPulls] = useState<PullRow[] | "error" | null>(() => initialPulls ?? null);
  const [pullsAttempt, setPullsAttempt] = useState(0);
  /** The last first-page failure was the #1079 no-public-URL 503 (no retry offered). */
  const [notPublic, setNotPublic] = useState(false);
  const prRef = number !== null ? `${repo}#${number}` : null;
  const scope: LiveLinkScope = number !== null ? { repo, pr: number } : { repo };

  // Only the newest first-page load may update the header, share info, and
  // failure kind; a slower response for a filter the viewer already left must
  // not win. Declared before useCursorList so the ref is current before its
  // fetch effect runs in the same commit.
  const queryKey = `${repo}#${number ?? ""}:${query.type ?? ""}`;
  const queryKeyRef = useRef(queryKey);
  useEffect(() => {
    queryKeyRef.current = queryKey;
  }, [queryKey]);

  const {
    state: list,
    loadMore,
    retry,
  } = useCursorList<ScopeTile>({
    queryKey,
    seed: initialScope
      ? { rows: initialScope.items.map(scopeItemToTile), nextCursor: initialScope.nextCursor }
      : undefined,
    keyOf: (tile) => tile.key,
    load: (cursor) =>
      loadScopeFiles(apiOrigin, workspace, { repo, number, type: query.type, cursor }).then(
        (result) => {
          const current = cursor === undefined && queryKeyRef.current === queryKey;
          if (current) setNotPublic(isNotPubliclyServed(result));
          if (!result.ok) return { ok: false as const };
          // privateCount ignores `type`, so any first page carries the scope's share info.
          if (current) {
            setShare(shareInfoFromScope(result.value));
            setPull(result.value.pull);
          }
          return {
            ok: true as const,
            value: {
              rows: result.value.items.map(scopeItemToTile),
              nextCursor: result.value.nextCursor,
            },
          };
        },
      ),
  });

  const scopeLabel = liveLinkScopeLabel(scope);
  useEffect(() => {
    document.title = `${scopeLabel} · Files · ${workspace} · uploads.sh`;
  }, [scopeLabel, workspace]);

  useReplaceSearch(scopePageSearch(query));

  // Fallback only: the rollup row has no title (no row, or an unlinked repo).
  // Also runs when the scope load failed, so the header still names the PR.
  // At most once per page mount: a type change reloads the list, not the PR.
  const needsTitle = prRef !== null && list.status !== "loading" && !pull?.title;
  const titleRequested = useRef(false);
  useEffect(() => {
    if (!needsTitle || !prRef || titleRequested.current) return;
    titleRequested.current = true;
    onSession(() => {
      void getGithubTitles(apiOrigin, workspace, [prRef]).then((map) => {
        setFallbackTitle(map?.[prRef] ?? null);
      });
    });
  }, [apiOrigin, workspace, prRef, needsTitle]);

  useEffect(() => {
    if (number !== null || (initialPulls !== undefined && pullsAttempt === 0)) return;
    let cancelled = false;
    onSession(() => {
      void loadPulls(apiOrigin, workspace, { type: null, repo, state: null }).then((result) => {
        if (!cancelled) setPulls(result.ok ? result.value.pulls : "error");
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, repo, number, initialPulls, pullsAttempt]);
  const retryPulls = () => {
    setPulls(null);
    setPullsAttempt((n) => n + 1);
  };

  if (info.status === "loading") return <RowsSkeleton rows={2} />;
  if (info.status !== "ready") return <InfoBlocked info={info} retry={retryInfo} />;

  const opener = makeFileOpener(apiOrigin, workspace, info.hasPublicUrl);
  // copy() runs straight from the click (no await first) so the clipboard
  // write starts inside the gesture.
  const onCopy = () => {
    void liveLink.copy(scope, share).then((outcome) => {
      if (outcome.kind === "copied" || outcome.kind === "clipboard-blocked") {
        setShare((prev) => ({
          privateCount: prev?.privateCount ?? null,
          liveLink: { id: outcome.id, url: outcome.url },
        }));
      }
    });
  };
  const empty = scopeEmptyCopy({ number, type: query.type });
  const githubHref =
    number !== null ? githubUrl(repo, "pull", String(number)) : `https://github.com/${repo}`;
  const repoPullsHref = `${filesBasePath(workspace)}${filesSearch({
    view: "pulls",
    type: null,
    repo,
    state: null,
    all: false,
  })}`;

  return (
    <div className="wsp grid gap-6">
      <header className="grid gap-2">
        <a
          className="text-btn justify-self-start"
          href={
            number !== null ? filesRepoHref(workspace, repo) : filesViewHref(workspace, "repos")
          }
        >
          {number !== null ? `← ${repo}` : "← All repos"}
        </a>
        <div className="flex flex-wrap items-center gap-3">
          {/* Full row: in this wrapping flex row a `flex-1` heading shrinks to
              nothing beside the buttons and the label (PR number included)
              ellipsizes away. The branch and actions wrap below it. */}
          <h1 className="m-0 min-w-0 basis-full text-[19px] leading-[1.3] font-semibold [overflow-wrap:anywhere]">
            {prRef ? (
              <PrLabel
                ghRef={prRef}
                title={pull?.title ?? fallbackTitle?.title ?? null}
                state={pull?.state ?? prStateFromTitle(fallbackTitle?.state)}
                kind="pull"
                size="lg"
              />
            ) : (
              repo
            )}
          </h1>
          {pull?.branch && (
            <span className="text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
              {pull.branch}
            </span>
          )}
          {/* One copy at a time across the page: busy disables every Copy
              control. focusableWhenDisabled keeps focus on the button (and
              gives the confirm dialog a target to return focus to). */}
          <Button
            onClick={onCopy}
            disabled={liveLink.busy}
            focusableWhenDisabled
            className="aria-disabled:opacity-50"
          >
            Copy live link
          </Button>
          {share?.liveLink && (
            <a
              className="text-btn text-btn--boxed"
              href={share.liveLink.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open live link
            </a>
          )}
          <a className="text-btn" href={githubHref} target="_blank" rel="noopener noreferrer">
            Open on GitHub ↗
          </a>
        </div>
      </header>

      {number === null && (
        <section className="grid gap-2" aria-labelledby="files-repo-pulls">
          <h2 id="files-repo-pulls" className="m-0 text-[13px] font-semibold">
            Recent pull requests
          </h2>
          {pulls === null ? (
            <RowsSkeleton rows={1} />
          ) : pulls === "error" ? (
            <p role="alert" className="m-0 text-[13px] text-muted-foreground">
              Couldn’t load pull requests for this repo.{" "}
              <button type="button" className="text-btn" onClick={retryPulls}>
                Try again
              </button>
            </p>
          ) : pulls.length === 0 ? (
            <p className="m-0 text-[13px] text-muted-foreground">
              No pull requests with files in this repo in the last 90 days.
            </p>
          ) : (
            <>
              <ul className="m-0 grid list-none gap-1.5 p-0">
                {pulls.slice(0, RECENT_PULLS_SHOWN).map((row) => (
                  <li key={row.ref} className="flex flex-wrap items-baseline gap-x-2">
                    <PrLabel
                      ghRef={row.ref}
                      title={row.title}
                      state={row.state}
                      kind="pull"
                      size="sm"
                      href={filesPrHref(workspace, row.repo, row.number)}
                    />
                    {/* Relative to render time; SSR and hydrate can straddle a minute boundary. */}
                    <span className="text-[12px] text-muted-foreground" suppressHydrationWarning>
                      {`updated ${lastUpdatedLabel(row.lastMediaAt, new Date())}`}
                    </span>
                  </li>
                ))}
              </ul>
              {pulls.length > RECENT_PULLS_SHOWN && (
                <a className="text-btn justify-self-start" href={repoPullsHref}>
                  All pull requests in {repo} →
                </a>
              )}
            </>
          )}
        </section>
      )}

      <div className="wsp-filter flex flex-wrap items-stretch gap-2">
        <TypeSelect value={query.type} onChange={(type) => setQuery({ ...query, type })} />
        {number !== null && (
          <div
            className="wsp-toggle flex items-stretch overflow-hidden rounded-[6px] border border-line box-border"
            role="group"
            aria-label="Grouping"
          >
            <button
              type="button"
              className="wsp-toggle__opt min-h-[34px] whitespace-nowrap border-0 bg-none px-3 text-[13px] text-muted-foreground cursor-pointer aria-pressed:bg-panel aria-pressed:text-fg hover:text-fg focus-visible:text-fg"
              aria-pressed={query.groupByPath}
              onClick={() => setQuery({ ...query, groupByPath: !query.groupByPath })}
            >
              Group by page
            </button>
          </div>
        )}
      </div>

      {list.status === "loading" && (
        <div className={GRID_CLASS} aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <span className="wsp-thumb wsp-thumb--skel" key={i} aria-hidden="true" />
          ))}
        </div>
      )}
      {list.status === "error" &&
        (notPublic ? (
          // Issue #1079: deterministic until the workspace has a public base URL.
          <Callout tone="muted">
            Files in this workspace aren’t publicly served, so they can’t be shown here yet.
          </Callout>
        ) : (
          <Callout tone="error" role="alert">
            Couldn’t load these files.{" "}
            <button type="button" className="text-btn" onClick={retry}>
              Try again
            </button>
          </Callout>
        ))}
      {list.status === "ready" &&
        list.rows.length === 0 &&
        (empty.command ? (
          <CommandEmpty
            title={empty.title}
            description={empty.description}
            command={empty.command}
          />
        ) : (
          <InlineEmpty title={`${empty.title}. ${empty.description}`} />
        ))}
      {list.status === "ready" &&
        list.rows.length > 0 &&
        (query.groupByPath && number !== null ? (
          groupScopeItemsByPath(list.rows).map((group) => (
            <section key={group.path ?? "\0none"} className="wsp-group grid gap-2.5">
              <h2 className="wsp-group__path m-0 text-[13px] font-semibold [overflow-wrap:anywhere]">
                {group.path ?? "No page"}
              </h2>
              <TileGrid items={group.items} opener={opener} preview={preview.handlers} />
            </section>
          ))
        ) : (
          <TileGrid items={list.rows} opener={opener} preview={preview.handlers} />
        ))}
      {list.status === "ready" && list.nextCursor && (
        <LoadMoreFooter more={list.more} onLoadMore={loadMore} />
      )}
      {preview.layer}
      {liveLink.dialog}
      {liveLink.toast}
    </div>
  );
}

/**
 * One grid of tiles, newest first. A before/after pair is one cell spanning
 * two columns (before first), so its halves never wrap onto different rows.
 * Pair flags are per grid, so a pair split across path groups is not
 * announced as paired.
 */
function TileGrid({
  items,
  opener,
  preview,
}: {
  items: ScopeTile[];
  opener: FileOpener;
  preview: PreviewHandlers;
}) {
  const paired = pairedShotKeys(items);
  const thumb = (tile: ScopeTile) => (
    <ShotThumb
      key={tile.key}
      item={tile}
      paired={paired.has(tile.key)}
      href={opener.href(tile)}
      onOpen={() => opener.activate(tile)}
      {...preview}
    />
  );
  return (
    <div className={`${GRID_CLASS} wsp-grid--pairs`}>
      {pairCells(items).map((cell) =>
        cell.kind === "pair" ? (
          <div className="wsp-pair-cell" key={`pair:${cell.items[0].key}`}>
            {cell.items.map(thumb)}
          </div>
        ) : (
          thumb(cell.item)
        ),
      )}
    </div>
  );
}

export function ScopePage(props: ScopePageProps) {
  return (
    <IslandErrorBoundary>
      <ScopePageInner {...props} />
    </IslandErrorBoundary>
  );
}
