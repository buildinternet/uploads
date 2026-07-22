import { renderEnrollmentInvitationEmail } from "@uploads/email";
import {
  AppError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@uploads/errors";
import { Hono } from "hono";
import { adminAuth } from "../admin";
import {
  DEFAULT_ENROLLMENT_SECONDS,
  DEFAULT_TOKEN_SECONDS,
  FILE_SCOPES,
  MAX_TOKEN_SECONDS,
  createEnrollment,
  createToken,
  listTokens,
  parseScopes,
  revokeToken,
  validateScopes,
} from "../auth-db";
import { deriveWebOrigin, inviteLinkUrl as inviteMagicLink } from "../invite-links";
import { reencryptRegistryCredentials } from "../reencrypt-registry";
import { storage } from "../storage";
import { mutateWorkspaceRecord } from "../workspace-mutate";
import { teardownWorkspace } from "../workspace-teardown";
import {
  isPastGrace,
  isPurgedTombstone,
  loadWorkspaceRecordRaw,
  stampRestore,
  stampSoftDelete,
  type WorkspaceRecord,
} from "../workspace";

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HASH_PREFIX_LEN = 8;
const SECONDS_PER_DAY = 24 * 60 * 60;
// Ceiling for --expires-in. 24h caps how long a single-use invite secret can
// live; the floor stays 60s at the validation site below.
const MAX_ENROLLMENT_SECONDS = SECONDS_PER_DAY;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Invitations are delivered from this address; uploads.sh is onboarded for
// Cloudflare Email Sending, so any @uploads.sh sender works.
const INVITE_FROM = { name: "uploads.sh", email: "invites@uploads.sh" } as const;

function inviteEmail(to: string, workspaceName: string, link: string, expiresAt: string) {
  return {
    to,
    from: INVITE_FROM,
    ...renderEnrollmentInvitationEmail({ workspaceName, link, expiresAt }),
  };
}

interface LegacyToken {
  hash: string;
  label?: string;
  createdAt: string;
}

/** Token list for a record, migrating a legacy `tokenHash`-only record into the list shape. */
function legacyTokens(record: WorkspaceRecord): LegacyToken[] {
  return (
    record.tokens ??
    (record.tokenHash ? [{ hash: record.tokenHash, createdAt: new Date(0).toISOString() }] : [])
  );
}

async function workspace(c: { env: Env }, name: string): Promise<WorkspaceRecord | null> {
  return c.env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json" });
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function labelValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 100 ? label : null;
}

function requireWorkspaceName(name: string): void {
  if (!WS_NAME_RE.test(name)) {
    throw new ValidationError("invalid workspace", { code: "invalid_workspace" });
  }
}

function requireLabel(label: string | undefined | null): asserts label is string | undefined {
  if (label === null) {
    throw new ValidationError("label must be between 1 and 100 characters", {
      code: "invalid_label",
    });
  }
}

const EMAIL_VALID_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const admin = new Hono<{ Bindings: Env }>()
  .use("/*", adminAuth)

  // D9 fallback: ADMIN_TOKEN-gated first-admin/second-admin promotion,
  // proxying to the auth worker's internal-only promote-admin endpoint over
  // the AUTH service binding. Stays on adminAuth (not sessionAuth) — this is
  // explicitly the ops/CI fallback path, not part of the session-auth admin
  // UI surface (that's requireAdminUser, added alongside but not wired to any
  // route yet — see src/session-auth.ts).
  .post("/users/promote", async (c) => {
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email || !EMAIL_VALID_RE.test(email)) {
      throw new ValidationError("invalid email address", { code: "invalid_email" });
    }

    // x-uploads-internal marks this as a service-binding call (see
    // apps/auth/src/internal.ts); cf-connecting-ip is never set on a binding
    // fetch(), so there is nothing to strip here.
    const response = await c.env.AUTH.fetch("https://auth.internal/internal/promote-admin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-uploads-internal": "1" },
      body: JSON.stringify({ email }),
    });
    const payload = await response.json().catch(() => null);

    if (response.status === 404) {
      throw new NotFoundError("no user with that email", { code: "user_not_found" });
    }
    if (!response.ok) {
      throw new ValidationError("promote-admin failed", { details: payload });
    }
    return c.json(payload as object, 200);
  })

  // Phase 3 (plan scope B): one-time/idempotent backfill — creates an org
  // (slug = workspace name) for every KV workspace that doesn't have one yet.
  // Mirrors reencrypt-registry.ts's `ws:` KV pagination. ADMIN_TOKEN-gated
  // (this stays on the ops/CI `/admin` surface, not `/admin-ui`) since it's a
  // one-off migration operation, not part of the session-authenticated
  // admin dashboard.
  .post("/orgs/backfill", async (c) => {
    const created: string[] = [];
    const existing: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
      for (const entry of page.keys) {
        const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
        if (!name) continue;

        const response = await c.env.AUTH.fetch("https://auth.internal/internal/orgs", {
          method: "POST",
          headers: { "content-type": "application/json", "x-uploads-internal": "1" },
          body: JSON.stringify({ slug: name, name }),
        });
        if (!response.ok) {
          throw new ValidationError(`failed to create org for workspace "${name}"`, {
            details: await response.json().catch(() => null),
          });
        }
        if (response.status === 201) {
          created.push(name);
        } else {
          existing.push(name);
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    return c.json({ created, existing });
  })

  // Mint a scoped bearer token for an existing workspace (defaults to "default").
  // New credentials live in D1; legacy KV credentials remain readable/revocable.
  .post("/tokens", async (c) => {
    const body = await c.req
      .json<{
        workspace?: string;
        label?: string;
        scopes?: unknown;
        expiresInDays?: number;
      }>()
      .catch(
        () =>
          ({}) as {
            workspace?: string;
            label?: string;
            scopes?: unknown;
            expiresInDays?: number;
          },
      );
    const name = body.workspace?.trim() || "default";
    const label = labelValue(body.label);
    requireWorkspaceName(name);
    requireLabel(label);
    if (!(await workspace(c, name))) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const scopes = validateScopes(body.scopes, [...FILE_SCOPES]);
    if (!scopes) throw new ValidationError("invalid scopes", { code: "invalid_scopes" });
    if (
      body.expiresInDays !== undefined &&
      !validInteger(body.expiresInDays, 1, MAX_TOKEN_SECONDS / SECONDS_PER_DAY)
    ) {
      throw new ValidationError(
        `expiresInDays must be between 1 and ${MAX_TOKEN_SECONDS / SECONDS_PER_DAY}`,
        { code: "invalid_expires" },
      );
    }

    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;
    const created = await createToken(c.env.DB, {
      workspace: name,
      label,
      scopes,
      expiresAt,
    });
    return c.json(
      {
        workspace: name,
        token: created.token,
        label: label ?? null,
        scopes,
        expiresAt: created.record.expires_at,
      },
      201,
    );
  })

  // Create a one-time login code. The code itself is returned once and only its
  // hash is persisted. Exchanged tokens default to 90 days and read/write.
  .post("/enrollments", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req
      .json<{
        workspace?: string;
        label?: string;
        scopes?: unknown;
        enrollmentSeconds?: number;
        tokenExpiresInSeconds?: number;
        email?: string;
      }>()
      .catch(
        () =>
          ({}) as {
            workspace?: string;
            label?: string;
            scopes?: unknown;
            enrollmentSeconds?: number;
            tokenExpiresInSeconds?: number;
            email?: string;
          },
      );
    const name = body.workspace?.trim() || "default";
    const label = labelValue(body.label);
    requireWorkspaceName(name);
    requireLabel(label);
    if (!(await workspace(c, name))) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const scopes = validateScopes(body.scopes, ["files:read", "files:write"]);
    if (!scopes) throw new ValidationError("invalid scopes", { code: "invalid_scopes" });
    if (
      body.enrollmentSeconds !== undefined &&
      !validInteger(body.enrollmentSeconds, 60, MAX_ENROLLMENT_SECONDS)
    ) {
      throw new ValidationError(
        `enrollmentSeconds must be between 60 and ${MAX_ENROLLMENT_SECONDS}`,
        { code: "invalid_expires" },
      );
    }
    if (
      body.tokenExpiresInSeconds !== undefined &&
      !validInteger(body.tokenExpiresInSeconds, 60, MAX_TOKEN_SECONDS)
    ) {
      throw new ValidationError(
        `tokenExpiresInSeconds must be between 60 and ${MAX_TOKEN_SECONDS}`,
        { code: "invalid_expires" },
      );
    }

    const email = typeof body.email === "string" ? body.email.trim() : undefined;
    if (email !== undefined && !EMAIL_RE.test(email)) {
      throw new ValidationError("invalid email address", { code: "invalid_email" });
    }
    if (email) {
      // Rate-limit per recipient so invitations cannot be used to email-bomb a
      // victim, even with a valid admin token. Reuses the invite limiter namespace.
      const limiter = c.env.INVITE_LIMITER;
      if (limiter) {
        const { success } = await limiter.limit({ key: `invite:email:${email.toLowerCase()}` });
        if (!success) throw new RateLimitedError("invitation email rate limit exceeded");
      }
    }

    const enrollment = await createEnrollment(c.env.DB, {
      workspace: name,
      label,
      scopes,
      enrollmentSeconds: body.enrollmentSeconds ?? DEFAULT_ENROLLMENT_SECONDS,
      tokenSeconds: body.tokenExpiresInSeconds ?? DEFAULT_TOKEN_SECONDS,
    });

    let emailed: boolean | undefined;
    if (email) {
      const webOrigin = c.env.WEB_ORIGIN || deriveWebOrigin(c.req.url);
      const link = inviteMagicLink(webOrigin, enrollment.pageId, enrollment.code);
      try {
        await c.env.EMAIL.send(inviteEmail(email, name, link, enrollment.expiresAt));
        emailed = true;
        // Audit only non-secret metadata — never the code, magic link, or URL.
        console.log(
          JSON.stringify({
            event: "invite_emailed",
            workspace: name,
            recipient: email,
            pageId: enrollment.pageId,
          }),
        );
      } catch (error) {
        emailed = false;
        console.log(
          JSON.stringify({
            event: "invite_email_failed",
            workspace: name,
            recipient: email,
            pageId: enrollment.pageId,
            error: (error as { code?: string }).code ?? (error as Error).message,
          }),
        );
      }
    }

    return c.json({ workspace: name, label: label ?? null, scopes, emailed, ...enrollment }, 201);
  })

  // Lists D1 credentials and legacy KV credentials without exposing secrets.
  .get("/tokens", async (c) => {
    const name = c.req.query("workspace")?.trim() || "default";
    requireWorkspaceName(name);
    const record = await workspace(c, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const d1 = (await listTokens(c.env.DB, name)).map((token) => ({
      label: token.label,
      createdAt: token.created_at,
      hashPrefix: token.token_hash.slice(0, HASH_PREFIX_LEN),
      scopes: parseScopes(token.scopes),
      expiresAt: token.expires_at,
      revokedAt: token.revoked_at,
      source: "d1" as const,
    }));
    const legacy = legacyTokens(record).map((token) => ({
      label: token.label ?? null,
      createdAt: token.createdAt,
      hashPrefix: token.hash.slice(0, HASH_PREFIX_LEN),
      scopes: [...FILE_SCOPES],
      expiresAt: null,
      revokedAt: null,
      source: "legacy" as const,
    }));
    return c.json({ workspace: name, tokens: [...legacy, ...d1] });
  })

  // Revoke an active D1 or legacy KV token by hash prefix or label.
  .delete("/tokens", async (c) => {
    const body = await c.req
      .json<{ workspace?: string; hashPrefix?: string; label?: string }>()
      .catch(() => ({}) as { workspace?: string; hashPrefix?: string; label?: string });
    const name = body.workspace?.trim() || "default";
    const hashPrefix = body.hashPrefix?.trim();
    const label = body.label?.trim();
    requireWorkspaceName(name);
    if (!hashPrefix && !label) {
      throw new ValidationError("hashPrefix or label required", {
        code: "hash_prefix_or_label_required",
      });
    }

    const record = await workspace(c, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const kv = legacyTokens(record);
    const kvMatches = kv.filter((token) =>
      hashPrefix ? token.hash.startsWith(hashPrefix) : token.label === label,
    );
    const activeD1 = (await listTokens(c.env.DB, name)).filter(
      (token) =>
        token.revoked_at === null &&
        (hashPrefix ? token.token_hash.startsWith(hashPrefix) : token.label === label),
    );
    const count = kvMatches.length + activeD1.length;
    if (count === 0) throw new NotFoundError("no matching token");
    if (count > 1) throw new ConflictError("selector matches multiple tokens");

    if (activeD1.length === 1) {
      const result = await revokeToken(c.env.DB, name, { hashPrefix, label });
      if (!result.match) throw new NotFoundError("no matching token");
      return c.json({
        workspace: name,
        revoked: {
          label: result.match.label,
          hashPrefix: result.match.token_hash.slice(0, HASH_PREFIX_LEN),
        },
      });
    }

    const revoked = kvMatches[0];
    // Re-derive the surviving list from the freshest record inside the
    // mutation (issue #387) — filtering the snapshot read above would restore
    // a token another request revoked in the meantime.
    await mutateWorkspaceRecord(c.env, name, (current) => {
      const { tokenHash: _drop, ...rest } = current;
      return {
        ...rest,
        tokens: legacyTokens(current).filter((token) => token.hash !== revoked.hash),
      };
    });
    return c.json({
      workspace: name,
      revoked: { label: revoked.label ?? null, hashPrefix: revoked.hash.slice(0, HASH_PREFIX_LEN) },
    });
  })

  /**
   * Re-seal BYO S3 credentials under WORKSPACE_SECRETS_KEY (current).
   * Decrypt tries current then WORKSPACE_SECRETS_KEY_PREVIOUS.
   * Prefer this over a laptop script so the KEK never leaves the worker.
   * Query: ?dryRun=1
   */
  .post("/credentials/reencrypt", async (c) => {
    const dryRun =
      c.req.query("dryRun") === "1" ||
      c.req.query("dryRun") === "true" ||
      c.req.query("dry_run") === "1";
    try {
      const result = await reencryptRegistryCredentials(c.env, { dryRun });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(message, { cause: err });
    }
  })

  /**
   * Admin-gated workspace teardown (v1 — see issue #241; soft-by-default —
   * see #247). Session-authed self-serve delete is deliberately out of scope
   * here; this is the ops/CI break-glass path, same as `/tokens` and
   * `/enrollments` above.
   *
   * Default (no `?hard=1`): **soft delete**. Stamps `deletedAt`/`purgeAt`
   * (14-day grace window) on the record and puts it back — access denies at
   * the record layer (`loadWorkspaceRecord` treats a `deletedAt` record as
   * not found; its 60s KV cacheTtl means auth may trail up to a minute),
   * data untouched. Deleting an already-soft-deleted workspace 409s.
   * The daily retention sweep finalizes (full hard teardown + permanent
   * purged tombstone) once `purgeAt` passes.
   *
   * `?hard=1`: immediate permanent teardown via `teardownWorkspace` — R2
   * objects, file_metadata + galleries rows, best-effort auth org, then the
   * `ws:<name>` KV key is deleted outright (the only path that frees the
   * slug). Non-empty workspaces still require `?force=1` on top.
   */
  .delete("/workspaces/:name", async (c) => {
    const name = c.req.param("name");
    requireWorkspaceName(name);

    const raw = await loadWorkspaceRecordRaw(c.env, name);
    if (!raw || isPurgedTombstone(raw)) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const record = raw;

    const hard = c.req.query("hard") === "1" || c.req.query("hard") === "true";
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";

    if (!hard) {
      // The already-deleted guard lives inside the mutation so it sees the
      // record actually being overwritten, not the snapshot above (#387).
      const updated = await mutateWorkspaceRecord(c.env, name, (current) => {
        if (current.deletedAt) {
          throw new ConflictError("workspace is already soft-deleted", {
            code: "already_deleted",
            details: { deletedAt: current.deletedAt, purgeAt: current.purgeAt },
          });
        }
        return stampSoftDelete(current);
      });

      console.log(
        JSON.stringify({
          event: "workspace_deleted",
          workspace: name,
          mode: "soft",
          purgeAt: updated.purgeAt,
        }),
      );

      return c.json({
        ok: true,
        workspace: name,
        mode: "soft",
        deletedAt: updated.deletedAt,
        purgeAt: updated.purgeAt,
      });
    }

    // Hard path: count objects up front so the not-empty guard still applies
    // without force, mirroring the previous behavior.
    if (!force) {
      const store = await storage(c.env, record);
      let objectCount = 0;
      for await (const _item of store.listAll()) objectCount += 1;
      if (objectCount > 0) {
        throw new ConflictError(
          `workspace has ${objectCount} object(s); retry with ?force=1 to delete them too`,
          { code: "workspace_not_empty", details: { objectCount } },
        );
      }
    }

    // Stamp the record non-serving before any destructive step: if teardown
    // crashes partway, the workspace denies access instead of serving a
    // half-wiped state, and the retention sweep finalizes it (purgeAt is
    // already past) on its next run. Already soft-deleted -> nothing to write.
    const now = new Date().toISOString();
    await mutateWorkspaceRecord(c.env, name, (current) =>
      current.deletedAt ? null : { ...current, deletedAt: now, purgeAt: now },
    );

    const result = await teardownWorkspace(c.env, name, record, {
      reason: "admin_hard_delete",
      force: true,
    });

    return c.json({
      ok: true,
      workspace: name,
      mode: "hard",
      deleted: true,
      forced: force,
      objectsDeleted: result.objectsDeleted,
      freedBytes: result.freedBytes,
      galleriesDeleted: result.galleriesDeleted,
    });
  })

  /**
   * Undelete a soft-deleted workspace within its grace window. 404 if the
   * workspace never existed or is already a purged tombstone; 409
   * `not_deleted` if it isn't currently soft-deleted; 410 `grace_expired`
   * once `purgeAt` has passed (even if the sweep hasn't finalized it yet —
   * restorability must not depend on cron timing).
   */
  .post("/workspaces/:name/restore", async (c) => {
    const name = c.req.param("name");
    requireWorkspaceName(name);

    const raw = await loadWorkspaceRecordRaw(c.env, name);
    if (!raw || isPurgedTombstone(raw)) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    // Both guards run against the freshest record inside the mutation (#387):
    // a restore must not resurrect a workspace whose grace window expired
    // between this handler's read and its write.
    await mutateWorkspaceRecord(c.env, name, (current) => {
      if (!current.deletedAt) {
        throw new ConflictError("workspace is not deleted", { code: "not_deleted" });
      }
      if (isPastGrace(current.purgeAt)) {
        throw new AppError({
          type: "conflict",
          code: "grace_expired",
          message: "grace period has expired",
          status: 410,
        });
      }
      return stampRestore(current);
    });

    console.log(JSON.stringify({ event: "workspace_restored", workspace: name }));

    return c.json({ ok: true, workspace: name });
  });
