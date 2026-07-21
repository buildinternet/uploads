/**
 * Shared `auth_tokens` D1 stub for tests exercising issue #297's
 * claim-authorization gate, which reads `c.get("mintingUserId")` off the D1
 * token row (`findActiveToken`/`d1Token.minting_user_id`, workspace.ts and
 * auth-db.ts). Mirrors the real column shape (`AuthTokenRecord`) closely
 * enough for a `first()` stand-in — used by `github-comment-route.test.ts`,
 * `github-link-route.test.ts`, and `github-promote-route.test.ts` so the
 * shape and lookup semantics don't drift between them.
 */

export interface MintingUserTokenOpts {
  workspace: string;
  tokenHash: string;
  mintingUserId: string;
  scopes?: string[];
}

/** The `auth_tokens` row `findActiveToken` would return for a minted token. */
export function mintingUserTokenRow(opts: MintingUserTokenOpts) {
  return {
    id: "token-id",
    workspace: opts.workspace,
    token_hash: opts.tokenHash,
    label: null,
    scopes: JSON.stringify(opts.scopes ?? ["files:read", "files:write", "files:delete"]),
    created_at: "2026-07-13T00:00:00.000Z",
    expires_at: null,
    revoked_at: null,
    minting_user_id: opts.mintingUserId,
  };
}

/**
 * Wraps `db.prepare` in place so the `auth_tokens` active-token lookup
 * returns `mintingUserTokenRow(opts)` for a bound hash matching
 * `opts.tokenHash`, and falls through to `db`'s own `prepare` for every other
 * hash and every other statement. Omit `opts` (or don't call this at all) to
 * leave `auth_tokens` at whatever the underlying fake already does (typically
 * `null` — the legacy/no-tracked-user path that must always be treated as
 * "not entitled" to claim a NEW repo).
 */
export function withMintingUserToken<T extends { prepare: (sql: string) => unknown }>(
  db: T,
  opts: MintingUserTokenOpts,
): void {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (!normalized.startsWith("SELECT id, workspace, token_hash")) return originalPrepare(sql);
    let args: unknown[] = [];
    return {
      bind: (...v: unknown[]) => {
        args = v;
        return {
          first: async () => {
            const hash = args[1] as string;
            return hash === opts.tokenHash ? mintingUserTokenRow(opts) : null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({}),
        };
      },
    };
  }) as T["prepare"];
}
