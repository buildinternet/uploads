import {
  createUploadsClient as createSdkClient,
  fetchJson,
  parseErrorEnvelope,
  type GithubCommentResult,
  type HeadResult,
  type ListItem,
  type ListOptions,
  type ListResult,
  type RetryInfo,
  type TokenScope,
} from "@buildinternet/uploads-sdk";
import { inferContentType } from "./embed.js";
import type { UploadsClientConfig } from "./config.js";
import { UsageError } from "./cli-args.js";
import { UploadsError } from "./errors.js";
import { buildScreenshotKey } from "./keys.js";
import { packageVersion } from "./package-version.js";
import { resolveEmbedUrl } from "./public-urls.js";

// The public API types and error helpers live in the SDK; re-exported so
// existing `./client.js` imports keep working.
export {
  extractErrorFields,
  parseErrorEnvelope,
  scopeRemedy,
  FIND_FILES_MAX_PAGES,
} from "@buildinternet/uploads-sdk";
export type {
  AddGalleryItemOptions,
  ApproveResult,
  CreateFeedOptions,
  CreateGalleryOptions,
  DeleteGalleryOptions,
  DeleteResult,
  Feed,
  FeedItem,
  FeedListOptions,
  FeedListResult,
  FeedSummary,
  FindFilesItem,
  FindFilesOptions,
  FindFilesResult,
  FindGalleriesByReferenceOptions,
  Gallery,
  GalleryExternalReference,
  GalleryExternalReferenceListResult,
  GalleryItem,
  GalleryListOptions,
  GalleryListResult,
  GallerySummary,
  GetMetadataResult,
  GithubCommentDeclineReason,
  GithubCommentResult,
  HeadResult,
  HealthResult,
  HeldFile,
  LinkGalleryExternalReferenceOptions,
  ListItem,
  ListOptions,
  ListResult,
  MetadataKeysResult,
  MetadataValuesResult,
  PatchMetadataOptions,
  PurgeExpiredResponse,
  PurgeExpiredResult,
  ReconcileResult,
  TokenScope,
  UnlinkGalleryExternalReferenceOptions,
  UsageResult,
} from "@buildinternet/uploads-sdk";

/** Allowlisted object provenance (maps to X-Uploads-Meta-* on put). */
export type ProvenanceInput = {
  client?: string;
  "client-version"?: string;
  "source-name"?: string;
  optimized?: "0" | "1";
  frame?: string;
  "keep-exif"?: "0" | "1";
};

export interface PutOptions {
  key?: string;
  contentType?: string;
  prefix?: string;
  repo?: string;
  ref?: string;
  deriveRepoFromGit?: boolean;
  /** Stored as R2 custom metadata; echoed on put/head. */
  provenance?: ProvenanceInput;
  /**
   * Queryable metadata (D1), sent as more `X-Uploads-Meta-<key>` headers; the
   * server routes each key to R2 provenance or D1 by name. Validate with
   * `metadata.ts` first.
   */
  metadata?: Record<string, string>;
  /** Validate key + resolve public URL without writing. `size` is local bytes only. */
  dryRun?: boolean;
  /**
   * Overwrite an existing object on a strict (non-`gh/`) key. Without it such
   * a put throws `UploadsError` `KEY_EXISTS`. Managed `gh/` paths always
   * hot-swap.
   */
  replace?: boolean;
  /** Reuse to safely retry the same upload. Not generated; omit and no header is sent. */
  idempotencyKey?: string;
}

export interface PutResult {
  workspace: string;
  key: string;
  url: string;
  /** Same object on the embed host when dual-host applies; prefer for GitHub markdown. */
  embedUrl: string | null;
  size: number;
  contentType: string;
  /**
   * `pending` when the classifier may still hold this file for review. It
   * decides after the response; `uploads approve --pr <n>` lists holds.
   */
  holdCheck?: "pending";
  /**
   * True when the put overwrote an existing key, or (with dryRun) when a put
   * at this key would overwrite. Always set by the API for put/dry-run.
   */
  replaced?: boolean;
  /**
   * dryRun only: true when a real put at this key would be refused (strict
   * non-`gh/` key, existing object, no `replace`) instead of overwriting.
   */
  wouldRefuse?: boolean;
  /**
   * The R2 provenance bag (`client`, `source-name`, `content-sha256`). Absent
   * on a dry run and on older APIs.
   */
  provenance?: Record<string, string>;
  /**
   * The queryable metadata this put stored, including server-derived pairs
   * (`gh.uploader`). Absent when the put carried no metadata, since existing
   * tags were left untouched. Older APIs return the provenance bag here
   * instead, so read `path`-style tags defensively.
   */
  metadata?: Record<string, string>;
}

