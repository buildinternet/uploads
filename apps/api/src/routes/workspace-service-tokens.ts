/**
 * Workspace-owned service tokens (issue #1026): `/:workspace/service-tokens`,
 * mounted at `/v1/workspaces` in `index.ts`.
 *
 * A service token is an `auth_tokens` row with `owner = 'workspace'` and no
 * `minting_user_id`. It is for CI jobs and bots, which should not borrow one
 * member's identity:
 *
 *  - Uploads made with it are attributed to its label (`gh.uploader` plus
 *    `gh.uploader-kind: service`, see `withUploaderTags`), not to a member.
 *  - No member's removal, demotion or account deletion revokes it — those
 *    revocations match on `minting_user_id` (apps/auth/src/member-tokens.ts).
 *    Only a workspace admin revoking it here, or its expiry, ends it.
 *  - `created_by_user_id` records which admin minted it. That is audit only.
 *  - File scopes only (read & write, or read-only). It can never carry
 *    `workspace:*` or `operator:*` scopes.
 *
 * All three routes are session-only and admin/owner-gated through the People
 * vertical's `sessionAdminGate`: an `up_` bearer 403s. No bearer credential
 * can mint, list or revoke service tokens, so a leaked service token can't
 * mint siblings, and a `workspace:manage` token can't create credentials that
 * outlive its minter.
 *
 * With a null minting user, a service token counts as "no GitHub identity"
 * everywhere #297 checks one: it can't claim a new repo for the workspace
 * (`isEntitledToClaimRepo`), and the opt-in actor-on-PR gate skips it the
 * same way it skips legacy shared tokens. Link the repo from workspace
 * settings first, then CI can attach to it.
 */
import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import {
  buildTokenRecord,
  DEFAULT_TOKEN_SECONDS,
  isFileScope,
  listServiceTokens,
  MAX_ACTIVE_SERVICE_TOKENS,
  MAX_SERVICE_TOKEN_LABEL_LEN,
  MAX_TOKEN_SECONDS,
  prepareTokenInsert,
  revokeServiceToken,
  validateScopes,
  type AuthTokenRecord,
  type FileScope,
} from "../auth-db";
import { dbFor, primaryDbFor } from "../db-session";
import { resolveSessionUserId } from "../dual-workspace-auth";
import { respondError } from "../error-response";
import { allowWrite } from "../guards";
import type { SessionVars } from "../session-auth";
import { requireLiveWorkspace, sessionAdminGate, type MembersVars } from "./workspace-members";

const MAX_BODY_BYTES = 1024;
const DEFAULT_SERVICE_SCOPES: FileScope[] = ["files:read", "files:write"];

/** Wire types (issue #896 pattern) — apps/web imports these, never re-declares them. */
export type ServiceTokenRow = ReturnType<typeof serviceTokenRow>;
export type ServiceTokenMintResponse = ServiceTokenRow & { token: string };

/** The listed shape — never the token value or its hash. */
function serviceTokenRow(token: AuthTokenRecord) {
  let scopes: FileScope[] = [];
  try {
    const parsed: unknown = JSON.parse(token.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter(isFileScope);
  } catch {
    // Unparseable scopes list as none; the row can still be revoked.
  }
  return {
    id: token.id,
    label: token.label ?? "",
    scopes,
    createdAt: token.created_at,
    expiresAt: token.expires_at,
    lastUsedAt: token.last_used_at,
    createdByUserId: token.created_by_user_id,
  };
}

function parseMintBody(parsed: unknown): {
  label: string;
  scopes: FileScope[];
  ttlSeconds: number | null;
} {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("request body must be a JSON object", { code: "invalid_request" });
  }
  const body = parsed as Record<string, unknown>;

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label.length === 0 || label.length > MAX_SERVICE_TOKEN_LABEL_LEN) {
    throw new ValidationError(
      `label is required and must be ${MAX_SERVICE_TOKEN_LABEL_LEN} characters or fewer`,
      { code: "invalid_label" },
    );
  }

  // validateScopes without allowOperator/allowWorkspace accepts file scopes only.
  const scopes = validateScopes(body.scopes, DEFAULT_SERVICE_SCOPES);
  if (scopes === null) {
    throw new ValidationError("scopes must be a non-empty list of files:* scopes", {
      code: "invalid_scopes",
    });
  }

  let ttlSeconds: number | null = DEFAULT_TOKEN_SECONDS;
  if (body.ttlSeconds === null) {
    ttlSeconds = null;
  } else if (body.ttlSeconds !== undefined) {
    if (
      typeof body.ttlSeconds !== "number" ||
      !Number.isInteger(body.ttlSeconds) ||
      body.ttlSeconds < 1 ||
      body.ttlSeconds > MAX_TOKEN_SECONDS
    ) {
      throw new ValidationError(
        `ttlSeconds must be null or an integer between 1 and ${MAX_TOKEN_SECONDS}`,
        { code: "invalid_ttl" },
      );
    }
    ttlSeconds = body.ttlSeconds;
  }
  return { label, scopes, ttlSeconds };
}

