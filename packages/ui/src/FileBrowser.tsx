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

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
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
  const requestGeneration = useRef(0);
  filesRef.current = files;

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
    // Keep the current listing on screen while the next level loads. The
    // requestGeneration bump discards any in-flight page from this level, and
    // load() replaces folders/items wholesale on success — so we avoid the
    // flash-of-empty (and the shrink-then-grow) that clearing state caused.
    requestGeneration.current++;
    setHasError(false);
    setIsLoading(true);
    setPrefix(nextPrefix);
  };
  const hasContent = folders.length > 0 || items.length > 0;
  const isEmpty = !(isLoading || hasError || hasContent);
  // While navigating with content already on screen, dim the old listing
  // instead of collapsing it — the reserved-height viewport does the rest.
  const isBusyOverlay = isLoading && hasContent;

  return (
    <div className="ul-files">
      <nav className="ul-files__crumbs" aria-label="Current folder">
        <button
          type="button"
          onClick={() => navigate("")}
          aria-label="File root"
          aria-current={prefix === "" ? "location" : undefined}
        >
          <Home aria-hidden="true" />
        </button>
        {crumbsOf(prefix, delimiter).map((crumb, index, crumbs) => (
          <Fragment key={crumb.prefix}>
            <ChevronRight className="ul-files__chevron" aria-hidden="true" />
            <button
              type="button"
              onClick={() => navigate(crumb.prefix)}
              aria-current={index === crumbs.length - 1 ? "location" : undefined}
            >
              {crumb.label}
            </button>
          </Fragment>
        ))}
      </nav>
      <div className="ul-files__viewport" data-busy={isBusyOverlay ? "" : undefined}>
        <ul className="ul-files__list">
          {folders.map((folder) => (
            <li key={folder}>
              <button className="ul-files__row" onClick={() => navigate(folder)} type="button">
                <span className="ul-files__icon">
                  <Folder aria-hidden="true" />
                </span>
                <span className="ul-files__name">{childName(folder, prefix, delimiter)}</span>
                <ChevronRight className="ul-files__chevron" aria-hidden="true" />
              </button>
            </li>
          ))}
          {items.map((item) => (
            <li key={item.key}>
              <div className="ul-files__row-wrap">
                <button
                  className="ul-files__row"
                  disabled={!onSelect}
                  onClick={() => onSelect?.(item)}
                  type="button"
                >
                  <span className="ul-files__icon">
                    <File aria-hidden="true" />
                  </span>
                  <span className="ul-files__name">
                    <span>{childName(item.key, prefix, delimiter) || item.key}</span>
                    <small>
                      {formatBytes(item.size)} · {item.type || "unknown"}
                    </small>
                  </span>
                  {isPrivate?.(item) ? <Badge tone="neutral">Private</Badge> : null}
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
          <div className="ul-files__busy" aria-hidden="true">
            <LoaderCircle className="ul-files__spin" />
          </div>
        ) : null}
        {isLoading && !hasContent ? (
          <div className="ul-files__state">
            <LoaderCircle className="ul-files__spin" aria-hidden="true" /> Loading…
          </div>
        ) : null}
        {hasError ? <div className="ul-files__state">Files unavailable.</div> : null}
        {isEmpty ? (
          <div className="ul-files__state">
            <Folder aria-hidden="true" /> This folder is empty.
          </div>
        ) : null}
      </div>
      {cursor && !isLoading ? (
        <button className="ul-files__more" onClick={() => void load(cursor)} type="button">
          Load more
        </button>
      ) : null}
    </div>
  );
}