/** `POST /v1/workspaces/:workspace/github/private-prefix` request. */
export interface ResolveGhPrefixOptions {
  repo: string;
  branch?: string;
  target?: { kind: "pull" | "issues"; num: number };
}

/** `POST /v1/workspaces/:workspace/github/private-prefix` response. */
export type ResolveGhPrefixResult =
  | { mode: "plain" }
  | {
      mode: "private";
      prefixId: string;
      /**
       * Ids the caller may list: with a target, those that can hold it; with
       * only a branch, that branch's (a private staged key has no branch
       * segment). Older workers may return every active id in the repo.
       */
      activePrefixIds?: string[];
      /**
       * This branch's ids (active, then retired), on a branch resolve with no
       * target. Prefer it for `uploads staged`.
       */
      branchPrefixIds?: string[];
    };

/** `POST /v1/workspaces/:workspace/github/private-prefix/rotate` request. */
export interface RotateGhPrefixOptions {
  repo: string;
  /** Mutually exclusive with `repoLevel`: rotate one branch's id. */
  branch?: string;
  /** Mutually exclusive with `branch`: rotate the repo-level id shared by
   * issue attachments and ingested assets. */
  repoLevel?: boolean;
}

/** `POST /v1/workspaces/:workspace/github/private-prefix/rotate` response. */
export type RotateGhPrefixResult =
  | { rotated: false; reason: string }
  | { rotated: true; prefixId: string; moved: number };

/** `POST /v1/workspaces/:workspace/github/promote` request/response. */
export interface PromoteBranchAttachmentsOptions {
  repo: string;
  num: number;
  branch: string;
}

export interface PromoteSkip {
  key: string;
  reason: string;
}

export interface PromoteBranchAttachmentsResult {
  promoted: string[];
  skipped: PromoteSkip[];
  /** Branch names the sweep covered, current first. Only when the branch was renamed. */
  lineage?: string[];
}

/** `POST /v1/workspaces/:workspace/github/branch-rename` request. */
export interface RegisterBranchRenameOptions {
  repo: string;
  /** Previous branch name (`git branch -m <from> <to>`). */
  from: string;
  /** Name the branch was renamed to. */
  to: string;
}

/** `POST /v1/workspaces/:workspace/github/branch-rename` response. `recorded:
 * false` means the pair was already known (or the server has no such route). */
export interface RegisterBranchRenameResult {
  recorded: boolean;
}

/**
 * `POST /v1/workspaces/:workspace/github/attach`. `source` is an object key
 * or uploads.sh URL. Exactly one of `pr`/`issue`. Copies by default;
 * `move: true` deletes the source after.
 */
export interface AttachExistingOptions {
  source: string;
  repo: string;
  pr?: number;
  issue?: number;
  move?: boolean;
  filename?: string;
}

export interface AttachExistingResult {
  key: string;
  url: string | null;
  embedUrl: string | null;
  pageUrl?: string;
  moved: boolean;
  source: { key: string };
  comment: GithubCommentResult;
}

/** `GET`/`POST /v1/workspaces/:workspace/github/link` result. */
export interface GithubLinkResult {
  repo: string;
  linked: boolean;
  workspace: string | null;
  source: string | null;
  createdAt: string | null;
}

/** POST only: whether this call's workspace owns the binding. */
export interface GithubLinkClaimResult extends GithubLinkResult {
  claimed: boolean;
  /**
   * Set when the repo is unbound but this workspace couldn't be verified as
   * entitled to claim it. "Owned elsewhere" reports `workspace` instead.
   */
  reason?: "not_authorized";
}

/** `DELETE /v1/workspaces/:workspace/github/link` result. */
export interface GithubLinkUnlinkResult {
  repo: string;
  unlinked: boolean;
  reason?: "not_linked";
}

/**
 * `GET /v1/workspaces/:workspace/github/repo-link` result. Never names
 * another workspace; "self"/"other"/"none" avoids leaking cross-tenant info.
 */
export interface GithubRepoLinkResult {
  binding: "self" | "other" | "none";
}

/**
 * `POST /v1/workspaces/:workspace/github/ingest` result. `repo` comes back
 * lowercased.
 */
