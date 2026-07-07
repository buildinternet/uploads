import { Hono } from "hono";
import { adminAuth } from "../admin";
import { sha256Hex, type WorkspaceRecord } from "../workspace";

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HASH_PREFIX_LEN = 8;

/** Token list for a record, migrating a legacy `tokenHash`-only record into the list shape. */
function migrateTokens(
  record: WorkspaceRecord,
): { hash: string; label?: string; createdAt: string }[] {
  return (
    record.tokens ??
    (record.tokenHash ? [{ hash: record.tokenHash, createdAt: new Date(0).toISOString() }] : [])
  );
}

export const admin = new Hono<{ Bindings: Env }>()
  .use("/*", adminAuth)

  // Mint a bearer token for an existing workspace (defaults to "default").
  .post("/tokens", async (c) => {
    const body = await c.req
      .json<{ workspace?: string; label?: string }>()
      .catch(() => ({}) as { workspace?: string; label?: string });
    const name = body.workspace?.trim() || "default";
    const label = body.label?.trim() || undefined;
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);

    // Read-modify-write, no locking: concurrent mints for the same workspace can race (last put wins, dropping a token). Acceptable for this admin-only PoC endpoint.
    const record = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json" });
    if (!record) return c.json({ error: "workspace not found" }, 404);

    const token = `up_${name}_${btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}`;
    const entry = { hash: await sha256Hex(token), label, createdAt: new Date().toISOString() };

    const tokens = migrateTokens(record);
    tokens.push(entry);
    const { tokenHash: _drop, ...rest } = record;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify({ ...rest, tokens }));

    return c.json({ workspace: name, token, label: label ?? null }, 201);
  })

  // List a workspace's tokens (defaults to "default"). Never returns the full
  // hash or raw token — only the 8-char hashPrefix, which is the revoke handle.
  .get("/tokens", async (c) => {
    const name = c.req.query("workspace")?.trim() || "default";
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);

    const record = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json" });
    if (!record) return c.json({ error: "workspace not found" }, 404);

    const tokens = migrateTokens(record).map((t) => ({
      label: t.label ?? null,
      createdAt: t.createdAt,
      hashPrefix: t.hash.slice(0, HASH_PREFIX_LEN),
    }));
    return c.json({ workspace: name, tokens });
  })

  // Revoke a token by { hashPrefix } or { label }. Migrates a legacy
  // tokenHash-only record into tokens[] first, then removes the match.
  // 404 when nothing matches, 409 when the selector is ambiguous.
  .delete("/tokens", async (c) => {
    const body = await c.req
      .json<{ workspace?: string; hashPrefix?: string; label?: string }>()
      .catch(() => ({}) as { workspace?: string; hashPrefix?: string; label?: string });
    const name = body.workspace?.trim() || "default";
    const hashPrefix = body.hashPrefix?.trim();
    const label = body.label?.trim();
    if (!WS_NAME_RE.test(name)) return c.json({ error: "invalid workspace" }, 400);
    if (!hashPrefix && !label) return c.json({ error: "hashPrefix or label required" }, 400);

    // Read-modify-write, no locking: a concurrent mint/revoke on the same workspace can race (last put wins). Acceptable for this admin-only PoC endpoint.
    const record = await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json" });
    if (!record) return c.json({ error: "workspace not found" }, 404);

    const tokens = migrateTokens(record);
    const matches = tokens.filter((t) =>
      hashPrefix ? t.hash.startsWith(hashPrefix) : t.label === label,
    );
    if (matches.length === 0) return c.json({ error: "no matching token" }, 404);
    if (matches.length > 1) return c.json({ error: "selector matches multiple tokens" }, 409);

    const revoked = matches[0];
    const remaining = tokens.filter((t) => t !== revoked);
    const { tokenHash: _drop, ...rest } = record;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify({ ...rest, tokens: remaining }));

    return c.json({
      workspace: name,
      revoked: { label: revoked.label ?? null, hashPrefix: revoked.hash.slice(0, HASH_PREFIX_LEN) },
    });
  });
