"use client";

import type { StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { ChevronRight, File, Folder, Home, LoaderCircle } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "./Badge";

export interface FileBrowserProps {
  files: UseFilesResult;
  initialPrefix?: string;
  delimiter?: string;
  onSelect?: (file: StoredFile) => void;
  /**
   * Fired when the user navigates into a folder or breadcrumb (including
   * back to root with `""`). Not fired for the initial mount — use
   * `initialPrefix` to seed location. files-sdk's registry FileBrowser owns
   * navigation state the same way; there is no built-in URL sync.
   */
  onPrefixChange?: (prefix: string) => void;
  /** When it returns true, a small "Private" badge renders next to the item. */
  isPrivate?: (file: StoredFile) => boolean;
  /**
   * Renders a per-item action (e.g. a visibility toggle) alongside the
   * select row rather than inside it — `<button>` can't nest another
   * `<button>`. `refresh` re-runs the current listing (resetting any
   * "Load more" pagination); `patchItem` updates one already-listed row in
   * place — prefer it after a mutation whose result the caller already
   * knows, so paginated results survive.
   */
  itemActions?: (
    file: StoredFile,
    helpers: { refresh: () => void; patchItem: (key: string, patch: Partial<StoredFile>) => void },
  ) => React.ReactNode;
}

/** Decimal SI sizes — matches account/billing and CLI (250 MB free, not 238 MB). */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
};

const crumbsOf = (prefix: string, delimiter: string) => {
  let accumulated = "";
  return prefix
    .split(delimiter)
    .filter(Boolean)
    .map((label) => {
      accumulated += label + delimiter;
      return { label, prefix: accumulated };
    });
};

const childName = (path: string, parent: string, delimiter: string): string =>
  path.slice(parent.length).replace(delimiter, "");

