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
import { reencryptRegistryCredentials } from "../reencrypt-registry";
import type { WorkspaceRecord } from "../workspace";

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HASH_PREFIX_LEN = 8;
const MAX_ENROLLMENT_SECONDS = 60 * 60;
const SECONDS_PER_DAY = 24 * 60 * 60;

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

export const admin = new Hono<{ Bindings: Env }>()
  .use("/*", adminAuth)

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
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);
    if (label === null) return c.json({ error: "label must be between 1 and 100 characters" }, 400);
    if (!(await workspace(c, name))) return c.json({ error: "workspace not found" }, 404);

    const scopes = validateScopes(body.scopes, [...FILE_SCOPES]);
    if (!scopes) return c.json({ error: "invalid scopes" }, 400);
    if (
      body.expiresInDays !== undefined &&
      !validInteger(body.expiresInDays, 1, MAX_TOKEN_SECONDS / SECONDS_PER_DAY)
    ) {
      return c.json(
        { error: `expiresInDays must be between 1 and ${MAX_TOKEN_SECONDS / SECONDS_PER_DAY}` },
        400,
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
      }>()
      .catch(
        () =>
          ({}) as {
            workspace?: string;
            label?: string;
            scopes?: unknown;
            enrollmentSeconds?: number;
            tokenExpiresInSeconds?: number;
          },
      );
    const name = body.workspace?.trim() || "default";
    const label = labelValue(body.label);
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);
    if (label === null) return c.json({ error: "label must be between 1 and 100 characters" }, 400);
    if (!(await workspace(c, name))) return c.json({ error: "workspace not found" }, 404);

    const scopes = validateScopes(body.scopes, ["files:read", "files:write"]);
    if (!scopes) return c.json({ error: "invalid scopes" }, 400);
    if (
      body.enrollmentSeconds !== undefined &&
      !validInteger(body.enrollmentSeconds, 60, MAX_ENROLLMENT_SECONDS)
    ) {
      return c.json(
        { error: `enrollmentSeconds must be between 60 and ${MAX_ENROLLMENT_SECONDS}` },
        400,
      );
    }
    if (
      body.tokenExpiresInSeconds !== undefined &&
      !validInteger(body.tokenExpiresInSeconds, 60, MAX_TOKEN_SECONDS)
    ) {
      return c.json(
        { error: `tokenExpiresInSeconds must be between 60 and ${MAX_TOKEN_SECONDS}` },
        400,
      );
    }

    const enrollment = await createEnrollment(c.env.DB, {
      workspace: name,
      label,
      scopes,
      enrollmentSeconds: body.enrollmentSeconds ?? DEFAULT_ENROLLMENT_SECONDS,
      tokenSeconds: body.tokenExpiresInSeconds ?? DEFAULT_TOKEN_SECONDS,
    });
    return c.json({ workspace: name, label: label ?? null, scopes, ...enrollment }, 201);
  })

  // Lists D1 credentials and legacy KV credentials without exposing secrets.
  .get("/tokens", async (c) => {
    const name = c.req.query("workspace")?.trim() || "default";
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);
    const record = await workspace(c, name);
    if (!record) return c.json({ error: "workspace not found" }, 404);

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
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);
    if (!hashPrefix && !label) return c.json({ error: "hashPrefix or label required" }, 400);

    const record = await workspace(c, name);
    if (!record) return c.json({ error: "workspace not found" }, 404);
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
    if (count === 0) return c.json({ error: "no matching token" }, 404);
    if (count > 1) return c.json({ error: "selector matches multiple tokens" }, 409);

    if (activeD1.length === 1) {
      const result = await revokeToken(c.env.DB, name, { hashPrefix, label });
      if (!result.match) return c.json({ error: "no matching token" }, 404);
      return c.json({
        workspace: name,
        revoked: {
          label: result.match.label,
          hashPrefix: result.match.token_hash.slice(0, HASH_PREFIX_LEN),
        },
      });
    }

    const revoked = kvMatches[0];
    const remaining = kv.filter((token) => token !== revoked);
    const { tokenHash: _drop, ...rest } = record;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify({ ...rest, tokens: remaining }));
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
      return c.json({ error: message }, 400);
    }
  });
