/**
 * POST /v1/workspaces (spec 2026-07-14): self-serve workspace creation.
 * Session-authed; requires a GitHub-linked account; creates the backing org
 * (with the caller as owner) over the AUTH binding, then writes the KV
 * ws:<name> record with the self-serve limit template. Org first, KV second,
 * with a compensating org delete when the KV write fails.
 */
import { ConflictError, ForbiddenError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { allowWorkspaceCreate } from "../guards";
import { deleteOrg, isGithubLinked, membershipsForUser, provisionOrg } from "../org-workspaces";
import { selfServeWorkspaceRecord } from "../self-serve-defaults";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { validateSlug } from "../slug-policy";
import { loadWorkspaceRecord } from "../workspace";

const MAX_BODY_BYTES = 1024;
export const MAX_SELF_SERVE_WORKSPACES = 3;

export const workspaces = new Hono<SessionVars>().post(
  "/",
  sessionAuth,
  requireSessionUser,
  async (c) => {
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
    const name =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? String((parsed as Record<string, unknown>).name ?? "").trim()
        : "";

    const verdict = validateSlug(name);
    if (!verdict.ok) {
      throw new ValidationError("workspace name is invalid or unavailable", {
        code: verdict.code,
      });
    }

    const user = c.get("sessionUser")!;

    // Rate-limit before the GitHub round-trip so unthrottled probes can't
    // hammer the auth worker. Dedicated strict limiter (3/60s, matching the
    // create cap) rather than the shared WRITE_LIMITER — that keeps
    // concurrent requests from racing past the per-user cap check below.
    if (!(await allowWorkspaceCreate(c.env, user.id))) {
      throw new RateLimitedError("workspace creation rate limit exceeded");
    }

    if (!(await isGithubLinked(c.env, user.id))) {
      throw new ForbiddenError("connect a GitHub account to create workspaces", {
        code: "github_required",
      });
    }

    // Cap counts only self-serve workspaces the user OWNS — BYO/operator
    // workspaces (no selfServe flag) never burn the allowance.
    const memberships = await membershipsForUser(c.env, user.id);
    const owned = memberships.filter((m) => m.role === "owner");
    const records = await Promise.all(
      owned.map((m) => loadWorkspaceRecord(c.env, m.organizationSlug)),
    );
    const selfServeCount = records.filter((r) => r?.selfServe === true).length;
    if (selfServeCount >= MAX_SELF_SERVE_WORKSPACES) {
      throw new ForbiddenError(`workspace limit reached (${MAX_SELF_SERVE_WORKSPACES})`, {
        code: "workspace_cap_reached",
      });
    }

    // Direct KV read (no cacheTtl) — a 60s-stale cached miss here could let a
    // just-taken name through to the org 409 instead, which is fine, but a
    // stale HIT must not block a genuinely free name.
    const existing = await c.env.REGISTRY.get(`ws:${name}`);
    if (existing !== null) {
      throw new ConflictError("workspace name is taken", { code: "workspace_name_taken" });
    }

    // Org first (owns uniqueness via UNIQUE slug), KV second, compensate on failure.
    await provisionOrg(c.env, { slug: name, ownerUserId: user.id });
    const record = selfServeWorkspaceRecord({ name, userId: user.id, now: new Date() });
    try {
      await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    } catch (err) {
      // Best-effort rollback; if this also fails the org is inert (no KV
      // record → no storage access) and an admin can clean it up.
      await deleteOrg(c.env, name).catch(() => {});
      throw err;
    }

    return c.json(
      { workspace: { name, publicBaseUrl: record.publicBaseUrl, selfServe: true } },
      201,
    );
  },
);