/** A read-only, folder-aware browser for a files-sdk React client. */
export function FileBrowser({
  files,
  initialPrefix = "",
  delimiter = "/",
  onSelect,
  onPrefixChange,
  isPrivate,
  itemActions,
}: FileBrowserProps) {
  const [prefix, setPrefix] = useState(initialPrefix);
  const [folders, setFolders] = useState<string[]>([]);
  const [items, setItems] = useState<StoredFile[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const filesRef = useRef(files);
  const onPrefixChangeRef = useRef(onPrefixChange);
  const requestGeneration = useRef(0);
  filesRef.current = files;
  onPrefixChangeRef.current = onPrefixChange;

  const load = useCallback(
    async (next?: string) => {
      const generation = ++requestGeneration.current;
      setIsLoading(true);
      setHasError(false);
      try {
        const result = await filesRef.current.list({
          delimiter,
          prefix: prefix || undefined,
          ...(next ? { cursor: next } : {}),
        });
        if (generation !== requestGeneration.current) return;
        setFolders((previous) =>
          next ? [...new Set([...previous, ...(result.prefixes ?? [])])] : (result.prefixes ?? []),
        );
        setItems((previous) => (next ? [...previous, ...result.items] : result.items));
        setCursor(result.cursor);
      } catch {
        if (generation === requestGeneration.current) setHasError(true);
      } finally {
        if (generation === requestGeneration.current) setIsLoading(false);
      }
    },
    [delimiter, prefix],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const navigate = (nextPrefix: string) => {
    if (nextPrefix === prefix) return;
    // Keep the current listing visible while the next level loads. Bumping
    // requestGeneration drops any in-flight page; load() replaces rows on success.
    requestGeneration.current++;
    setHasError(false);
    setIsLoading(true);
    setPrefix(nextPrefix);
    onPrefixChangeRef.current?.(nextPrefix);
  };
  const hasContent = folders.length > 0 || items.length > 0;
  const isEmpty = !(isLoading || hasError || hasContent);
  // While navigating with content already on screen, dim the old listing
  // instead of collapsing it — the reserved-height viewport does the rest.
  const isBusyOverlay = isLoading && hasContent;

  const crumbBtn =
    "font-[var(--mono)] text-[length:var(--text-meta)] leading-[var(--leading-tight)] text-muted-foreground border border-transparent rounded-[var(--radius-sm)] px-1.5 py-1 bg-none cursor-pointer hover:text-accent hover:border-line focus-visible:text-accent focus-visible:border-line focus-visible:outline-none";

  return (
    <div className="ul-files grid gap-[7px]">
      <nav
        className="ul-files__crumbs flex min-w-0 items-center gap-[3px]"
        aria-label="Current folder"
      >
        <button
          type="button"
          className={crumbBtn}
          onClick={() => navigate("")}
          aria-label="File root"
          aria-current={prefix === "" ? "location" : undefined}
        >
          <Home className="h-[13px] w-[13px] flex-none" aria-hidden="true" />
        </button>
        {crumbsOf(prefix, delimiter).map((crumb, index, crumbs) => (
          <Fragment key={crumb.prefix}>
            <ChevronRight
              className="ul-files__chevron h-[13px] w-[13px] flex-none"
              aria-hidden="true"
            />
            <button
              type="button"
              className={crumbBtn}
              onClick={() => navigate(crumb.prefix)}
              aria-current={index === crumbs.length - 1 ? "location" : undefined}
            >
              {crumb.label}
            </button>
          </Fragment>
        ))}
      </nav>
      <div
        className="ul-files__viewport group relative min-h-[var(--ul-files-min-height,116px)]"
        data-busy={isBusyOverlay ? "" : undefined}
      >
        <ul className="ul-files__list m-0 grid gap-0 p-0 [&>li]:m-0 [&>li]:border-0 [&>li]:border-b [&>li]:border-line [&>li]:bg-none [&>li]:p-0 [&>li:last-child]:border-b-0 group-data-[busy]:pointer-events-none group-data-[busy]:opacity-45">
          {folders.map((folder) => (
            <li key={folder}>
              <button
                className="ul-files__row flex w-full cursor-pointer items-center gap-[9px] rounded-[var(--radius-sm)] border-0 bg-none px-2 py-[7px] text-left font-[var(--mono)] text-[length:var(--text-meta)] leading-[var(--leading-tight)] text-fg hover:bg-accent/12 hover:text-accent focus-visible:bg-accent/12 focus-visible:text-accent focus-visible:outline-none"
                onClick={() => navigate(folder)}
                type="button"
              >
                <span className="ul-files__icon grid h-[27px] w-[27px] flex-none place-items-center rounded-[var(--radius-sm)] bg-panel text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">
                  <Folder aria-hidden="true" />
                </span>
                <span className="ul-files__name grid min-w-0 flex-1 overflow-hidden [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap">
                  {childName(folder, prefix, delimiter)}
                </span>
                <ChevronRight
                  className="ul-files__chevron h-[13px] w-[13px] flex-none"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
          {items.map((item) => (
            <li key={item.key}>
              <div className="ul-files__row-wrap flex items-center gap-1">
                <button
                  className="ul-files__row flex min-w-0 flex-1 cursor-pointer items-center gap-[9px] rounded-[var(--radius-sm)] border-0 bg-none px-2 py-[7px] text-left font-[var(--mono)] text-[length:var(--text-meta)] leading-[var(--leading-tight)] text-fg hover:bg-accent/12 hover:text-accent focus-visible:bg-accent/12 focus-visible:text-accent focus-visible:outline-none disabled:cursor-default"
                  disabled={!onSelect}
                  onClick={() => onSelect?.(item)}
                  type="button"
                >
                  <span className="ul-files__icon grid h-[27px] w-[27px] flex-none place-items-center rounded-[var(--radius-sm)] bg-panel text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">
                    <File aria-hidden="true" />
                  </span>
                  <span className="ul-files__name grid min-w-0 flex-1 overflow-hidden [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap">
                    <span>{childName(item.key, prefix, delimiter) || item.key}</span>
                    <small className="font-[var(--mono)] text-[length:var(--text-micro)] leading-none text-muted-foreground [font-variant-numeric:tabular-nums]">
                      {formatBytes(item.size)} · {item.type || "unknown"}
                    </small>
                  </span>
                  {isPrivate?.(item) ? <Badge tone="neutral">Unlisted</Badge> : null}
                </button>
                {itemActions?.(item, {
                  refresh: () => void load(),
                  patchItem: (key, patch) =>
                    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i))),
                })}
              </div>
            </li>
          ))}
        </ul>
        {isBusyOverlay ? (
          <div
            className="ul-files__busy pointer-events-none absolute top-1 right-1 text-muted-foreground [&>svg]:h-[15px] [&>svg]:w-[15px]"
            aria-hidden="true"
          >
            <LoaderCircle className="ul-files__spin animate-spin motion-reduce:animate-none" />
          </div>
        ) : null}
        {isLoading && !hasContent ? (
          <div className="ul-files__state absolute inset-0 flex items-center justify-center gap-[7px] p-3 font-[var(--sans)] text-[length:var(--text-meta)] leading-[var(--leading-ui)] text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">
            <LoaderCircle
              className="ul-files__spin animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />{" "}
            Loading…
          </div>
        ) : null}
        {hasError ? (
          <div className="ul-files__state absolute inset-0 flex items-center justify-center gap-[7px] p-3 font-[var(--sans)] text-[length:var(--text-meta)] leading-[var(--leading-ui)] text-muted-foreground">
            Files unavailable.
          </div>
        ) : null}
        {isEmpty ? (
          <div className="ul-files__state absolute inset-0 flex items-center justify-center gap-[7px] p-3 font-[var(--sans)] text-[length:var(--text-meta)] leading-[var(--leading-ui)] text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">
            <Folder aria-hidden="true" /> This folder is empty.
          </div>
        ) : null}
      </div>
      {cursor && !isLoading ? (
        <button
          className={crumbBtn + " ul-files__more"}
          onClick={() => void load(cursor)}
          type="button"
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}
