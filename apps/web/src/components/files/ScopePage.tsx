/**
 * Files PR page (`/files/:owner/:repo/pull/:number`) and repo page
 * (`/files/:owner/:repo`), spec "PR page and repo page". Same scope query as
 * the live link (scope endpoint → prScopeQuery), so the page and the shared
 * link show the same objects. Newest first; before/after pairs stay side by
 * side; the PR page can group by `path` (`?group=path`). Tiles open through
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
import { loadPulls, loadScopeFiles, shareInfoFromScope } from "../../lib/files-api";
import {
  groupScopeItemsByPath,
  keepPairsTogether,
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
import { useLiveLink } from "./LiveLink";
import { ShotThumb, type PreviewHandlers } from "./ShotThumb";
import { useCursorList } from "./useCursorList";
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
  const [pulls, setPulls] = useState<PullRow[] | null>(() => initialPulls ?? null);
  const prRef = number !== null ? `${repo}#${number}` : null;
  const scope: LiveLinkScope = number !== null ? { repo, pr: number } : { repo };

  // Only the newest first-page load may update the header and share info; a
  // slower response for a filter the viewer already left must not win.
  const queryKey = `${repo}#${number ?? ""}:${query.type ?? ""}`;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

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
          if (!result.ok) return { ok: false as const };
          // privateCount ignores `type`, so any first page carries the scope's share info.
          if (cursor === undefined && queryKeyRef.current === queryKey) {
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

  useEffect(() => {
    const target = window.location.pathname + scopePageSearch(query);
    if (target === window.location.pathname + window.location.search) return;
    window.history.replaceState(window.history.state, "", target);
  }, [query]);

  // Fallback only: the rollup row has no title (no row, or an unlinked repo).
  // Also runs when the scope load failed, so the header still names the PR.
  const needsTitle = prRef !== null && list.status !== "loading" && !pull?.title;
  useEffect(() => {
    if (!needsTitle || !prRef) return;
    let cancelled = false;
    onSession(() => {
      void getGithubTitles(apiOrigin, workspace, [prRef]).then((map) => {
        if (!cancelled) setFallbackTitle(map?.[prRef] ?? null);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, prRef, needsTitle]);

  useEffect(() => {
    if (number !== null || initialPulls !== undefined) return;
    let cancelled = false;
    onSession(() => {
      void loadPulls(apiOrigin, workspace, { type: null, repo, state: null }).then((result) => {
        if (!cancelled) setPulls(result.ok ? result.value.pulls : []);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, repo, number, initialPulls]);

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
  })}`;

  return (
    <div className="wsp grid gap-6" aria-busy={list.status === "loading" || undefined}>
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
          <h1 className="m-0 min-w-0 flex-1 text-[19px] leading-[1.3] font-semibold [overflow-wrap:anywhere]">
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
          {/* One copy at a time across the page: busy disables every Copy control. */}
          <Button onClick={onCopy} disabled={liveLink.busy}>
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
      {list.status === "error" && (
        <Callout tone="error" role="alert">
          Couldn’t load these files.{" "}
          <button type="button" className="text-btn" onClick={retry}>
            Try again
          </button>
        </Callout>
      )}
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
          <TileGrid
            items={keepPairsTogether(list.rows)}
            opener={opener}
            preview={preview.handlers}
          />
        ))}
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
      {preview.layer}
      {liveLink.dialog}
      {liveLink.toast}
    </div>
  );
}

/** One grid of tiles, already in display order. Pair flags are per grid, so a pair split across path groups is not announced as paired. */
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
  return (
    <div className={GRID_CLASS}>
      {items.map((tile) => (
        <ShotThumb
          key={tile.key}
          item={tile}
          paired={paired.has(tile.key)}
          href={opener.href(tile)}
          onOpen={() => opener.activate(tile)}
          {...preview}
        />
      ))}
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