/**
 * `POST /:workspace/service-tokens` — mint a service token; the plaintext is
 * in this response only. The insert is conditional, so the per-workspace cap
 * and the unique-active-label rule hold under concurrent mints.
 */
export async function serviceTokenMintHandler(c: Context<MembersVars>) {
  const org = c.get("memberOrg");
  const workspace = org.slug;
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ValidationError("request body too large", { code: "invalid_request" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("request body must be valid JSON", { code: "invalid_request" });
  }
  const { label, scopes, ttlSeconds } = parseMintBody(parsed);

  await requireLiveWorkspace(c.env, workspace);
  if (!(await allowWrite(c.env, workspace))) {
    throw new RateLimitedError("token minting rate limit exceeded");
  }

  const adminUserId = await resolveSessionUserId(c as unknown as Context<SessionVars>);
  const now = new Date();
  const nowIso = now.toISOString();
  const { token, record } = await buildTokenRecord({
    workspace,
    label,
    scopes,
    expiresAt: ttlSeconds === null ? undefined : new Date(now.getTime() + ttlSeconds * 1000),
    owner: "workspace",
    mintedByUserId: null,
    createdByUserId: adminUserId,
    now,
  });

  const ACTIVE = `workspace = ? AND owner = 'workspace' AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`;
  const db = primaryDbFor(c.env);
  const result = await prepareTokenInsert(db, record, {
    sql: `(SELECT COUNT(*) FROM auth_tokens WHERE ${ACTIVE}) < ?
      AND NOT EXISTS (SELECT 1 FROM auth_tokens WHERE ${ACTIVE} AND label = ?)`,
    values: [workspace, nowIso, MAX_ACTIVE_SERVICE_TOKENS, workspace, nowIso, label],
  }).run();

  if ((result.meta?.changes ?? 0) === 0) {
    const active = await listServiceTokens(db, workspace, now);
    if (active.some((t) => t.label === label)) {
      throw new ConflictError("a service token with this label already exists", {
        code: "service_token_label_taken",
      });
    }
    throw new ConflictError(
      `this workspace already has ${MAX_ACTIVE_SERVICE_TOKENS} active service tokens; revoke one first`,
      { code: "service_token_limit_reached" },
    );
  }

  const response: ServiceTokenMintResponse = { ...serviceTokenRow(record), token };
  return c.json(response, 201);
}

/** `GET /:workspace/service-tokens` — active, unexpired service tokens, newest first. */
export async function serviceTokenListHandler(c: Context<MembersVars>) {
  const workspace = c.get("memberOrg").slug;
  const tokens = await listServiceTokens(dbFor(c.env), workspace);
  return c.json({ workspace, tokens: tokens.map(serviceTokenRow) });
}

/** `DELETE /:workspace/service-tokens/:id` — revoke one; can never touch a personal token. */
export async function serviceTokenRevokeHandler(c: Context<MembersVars>) {
  const workspace = c.get("memberOrg").slug;
  if (!(await allowWrite(c.env, workspace))) {
    throw new RateLimitedError("token revoke rate limit exceeded");
  }
  const id = (c.req.param("id") ?? "").trim();
  const revoked = await revokeServiceToken(primaryDbFor(c.env), workspace, id);
  if (!revoked) {
    throw new NotFoundError("no matching service token", { code: "token_not_found" });
  }
  return c.json({ id: revoked.id, workspace, revoked: true });
}

export const workspaceServiceTokens = new Hono<MembersVars>()
  .get("/:workspace/service-tokens", sessionAdminGate(), serviceTokenListHandler)
  .post("/:workspace/service-tokens", sessionAdminGate(), serviceTokenMintHandler)
  .delete("/:workspace/service-tokens/:id", sessionAdminGate(), serviceTokenRevokeHandler)
  .onError((err, c) => respondError(c, err));
