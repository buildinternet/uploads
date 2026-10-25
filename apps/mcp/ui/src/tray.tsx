import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@uploads/ui/components/ui/button";
import { Input } from "@uploads/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@uploads/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@uploads/ui/components/ui/select";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@uploads/ui/components/ui/empty";
import type {
  StagedMediaItem,
  StagedMediaPage,
  MediaContext,
  AttachedMediaPage,
} from "../../src/staged-media-response";
import {
  mediaPage,
  mediaContext,
  attachedPage,
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

function ImagePreview({
  item,
  src,
  onError,
}: {
  item: StagedMediaItem;
  src: string;
  onError: () => void;
}) {
  const [actualSize, setActualSize] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) {
          setActualSize(false);
          setFailed(false);
        }
      }}
    >
      <DialogTrigger className="tray-image-button" aria-label={`Enlarge ${item.filename}`}>
        <img
          src={src}
          alt={item.filename}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={onError}
        />
      </DialogTrigger>
      <DialogContent className="tray-image-dialog">
        <DialogTitle className="tray-image-title">{item.filename}</DialogTitle>
        <DialogDescription className="sr-only">
          Image preview. Choose Actual size to inspect details, then scroll to move around the
          image.
        </DialogDescription>
        <div>
          <Button variant="outline" onClick={() => setActualSize((value) => !value)}>
            {actualSize ? "Fit to panel" : "Actual size"}
          </Button>
        </div>
        <div
          className={`tray-image-view${actualSize ? " tray-image-view-actual" : ""}`}
          role="region"
          aria-label="Image preview"
          tabIndex={0}
        >
          {failed ? (
            <p role="status">Preview unavailable</p>
          ) : (
            <img
              src={src}
              alt={item.filename}
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
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
          <ImagePreview item={item} src={preview} onError={() => setFailed(true)} />
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

function mergePage<T extends StagedMediaPage>(previous: T | null, next: T, append: boolean): T {
  if (!append || !previous || scopeKey(previous) !== scopeKey(next)) return next;
  const items = new Map(previous.items.map((item) => [item.id, item]));
  for (const item of next.items) items.set(item.id, item);
  return { ...next, items: [...items.values()] };
}

function MediaSection({
  title,
  page,
  loading,
  error,
  empty,
  onMore,
}: {
  title: string;
  page: StagedMediaPage | null;
  loading: boolean;
  error: string | null;
  empty: string;
  onMore: () => void;
}) {
  return (
    <section className="tray-section" aria-label={title} aria-busy={loading}>
      <div className="tray-section-title">
        <h2>{title}</h2>
        {page && (
          <span className="tray-count">
            {page.items.length}
            {page.cursor ? "+" : ""} files
          </span>
        )}
      </div>
      {error && (
        <div className="tray-error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <p className="tray-loading" role="status">
          Loading {title.toLowerCase()} files…
        </p>
      )}
      {page && page.items.length > 0 && (
        <div className="tray-grid">
          {page.items.map((item) => (
            <MediaCard key={`${title}:${scopeKey(page)}:${item.id}`} item={item} />
          ))}
        </div>
      )}
      {!loading && !error && page?.items.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{page.cursor ? "No files on this page" : empty}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {page?.cursor && (
        <div className="tray-more">
          <Button variant="outline" disabled={loading} onClick={onMore}>
            Load more {title.toLowerCase()}
          </Button>
        </div>
      )}
    </section>
  );
}

export function Tray({ client }: { client: TrayClient }) {
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const scopeRef = useRef<Scope | null>(null);
  const generation = useRef(0);
  const stagedRequest = useRef(0);
  const attachedRequest = useRef(0);
  const hostRequest = useRef<number | null>(null);
  const pendingHostContext = useRef<MediaContext | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [pr, setPr] = useState("");
  const [manual, setManual] = useState(false);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [scopeCursor, setScopeCursor] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopesLoading, setScopesLoading] = useState(false);
  const [page, setPage] = useState<StagedMediaPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<MediaContext | null>(null);
  const [attached, setAttached] = useState<AttachedMediaPage | null>(null);
  const [attachedLoading, setAttachedLoading] = useState(false);
  const [attachedError, setAttachedError] = useState<string | null>(null);

  function chooseScope(next: Scope) {
    generation.current++;
    scopeRef.current = next;
    setScope(next);
    setRepo(next.repo);
    setBranch(next.branch);
    setPr(next.pr ? String(next.pr) : "");
    setPage(null);
    setError(null);
    setContext(null);
    setAttached(null);
    setAttachedError(null);
    setAttachedLoading(false);
    pendingHostContext.current = null;
    return generation.current;
  }
  function acceptPage(next: StagedMediaPage, append: boolean) {
    // Storage tags are lowercase, but GitHub resolves the original case-sensitive branch.
    const selected =
      scopeRef.current && scopeKey(scopeRef.current) === scopeKey(next)
        ? scopeRef.current
        : { repo: next.repo, branch: next.branch };
    scopeRef.current = selected;
    setScope(selected);
    setRepo(selected.repo);
    setBranch(selected.branch);
    setPage((previous) => mergePage(previous, next, append));
  }
  async function loadAttached(next: MediaContext, sequence: number, cursor?: string) {
    if (next.pr === null) return;
    const request = ++attachedRequest.current;
    setAttachedLoading(true);
    setAttachedError(null);
    try {
      const result = attachedPage(
        await client.callTool("list_attached_media", {
          repo: next.repo,
          branch: next.branch,
          pr: next.pr,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (sequence !== generation.current || request !== attachedRequest.current) return;
      if (scopeKey(result) !== scopeKey(next) || result.pr !== next.pr)
        throw new Error("The response did not match the selected pull request.");
      setAttached((previous) => mergePage(previous, result, Boolean(cursor)));
    } catch (failure) {
      if (sequence === generation.current && request === attachedRequest.current)
        setAttachedError(errorMessage(failure));
    } finally {
      if (sequence === generation.current && request === attachedRequest.current)
        setAttachedLoading(false);
    }
  }
  async function loadContext(next: Scope, sequence: number) {
    setAttachedLoading(true);
    setAttachedError(null);
    try {
      const result = mediaContext(await client.callTool("resolve_media_context", { ...next }));
      if (sequence !== generation.current) return;
      if (scopeKey(result) !== scopeKey(next) || (next.pr !== undefined && result.pr !== next.pr))
        throw new Error("The response did not match the selected repository, branch, and PR.");
      setContext(result);
      if (result.pr === null) setAttachedLoading(false);
      else await loadAttached(result, sequence);
    } catch (failure) {
      if (sequence === generation.current) {
        setAttachedError(errorMessage(failure));
        setAttachedLoading(false);
      }
    }
  }
  async function load(next: Scope, cursor?: string) {
    const sequence = cursor ? generation.current : chooseScope(next);
    const request = ++stagedRequest.current;
    setLoading(true);
    setError(null);
    if (!cursor) void loadContext(next, sequence);
    try {
      const result = mediaPage(
        await client.callTool("list_staged_media", {
          repo: next.repo,
          branch: next.branch,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (sequence !== generation.current || request !== stagedRequest.current) return;
      if (scopeKey(result) !== scopeKey(next))
        throw new Error("The response did not match the selected repository and branch.");
      acceptPage(result, Boolean(cursor));
    } catch (failure) {
      if (sequence === generation.current && request === stagedRequest.current)
        setError(errorMessage(failure));
    } finally {
      if (sequence === generation.current && request === stagedRequest.current) setLoading(false);
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
        if (scopeRef.current && scopeKey(scopeRef.current) !== scopeKey(next)) return;
        // The opener already resolved the PR using the original Git branch spelling.
        // Keep that context rather than repeating its GitHub lookup with normalized tags.
        const resolved =
          event.result.structuredContent &&
          typeof event.result.structuredContent === "object" &&
          "prResolution" in event.result.structuredContent
            ? mediaContext(event.result)
            : null;
        // A late opener result for a different PR must not invalidate the current request.
        if (scopeRef.current?.pr !== undefined && resolved?.pr !== scopeRef.current.pr) return;
        generation.current++;
        acceptPage(next, false);
        setError(null);
        if (resolved) {
          setContext(resolved);
          if (readyRef.current) void loadAttached(resolved, generation.current);
          else pendingHostContext.current = resolved;
        } else if (readyRef.current) void loadContext(scopeRef.current!, generation.current);
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
        readyRef.current = true;
        setReady(true);
        void loadScopes();
        if (pendingHostContext.current) {
          void loadAttached(pendingHostContext.current, generation.current);
          pendingHostContext.current = null;
        } else if (scopeRef.current) void loadContext(scopeRef.current, generation.current);
      })
      .catch((failure) => {
        if (active) setConnectionError(errorMessage(failure));
      });
    return () => {
      active = false;
      readyRef.current = false;
      generation.current++;
      unsubscribe();
    };
    // The client is stable for the lifetime of the panel; requests use refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const choices =
    scope && !scopes.some((entry) => scopeKey(entry) === scopeKey(scope))
      ? [scope, ...scopes]
      : scopes;
  const selected = scope ? scopeKey(scope) : null;
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = scopeFrom({ repo, branch, ...(pr ? { pr: Number(pr) } : {}) });
    if (next && ready) {
      setManual(false);
      void load(next);
    }
  }

  return (
    <main className="tray">
      <header className="tray-header">
        <div className="tray-title">
          <h1>Files</h1>
        </div>
        <Button
          variant="outline"
          disabled={!ready || loading || attachedLoading || scopesLoading}
          onClick={() => {
            void loadScopes();
            if (scope) void load(scope);
          }}
        >
          Refresh
        </Button>
      </header>
      <section className="tray-scope" aria-label="Repository and branch">
        {(choices.length > 0 || scopeCursor) && (
          <div className="tray-scope-row">
            {choices.length > 0 && (
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
            )}
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
            <label htmlFor="pr">
              Pull request (optional)
              <Input
                id="pr"
                type="number"
                min="1"
                step="1"
                value={pr}
                onChange={(event) => setPr(event.target.value)}
                placeholder="PR number"
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
      {scope && (
        <>
          <MediaSection
            title="Staged"
            page={page}
            loading={loading}
            error={error}
            empty="No staged files on this branch"
            onMore={() => {
              if (page?.cursor) void load(scope, page.cursor);
            }}
          />
          <MediaSection
            title={context?.pr ? `Attached · #${context.pr}` : "Attached"}
            page={attached}
            loading={attachedLoading}
            error={attachedError}
            empty="No files attached to this PR"
            onMore={() => {
              if (context && attached?.cursor)
                void loadAttached(context, generation.current, attached.cursor);
            }}
          />
          {context?.pr === null && !attachedLoading && !attachedError && (
            <div className="tray-hint">
              Choose a pull request to see attached files.{" "}
              <Button variant="link" onClick={() => setManual(true)}>
                Enter PR number
              </Button>
            </div>
          )}
        </>
      )}
      {!scope && ready && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Choose a repository and branch</EmptyTitle>
            <EmptyDescription>
              Staged and attached files stay scoped to your selection.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </main>
  );
}
