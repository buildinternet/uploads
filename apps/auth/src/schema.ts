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
 * once the `admin` plugin is mounted (Phase 2, see src/auth.ts) — the columns
 * were added in Phase 1 anticipating this, so the Phase 2 migration is
 * additive-free for this table (verified: no ALTER TABLE for `user` in
 * `migrations/20260712210000_admin_plugin.sql`).
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
 * Paired migrations: `migrations/20260712200000_better_auth_core.sql` (core
 * columns), `migrations/20260712210000_admin_plugin.sql` (`impersonated_by`,
 * written by the `admin` plugin's impersonation feature — Phase 2),
 * `migrations/20260712220000_organization.sql` (`active_organization_id`,
 * written by the `organization` plugin — Phase 3).
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
    impersonatedBy: text("impersonated_by"),
    activeOrganizationId: text("active_organization_id"),
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

/**
 * Organizations (plan D4/Phase 3): `organization.slug === workspace name`,
 * 1:1 for now (see apps/api/src/org-workspaces.ts for the indirection that
 * keeps this an implementation detail). No `team` support (D3 explicitly
 * excludes it) and no auto-provisioning hooks — orgs are only created via
 * `/internal/orgs` (admin-provisioned, per D4) or the backfill script.
 *
 * Paired migration: `migrations/20260712220000_organization.sql`.
 */
export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestampCol("created_at"),
  metadata: text("metadata"),
});

/**
 * Org membership. `role` here is the org-scoped `owner`/`admin`/`member`
 * role (stock organization-plugin roles, no custom access control) — distinct
 * from the global `user.role` written by the `admin` plugin (Phase 2).
 *
 * Paired migration: `migrations/20260712220000_organization.sql`.
 */
export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestampCol("created_at"),
  },
  (t) => [
    index("idx_member_organization_id").on(t.organizationId),
    index("idx_member_user_id").on(t.userId),
  ],
);

/**
 * Pending org invitations. `sendInvitationEmail` (src/auth.ts) links to
 * `${WEB_ORIGIN}/accept-invitation/<id>` — this table's `id` is that path
 * segment.
 *
 * Paired migration: `migrations/20260712220000_organization.sql`.
 */
export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestampCol("created_at"),
  },
  (t) => [index("idx_invitation_organization_id").on(t.organizationId)],
);

/**
 * Device-authorization (RFC 8628) pending requests (plan D5/Phase 4): the
 * `deviceAuthorization` plugin's store backing `uploads login`. The field set
 * is mandated by the plugin (see its `schema.mjs`) — note there are NO
 * created/updated timestamps. `expires_at`/`last_polled_at` use drizzle's
 * `mode: "timestamp"` (stored as integer epoch *seconds*, not ms): the plugin
 * writes/reads `Date` objects the adapter serializes, so the round-trip is
 * second-precision — deliberately not this file's non-null `timestampCol`
 * helper, since both may be null/absent. Like `rate_limit`, the SQL table name
 * is snake_case but the drizzle-adapter schema KEY must stay the camelCase
 * model name `deviceCode`.
 *
 * Paired migration: `migrations/20260712230000_device_code.sql`.
 */
export const deviceCode = sqliteTable(
  "device_code",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    // null until a signed-in session claims/approves the request (see the
    // /device page on apps/web and the plugin's device/approve endpoint).
    userId: text("user_id"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    // pending | approved | denied
    status: text("status").notNull(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
  },
  (t) => [
    index("idx_device_code_device_code").on(t.deviceCode),
    index("idx_device_code_user_code").on(t.userCode),
  ],
);

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
export type AuthAccount = typeof account.$inferSelect;
export type AuthVerification = typeof verification.$inferSelect;
export type AuthRateLimit = typeof rateLimit.$inferSelect;
export type AuthOrganization = typeof organization.$inferSelect;
export type AuthMember = typeof member.$inferSelect;
export type AuthInvitation = typeof invitation.$inferSelect;
export type AuthDeviceCode = typeof deviceCode.$inferSelect;