export interface IngestGithubResult {
  repo: string;
  kind: "pull" | "issues";
  num: number;
  /** Object keys newly mirrored into the workspace this call. */
  ingested: string[];
  /** Object keys whose previously-detached ledger row was un-detached. */
  reattached: string[];
  /** Object keys detached because they're no longer referenced. */
  detached: string[];
  /** Attachment URLs skipped, with the reason. */
  skipped: { url: string; reason: string }[];
}

/** `GET /v1/workspaces/:workspace/github/health` result. */
export interface GithubHealthResult {
  configured: boolean;
  ok: boolean;
  events: string[] | null;
  missingEvents: string[];
  requiredEvents: string[];
  /** Recommended but non-gating events, e.g. `issue_comment`. Missing on older servers. */
  recommendedEvents?: string[];
  missingRecommendedEvents?: string[];
  hint?: string;
}

export interface EnrollmentExchangeResult {
  apiUrl?: string;
  workspace: string;
  token: string;
  scopes?: Array<TokenScope>;
  expiresAt?: string;
}

export interface EnrollmentCreateResult {
  pageId: string;
  code: string;
  expiresAt: string;
  tokenExpiresAt: string;
  // Present only when an --email recipient was requested: whether delivery succeeded.
  emailed?: boolean;
}

/** One-line stderr notice so a hook/CI log explains the SDK's one retry. */
function printRetryNotice({ reason, delayMs }: RetryInfo): void {
  const seconds = delayMs % 1000 === 0 ? `${delayMs / 1000}s` : `${Math.round(delayMs) / 1000}s`;
  process.stderr.write(`warning: uploads.sh ${reason}, retrying in ${seconds}…\n`);
}

function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  return fetchJson<T>(url, init, { onRetry: printRetryNotice });
}

/**
 * Fails a remembered expired token locally instead of sending it again, and
 * remembers one the API reports expired (`expired-tokens.ts`).
 */
function expiredTokenFetch(token: string, store: ExpiredTokenStore): typeof fetch {
  return async (input, init) => {
    const sendsToken = new Headers(init?.headers).has("Authorization");
    const expired = sendsToken ? store.lookup(token) : undefined;
    if (expired) {
      return Response.json({ error: { code: "token_expired", message: expired } }, { status: 401 });
    }
    const res = await fetch(input, init);
    if (sendsToken && res.status === 401) {
      const { message, code } = await parseErrorEnvelope(
        res.clone(),
        res.statusText || "request failed",
      );
      if (code === "token_expired") store.remember(token, message);
    }
    return res;
  };
}

export function exchangeEnrollment(
  apiUrl: string,
  code: string,
): Promise<EnrollmentExchangeResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/auth/enrollments/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

export function createEnrollment(
  apiUrl: string,
  adminToken: string,
  input: {
    workspace?: string;
    label?: string;
    email?: string;
    enrollmentSeconds?: number;
    tokenExpiresInSeconds?: number;
    scopes?: Array<TokenScope>;
  },
): Promise<EnrollmentCreateResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/admin/enrollments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// --- Device authorization (RFC 8628), for `uploads login` ---
//
// Plain `fetch` against the auth worker (no better-auth client dependency in
// the published package). Its device endpoints take JSON bodies, not the
// RFC's form encoding.

/**
 * OAuth client id for the device flow, a seeded `oauth_client` row (public
 * PKCE, device-code grant only) that operators can disable from
 * /admin/oauth. Must match the seeded client_id.
 */
export const DEVICE_CLIENT_ID = "uploads-cli";

/**
 * User-Agent for CLI requests. Stored on the session at `/device/token` so
 * the account UI can recognize a CLI login; the API records the client
 * version per credential (`mcp` purpose = stdio MCP). Keep the
 * `@buildinternet/uploads` prefix in sync with apps/web `CLI_USER_AGENT_RE`
 * and apps/api `CLI_UA_RE`.
 */
