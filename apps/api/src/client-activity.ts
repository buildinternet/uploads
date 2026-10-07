/**
 * Which client, at which version, each credential last used — so an operator
 * can see who is on an outdated CLI or MCP (table `client_activity`, see
 * migrations/20261007120000_client_activity.sql).
 *
 * Two producers:
 * - `workspaceAuth` (REST, and the hosted MCP's `up_` token lane) parses the
 *   CLI's `User-Agent: @buildinternet/uploads/<version> (<surface>)`. Any
 *   other User-Agent records nothing.
 * - the hosted MCP worker reads the MCP host's `clientInfo` from the JSON-RPC
 *   body (`mcp-remote`).
 *
 * Writes are best-effort and off the response path (`waitUntil`). The upsert
 * only rewrites a row older than CLIENT_ACTIVITY_TOUCH_SECONDS or whose
 * client/version changed, so a busy token pays at most one D1 write an hour
 * plus one per upgrade.
 */
import type { Context } from "hono";
import { type D1Queryable } from "./db-session";

/** How stale `last_seen_at` must be before an unchanged client rewrites it. */
export const CLIENT_ACTIVITY_TOUCH_SECONDS = 60 * 60;

/** npm package name the CLI and local MCP send in their User-Agent. */
export const CLI_PACKAGE_NAME = "@buildinternet/uploads";

export type ClientSurface = "cli" | "mcp-local" | "mcp-remote";

export interface ClientInfo {
  surface: ClientSurface;
  clientName: string;
  clientVersion: string | null;
}

const MAX_NAME = 100;
const MAX_VERSION = 64;
const MAX_ROWS = 500;

