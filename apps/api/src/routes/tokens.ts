/**
 * POST /v1/tokens (plan D5/Phase 4): mint a `up_<workspace>_…` workspace token
 * from a Better Auth session.
 *
 * The device flow (`uploads login`) authenticates the *user* and hands the CLI
 * a session access token (bearer plugin). The CLI presents it here as
 * `Authorization: Bearer <session>`; this route verifies the session over the
 * AUTH service binding (`sessionAuth`), confirms the user is a member of the
 * org backing the requested workspace, then mints via the existing
 * `createToken` path — the same `auth_tokens` row `workspaceAuth` consumes.
 * `/account/developers` uses the same mint over a session cookie.
 *
 * Wire format is grant-based for forward-compat (multi-workspace tokens):
 * the request carries a `grants` array, but v1 accepts exactly one grant and
 * rejects >1 with a clear "not yet supported".
 */
import { ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import {
  createToken,
  isFileScope,
  isOperatorScope,
  isWorkspaceScope,
  findTokenForMintingUser,
  listTokensForMintingUser,
  revokeTokenForMintingUser,
  validateScopes,
  DEFAULT_TOKEN_SECONDS,
  MAX_TOKEN_SECONDS,
  type FileScope,
} from "../auth-db";
import { allowWrite } from "../guards";
import { membershipsForUser, orgForWorkspace } from "../org-workspaces";
import {
  requireSessionUser,
  sessionAuth,
  userHasAdminRole,
  type SessionVars,
} from "../session-auth";
import { loadWorkspaceRecord, WS_NAME_RE } from "../workspace";
import { suggestWorkspaceName } from "../workspace-suggestion";

/** Redacted scope list for the issued-token surface — never garbage entries. */
function parseIssuedScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is string => isFileScope(v) || isOperatorScope(v) || isWorkspaceScope(v),
    );
  } catch {
    return [];
  }
}

const MAX_BODY_BYTES = 4096;
const MAX_LABEL_LEN = 200;
// Scopes a mint defaults to when the grant omits them — read+write, but not
// delete (least surprise; the CLI sends explicit scopes anyway). Never
// includes operator scopes — those must be explicitly requested and are gated on
// the minting user's admin role (see the mint handler below).
const DEFAULT_MINT_SCOPES: FileScope[] = ["files:read", "files:write"];

interface RawGrant {
  workspace: string;
  rawScopes: unknown;
}

/**
 * Parse the request body into a normalized (but not-yet-scope-validated)
 * grant + label/ttl. Throws ValidationError (400) on any malformed input.
 * `grants` is an array by contract, but v1 permits exactly one entry.
 *
 * Scope validation is deferred to the caller (see the mint handler below):
 * whether operator:* / workspace:* scopes are acceptable depends on the
 * session user's admin role (operator) and, for workspace:* scopes, on the
 * caller's org role in the *target workspace* — which this function doesn't
 * resolve. That keeps this parser a pure structural check.
 */
function parseMintRequest(parsed: unknown): {
  grant: RawGrant;
  label?: string;
  /** `null` means never expire. Omit in the request to get the 90-day default. */
  ttlSeconds: number | null;
} {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("request body must be a JSON object", { code: "invalid_request" });
  }
  const body = parsed as Record<string, unknown>;

  if (!Array.isArray(body.grants)) {
    throw new ValidationError("grants must be an array", { code: "invalid_grants" });
  }
  if (body.grants.length === 0) {
    throw new ValidationError("at least one grant is required", { code: "invalid_grants" });
  }
  if (body.grants.length > 1) {
    throw new ValidationError("multiple grants are not yet supported", {
      code: "multi_grant_unsupported",
    });
  }

  const raw = body.grants[0];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("grant must be an object", { code: "invalid_grant" });
  }
  const grantObj = raw as Record<string, unknown>;
  const workspace = typeof grantObj.workspace === "string" ? grantObj.workspace.trim() : "";
  if (!WS_NAME_RE.test(workspace)) {
    throw new ValidationError("grant.workspace is invalid", { code: "invalid_workspace" });
  }
  let label: string | undefined;
  if (body.label !== undefined) {
    if (typeof body.label !== "string") {
      throw new ValidationError("label must be a string", { code: "invalid_label" });
    }
    const trimmed = body.label.trim();
    if (trimmed.length > MAX_LABEL_LEN) {
      throw new ValidationError(`label must be ${MAX_LABEL_LEN} characters or fewer`, {
        code: "invalid_label",
      });
    }
    label = trimmed || undefined;
  }

  let ttlSeconds: number | null = DEFAULT_TOKEN_SECONDS;
  if (body.ttlSeconds !== undefined) {
    if (body.ttlSeconds === null) {
      ttlSeconds = null;
    } else if (
      typeof body.ttlSeconds !== "number" ||
      !Number.isInteger(body.ttlSeconds) ||
      body.ttlSeconds < 1 ||
      body.ttlSeconds > MAX_TOKEN_SECONDS
    ) {
      throw new ValidationError(
        `ttlSeconds must be null or an integer between 1 and ${MAX_TOKEN_SECONDS}`,
        {
          code: "invalid_ttl",
        },
      );
    } else {
      ttlSeconds = body.ttlSeconds;
    }
  }

  return { grant: { workspace, rawScopes: grantObj.scopes }, label, ttlSeconds };
}

