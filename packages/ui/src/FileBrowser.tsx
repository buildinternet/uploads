"use client";

import type { StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { ChevronRight, File, Folder, Home, LoaderCircle } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

export interface FileBrowserProps {
  files: UseFilesResult;
  initialPrefix?: string;
  delimiter?: string;
  onSelect?: (file: StoredFile) => void;
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
    requestGeneration.current++;
    setFolders([]);
    setItems([]);
    setCursor(undefined);
    setHasError(false);
    setIsLoading(true);
    setPrefix(nextPrefix);
  };
  const isEmpty = !(isLoading || hasError || folders.length || items.length);

  return (
    <div className="ul-files">
      <nav className="ul-files__crumbs" aria-label="Current folder">
        <button type="button" onClick={() => navigate("")} aria-label="File root">
          <Home />
        </button>
        {crumbsOf(prefix, delimiter).map((crumb) => (
          <Fragment key={crumb.prefix}>
            <ChevronRight className="ul-files__chevron" />
            <button type="button" onClick={() => navigate(crumb.prefix)}>
              {crumb.label}
            </button>
          </Fragment>
        ))}
      </nav>
      <ul className="ul-files__list">
        {folders.map((folder) => (
          <li key={folder}>
            <button className="ul-files__row" onClick={() => navigate(folder)} type="button">
              <span className="ul-files__icon">
                <Folder />
              </span>
              <span className="ul-files__name">{childName(folder, prefix, delimiter)}</span>
              <ChevronRight className="ul-files__chevron" />
            </button>
          </li>
        ))}
        {items.map((item) => (
          <li key={item.key}>
            <button
              className="ul-files__row"
              disabled={!onSelect}
              onClick={() => onSelect?.(item)}
              type="button"
            >
              <span className="ul-files__icon">
                <File />
              </span>
              <span className="ul-files__name">
                <span>{childName(item.key, prefix, delimiter) || item.key}</span>
                <small>
                  {formatBytes(item.size)} · {item.type || "unknown"}
                </small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {isLoading ? (
        <div className="ul-files__state">
          <LoaderCircle className="ul-files__spin" /> Loading…
        </div>
      ) : null}
      {hasError ? <div className="ul-files__state">Files unavailable.</div> : null}
      {isEmpty ? (
        <div className="ul-files__state">
          <Folder /> This folder is empty.
        </div>
      ) : null}
      {cursor && !isLoading ? (
        <button className="ul-files__more" onClick={() => void load(cursor)} type="button">
          Load more
        </button>
      ) : null}
    </div>
  );
}
