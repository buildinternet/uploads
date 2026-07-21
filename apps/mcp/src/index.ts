/**
 * Remote MCP server for uploads.sh — a standalone worker on agents.uploads.sh (alternate: mcp.uploads.sh).
 *
 * Stateless MCP Streamable HTTP: each POST carries one JSON-RPC message and
 * gets its response (or 202 for notifications) in the same HTTP exchange. No
 * sessions and no SSE stream — spec-compliant for a stateless server, so
 * GET/DELETE on the endpoint are 405. Auth is the REST API's per-workspace
 * bearer-token middleware; the protocol core is the CLI package's
 * `createMcpServer`, shared verbatim.
 */
import { createMcpServer } from "@buildinternet/uploads/mcp";
import {
  AppError,
  ForbiddenError,
  isAppError,
  MethodNotAllowedError,
  NotFoundError,
  UnauthorizedError,
} from "@uploads/errors";
import {
  loadWorkspaceRecord,
  tokenWorkspaceAuth,
  workspaceAuth,
  type WorkspaceVars,
} from "@uploads/api/workspace";
import { protectedResourceMetadata, requestOrigin } from "@uploads/api/well-known";
import { Hono, type Context, type Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import pkg from "../package.json";
import { createRemoteTools } from "./tools";
import { invalidTokenChallenge, isJwtShaped, missingTokenChallenge, verifyOAuthJwt } from "./oauth";

/**
 * Both prod hostnames this worker answers on (see wrangler.jsonc routes) are
 * accepted as `aud` — mirrored into the AS's own audience allow-list (parallel
 * lane). A JWT minted against either resource works on either route.
 */
const OAUTH_AUDIENCES = ["https://agents.uploads.sh/mcp", "https://mcp.uploads.sh/mcp"];

function authOriginOf(env: Env): string {
  return (env.AUTH_ORIGIN || "https://auth.uploads.sh").replace(/\/+$/, "");
}

function bearerFrom(header: string | undefined): string {
  // RFC 9110 §11.1: auth scheme names are case-insensitive.
  return header?.match(/^Bearer +(.+)$/i)?.[1] ?? "";
}

/** Actionable 403 for a token whose user has no workspace yet (`workspace: null`). */
function noWorkspaceError(): ForbiddenError {
  return new ForbiddenError(
    "This account has no workspace yet. Create one at https://uploads.sh, then reconnect.",
    { code: "workspace_required" },
  );
}

/**
 * Verifies a JWT-shaped bearer against the AS JWKS and, on success, sets the
 * same context vars `tokenWorkspaceAuth`/`workspaceAuth` set (workspace
 * record, name, scopes) so downstream tool handlers don't need to know which
 * auth lane ran. `pathWorkspace` is set only for the `/:workspace/mcp` route,
 * where the token must additionally list that workspace in its `workspaces`
 * claim — otherwise this is the token-inferred `/mcp` route, which uses the
 * token's primary `workspace` claim.
 */
async function oauthAuth(
  c: Context<WorkspaceVars>,
  token: string,
  pathWorkspace: string | undefined,
): Promise<Response | null> {
  const verified = await verifyOAuthJwt(token, {
    issuer: `${authOriginOf(c.env)}/api/auth`,
    audience: OAUTH_AUDIENCES,
  });
  if (!verified) return invalidTokenChallenge(c.req.url);

  const workspaceName = pathWorkspace ?? verified.workspace ?? undefined;
  if (pathWorkspace) {
    // Path-based route: the presented JWT must grant access to THIS workspace.
    // A uniform 401 (not the invalid_token challenge, which is only for a bad
    // credential) — mirrors the existing up_ token behavior for a workspace
    // mismatch (see mcp.test.ts "rejects the same token against a different
    // workspace path").
    if (!verified.workspaces.includes(pathWorkspace)) throw new UnauthorizedError();
  } else if (verified.workspace === null) {
    throw noWorkspaceError();
  }

  const record = workspaceName ? await loadWorkspaceRecord(c.env, workspaceName) : null;
  // Token claims a workspace slug that no longer exists (deleted after
  // issuance, or a claims/registry desync) — treat like any other credential
  // that doesn't resolve, rather than inventing a third error shape.
  if (!record || !workspaceName) throw new UnauthorizedError();

  c.set("workspace", record);
  c.set("workspaceName", workspaceName);
  c.set("authScopes", verified.scopes);
  // Uploader attribution (issue #345, parity with #340/#344): the AS signs
  // `sub` as the Better Auth user id (see @better-auth/oauth-provider's
  // customAccessTokenClaims call site — `sub: user?.id`, no pairwise-subject
  // config on this AS), the same id `uploaderTags()` resolves against the
  // internal `/users/:id/github-account` route. `tokenWorkspaceAuth`/
  // `workspaceAuth` set the same var from `up_` tokens' `minting_user_id`.
  c.set("mintingUserId", typeof verified.raw.sub === "string" ? verified.raw.sub : null);
  return null;
}

/** POST /mcp: JWT-shaped bearer → OAuth verification; everything else → the existing up_ token path. */
async function mcpBearerAuth(c: Context<WorkspaceVars>, next: Next): Promise<Response | void> {
  const token = bearerFrom(c.req.header("Authorization"));
  // No credential at all → 401 with the RFC 9728 discovery challenge; MCP
  // clients start the OAuth flow from this response's `resource_metadata`.
  if (!token) return missingTokenChallenge(c.req.url);
  if (isJwtShaped(token)) {
    const response = await oauthAuth(c, token, undefined);
    if (response) return response;
    return next();
  }
  return tokenWorkspaceAuth(c, next);
}

/** /:workspace/mcp: JWT-shaped bearer → OAuth verification scoped to the path workspace; everything else → the existing up_ token path. */
async function workspacePathAuth(c: Context<WorkspaceVars>, next: Next): Promise<Response | void> {
  const token = bearerFrom(c.req.header("Authorization"));
  if (isJwtShaped(token)) {
    const response = await oauthAuth(c, token, c.req.param("workspace"));
    if (response) return response;
    return next();
  }
  return workspaceAuth(c, next);
}

async function handleMcp(c: Context<WorkspaceVars>): Promise<Response> {
  const body = await c.req.text();
  const server = createMcpServer({
    serverInfo: { name: "uploads-mcp", version: pkg.version },
    tools: createRemoteTools({
      env: c.env,
      workspace: c.get("workspace"),
      workspaceName: c.get("workspaceName"),
      authScopes: c.get("authScopes"),
      mintingUserId: c.get("mintingUserId") ?? null,
    }),
  });
  const result = await server.handleLine(body);
  // Notifications and client responses get no JSON-RPC reply: 202, empty.
  if (result === undefined) return c.body(null, 202);
  return c.body(result, 200, { "Content-Type": "application/json" });
}

function respondError(c: Context, err: unknown): Response {
  const appErr = isAppError(err) ? err : AppError.from(err);
  if (!appErr.expose || appErr.type === "internal") {
    console.error(
      JSON.stringify({
        message: appErr.message,
        code: appErr.code,
        type: appErr.type,
        stack: appErr.stack,
      }),
    );
  }
  return c.json(appErr.toWire(), appErr.status as ContentfulStatusCode);
}

const methodNotAllowed = (_c: Context<WorkspaceVars>) => {
  throw new MethodNotAllowedError();
};

/** SEP-1649-style discovery document for HTTP MCP clients probing this origin. */
function mcpServerCard() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "uploads-mcp",
      version: pkg.version,
      description:
        "Host files on uploads.sh from an agent — put, attach, list, delete, usage, and GitHub attachment comments.",
      homepage: "https://uploads.sh/",
    },
    transport: {
      type: "streamable-http",
      endpoint: "https://agents.uploads.sh/mcp",
    },
    capabilities: {
      tools: true,
      resources: false,
      prompts: false,
    },
    authentication: {
      required: true,
      schemes: ["bearer", "oauth2"],
      description:
        "Bearer token — either a per-workspace token (Authorization: Bearer up_<workspace>_…, via invitation + `uploads login`) or an OAuth 2.1 access token from the uploads-auth authorization server (browser consent flow; see /.well-known/oauth-protected-resource). See https://uploads.sh/auth.md",
    },
  };
}

