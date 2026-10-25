import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@uploads/ui/components/ui/button";
import { Input } from "@uploads/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@uploads/ui/components/ui/select";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@uploads/ui/components/ui/empty";
import type { StagedMediaItem, StagedMediaPage } from "../../src/staged-media-response";
import {
  mediaPage,
  needsScope,
  safePreviewUrl,
  scopeFrom,
  scopeKey,
  scopePage,
  type Scope,
  type TrayClient,
} from "./client";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load staged media. Try again.";
}

function MediaCard({ item }: { item: StagedMediaItem }) {
  const [failed, setFailed] = useState(false);
  const preview = item.status === "available" ? safePreviewUrl(item.previewUrl) : null;
  const placeholder = failed
    ? "Preview unavailable"
    : item.status === "withheld"
      ? "Private or held for review"
      : item.status === "missing"
        ? "File unavailable"
        : "Preview unavailable";
  return (
    <article className="tray-card">
      <div className="tray-preview">
        {!failed && preview && item.mediaType === "image" ? (
          <img
            src={preview}
            alt={item.filename}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        ) : !failed && preview && item.mediaType === "video" ? (
          <video
            src={preview}
            controls
            preload="metadata"
            aria-label={item.filename}
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="tray-placeholder">{placeholder}</span>
        )}
      </div>
      <div className="tray-caption">
        <span className="tray-filename">{item.filename}</span>
        {(item.state || item.path) && (
          <div className="tray-meta">
            {item.state && <span>{item.state}</span>}
            {item.path && <span>{item.path}</span>}
          </div>
        )}
      </div>
    </article>
  );
}

