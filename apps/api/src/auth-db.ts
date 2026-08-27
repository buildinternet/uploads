import { sha256Hex } from "./workspace";
import { type D1Queryable } from "./db-session";

export const FILE_SCOPES = ["files:read", "files:write", "files:delete"] as const;
export type FileScope = (typeof FILE_SCOPES)[number];

// Operator/admin scopes for session-minted tokens (issue #257). Never granted
// by default — only when explicitly requested by a session user holding the
// better-auth `admin` role (see routes/tokens.ts). Distinct from FILE_SCOPES
// so existing file-scope-only callers (routes/admin.ts, routes/admin-ui.ts)
// can't accidentally accept them.
export const OPERATOR_SCOPES = ["operator:read", "operator:write"] as const;
export type OperatorScope = (typeof OPERATOR_SCOPES)[number];

export function isOperatorScope(value: unknown): value is OperatorScope {
  return typeof value === "string" && OPERATOR_SCOPES.includes(value as OperatorScope);
}

// Workspace-governance scopes for session-minted tokens (issue #262). Like
// OPERATOR_SCOPES, never granted by default — only when explicitly requested
// by a session user holding org role `admin`/`owner` in the target workspace
// (see routes/tokens.ts mint handler). A `workspace:*` token authorizes
// governance actions (e.g. inviting members) only on the workspace embedded
// in the token; it carries zero file access (parseScopes rejects it outright).
export const WORKSPACE_SCOPES = ["workspace:invite", "workspace:manage"] as const;
export type WorkspaceScope = (typeof WORKSPACE_SCOPES)[number];

export function isWorkspaceScope(value: unknown): value is WorkspaceScope {
  return typeof value === "string" && WORKSPACE_SCOPES.includes(value as WorkspaceScope);
}

// Invite code lifetime. 2h gives a human time to onboard after receiving the
// link out-of-band, while keeping the single-use secret short-lived. Override
// per-invite with --expires-in up to MAX_ENROLLMENT_SECONDS (see routes/admin).
export const DEFAULT_ENROLLMENT_SECONDS = 2 * 60 * 60;
export const DEFAULT_TOKEN_SECONDS = 90 * 24 * 60 * 60;
export const MAX_TOKEN_SECONDS = 365 * 24 * 60 * 60;
/** How stale last_used_at must be before a successful auth rewrites it. */
export const LAST_USED_TOUCH_SECONDS = 60 * 60;

const TOKEN_COLUMNS = `id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at,
              minting_user_id, last_used_at`;