/** RFC 9728 metadata for the MCP endpoint, keyed to the request host. */
function respondProtectedResource(c: Context<WorkspaceVars>): Response {
  return c.json(
    protectedResourceMetadata({
      // The protected resource is the `/mcp` endpoint itself (matches the
      // server-card transport endpoint and the RFC 8707 resource an MCP
      // client indicates when requesting a token).
      resource: `${requestOrigin(c.req.url)}/mcp`,
      resourceName: "uploads.sh MCP server",
      webOrigin: c.env.WEB_ORIGIN || "https://uploads.sh",
      // Only this worker advertises an AS — it's the only resource server
      // that verifies uploads-auth OAuth JWTs (v1 is MCP-only). The issuer,
      // not a well-known URL: clients apply RFC 8414 path-insertion for
      // discovery.
      authorizationServers: [`${authOriginOf(c.env)}/api/auth`],
    }),
    200,
    { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  );
}

const app = new Hono<WorkspaceVars>()
  .get("/health", (c) => c.json({ ok: true }))
  // Public discovery — registered before /:workspace/* so ".well-known" is not a tenant.
  .get("/.well-known/mcp/server-card.json", (c) => c.json(mcpServerCard()))
  // OAuth Protected Resource Metadata (RFC 9728). Served at both the origin
  // root (where scanners probe) and the RFC path-suffixed location a strict
  // client derives from `resource` = `<origin>/mcp`.
  .get("/.well-known/oauth-protected-resource", respondProtectedResource)
  .get("/.well-known/oauth-protected-resource/mcp", respondProtectedResource)
  // Primary endpoint: the workspace is inferred from the bearer token
  // (up_<workspace>_…) or, for a JWT-shaped bearer, the OAuth token's
  // `workspace` claim — so clients only need the URL and the token.
  .post("/mcp", mcpBearerAuth, handleMcp)
  .on(["GET", "DELETE"], "/mcp", methodNotAllowed)
  // Workspace-prefixed alternate, kept for existing clients.
  .use("/:workspace/*", workspacePathAuth)
  .post("/:workspace/mcp", handleMcp)
  .on(["GET", "DELETE"], "/:workspace/mcp", methodNotAllowed)
  .onError((err, c) => respondError(c, err))
  .notFound((c) => respondError(c, new NotFoundError()));

export default app;
