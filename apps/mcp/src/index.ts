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
import { createMcpServer, type McpServer } from "@buildinternet/uploads/mcp";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
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
import { ROBOTS_TXT } from "./robots";

/**
 * Both prod hostnames this worker answers on (see wrangler.jsonc routes) are
 * accepted as `aud`, in `/mcp` and origin form. Generic clients copy the
 * origin into authorize `resource=` (RFC 8707); the AS mints `aud` from
 * that. Mirrored into the AS's `oauthResources()` list — keep both in
 * lockstep. A JWT minted against any of these works on either route.
 */
const OAUTH_AUDIENCES = [
  "https://agents.uploads.sh/mcp",
  "https://agents.uploads.sh",
  "https://mcp.uploads.sh/mcp",
  "https://mcp.uploads.sh",
];

/**
 * The JSON Schema validator for `createMcpServer`'s tool registration. Built
 * once at module scope — it's stateless config, not per-request state — and
 * MUST be the `@cfworker/json-schema`-backed provider: the Ajv provider
 * compiles schemas with `new Function` at runtime, which workerd rejects (see
 * packages/uploads/src/mcp/server.ts's module doc and the design doc's
 * "JSON Schema validator is injected per runtime" section).
 */
const validator = new CfWorkerJsonSchemaValidator();

function authOriginOf(env: Env): string {
  // #731 phase C: falls back to the WEB origin (issuer now lives at
  // uploads.sh/api/auth) — kept in lockstep with the AUTH_ORIGIN var in
  // wrangler.jsonc.
  return (env.AUTH_ORIGIN || "https://uploads.sh").replace(/\/+$/, "");
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
  const currentIssuer = `${authOriginOf(c.env)}/api/auth`;
  const verified = await verifyOAuthJwt(token, {
    // #731 phase E: the pre-flip `auth.uploads.sh/api/auth` issuer is no longer
    // accepted. Legacy access tokens (bounded ~1h expiry) have long since aged
    // out since the phase-C flip; a client presenting a stale one gets a 401,
    // re-discovers the current issuer via RFC 9728, and re-authorizes.
    issuer: currentIssuer,
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

/** Builds a fresh server for this request — same tool catalog for both eras, so they can't drift. */
function buildServer(c: Context<WorkspaceVars>): McpServer {
  return createMcpServer({
    serverInfo: { name: "uploads-mcp", version: pkg.version },
    tools: createRemoteTools({
      env: c.env,
      workspace: c.get("workspace"),
      workspaceName: c.get("workspaceName"),
      authScopes: c.get("authScopes"),
      mintingUserId: c.get("mintingUserId") ?? null,
      resourceMetadataUrl: `${requestOrigin(c.req.url)}/.well-known/oauth-protected-resource`,
    }),
    validator,
  });
}

/**
 * Routes the two protocol eras explicitly rather than leaning on
 * `createMcpHandler`'s own legacy fallback, because that fallback constructs
 * its transport without `enableJsonResponse` and answers with an SSE stream
 * whenever the caller's `Accept` header permits one. Every existing
 * agents.uploads.sh caller receives plain JSON today, and this migration must
 * not silently change their wire shape — so the legacy leg is hand-wired to
 * be byte-identical to the pre-SDK behavior, while `legacy: "reject"` on the
 * modern leg is an unreachable safety net (isLegacyRequest already claimed
 * anything that would hit it).
 */
async function handleMcp(c: Context<WorkspaceVars>): Promise<Response> {
  if (await isLegacyRequest(c.req.raw)) {
    const server = buildServer(c);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      // Parse the body ourselves and hand it to the transport as
      // `parsedBody` (rather than letting it read `c.req.raw` itself): this
      // transport, unlike the retired hand-rolled core, does not reject a
      // JSON-RPC batch (array) body — the 2026-07-28 spec removed batching,
      // but this leg exists precisely to keep 2025-era callers byte-identical
      // to their pre-SDK behavior, so that rejection is preserved here.
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(await c.req.text());
      } catch {
        parsedBody = null;
      }
      if (Array.isArray(parsedBody)) {
        return c.json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
          200,
        );
      }
      return await transport.handleRequest(c.req.raw, { parsedBody });
    } finally {
      await server.close();
    }
  }

  const handler = createMcpHandler(() => buildServer(c), { legacy: "reject" });
  try {
    return await handler.fetch(c.req.raw);
  } finally {
    await handler.close();
  }
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
    // Plural, mirroring the ratified `server/discover` result. There is no
    // ratified server-card schema to key off — the `$schema` URL above 404s
    // and SEP-2127 is still an unmerged draft with a different shape — so the
    // discover result is the closest thing to an authority. Keep this list in
    // sync with apps/web/public/.well-known/mcp/server-card.json, which serves
    // the same document from the uploads.sh origin.
    supportedVersions: ["2026-07-28", "2025-06-18"],
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
      // server-card transport endpoint). Generic clients still copy the
      // origin into authorize `resource=`; the AS and this worker's JWT
      // `aud` list accept both forms. Do not switch this advertisement to
      // origin-only.
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
  .get("/robots.txt", (c) =>
    c.text(ROBOTS_TXT, 200, {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "text/plain; charset=utf-8",
    }),
  )
  // Public discovery — registered before /:workspace/* so ".well-known" is not a tenant.
  .get("/.well-known/mcp/server-card.json", (c) => c.json(mcpServerCard()))
  // OAuth Protected Resource Metadata (RFC 9728). Served at both the origin
  // root (where scanners probe) and the RFC path-suffixed location a strict
  // client derives from `resource` = `<origin>/mcp`.
  .get("/.well-known/oauth-protected-resource", respondProtectedResource)
  .get("/.well-known/oauth-protected-resource/mcp", respondProtectedResource)
  // OpenAI plugin portal domain verification. Must return only the token as
  // text/plain — no JSON, no extra bytes. 404 when the secret is unset so a
  // draft that hasn't been issued a token yet doesn't serve an empty body.
  .get("/.well-known/openai-apps-challenge", (c) => {
    const token = c.env.OPENAI_APPS_CHALLENGE?.trim();
    if (!token) throw new NotFoundError();
    return c.text(token, 200, {
      "Cache-Control": "public, max-age=60",
      "Content-Type": "text/plain; charset=utf-8",
    });
  })
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
