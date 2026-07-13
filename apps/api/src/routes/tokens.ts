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
 *
 * Wire format is grant-based for forward-compat (multi-workspace tokens,
 * user-generated API tokens): the request carries a `grants` array, but v1
 * accepts exactly one grant and rejects >1 with a clear "not yet supported".
 */
import { ForbiddenError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import {
  createToken,
  validateScopes,
  DEFAULT_TOKEN_SECONDS,
  MAX_TOKEN_SECONDS,
  type FileScope,
} from "../auth-db";
import { membershipsForUser, orgForWorkspace } from "../org-workspaces";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { loadWorkspaceRecord } from "../workspace";

const MAX_BODY_BYTES = 4096;
const MAX_LABEL_LEN = 200;
const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Scopes a mint defaults to when the grant omits them — read+write, but not
// delete (least surprise; the CLI sends explicit scopes anyway).
const DEFAULT_MINT_SCOPES: FileScope[] = ["files:read", "files:write"];

interface Grant {
  workspace: string;
  scopes: FileScope[];
}

/**
 * Validate the request body into a single normalized grant + label/ttl.
 * Throws ValidationError (400) on any malformed input. `grants` is an array by
 * contract, but v1 permits exactly one entry.
 */
function parseMintRequest(parsed: unknown): {
  grant: Grant;
  label?: string;
  ttlSeconds: number;
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
  const scopes = validateScopes(grantObj.scopes, DEFAULT_MINT_SCOPES);
  if (scopes === null) {
    throw new ValidationError("grant.scopes contains an unknown scope", { code: "invalid_scopes" });
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

  let ttlSeconds = DEFAULT_TOKEN_SECONDS;
  if (body.ttlSeconds !== undefined) {
    if (
      typeof body.ttlSeconds !== "number" ||
      !Number.isInteger(body.ttlSeconds) ||
      body.ttlSeconds < 1 ||
      body.ttlSeconds > MAX_TOKEN_SECONDS
    ) {
      throw new ValidationError(
        `ttlSeconds must be an integer between 1 and ${MAX_TOKEN_SECONDS}`,
        {
          code: "invalid_ttl",
        },
      );
    }
    ttlSeconds = body.ttlSeconds;
  }

  return { grant: { workspace, scopes }, label, ttlSeconds };
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
    return c.json({ workspaces });
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

    const { grant, label, ttlSeconds } = parseMintRequest(parsed);

    // requireSessionUser guarantees this is set.
    const user = c.get("sessionUser")!;

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
    if (!record || !org || !memberships.some((m) => m.organizationId === org.id)) {
      throw new ForbiddenError("no access to this workspace", { code: "workspace_forbidden" });
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const { token, record: tokenRecord } = await createToken(c.env.DB, {
      workspace: grant.workspace,
      label,
      scopes: grant.scopes,
      expiresAt,
      mintedByUserId: user.id,
    });

    return c.json(
      {
        token,
        workspace: grant.workspace,
        scopes: grant.scopes,
        label: tokenRecord.label,
        expiresAt: tokenRecord.expires_at,
      },
      201,
    );
  });
