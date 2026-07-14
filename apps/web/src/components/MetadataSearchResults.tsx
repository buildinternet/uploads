import { Badge, Button, Callout } from "@uploads/ui";
import { useEffect, useState } from "react";
import { searchWorkspaceFiles, type SearchFileItem } from "../lib/api-client";
import type { MetaFilter } from "../lib/workspace-search-url";

interface MetadataSearchResultsProps {
  apiOrigin: string;
  workspace: string;
  filters: MetaFilter[];
  onRemoveFilter: (key: string) => void;
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; items: SearchFileItem[]; truncated: boolean };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const filename = (key: string) => key.split("/").filter(Boolean).pop() ?? key;

export function MetadataSearchResults({
  apiOrigin,
  workspace,
  filters,
  onRemoveFilter,
}: MetadataSearchResultsProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  // Re-fetch whenever the filter set changes. Serialize the filters into the
  // dependency so add/remove re-runs the search.
  const key = filters.map((f) => `${f.key}=${f.value}`).join("&");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void searchWorkspaceFiles(apiOrigin, workspace, filters).then((result) => {
      if (cancelled) return;
      setState(
        result.kind === "ok"
          ? { status: "ok", items: result.items, truncated: result.truncated }
          : { status: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOrigin, workspace, key]);

  const copyLink = async (url: string, button: HTMLButtonElement) => {
    try {
      await navigator.clipboard.writeText(url);
      const previous = button.textContent;
      button.textContent = "copied ✓";
      setTimeout(() => (button.textContent = previous), 1500);
    } catch {
      /* clipboard blocked — leave the label */
    }
  };

  return (
    <div className="ws-search-results">
      <div className="ws-search-chips">
        {filters.map((f) => (
          <Badge key={f.key}>
            {f.key}={f.value}
            <button
              type="button"
              className="ws-chip-remove"
              aria-label={`Remove filter ${f.key}`}
              onClick={() => onRemoveFilter(f.key)}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>

      {state.status === "loading" && <p className="ws-search-status">Searching…</p>}
      {state.status === "error" && (
        <Callout tone="error">Search is temporarily unavailable. Try again.</Callout>
      )}
      {state.status === "ok" && state.items.length === 0 && (
        <p className="ws-search-status">No files match these filters.</p>
      )}
      {state.status === "ok" && state.items.length > 0 && (
        <>
          {state.truncated && (
            <p className="ws-search-truncated">
              Showing the first 100 matches — add a filter to narrow.
            </p>
          )}
          <ul className="ws-search-list">
            {state.items.map((item) => (
              <li key={item.key} className="ws-search-row">
                <div className="ws-search-thumb">
                  {item.url && IMAGE_EXT.test(item.key) ? (
                    <img src={item.url} alt="" loading="lazy" />
                  ) : (
                    <span className="ws-search-glyph" aria-hidden="true">
                      ▢
                    </span>
                  )}
                </div>
                <div className="ws-search-body">
                  <span className="ws-search-name">{filename(item.key)}</span>
                  <span className="ws-search-meta">
                    {Object.entries(item.metadata).map(([k, v]) => (
                      <Badge key={k}>
                        {k}={v}
                      </Badge>
                    ))}
                  </span>
                </div>
                <div className="ws-search-actions">
                  {item.url && (
                    <>
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        Open ↗
                      </a>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={(e) => void copyLink(item.url as string, e.currentTarget)}
                      >
                        Copy link
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