export interface AuthTokenRecord {
  id: string;
  workspace: string;
  token_hash: string;
  label: string | null;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  // Better Auth user id that minted this token (POST /v1/tokens), or null for
  // enrollment-code tokens and rows created before the Phase 4 migration.
  minting_user_id: string | null;
  last_used_at: string | null;
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

/** One outstanding (unredeemed, unexpired) invite-link enrollment, as
 * surfaced to the admin panel — deliberately excludes `code_hash`: a listed
 * link's URL can never be reconstructed, only revoked. */
export interface OpenEnrollment {
  id: string;
  pageId: string | null;
  label: string | null;
  scopes: FileScope[];
  createdAt: string;
  expiresAt: string;
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

export function validateScopes(value: unknown, defaults: FileScope[]): FileScope[] | null;
export function validateScopes(
  value: unknown,
  defaults: FileScope[],
  opts: { allowOperator?: boolean; allowWorkspace?: boolean },
): (FileScope | OperatorScope | WorkspaceScope)[] | null;
export function validateScopes(
  value: unknown,
  defaults: FileScope[],
  opts?: { allowOperator?: boolean; allowWorkspace?: boolean },
): (FileScope | OperatorScope | WorkspaceScope)[] | null {
  if (value === undefined) return defaults;
  if (!Array.isArray(value) || value.length === 0) return null;
  const isValid = (v: unknown) =>
    isFileScope(v) ||
    (opts?.allowOperator === true && isOperatorScope(v)) ||
    (opts?.allowWorkspace === true && isWorkspaceScope(v));
  if (!value.every(isValid)) return null;
  return [...new Set(value)] as (FileScope | OperatorScope | WorkspaceScope)[];
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
  db: D1Queryable,
  workspace: string,
  rawToken: string,
  now = new Date(),
): Promise<AuthTokenRecord | null> {
  if (!rawToken) return null;
  const hash = await sha256Hex(rawToken);
  return db
    .prepare(
      `SELECT ${TOKEN_COLUMNS}
       FROM auth_tokens
       WHERE workspace = ? AND token_hash = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
    )
    .bind(workspace, hash, now.toISOString())
    .first<AuthTokenRecord>();
}

export interface CreateTokenInput {
  workspace: string;
  label?: string;
  // Widened beyond FileScope so admin-scoped operator tokens (issue #257) and
  // workspace-governance tokens (issue #262) can be minted through the same
  // path; storage is just a JSON TEXT column.
  scopes: (FileScope | OperatorScope | WorkspaceScope)[];
  expiresAt?: Date;
  mintedByUserId?: string | null;
  now?: Date;
}

/**
 * Mint a fresh secret and its row *without writing it*. The plaintext `token`
 * is returned once and never persisted (only its hash lives in `record`).
 * Split out from {@link createToken} so retry-safe minting can insert the row
 * inside a larger idempotency batch — see `token-idempotency.ts`.
 */
export async function buildTokenRecord(
  input: CreateTokenInput,
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
    minting_user_id: input.mintedByUserId ?? null,
    last_used_at: null,
  };
  return { token, record };
}

/**
 * Build the `auth_tokens` insert, optionally gated by another row (e.g. an
 * owned idempotency claim). Uses `INSERT … SELECT … WHERE` so the guard is
 * evaluated atomically with the insert. `revoked_at`/`last_used_at` are always
 * NULL at creation. `meta.changes > 0` means the row was written.
 */
export function prepareTokenInsert(
  db: D1Queryable,
  record: AuthTokenRecord,
  condition?: { sql: string; values: unknown[] },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO auth_tokens
       (id, workspace, token_hash, label, scopes, created_at, expires_at, revoked_at,
        minting_user_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?
       ${condition ? `WHERE (${condition.sql})` : ""}`,
    )
    .bind(
      record.id,
      record.workspace,
      record.token_hash,
      record.label,
      record.scopes,
      record.created_at,
      record.expires_at,
      record.minting_user_id,
      ...(condition?.values ?? []),
    );
}

export async function createToken(
  db: D1Queryable,
  input: CreateTokenInput,
): Promise<{ token: string; record: AuthTokenRecord }> {
  const built = await buildTokenRecord(input);
  await prepareTokenInsert(db, built.record).run();
  return built;
}

export async function createEnrollment(
  db: D1Queryable,
  input: {
    workspace: string;
    label?: string;
    scopes: FileScope[];
    enrollmentSeconds?: number;
    tokenSeconds?: number;
    now?: Date;
  },
): Promise<{
  id: string;
  pageId: string;
  code: string;
  expiresAt: string;
  tokenExpiresAt: string;
}> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.enrollmentSeconds ?? DEFAULT_ENROLLMENT_SECONDS) * 1000,
  );
  const tokenExpiresAt = new Date(
    now.getTime() + (input.tokenSeconds ?? DEFAULT_TOKEN_SECONDS) * 1000,
  );
  const code = randomSecret("upe_", 18);
  const pageId = randomSecret("upi_", 12);
  const enrollmentId = id();
  await db
    .prepare(
      `INSERT INTO auth_enrollments
       (id, workspace, code_hash, label, scopes, created_at, expires_at, token_expires_at, used_at,
        page_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      enrollmentId,
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
    id: enrollmentId,
    pageId,
    code,
    expiresAt: expiresAt.toISOString(),
    tokenExpiresAt: tokenExpiresAt.toISOString(),
  };
}

/**
 * Outstanding (unredeemed, unexpired) invite-link enrollments for a
 * workspace, newest first — backs the admin panel's invite-link list. Never
 * selects `code_hash`; the plaintext code is never stored either, so a
 * listed link's URL can't be reconstructed (show-once stays show-once).
 */
export async function listOpenEnrollments(
  db: D1Queryable,
  workspace: string,
  now = new Date(),
): Promise<OpenEnrollment[]> {
  const result = await db
    .prepare(
      `SELECT id, page_id, label, scopes, created_at, expires_at
       FROM auth_enrollments
       WHERE workspace = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .bind(workspace, now.toISOString())
    .all<
      Pick<EnrollmentRecord, "id" | "page_id" | "label" | "scopes" | "created_at" | "expires_at">
    >();
  return result.results.map((row) => ({
    id: row.id,
    pageId: row.page_id,
    label: row.label,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

/**
 * Delete one outstanding enrollment, scoped by both workspace and id so an
 * admin can't revoke another workspace's link. Returns whether a row was
 * actually deleted (false for an unknown id or one owned by another
 * workspace — same 404 either way at the route layer).
 */
export async function revokeEnrollment(
  db: D1Queryable,
  workspace: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM auth_enrollments WHERE workspace = ? AND id = ?`)
    .bind(workspace, id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function findEnrollmentPage(
  db: D1Queryable,
  pageId: string,
  now = new Date(),
): Promise<{ workspace: string; expiresAt: string; used: boolean } | null> {
  if (!/^upi_[A-Za-z0-9_-]{16}$/.test(pageId)) return null;
  const record = await db
    .prepare(
      `SELECT workspace, expires_at, used_at FROM auth_enrollments
       WHERE page_id = ? AND expires_at > ? LIMIT 1`,
    )
    .bind(pageId, now.toISOString())
    .first<Pick<EnrollmentRecord, "workspace" | "expires_at" | "used_at">>();
  return record
    ? { workspace: record.workspace, expiresAt: record.expires_at, used: record.used_at !== null }
    : null;
}

export async function exchangeEnrollment(
  db: D1Queryable,
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

/**
 * List tokens for a workspace. Active-only by default so list/revoke paths
 * don't pay D1 rows-read for the full revoke history. Pass
 * `includeRevoked: true` for admin audit listing.
 */
export async function listTokens(
  db: D1Queryable,
  workspace: string,
  opts?: { includeRevoked?: boolean },
): Promise<AuthTokenRecord[]> {
  const includeRevoked = opts?.includeRevoked === true;
  const result = await db
    .prepare(
      includeRevoked
        ? `SELECT ${TOKEN_COLUMNS}
           FROM auth_tokens WHERE workspace = ? ORDER BY created_at ASC`
        : `SELECT ${TOKEN_COLUMNS}
           FROM auth_tokens WHERE workspace = ? AND revoked_at IS NULL ORDER BY created_at ASC`,
    )
    .bind(workspace)
    .all<AuthTokenRecord>();
  return result.results;
}

export async function revokeToken(
  db: D1Queryable,
  workspace: string,
  selector: { hashPrefix?: string; label?: string },
  now = new Date(),
): Promise<{ match: AuthTokenRecord | null; ambiguous: boolean }> {
  // Active tokens only (listTokens default) — revoked history is irrelevant for revoke.
  const tokens = await listTokens(db, workspace);
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

/**
 * Soft-revoke every active workspace API token minted by this Better Auth
 * user. Paired with the admin plugin's ban-user (which only wipes sessions)
 * so an abuse ban also cuts off CLI/API keys the user already issued.
 * Tokens with a null `minting_user_id` (pre-tracking rows) are left alone.
 */
export async function revokeTokensForMintingUser(
  db: D1Queryable,
  userId: string,
  now = new Date(),
): Promise<number> {
  if (!userId) return 0;
  const result = await db
    .prepare(
      `UPDATE auth_tokens SET revoked_at = ?
       WHERE minting_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(now.toISOString(), userId)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Active, unexpired tokens this user minted (POST /v1/tokens). Used by
 * `/account/developers` so a member can list their own keys without the
 * workspace-admin token list.
 */
export async function listTokensForMintingUser(
  db: D1Queryable,
  userId: string,
  now = new Date(),
): Promise<AuthTokenRecord[]> {
  if (!userId) return [];
  const result = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS}
       FROM auth_tokens
       WHERE minting_user_id = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
    )
    .bind(userId, now.toISOString())
    .all<AuthTokenRecord>();
  return result.results;
}

/**
 * One active, unexpired token this user minted. Missing / revoked / expired /
 * someone else's id all return null so callers can collapse them to the same 404.
 */
export async function findTokenForMintingUser(
  db: D1Queryable,
  userId: string,
  tokenId: string,
  now = new Date(),
): Promise<AuthTokenRecord | null> {
  if (!userId || !tokenId) return null;
  const iso = now.toISOString();
  const match = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS}
       FROM auth_tokens
       WHERE id = ? AND minting_user_id = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(tokenId, userId)
    .first<AuthTokenRecord>();
  if (!match) return null;
  if (match.expires_at !== null && match.expires_at <= iso) return null;
  return match;
}

/** Soft-revoke one token this user minted. Same null contract as find. */
export async function revokeTokenForMintingUser(
  db: D1Queryable,
  userId: string,
  tokenId: string,
  now = new Date(),
): Promise<AuthTokenRecord | null> {
  const match = await findTokenForMintingUser(db, userId, tokenId, now);
  if (!match) return null;
  await db
    .prepare(
      `UPDATE auth_tokens SET revoked_at = ?
       WHERE id = ? AND minting_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(now.toISOString(), match.id, userId)
    .run();
  return match;
}

/**
 * Stamp last_used_at on a successful auth. No-ops when the column was
 * written in the last hour so a busy token does not pay a D1 write per request.
 *
 * Returns the raw `D1Result` (or `null` on the no-op path) so callers can
 * read `meta.duration` for Server-Timing exec-ms reporting (issue #812)
 * without this helper needing to know about timing itself.
 */
export async function touchTokenLastUsed(
  db: D1Queryable,
  tokenId: string,
  now = new Date(),
): Promise<D1Result | null> {
  if (!tokenId) return null;
  const iso = now.toISOString();
  const staleBefore = new Date(now.getTime() - LAST_USED_TOUCH_SECONDS * 1000).toISOString();
  return db
    .prepare(
      `UPDATE auth_tokens SET last_used_at = ?
       WHERE id = ? AND revoked_at IS NULL
         AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(iso, tokenId, staleBefore)
    .run();
}
