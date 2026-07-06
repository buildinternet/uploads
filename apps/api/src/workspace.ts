import type { MiddlewareHandler } from "hono";
import type { StorageProvider } from "@uploads/storage";

/**
 * A workspace is a tenant: its own bucket, credentials, and auth token.
 * Records live in the REGISTRY KV namespace under `ws:<name>`; secrets in the
 * record are a SHA-256 token hash plus (optional) bucket-scoped S3 keys.
 */
export interface WorkspaceRecord {
  provider: StorageProvider;
  bucket: string;
  /** Name of an R2 binding declared in wrangler.jsonc (e.g. "UPLOADS"). When set, I/O uses the binding. */
  binding?: string;
  /** Public custom domain for this workspace's bucket. */
  publicBaseUrl?: string;
  /** SHA-256 hex of the workspace's bearer token. */
  tokenHash: string;
  /** HTTP credentials — presigning, or I/O for workspaces without a binding. */
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export type WorkspaceVars = {
  Variables: { workspace: WorkspaceRecord; workspaceName: string };
  Bindings: Env;
};

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolves `:workspace` from the path, verifies the bearer token against the
 * workspace's stored token hash, and puts the record on the context.
 * 404 for unknown workspaces only after the token check, so probing for
 * workspace names requires no fewer requests than probing tokens.
 */
export const workspaceAuth: MiddlewareHandler<WorkspaceVars> = async (c, next) => {
  const name = c.req.param("workspace");
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  const record =
    name && WS_NAME_RE.test(name)
      ? await c.env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json", cacheTtl: 60 })
      : null;

  // Always burn a hash + compare, even for unknown workspaces.
  const providedHash = await sha256Hex(token);
  const expectedHash = record?.tokenHash ?? providedHash.replace(/./g, "0");
  const ok =
    record !== null &&
    token.length > 0 &&
    crypto.subtle.timingSafeEqual(hexToBytes(providedHash), hexToBytes(expectedHash));

  if (!ok || !record || !name) return c.json({ error: "unauthorized" }, 401);

  c.set("workspace", record);
  c.set("workspaceName", name);
  await next();
};