export const tokens = new Hono<SessionVars>()
  // List the workspaces the signed-in user can mint a token for — the CLI uses
  // this to auto-select when the account has exactly one, or to prompt/require
  // --workspace when it has several. Derived from org memberships (D4: org
  // slug === workspace name), filtered to workspaces that still exist in KV.
  .get("/", sessionAuth, requireSessionUser, async (c) => {
    const user = c.get("sessionUser")!;
    const memberships = await membershipsForUser(c.env, user.id);
    const workspaces = (
      await Promise.all(
        memberships.map(async (m) => {
          const name = m.organizationSlug;
          const record = await loadWorkspaceRecord(c.env, name);
          return record ? { workspace: name, role: m.role } : null;
        }),
      )
    ).filter((w): w is { workspace: string; role: string } => w !== null);

    // Name to prefill when this account is about to create its first
    // workspace (#506). Only computed when there is nothing to pick from —
    // a user who already has a workspace is not being asked to name one, so
    // the GitHub round-trip would be wasted. Omitted entirely when no clean
    // candidate exists; the field being absent means "offer nothing", which
    // is the pre-#506 behavior.
    const suggestedWorkspace =
      workspaces.length === 0 ? await suggestWorkspaceName(c.env, user.id) : null;

    return c.json({
      workspaces,
      ...(suggestedWorkspace ? { suggestedWorkspace } : {}),
    });
  })
  .post("/", sessionAuth, requireSessionUser, async (c) => {
    const contentLength = Number(c.req.header("Content-Length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      throw new ValidationError("request body too large", { code: "invalid_request" });
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new ValidationError("request body too large", { code: "invalid_request" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_request" });
    }

    // requireSessionUser guarantees this is set.
    const user = c.get("sessionUser")!;
    const { grant, label, ttlSeconds } = parseMintRequest(parsed);

    // Three independent lookups — resolve them concurrently, then gate. The
    // workspace must exist as a KV tenant record (a token is meaningless
    // otherwise, and this blocks typo'd/non-existent workspaces); the session
    // user must be a member of the org backing it. All checks collapse to the
    // same 403/`workspace_forbidden` so a non-member can't distinguish
    // "workspace doesn't exist" from "you're not a member".
    const [record, org, memberships] = await Promise.all([
      loadWorkspaceRecord(c.env, grant.workspace),
      orgForWorkspace(c.env, grant.workspace),
      membershipsForUser(c.env, user.id),
    ]);
    const membership = org ? memberships.find((m) => m.organizationId === org.id) : undefined;
    if (!record || !org || !membership) {
      throw new ForbiddenError("no access to this workspace", { code: "workspace_forbidden" });
    }

    // workspace:* scopes require the caller's org role in THIS workspace to be
    // admin/owner (string check matching adminWorkspaceOr403 in routes/me.ts).
    // Platform-admin role does NOT bypass this — operators already have
    // /admin-ui, so a platform admin without an org role here still fails
    // invalid_scopes, same as any other unauthorized scope request (#262).
    const allowWorkspace = membership.role === "admin" || membership.role === "owner";
    const scopes = validateScopes(grant.rawScopes, DEFAULT_MINT_SCOPES, {
      allowOperator: userHasAdminRole(user),
      allowWorkspace,
    });
    if (scopes === null) {
      throw new ValidationError("grant.scopes contains an unknown scope", {
        code: "invalid_scopes",
      });
    }

    // Throttle minting per workspace — checked only after the membership gate,
    // so a non-member can't burn a workspace's mint budget by griefing this
    // endpoint. Same WRITE_LIMITER other mutating routes use (see guards.ts).
    if (!(await allowWrite(c.env, grant.workspace))) {
      throw new RateLimitedError("token minting rate limit exceeded");
    }

    const expiresAt = ttlSeconds === null ? undefined : new Date(Date.now() + ttlSeconds * 1000);
    const { token, record: tokenRecord } = await createToken(c.env.DB, {
      workspace: grant.workspace,
      label,
      scopes,
      expiresAt,
      mintedByUserId: user.id,
    });

    return c.json(
      {
        token,
        workspace: grant.workspace,
        scopes,
        label: tokenRecord.label,
        expiresAt: tokenRecord.expires_at,
      },
      201,
    );
  })
  // Tokens this session user minted. Distinct from GET / (workspace picker)
  // and from GET /v1/workspaces/:name/tokens (workspace-admin list of every
  // token on that workspace). Members only see their own rows.
  .get("/issued", sessionAuth, requireSessionUser, async (c) => {
    const user = c.get("sessionUser")!;
    const issued = (await listTokensForMintingUser(c.env.DB, user.id)).map((token) => ({
      id: token.id,
      workspace: token.workspace,
      label: token.label,
      scopes: parseIssuedScopes(token.scopes),
      createdAt: token.created_at,
      expiresAt: token.expires_at,
      lastUsedAt: token.last_used_at,
    }));
    return c.json({ tokens: issued });
  })
  .delete("/:id", sessionAuth, requireSessionUser, async (c) => {
    const user = c.get("sessionUser")!;
    const id = c.req.param("id").trim();
    if (!id) {
      throw new NotFoundError("no matching token", { code: "token_not_found" });
    }
    const match = await findTokenForMintingUser(c.env.DB, user.id, id);
    if (!match) {
      throw new NotFoundError("no matching token", { code: "token_not_found" });
    }
    if (!(await allowWrite(c.env, match.workspace))) {
      throw new RateLimitedError("token revoke rate limit exceeded");
    }
    const revoked = await revokeTokenForMintingUser(c.env.DB, user.id, id);
    if (!revoked) {
      throw new NotFoundError("no matching token", { code: "token_not_found" });
    }
    return c.json({
      id: revoked.id,
      workspace: revoked.workspace,
      revoked: true,
    });
  });
