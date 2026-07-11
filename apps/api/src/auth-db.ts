import { sha256Hex } from "./workspace";

export const FILE_SCOPES = ["files:read", "files:write", "files:delete"] as const;
export type FileScope = (typeof FILE_SCOPES)[number];

// Invite code lifetime. 2h gives a human time to onboard after receiving the
// link out-of-band, while keeping the single-use secret short-lived. Override
// per-invite with --expires-in up to MAX_ENROLLMENT_SECONDS (see routes/admin).
export const DEFAULT_ENROLLMENT_SECONDS = 2 * 60 * 60;
export const DEFAULT_TOKEN_SECONDS = 90 * 24 * 60 * 60;
export const MAX_TOKEN_SECONDS = 365 * 24 * 60 * 60;

export interface AuthTokenRecord {
  id: string;
  workspace: string;
  token_hash: string;
  label: string | null;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface EnrollmentRecord {
  id: string;
  workspace: string;
  code_hash: string;
  label: string | null;
  scopes: string;
  created_at: string;
  expires_at: string;
  token_expires_at: string;
  used_at: string | null;
  page_id: string | null;
}

export function parseScopes(value: string): FileScope[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isFileScope)) return [];
    return [...new Set(parsed)];
  } catch {
    return [];
  }
}

export function isFileScope(value: unknown): value is FileScope {
  return typeof value === "string" && FILE_SCOPES.includes(value as FileScope);
}

export function validateScopes(value: unknown, defaults: FileScope[]): FileScope[] | null {
  if (value === undefined) return defaults;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isFileScope)) return null;
  return [...new Set(value)];
}

function randomSecret(prefix: string, bytes = 24): string {
  return `${prefix}${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

function id(): string {
  return crypto.randomUUID();
}

export async function findActiveToken(
  db: D1Database,
  workspace: string,
  rawToken: string,
  now = new Date(),
): Promise<AuthTokenRecord | null> {
  if (!rawToken) return null;
  const hash = await sha256Hex(rawToken);
  return db
    .prepare(
      `SELECT id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at
       FROM auth_tokens
       WHERE workspace = ? AND token_hash = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
    )
    .bind(workspace, hash, now.toISOString())
    .first<AuthTokenRecord>();
}