const CLI_UA_RE = /^@buildinternet\/uploads\/([0-9A-Za-z][0-9A-Za-z.+-]{0,63})(?:\s+\(([^)]*)\))?/;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Printable ASCII only — these strings are rendered in the admin UI.
  const trimmed = value.replace(/[^\x20-\x7e]/g, "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Client identity from the CLI's User-Agent, or null for anything else
 * (browsers, curl, the hosted MCP's callers). The parenthesized comment's
 * first `;`-separated token names the surface: `mcp` for `uploads mcp`,
 * anything else (or none, for older CLIs that never sent one) is the CLI.
 */
export function parseCliUserAgent(ua: string | null | undefined): ClientInfo | null {
  const match = ua ? CLI_UA_RE.exec(ua) : null;
  if (!match) return null;
  const surfaceToken = match[2]?.split(";")[0]?.trim().toLowerCase();
  return {
    surface: surfaceToken === "mcp" ? "mcp-local" : "cli",
    clientName: CLI_PACKAGE_NAME,
    clientVersion: match[1],
  };
}

const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

/**
 * MCP host identity from a JSON-RPC body: `params.clientInfo` on a 2025-era
 * `initialize`, or the per-request `_meta["io.modelcontextprotocol/clientInfo"]`
 * the 2026-07-28 stateless protocol sends on every request.
 */
export function parseMcpClientInfo(body: unknown): ClientInfo | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return null;
  const p = params as { clientInfo?: unknown; _meta?: unknown };
  const meta = p._meta && typeof p._meta === "object" ? (p._meta as Record<string, unknown>) : {};
  const info = (meta[CLIENT_INFO_META_KEY] ?? p.clientInfo) as
    | { name?: unknown; version?: unknown }
    | undefined;
  if (!info || typeof info !== "object") return null;
  const clientName = clean(info.name, MAX_NAME);
  if (!clientName) return null;
  return { surface: "mcp-remote", clientName, clientVersion: clean(info.version, MAX_VERSION) };
}

export interface ClientPrincipal {
  principal: string;
  tokenId: string | null;
  userId: string | null;
}

/**
 * Row identity from `WorkspaceVars.authPrincipal`. Legacy KV tokens carry the
 * full SHA-256 there; only an 8-char prefix is stored (the same prefix the
 * admin token list shows).
 */
export function principalFromAuth(
  authPrincipal: string | undefined,
  userId: string | null,
): ClientPrincipal | null {
  if (!authPrincipal) return null;
  if (authPrincipal.startsWith("d1-token:")) {
    const tokenId = authPrincipal.slice("d1-token:".length);
    return tokenId ? { principal: `token:${tokenId}`, tokenId, userId } : null;
  }
  if (authPrincipal.startsWith("legacy-token:")) {
    const hash = authPrincipal.slice("legacy-token:".length, "legacy-token:".length + 8);
    return hash ? { principal: `legacy:${hash}`, tokenId: null, userId } : null;
  }
  if (authPrincipal.startsWith("session-user:") || authPrincipal.startsWith("oauth-user:")) {
    const id = authPrincipal.slice(authPrincipal.indexOf(":") + 1);
    return id ? { principal: `user:${id}`, tokenId: null, userId: userId ?? id } : null;
  }
  return null;
}

export interface ClientActivityInput extends ClientPrincipal, ClientInfo {
  workspace: string;
}

export async function recordClientActivity(
  db: D1Queryable,
  input: ClientActivityInput,
  now = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  const staleBefore = new Date(now.getTime() - CLIENT_ACTIVITY_TOUCH_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO client_activity (
         workspace, principal, surface, user_id, token_id,
         client_name, client_version, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace, principal, surface) DO UPDATE SET
         user_id = COALESCE(excluded.user_id, client_activity.user_id),
         token_id = COALESCE(excluded.token_id, client_activity.token_id),
         client_name = excluded.client_name,
         client_version = excluded.client_version,
         last_seen_at = excluded.last_seen_at
       WHERE client_activity.last_seen_at < ?
          OR client_activity.client_name IS NOT excluded.client_name
          OR client_activity.client_version IS NOT excluded.client_version`,
    )
    .bind(
      input.workspace,
      input.principal,
      input.surface,
      input.userId,
      input.tokenId,
      input.clientName,
      input.clientVersion,
      iso,
      iso,
      staleBefore,
    )
    .run();
}

/**
 * Fire-and-forget `recordClientActivity` after the response. Awaits it when
 * there is no ExecutionContext (vitest `app.request` supplies none). Never
 * throws: a failed write must not fail the request.
 */
export async function scheduleClientActivity(
  c: Context,
  db: D1Queryable,
  input: ClientActivityInput,
): Promise<void> {
  const task = recordClientActivity(db, input).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        message: "client_activity write failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
  try {
    c.executionCtx.waitUntil(task);
    return;
  } catch {
    // No ExecutionContext: fall through and await.
  }
  await task;
}

export interface ClientActivityRow {
  workspace: string;
  principal: string;
  surface: string;
  user_id: string | null;
  token_id: string | null;
  client_name: string | null;
  client_version: string | null;
  first_seen_at: string;
  last_seen_at: string;
  token_label: string | null;
  token_owner: string | null;
  token_minting_user_id: string | null;
  user_email: string | null;
}

/**
 * Recent client activity, newest first, joined to the token's label/owner
 * and the user's email (auth tables share this D1).
 * `workspace` narrows to one tenant; `sinceDays` drops rows not seen in that
 * window.
 */
export async function listClientActivity(
  db: D1Queryable,
  opts: { workspace?: string; sinceDays?: number; now?: Date } = {},
): Promise<ClientActivityRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.workspace) {
    where.push("ca.workspace = ?");
    binds.push(opts.workspace);
  }
  if (opts.sinceDays && opts.sinceDays > 0) {
    const now = opts.now ?? new Date();
    where.push("ca.last_seen_at >= ?");
    binds.push(new Date(now.getTime() - opts.sinceDays * 86_400_000).toISOString());
  }
  const { results } = await db
    .prepare(
      `SELECT ca.workspace, ca.principal, ca.surface, ca.user_id, ca.token_id,
              ca.client_name, ca.client_version, ca.first_seen_at, ca.last_seen_at,
              t.label AS token_label, t.owner AS token_owner,
              t.minting_user_id AS token_minting_user_id, u.email AS user_email
         FROM client_activity ca
         LEFT JOIN auth_tokens t ON t.id = ca.token_id
         LEFT JOIN user u ON u.id = COALESCE(ca.user_id, t.minting_user_id)
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ca.last_seen_at DESC
        LIMIT ${MAX_ROWS}`,
    )
    .bind(...binds)
    .all<ClientActivityRow>();
  return results ?? [];
}

/** Wire shape for the admin listing (`GET /admin-ui/clients`). */
export function clientActivityResponse(row: ClientActivityRow) {
  return {
    workspace: row.workspace,
    principal: row.principal,
    surface: row.surface as ClientSurface,
    userId: row.user_id ?? row.token_minting_user_id,
    email: row.user_email,
    tokenLabel: row.token_label,
    serviceToken: row.token_owner === "workspace",
    clientName: row.client_name,
    clientVersion: row.client_version,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export type AdminClientActivity = ReturnType<typeof clientActivityResponse>;
