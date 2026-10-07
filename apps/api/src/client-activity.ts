/**
 * Which client, at which version, each credential last used — so an operator
 * can see who is on an outdated CLI or MCP (table `client_activity`, see
 * migrations/20261007120000_client_activity.sql).
 *
 * Two producers, both through `recordClient`:
 * - `workspaceAuth` (REST, and the hosted MCP's `up_` token lane) parses the
 *   CLI's `User-Agent: @buildinternet/uploads/<version> (<surface>)`. Any
 *   other User-Agent records nothing.
 * - the hosted MCP worker reads the MCP host's `clientInfo` from the JSON-RPC
 *   body (`mcp-remote`).
 *
 * Writes are best-effort and off the response path (`waitUntil`). The upsert
 * only rewrites a row older than TOUCH_SECONDS or whose client/version
 * changed, so a busy token pays at most one D1 write an hour plus one per
 * upgrade.
 */
import type { Context } from "hono";
import { HASH_PREFIX_LEN } from "./admin-token-list";
import { afterResponse } from "./after-response";
import { sanitizeString } from "./cli-intake";
import { type D1Queryable, dbFor } from "./db-session";
import type { WorkspaceVars } from "./workspace";

/** How stale `last_seen_at` must be before an unchanged client rewrites it. */
const TOUCH_SECONDS = 60 * 60;
const MAX_NAME = 100;
const MAX_VERSION = 64;
const MAX_ROWS = 500;

type ClientSurface = "cli" | "mcp-local" | "mcp-remote";

export interface ClientInfo {
  surface: ClientSurface;
  clientName: string;
  clientVersion: string | null;
}

/** Row identity for one credential. Each auth lane builds its own. */
export interface ClientPrincipal {
  principal: string;
  tokenId: string | null;
  userId: string | null;
}

export function tokenClientPrincipal(token: {
  id: string;
  minting_user_id: string | null;
}): ClientPrincipal {
  return { principal: `token:${token.id}`, tokenId: token.id, userId: token.minting_user_id };
}

/** Legacy KV tokens: the same hash prefix the admin token list shows. */
export function legacyClientPrincipal(tokenHash: string): ClientPrincipal {
  return {
    principal: `legacy:${tokenHash.slice(0, HASH_PREFIX_LEN)}`,
    tokenId: null,
    userId: null,
  };
}

/** OAuth (hosted MCP): one row per user per workspace. */
export function userClientPrincipal(userId: string): ClientPrincipal {
  return { principal: `user:${userId}`, tokenId: null, userId };
}

/** Printable ASCII only — these strings are rendered in the admin UI. */
function clean(value: unknown, max: number): string | null {
  return typeof value === "string" ? sanitizeString(value.replace(/[^\x20-\x7e]/g, ""), max) : null;
}

const CLI_UA_RE = /^@buildinternet\/uploads\/([0-9A-Za-z][0-9A-Za-z.+-]{0,63})(?:\s+\(([^)]*)\))?/;

/**
 * Client identity from the CLI's User-Agent, or null for anything else
 * (browsers, curl, the hosted MCP's callers). The parenthesized comment's
 * first `;`-separated token names the surface: `mcp` for `uploads mcp`,
 * anything else (or none) is the CLI.
 */
export function parseCliUserAgent(ua: string | null | undefined): ClientInfo | null {
  const match = ua ? CLI_UA_RE.exec(ua) : null;
  if (!match) return null;
  const surfaceToken = match[2]?.split(";")[0]?.trim().toLowerCase();
  return {
    surface: surfaceToken === "mcp" ? "mcp-local" : "cli",
    clientName: "@buildinternet/uploads",
    clientVersion: match[1],
  };
}

/** MCP host identity from its `{ name, version }` clientInfo, or null without a usable name. */
export function mcpClientInfo(info: unknown): ClientInfo | null {
  if (!info || typeof info !== "object") return null;
  const { name, version } = info as { name?: unknown; version?: unknown };
  const clientName = clean(name, MAX_NAME);
  if (!clientName) return null;
  return { surface: "mcp-remote", clientName, clientVersion: clean(version, MAX_VERSION) };
}

export async function recordClientActivity(
  db: D1Queryable,
  input: ClientPrincipal & ClientInfo & { workspace: string },
  now = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  const staleBefore = new Date(now.getTime() - TOUCH_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO client_activity (
         workspace, principal, surface, user_id, token_id,
         client_name, client_version, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace, principal, surface) DO UPDATE SET
         user_id = excluded.user_id,
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
 * Records `client` for the request's authenticated credential after the
 * response. A no-op when the auth lane set no `clientPrincipal`. Never
 * throws: a failed write must not fail the request.
 */
export async function recordClient(c: Context<WorkspaceVars>, client: ClientInfo): Promise<void> {
  const principal = c.get("clientPrincipal");
  if (!principal) return;
  const task = recordClientActivity(dbFor(c.env), {
    ...principal,
    ...client,
    workspace: c.get("workspaceName"),
  }).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        message: "client_activity write failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
  await afterResponse(c, task);
}

interface ClientActivityRow {
  workspace: string;
  principal: string;
  surface: string;
  client_name: string | null;
  client_version: string | null;
  last_seen_at: string;
  token_label: string | null;
  token_owner: string | null;
  user_email: string | null;
}

/**
 * Recent client activity, newest first, joined to the token's label/owner
 * and the user's email (auth tables share this D1). `workspace` narrows to
 * one tenant; `sinceDays` drops rows not seen in that window.
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
      `SELECT ca.workspace, ca.principal, ca.surface, ca.client_name, ca.client_version,
              ca.last_seen_at, t.label AS token_label, t.owner AS token_owner,
              u.email AS user_email
         FROM client_activity ca
         LEFT JOIN auth_tokens t ON t.id = ca.token_id
         LEFT JOIN user u ON u.id = ca.user_id
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
    email: row.user_email,
    tokenLabel: row.token_label,
    serviceToken: row.token_owner === "workspace",
    clientName: row.client_name,
    clientVersion: row.client_version,
    lastSeenAt: row.last_seen_at,
  };
}

export type AdminClientActivity = ReturnType<typeof clientActivityResponse>;