export async function createToken(
  db: D1Database,
  input: {
    workspace: string;
    label?: string;
    scopes: FileScope[];
    expiresAt?: Date;
    now?: Date;
  },
): Promise<{ token: string; record: AuthTokenRecord }> {
  const token = randomSecret(`up_${input.workspace}_`);
  const now = input.now ?? new Date();
  const record: AuthTokenRecord = {
    id: id(),
    workspace: input.workspace,
    token_hash: await sha256Hex(token),
    label: input.label ?? null,
    scopes: JSON.stringify(input.scopes),
    created_at: now.toISOString(),
    expires_at: input.expiresAt?.toISOString() ?? null,
    revoked_at: null,
  };
  await db
    .prepare(
      `INSERT INTO auth_tokens
       (id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      record.id,
      record.workspace,
      record.token_hash,
      record.label,
      record.scopes,
      record.created_at,
      record.expires_at,
    )
    .run();
  return { token, record };
}

export async function createEnrollment(
  db: D1Database,
  input: {
    workspace: string;
    label?: string;
    scopes: FileScope[];
    enrollmentSeconds?: number;
    tokenSeconds?: number;
    now?: Date;
  },
): Promise<{ pageId: string; code: string; expiresAt: string; tokenExpiresAt: string }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.enrollmentSeconds ?? DEFAULT_ENROLLMENT_SECONDS) * 1000,
  );
  const tokenExpiresAt = new Date(
    now.getTime() + (input.tokenSeconds ?? DEFAULT_TOKEN_SECONDS) * 1000,
  );
  const code = randomSecret("upe_", 18);
  const pageId = randomSecret("upi_", 12);
  await db
    .prepare(
      `INSERT INTO auth_enrollments
       (id, workspace, code_hash, label, scopes, created_at, expires_at, token_expires_at, used_at,
        page_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      id(),
      input.workspace,
      await sha256Hex(code),
      input.label ?? null,
      JSON.stringify(input.scopes),
      now.toISOString(),
      expiresAt.toISOString(),
      tokenExpiresAt.toISOString(),
      pageId,
    )
    .run();
  return {
    pageId,
    code,
    expiresAt: expiresAt.toISOString(),
    tokenExpiresAt: tokenExpiresAt.toISOString(),
  };
}

export async function findEnrollmentPage(
  db: D1Database,
  pageId: string,
  now = new Date(),
): Promise<{ expiresAt: string; used: boolean } | null> {
  if (!/^upi_[A-Za-z0-9_-]{16}$/.test(pageId)) return null;
  const record = await db
    .prepare(
      `SELECT expires_at, used_at FROM auth_enrollments
       WHERE page_id = ? AND expires_at > ? LIMIT 1`,
    )
    .bind(pageId, now.toISOString())
    .first<Pick<EnrollmentRecord, "expires_at" | "used_at">>();
  return record ? { expiresAt: record.expires_at, used: record.used_at !== null } : null;
}

export async function exchangeEnrollment(
  db: D1Database,
  code: string,
  now = new Date(),
): Promise<{ workspace: string; token: string; scopes: FileScope[]; expiresAt: string } | null> {
  if (!/^upe_[A-Za-z0-9_-]{20,}$/.test(code)) return null;
  const nowIso = now.toISOString();
  const codeHash = await sha256Hex(code);
  const enrollment = await db
    .prepare(
      `SELECT id, workspace, code_hash, label, scopes, created_at, expires_at,
              token_expires_at, used_at
       FROM auth_enrollments
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
       LIMIT 1`,
    )
    .bind(codeHash, nowIso)
    .first<EnrollmentRecord>();
  if (!enrollment) return null;

  const scopes = parseScopes(enrollment.scopes);
  if (scopes.length === 0) return null;
  const token = randomSecret(`up_${enrollment.workspace}_`);
  const tokenId = id();
  const tokenHash = await sha256Hex(token);
  // D1 batch statements execute as one transaction. The INSERT reads directly
  // from the still-active enrollment, then the UPDATE consumes it. A replay or
  // concurrent loser changes zero rows and receives no token; any statement
  // error rolls back both operations.
  const [inserted, consumed] = await db.batch([
    db
      .prepare(
        `INSERT INTO auth_tokens
         (id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at)
         SELECT ?, workspace, ?, label, scopes, ?, token_expires_at, NULL
         FROM auth_enrollments
         WHERE id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .bind(tokenId, tokenHash, nowIso, enrollment.id, codeHash, nowIso),
    db
      .prepare(
        `UPDATE auth_enrollments SET used_at = ?
         WHERE id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .bind(nowIso, enrollment.id, codeHash, nowIso),
  ]);
  if (inserted.meta.changes !== 1 || consumed.meta.changes !== 1) return null;
  return {
    workspace: enrollment.workspace,
    token,
    scopes,
    expiresAt: enrollment.token_expires_at,
  };
}

export async function listTokens(db: D1Database, workspace: string): Promise<AuthTokenRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at
       FROM auth_tokens WHERE workspace = ? ORDER BY created_at ASC`,
    )
    .bind(workspace)
    .all<AuthTokenRecord>();
  return result.results;
}

export async function revokeToken(
  db: D1Database,
  workspace: string,
  selector: { hashPrefix?: string; label?: string },
  now = new Date(),
): Promise<{ match: AuthTokenRecord | null; ambiguous: boolean }> {
  const tokens = (await listTokens(db, workspace)).filter((token) => token.revoked_at === null);
  const matches = tokens.filter((token) =>
    selector.hashPrefix
      ? token.token_hash.startsWith(selector.hashPrefix)
      : token.label === selector.label,
  );
  if (matches.length !== 1) return { match: null, ambiguous: matches.length > 1 };
  const match = matches[0];
  await db
    .prepare(`UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now.toISOString(), match.id)
    .run();
  return { match, ambiguous: false };
}
