import { Hono } from "hono";
import { adminAuth } from "../admin";
import { sha256Hex, type WorkspaceRecord } from "../workspace";

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

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

    const token = `up_${name}_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const entry = { hash: await sha256Hex(token), label, createdAt: new Date().toISOString() };

    const tokens = record.tokens ?? (record.tokenHash ? [{ hash: record.tokenHash, createdAt: entry.createdAt }] : []);
    tokens.push(entry);
    const { tokenHash: _drop, ...rest } = record;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify({ ...rest, tokens }));

    return c.json({ workspace: name, token, label: label ?? null }, 201);
  });
