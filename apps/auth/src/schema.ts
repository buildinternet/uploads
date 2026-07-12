/**
 * Better Auth's D1 schema island, scoped to this worker only (see
 * docs/superpowers/plans/2026-07-12-better-auth-introduction.md, D2).
 *
 * snake_case columns, camelCase keys, integer timestamp mode + boolean mode —
 * Better Auth's canonical shape for the drizzle D1 adapter. Reconciled against
 * `npx @better-auth/cli generate` output and
 * `~/Code/releases/workers/api/src/db/schema-auth.ts`, trimmed to the Phase 1
 * plugin set (core tables + magicLink's `verification` + `rateLimit`).
 *
 * ⚠ footgun: this file and ./migrations/*.sql are hand-synced — there is no
 * generator wired into CI. Each table below is annotated with the migration
 * file that created it; keep that comment current when the schema changes.
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Non-null integer `timestamp` column with a JS-side default of "now". */
const timestampCol = (name: string) =>
  integer(name, { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

/**
 * Core identity table. Better Auth writes `role`/`banned`/`banExpires` only
 * once the `admin` plugin is mounted (Phase 2) — the columns exist now so the
 * Phase 2 migration is additive-free for this table.
 *
 * Paired migration: `migrations/20260712200000_better_auth_core.sql`.
 */
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => false),
  image: text("image"),
  createdAt: timestampCol("created_at"),
  updatedAt: timestampCol("updated_at"),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
});

/**
 * Signed-in sessions. `cookieCache` (5 min, see src/auth.ts) keeps most
 * `get-session` calls off this table.
 *
 * Paired migration: `migrations/20260712200000_better_auth_core.sql`.
 */
export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_session_user_id").on(t.userId)],
);

/**
 * Linked identity provider accounts — GitHub OAuth rows land here (Phase 1).
 * `password` stays unused (email/password is explicitly out of scope, see D3)
 * but is part of Better Auth's canonical account shape.
 *
 * Paired migration: `migrations/20260712200000_better_auth_core.sql`.
 */
export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_account_user_id").on(t.userId)],
);

/**
 * Single-use verification records — magic-link tokens (`storeToken: "hashed"`,
 * see src/auth.ts) live here.
 *
 * Paired migration: `migrations/20260712200000_better_auth_core.sql`.
 */
export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_verification_identifier").on(t.identifier)],
);

/**
 * Better Auth's own database-backed rate limiter storage
 * (`rateLimit.storage: "database"`, see src/auth.ts). Model name is fixed at
 * "rateLimit" by Better Auth; `count`/`lastRequest` are plain epoch-ms
 * integers, not timestamp-mode columns.
 *
 * Paired migration: `migrations/20260712200000_better_auth_core.sql`.
 */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
export type AuthAccount = typeof account.$inferSelect;
export type AuthVerification = typeof verification.$inferSelect;
export type AuthRateLimit = typeof rateLimit.$inferSelect;