export function Tray({ client }: { client: TrayClient }) {
  const [ready, setReady] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const scopeRef = useRef<Scope | null>(null);
  const generation = useRef(0);
  const hostRequest = useRef<number | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [manual, setManual] = useState(false);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeCursor, setScopeCursor] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopesLoading, setScopesLoading] = useState(false);
  const [page, setPage] = useState<StagedMediaPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function chooseScope(next: Scope) {
    generation.current++;
    scopeRef.current = next;
    setScope(next);
    setRepo(next.repo);
    setBranch(next.branch);
    setPage(null);
    setError(null);
    return generation.current;
  }
  function acceptPage(next: StagedMediaPage, append: boolean) {
    scopeRef.current = { repo: next.repo, branch: next.branch };
    setScope(scopeRef.current);
    setRepo(next.repo);
    setBranch(next.branch);
    setPage((previous) => {
      if (!append || !previous || scopeKey(previous) !== scopeKey(next)) return next;
      const items = new Map(previous.items.map((item) => [item.id, item]));
      for (const item of next.items) items.set(item.id, item);
      return { ...next, items: [...items.values()] };
    });
  }
  async function load(next: Scope, cursor?: string) {
    const sequence = cursor ? ++generation.current : chooseScope(next);
    setLoading(true);
    setError(null);
    try {
      const result = mediaPage(
        await client.callTool("list_staged_media", { ...next, ...(cursor ? { cursor } : {}) }),
      );
      if (sequence !== generation.current) return;
      if (scopeKey(result) !== scopeKey(next))
        throw new Error("The response did not match the selected repository and branch.");
      acceptPage(result, Boolean(cursor));
    } catch (failure) {
      if (sequence === generation.current) setError(errorMessage(failure));
    } finally {
      if (sequence === generation.current) setLoading(false);
    }
  }
  async function loadScopes(cursor?: string) {
    setScopesLoading(true);
    setScopeError(null);
    try {
      const result = scopePage(
        await client.callTool("list_staged_scopes", cursor ? { cursor } : {}),
      );
      setScopes((previous) => {
        const choices = new Map((cursor ? previous : []).map((entry) => [scopeKey(entry), entry]));
        for (const entry of result.scopes) choices.set(scopeKey(entry), entry);
        return [...choices.values()];
      });
      setScopeCursor(result.cursor);
    } catch (failure) {
      setScopeError(errorMessage(failure));
    } finally {
      setScopesLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    const unsubscribe = client.subscribe((event) => {
      if (!active) return;
      if (event.type === "input") {
        hostRequest.current = chooseScope(event.scope);
        setLoading(true);
        return;
      }
      if (hostRequest.current !== null && hostRequest.current !== generation.current) return;
      if (hostRequest.current === null && scopeRef.current) return;
      if (needsScope(event.result)) {
        hostRequest.current = null;
        setLoading(false);
        return;
      }
      try {
        const next = mediaPage(event.result);
        // A late result from an earlier scope must not replace the selected branch.
        if (scopeRef.current && scopeKey(scopeRef.current) !== scopeKey(next)) return;
        generation.current++;
        acceptPage(next, false);
        setError(null);
      } catch (failure) {
        setError(errorMessage(failure));
      }
      hostRequest.current = null;
      setLoading(false);
    });
    void client
      .connect()
      .then(() => {
        if (!active) return;
        setReady(true);
        void loadScopes();
      })
      .catch((failure) => {
        if (active) setConnectionError(errorMessage(failure));
      });
    return () => {
      active = false;
      generation.current++;
      unsubscribe();
    };
    // The client is stable for the lifetime of this panel. Request state uses refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const choices =
    scope && !scopes.some((entry) => scopeKey(entry) === scopeKey(scope))
      ? [scope, ...scopes]
      : scopes;
  const selected = scope ? scopeKey(scope) : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = scopeFrom({ repo, branch });
    if (next && ready) {
      setManual(false);
      void load(next);
    }
  }

  return (
    <main className="tray">
      <header className="tray-header">
        <div className="tray-title">
          <h1>Staged media</h1>
          {page && (
            <span className="tray-count">
              {page.items.length}
              {page.cursor ? "+" : ""} files
            </span>
          )}
        </div>
        <Button
          variant="outline"
          disabled={!ready || loading || scopesLoading}
          onClick={() => {
            void loadScopes();
            if (scope) void load(scope);
          }}
        >
          Refresh
        </Button>
      </header>
      <section className="tray-scope" aria-label="Repository and branch">
        {choices.length > 0 && (
          <div className="tray-scope-row">
            <label>
              Staged branches
              <Select
                value={selected}
                onValueChange={(value) => {
                  const next = choices.find((entry) => scopeKey(entry) === value);
                  if (next) {
                    setManual(false);
                    void load(next);
                  }
                }}
                disabled={!ready}
              >
                <SelectTrigger className="tray-scope-trigger" aria-label="Staged branch">
                  <SelectValue placeholder="Choose a repository and branch">
                    {scope ? `${scope.repo} · ${scope.branch}` : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {choices.map((entry) => (
                    <SelectItem
                      className="tray-scope-option"
                      key={scopeKey(entry)}
                      value={scopeKey(entry)}
                    >
                      {entry.repo} · {entry.branch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {scopeCursor && (
              <Button
                variant="outline"
                disabled={scopesLoading}
                onClick={() => void loadScopes(scopeCursor)}
              >
                More branches
              </Button>
            )}
          </div>
        )}
        {scopeCursor && choices.length === 0 && (
          <div>
            <Button
              variant="outline"
              disabled={scopesLoading}
              onClick={() => void loadScopes(scopeCursor)}
            >
              More branches
            </Button>
          </div>
        )}
        {scopesLoading && (
          <p className="tray-hint" role="status">
            Loading staged branches…
          </p>
        )}
        {scopeError && (
          <div className="tray-error" role="alert">
            {scopeError}{" "}
            <Button variant="link" disabled={scopesLoading} onClick={() => void loadScopes()}>
              Retry branch list
            </Button>
          </div>
        )}
        {manual || choices.length === 0 ? (
          <form className="tray-manual" onSubmit={submit}>
            <label htmlFor="repo">
              Repository
              <Input
                id="repo"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/repository"
                autoComplete="off"
                required
              />
            </label>
            <label htmlFor="branch">
              Branch
              <Input
                id="branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="branch-name"
                autoComplete="off"
                required
              />
            </label>
            <Button
              type="submit"
              variant="outline"
              disabled={!ready || !repo.trim() || !branch.trim()}
            >
              Show files
            </Button>
          </form>
        ) : (
          <div>
            <Button variant="link" className="h-auto p-0" onClick={() => setManual(true)}>
              Enter repository and branch
            </Button>
          </div>
        )}
      </section>
      {connectionError && (
        <div className="tray-error" role="alert">
          {connectionError}
        </div>
      )}
      {!ready && !connectionError && (
        <p className="tray-loading" role="status">
          Connecting to Uploads…
        </p>
      )}
      {scope && (
        <p className="tray-scope-label">
          {scope.repo} / {scope.branch}
        </p>
      )}
      {error && (
        <div className="tray-error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <p className="tray-loading" role="status">
          Loading staged media…
        </p>
      )}
      {page && page.items.length > 0 && (
        <section
          className="tray-grid"
          aria-label={`Staged files for ${page.repo}, ${page.branch}`}
          aria-busy={loading}
        >
          {page.items.map((item) => (
            <MediaCard key={`${scopeKey(page)}:${item.id}`} item={item} />
          ))}
        </section>
      )}
      {!loading && !error && ready && (!scope || (page && page.items.length === 0)) && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {scope
                ? page?.cursor
                  ? "No media on this page"
                  : "No staged media on this branch"
                : "Choose a repository and branch"}
            </EmptyTitle>
            {!scope && <EmptyDescription>Files from each branch stay separate.</EmptyDescription>}
          </EmptyHeader>
        </Empty>
      )}
      {page?.cursor && (
        <div className="tray-more">
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => {
              if (scope) void load(scope, page.cursor!);
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </main>
  );
}