export function cliUserAgent(purpose = "device-login"): string {
  return `@buildinternet/uploads/${packageVersion()} (${purpose})`;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** POST /api/auth/device/code — start a device flow. Throws on a non-2xx. */
export function requestDeviceCode(
  authUrl: string,
  clientId = DEVICE_CLIENT_ID,
  /**
   * RFC 8628 `scope`: the requested workspace (`workspace:<slug>`, plus
   * `create`), validated by the approval page and echoed back (possibly
   * rewritten) at token exchange.
   */
  scope?: string,
): Promise<DeviceCodeResponse> {
  return jsonRequest(`${authUrl.replace(/\/$/, "")}/api/auth/device/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": cliUserAgent("device-code"),
    },
    body: JSON.stringify({ client_id: clientId, ...(scope ? { scope } : {}) }),
  });
}

/**
 * One poll of POST /api/auth/device/token. `authorization_pending` and
 * `slow_down` are expected 400s, so this returns a result instead of throwing.
 */
export type DeviceTokenResult =
  | { status: "ok"; accessToken: string; tokenType: string; expiresIn: number; scope: string }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; error: string; description?: string };

export async function requestDeviceToken(
  authUrl: string,
  input: { deviceCode: string; clientId?: string },
): Promise<DeviceTokenResult> {
  let res: Response;
  try {
    res = await fetch(`${authUrl.replace(/\/$/, "")}/api/auth/device/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The session's user_agent comes from this request.
        "User-Agent": cliUserAgent("device-token"),
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: input.deviceCode,
        client_id: input.clientId ?? DEVICE_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw new UploadsError(
      err instanceof Error ? err.message : "network request failed",
      "NETWORK",
    );
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (res.ok && body?.access_token) {
    return {
      status: "ok",
      accessToken: body.access_token,
      tokenType: body.token_type ?? "Bearer",
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : 0,
      scope: body.scope ?? "",
    };
  }
  switch (body?.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      return {
        status: "error",
        error: body?.error ?? "unknown",
        description: body?.error_description,
      };
  }
}

export interface MintWorkspaceSummary {
  workspace: string;
  role: string;
}

/** GET /v1/tokens — workspaces the signed-in user can mint tokens for. */
export function listMintWorkspaces(
  apiUrl: string,
  accessToken: string,
): Promise<{ workspaces: MintWorkspaceSummary[]; suggestedWorkspace?: string }> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/v1/tokens`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export interface CreateWorkspaceResult {
  name: string;
  publicBaseUrl: string;
  selfServe: boolean;
}

/**
 * POST /v1/workspaces from a device-flow session bearer. Throws `UsageError`:
 * a linked-GitHub requirement gets an actionable pointer, anything else the
 * server's message.
 */
export async function createWorkspaceRequest(
  apiUrl: string,
  accessToken: string,
  name: string,
): Promise<CreateWorkspaceResult> {
  try {
    const { workspace } = await jsonRequest<{ workspace: CreateWorkspaceResult }>(
      `${apiUrl.replace(/\/$/, "")}/v1/workspaces`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      },
    );
    return workspace;
  } catch (err) {
    if (err instanceof UploadsError && err.code === "GITHUB_REQUIRED") {
      throw new UsageError(
        "creating a workspace requires a linked GitHub account — connect one at https://uploads.sh/account/profile and re-run `uploads login`",
      );
    }
    throw new UsageError(err instanceof Error ? err.message : "workspace creation failed");
  }
}

export interface MintTokenResult {
  token: string;
  workspace: string;
  scopes: Array<TokenScope>;
  label: string | null;
  expiresAt: string | null;
}

/**
 * POST /me/workspaces/:name/invites. Needs a session bearer (device flow) and
 * org admin/owner. `acceptUrl` is always returned for installs without email.
 */
export function createWorkspaceInvite(
  apiUrl: string,
  accessToken: string,
  workspace: string,
  input: { email: string; role?: "member" | "admin" },
): Promise<{
  invitation: { id: string; email: string; role: string; status: string };
  acceptUrl?: string;
  /** Whether the install can send invite emails; absent on older auth workers. */
  emailConfigured?: boolean;
}> {
  return jsonRequest(
    `${apiUrl.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/invites`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: input.email, role: input.role ?? "member" }),
    },
  );
}

/** POST /v1/tokens: mint an `up_<workspace>_…` token from a device-flow session bearer. */
export function mintWorkspaceToken(
  apiUrl: string,
  accessToken: string,
  input: {
    workspace: string;
    scopes?: Array<TokenScope>;
    label?: string;
    ttlSeconds?: number | null;
    /**
     * Reusing it within 24h replays the original response, including the
     * one-time token. A changed request with the same key returns 409.
     */
    idempotencyKey?: string;
  },
): Promise<MintTokenResult> {
  return jsonRequest(`${apiUrl.replace(/\/$/, "")}/v1/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      grants: [{ workspace: input.workspace, ...(input.scopes ? { scopes: input.scopes } : {}) }],
      ...(input.label ? { label: input.label } : {}),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
  });
}

