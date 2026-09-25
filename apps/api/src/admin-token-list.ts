import {
  FILE_SCOPES,
  listTokens,
  parseScopes,
  type AuthTokenRecord,
  type FileScope,
} from "./auth-db";
import { type D1Queryable } from "./db-session";
import { type WorkspaceRecord } from "./workspace";

export const HASH_PREFIX_LEN = 8;

export interface LegacyToken {
  hash: string;
  label?: string;
  createdAt: string;
}

/** Token list for a record, migrating a legacy `tokenHash`-only record into the list shape. */
export function legacyTokens(record: WorkspaceRecord): LegacyToken[] {
  return (
    record.tokens ??
    (record.tokenHash ? [{ hash: record.tokenHash, createdAt: new Date(0).toISOString() }] : [])
  );
}

/**
 * One row of the operator token listing. `owner` separates personal tokens
 * (`member`) from workspace service tokens (`workspace`, issue #1026). A
 * service token has no `mintingUserId`; `createdByUserId` is the admin who
 * minted it, for audit only. Legacy KV tokens predate ownership tracking and
 * report `member` with both ids null, matching the D1 default for
 * pre-tracking rows.
 */
export function d1TokenRow(token: AuthTokenRecord) {
  return {
    label: token.label,
    createdAt: token.created_at,
    hashPrefix: token.token_hash.slice(0, HASH_PREFIX_LEN),
    scopes: parseScopes(token.scopes),
    expiresAt: token.expires_at,
    revokedAt: token.revoked_at,
    owner: token.owner,
    mintingUserId: token.minting_user_id,
    createdByUserId: token.created_by_user_id,
    source: "d1" as const,
  };
}

function legacyTokenRow(token: LegacyToken) {
  return {
    label: token.label ?? null,
    createdAt: token.createdAt,
    hashPrefix: token.hash.slice(0, HASH_PREFIX_LEN),
    scopes: [...FILE_SCOPES] as FileScope[],
    expiresAt: null,
    revokedAt: null,
    owner: "member" as const,
    mintingUserId: null,
    createdByUserId: null,
    source: "legacy" as const,
  };
}

export type AdminTokenRow = ReturnType<typeof d1TokenRow> | ReturnType<typeof legacyTokenRow>;

/** Legacy KV tokens plus every D1 token (revoked included) for one workspace. */
export async function adminTokenRows(
  db: D1Queryable,
  name: string,
  record: WorkspaceRecord,
): Promise<AdminTokenRow[]> {
  const d1 = (await listTokens(db, name, { includeRevoked: true })).map(d1TokenRow);
  return [...legacyTokens(record).map(legacyTokenRow), ...d1];
}