export interface UploadsClientOptions {
  /** Which surface is calling (User-Agent comment): `mcp` for `uploads mcp`, else `cli`. */
  surface?: "cli" | "mcp";
  /**
   * Tokens the API has reported expired, so a remembered one fails locally
   * instead of being sent again (`expired-tokens.ts`).
   */
  expiredTokens?: ExpiredTokenStore;
  /** Called with the token's expiry (ISO) when the API reports one. */
  onTokenExpiry?: (expiresAt: string) => void;
}

export interface ExpiredTokenStore {
  /** The server's expiry message for this token, or undefined if not known expired. */
  lookup(token: string): string | undefined;
  remember(token: string, message: string): void;
}

export function createUploadsClient(
  config: UploadsClientConfig,
  clientOpts: UploadsClientOptions = {},
) {
  const sdk = createSdkClient(config, {
    userAgent: cliUserAgent(clientOpts.surface ?? "cli"),
    fetch: clientOpts.expiredTokens
      ? expiredTokenFetch(config.token, clientOpts.expiredTokens)
      : undefined,
    onRetry: printRetryNotice,
    onTokenExpiry: clientOpts.onTokenExpiry,
  });

  // The SDK returns the API's embed URL as is; the CLI also derives one
  // (including the env override) when an older API omits it.
  async function list(opts: ListOptions = {}): Promise<ListResult> {
    const page = await sdk.list(opts);
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        embedUrl: resolveEmbedUrl(item.url, item.embedUrl),
      })),
    };
  }

  // Per-process cache for resolveGhPrefix, keyed by repo+branch+target.
  const resolveGhPrefixCache = new Map<string, ResolveGhPrefixResult>();

  return {
    ...sdk,

    async put(body: Uint8Array, opts: PutOptions & { filename: string }): Promise<PutResult> {
      const key =
        opts.key ??
        (await buildScreenshotKey({
          filename: opts.filename,
          fileBytes: body,
          prefix: opts.prefix,
          repo: opts.repo,
          ref: opts.ref,
          deriveRepoFromGit: opts.deriveRepoFromGit,
        }));
      const contentType = opts.contentType ?? inferContentType(opts.filename);

      if (opts.dryRun) {
        const preview = await sdk.previewPut(key, { replace: opts.replace });
        if (preview.url == null) {
          throw new UploadsError(
            "workspace has no publicBaseUrl (cannot resolve a public URL)",
            "NO_PUBLIC_URL",
          );
        }
        return {
          workspace: preview.workspace,
          key: preview.key,
          url: preview.url,
          embedUrl: resolveEmbedUrl(preview.url, preview.embedUrl),
          size: body.byteLength,
          contentType,
          replaced: preview.replaced === true,
          wouldRefuse: preview.wouldRefuse === true,
        };
      }

      // The server splits provenance keys (R2) from the rest (D1) by name.
      const result = await sdk.put(key, body, {
        contentType,
        replace: opts.replace,
        idempotencyKey: opts.idempotencyKey,
        metadata: { ...opts.provenance, ...opts.metadata },
      });
      if (result.url == null) {
        throw new UploadsError(
          "upload succeeded but workspace has no publicBaseUrl",
          "NO_PUBLIC_URL",
          201,
        );
      }
      return {
        ...result,
        url: result.url,
        embedUrl: resolveEmbedUrl(result.url, result.embedUrl),
      };
    },

    list,

    /** Follow cursors (optionally starting from one) and return every remaining item. */
    async listAll(
      opts: Omit<ListOptions, "cursor"> & { cursor?: string } = {},
    ): Promise<ListItem[]> {
      const items: ListItem[] = [];
      let cursor: string | undefined = opts.cursor;
      do {
        const page = await list({ ...opts, cursor });
        items.push(...page.items);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      return items;
    },

    async head(key: string): Promise<HeadResult> {
      const result = await sdk.head(key);
      return { ...result, embedUrl: resolveEmbedUrl(result.url, result.embedUrl) };
    },

    /**
     * Resolve the GitHub-key mode (plain or private prefix) for `repo`.
     * Fail-open: any failure resolves to `{ mode: "plain" }` silently. Cached
     * per process by repo+branch+target.
     */
    async resolveGhPrefix(opts: ResolveGhPrefixOptions): Promise<ResolveGhPrefixResult> {
      const cacheKey = JSON.stringify([
        opts.repo.toLowerCase(),
        opts.branch ?? "",
        opts.target ?? null,
      ]);
      const cached = resolveGhPrefixCache.get(cacheKey);
      if (cached) return cached;

      const resolved = await (async (): Promise<ResolveGhPrefixResult> => {
        try {
          return await sdk.request<ResolveGhPrefixResult>(
            "POST",
            `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/private-prefix`,
            {
              body: new TextEncoder().encode(JSON.stringify(opts)),
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch {
          return { mode: "plain" };
        }
      })();
      resolveGhPrefixCache.set(cacheKey, resolved);
      return resolved;
    },

    /**
     * Rotate the private attachment prefix for a branch or the repo level.
     * Not fail-open: an explicit action, so any failure throws.
     */
    async rotateGhPrefix(opts: RotateGhPrefixOptions): Promise<RotateGhPrefixResult> {
      return sdk.request<RotateGhPrefixResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/private-prefix/rotate`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * Promote branch-staged attachments into a PR's prefix. Callers treat any
     * failure, including a 404 from an older worker, as nothing promoted.
     */
    async promoteBranchAttachments(
      opts: PromoteBranchAttachmentsOptions,
    ): Promise<PromoteBranchAttachmentsResult> {
      return sdk.request<PromoteBranchAttachmentsResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/promote`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * Record one `git branch -m` step so promote sweeps the old names too. A
     * 404 (older worker) returns `{ recorded: false }`; other failures throw.
     */
    async registerBranchRename(
      opts: RegisterBranchRenameOptions,
    ): Promise<RegisterBranchRenameResult> {
      try {
        return await sdk.request<RegisterBranchRenameResult>(
          "POST",
          `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/branch-rename`,
          {
            body: new TextEncoder().encode(JSON.stringify(opts)),
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (err) {
        if (err instanceof UploadsError && err.status === 404) return { recorded: false };
        throw err;
      }
    },

    /**
     * Attach an already-uploaded object to a PR/issue by server-side copy.
     * Throws on any failure: this is the only way to move the object, so
     * failures must be visible.
     */
    async attachExisting(opts: AttachExistingOptions): Promise<AttachExistingResult> {
      return sdk.request<AttachExistingResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/attach`,
        {
          body: new TextEncoder().encode(JSON.stringify(opts)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /** Current binding for `repo`, or `{ linked: false }`. A 404 means an
     * older server without bindings. */
    async githubLinkStatus(repo: string): Promise<GithubLinkResult> {
      return sdk.request<GithubLinkResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/link?repo=${encodeURIComponent(repo)}`,
      );
    },

    /**
     * Claim `repo` for this workspace (first claim wins). `claimed: false`
     * means another workspace owns it; never steals.
     */
    async githubLinkClaim(repo: string): Promise<GithubLinkClaimResult> {
      return sdk.request<GithubLinkClaimResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/link`,
        {
          body: new TextEncoder().encode(JSON.stringify({ repo })),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * Tri-state binding status for `repo`; never names another workspace.
     * Callers treat any failure as "stay silent".
     */
    async githubRepoLinkStatus(repo: string): Promise<GithubRepoLinkResult> {
      return sdk.request<GithubRepoLinkResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/repo-link?repo=${encodeURIComponent(repo)}`,
      );
    },

    /**
     * `POST /v1/workspaces/:workspace/github/ingest`: mirror a PR/issue's
     * `github.com/user-attachments` media and public Cursor artifact URLs
     * into the workspace.
     */
    async ingestGithub(input: {
      repo: string;
      kind: "pull" | "issues";
      num: number;
    }): Promise<IngestGithubResult> {
      const body =
        input.kind === "pull"
          ? { repo: input.repo, pr: input.num }
          : { repo: input.repo, issue: input.num };
      return sdk.request<IngestGithubResult>(
        "POST",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/ingest`,
        {
          body: new TextEncoder().encode(JSON.stringify(body)),
          headers: { "Content-Type": "application/json" },
        },
      );
    },

    /**
     * GitHub App configuration and webhook subscription check. A 404 (older
     * server) means unknown, not broken.
     */
    async githubHealth(): Promise<GithubHealthResult> {
      return sdk.request<GithubHealthResult>(
        "GET",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/health`,
      );
    },

    /**
     * Remove `repo`'s binding if this workspace owns it. 403 when another
     * workspace does; never touches its claim.
     */
    async githubLinkUnlink(repo: string): Promise<GithubLinkUnlinkResult> {
      return sdk.request<GithubLinkUnlinkResult>(
        "DELETE",
        `${config.apiUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}/github/link?repo=${encodeURIComponent(repo)}`,
      );
    },
  };
}

export type UploadsClient = ReturnType<typeof createUploadsClient>;
