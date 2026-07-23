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
 * Drizzle `relations()` below are TS-only (for experimental.joins) and do not
 * need a migration.
 */
import { relations } from "drizzle-orm";
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
 * Paired migrations: `20260712200000_better_auth_core.sql`,
 * `20260714120000_cli_onboarded_at.sql` (`cli_onboarded_at`).
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
  /** First CLI device-flow session; sticky. */
  cliOnboardedAt: integer("cli_onboarded_at", { mode: "timestamp" }),
  /** `@better-auth/stripe`'s `user` schema addition (dormant until the
   * plugin is mounted — see docs/superpowers/plans/2026-07-22-stripe-phase2-
   * better-auth-plugin.md). Paired migration:
   * `migrations/20260722190000_stripe_subscription.sql`. */
  stripeCustomerId: text("stripe_customer_id"),
});

/**
 * Signed-in sessions. `cookieCache` (5 min, see src/auth.ts) keeps most
 * `get-session` calls off this table.
 *
 * Paired migrations: `migrations/20260712200000_better_auth_core.sql` (core
 * columns), `migrations/20260712210000_admin_plugin.sql` (`impersonated_by`,
 * written by the `admin` plugin's impersonation feature — Phase 2),
 * `migrations/20260712220000_organization.sql` (`active_organization_id`,
 * written by the `organization` plugin — Phase 3),
 * `migrations/20260723120000_session_cli_version.sql` (`cli_version`).
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
    /** Installed `@buildinternet/uploads` version for CLI device sessions. */
    cliVersion: text("cli_version"),
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
 * Paired migrations: `migrations/20260712200000_better_auth_core.sql`,
 * `migrations/20260722180000_retention_expires_at_idx.sql`
 * (`idx_verification_expires_at` for nightly retention sweep).
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
  (t) => [
    index("idx_verification_identifier").on(t.identifier),
    // Retention sweep: expires_at < now. Migration: 20260722180000_retention_expires_at_idx.sql
    index("idx_verification_expires_at").on(t.expiresAt),
  ],
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
  /** `@better-auth/stripe`'s `organization` schema addition (dormant until
   * the plugin is mounted). Paired migration:
   * `migrations/20260722190000_stripe_subscription.sql`. */
  stripeCustomerId: text("stripe_customer_id"),
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
  (t) => [
    index("idx_invitation_organization_id").on(t.organizationId),
    // Pending counts/list: (org, status). Migration: 20260721160000_invitation_org_status_idx.sql
    index("idx_invitation_organization_status").on(t.organizationId, t.status),
  ],
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
 * Paired migrations: `migrations/20260712230000_device_code.sql`,
 * `migrations/20260722180000_retention_expires_at_idx.sql`
 * (`idx_device_code_expires_at` for nightly retention sweep).
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
    // Retention sweep: expires_at < now. Migration: 20260722180000_retention_expires_at_idx.sql
    index("idx_device_code_expires_at").on(t.expiresAt),
  ],
);

/**
 * `jwt()` plugin keyset (issue #224, Lane A): the signing keypair for OAuth
 * access-token JWTs, encrypted at rest under the Better Auth secret. Model
 * name is fixed at "jwks" by the plugin. `expiresAt` is optional (key
 * rotation, unused for now).
 *
 * Paired migration: `migrations/20260717000000_oauth_provider.sql`.
 */
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestampCol("created_at"),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
});

/**
 * `@better-auth/oauth-provider` tables (issue #224, Lane A: OAuth 2.1
 * authorization server). Adapter keys must match the plugin's model names;
 * SQL is snake_case. `string[]` columns are JSON text (drizzle `mode: "json"`)
 * — mirrors `~/Code/sunny/apps/auth/src/schema.ts:239-336`, itself reconciled
 * against `npx @better-auth/cli generate` output for this plugin.
 *
 * Paired migration: `migrations/20260717000000_oauth_provider.sql`.
 */
export const oauthClient = sqliteTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    name: text("name"),
    icon: text("icon"),
    uri: text("uri"),
    redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" }).$type<string[]>(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    grantTypes: text("grant_types", { mode: "json" }).$type<string[]>(),
    responseTypes: text("response_types", { mode: "json" }).$type<string[]>(),
    contacts: text("contacts", { mode: "json" }).$type<string[]>(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    type: text("type"),
    public: integer("public", { mode: "boolean" }),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    disabled: integer("disabled", { mode: "boolean" }),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    userId: text("user_id"),
    referenceId: text("reference_id"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_oauth_client_client_id").on(t.clientId)],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    refreshId: text("refresh_id"),
    userId: text("user_id"),
    referenceId: text("reference_id"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestampCol("created_at"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_oauth_access_token_token").on(t.token),
    index("idx_oauth_access_client_id").on(t.clientId),
    index("idx_oauth_access_session_id").on(t.sessionId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").notNull(),
    referenceId: text("reference_id"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    // Revocation timestamp, not a boolean: a Date when revoked, null while active.
    revoked: integer("revoked", { mode: "timestamp" }),
    authTime: integer("auth_time", { mode: "timestamp" }),
    createdAt: timestampCol("created_at"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_oauth_refresh_token_token").on(t.token),
    index("idx_oauth_refresh_client_id").on(t.clientId),
    index("idx_oauth_refresh_session_id").on(t.sessionId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    clientId: text("client_id").notNull(),
    referenceId: text("reference_id"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_oauth_consent_user_client").on(t.userId, t.clientId)],
);

/**
 * Per-grant workspace choice (issue #231, auth side): the user's last
 * explicit workspace pick for the OAuth 2.1 authorization server, one row per
 * user. Custom table (not part of `@better-auth/oauth-provider`) — read by
 * `resolveWorkspaceChoiceReferenceId` (src/workspace-choice.ts) to build the
 * `postLogin.consentReferenceId` the plugin ties to `oauth_consent` rows, and
 * written by `POST /api/auth/oauth2/workspace-choice`. Single-workspace users
 * never get a row (the hook returns `undefined` for them, see
 * src/workspace-choice.ts) so this table only ever holds multi-workspace
 * users' picks.
 *
 * Paired migration: `migrations/20260718000000_oauth_workspace_choice.sql`.
 */
export const oauthWorkspaceChoice = sqliteTable("oauth_workspace_choice", {
  userId: text("user_id").primaryKey(),
  workspace: text("workspace").notNull(),
  createdAt: timestampCol("created_at"),
  updatedAt: timestampCol("updated_at"),
});

/**
 * `@better-auth/stripe`'s `subscription` model (Stripe phase 2, see
 * docs/superpowers/plans/2026-07-22-stripe-phase2-better-auth-plugin.md).
 * Dormant: the plugin only mounts when `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRET` are both set (src/auth.ts), so this table stays
 * unwritten until then. Field set is mandated by the installed plugin
 * version — reconciled against `@better-auth/stripe@1.6.23`'s
 * `dist/index.mjs` `subscriptions` schema export, NOT the phase-2 plan's
 * example (which omits `cancelAt`/`canceledAt`/`endedAt`/`billingInterval`/
 * `stripeScheduleId`).
 *
 * Paired migration: `migrations/20260722190000_stripe_subscription.sql`.
 */
export const subscription = sqliteTable("subscription", {
  id: text("id").primaryKey(),
  plan: text("plan").notNull(),
  referenceId: text("reference_id").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").default("incomplete"),
  periodStart: integer("period_start", { mode: "timestamp" }),
  periodEnd: integer("period_end", { mode: "timestamp" }),
  trialStart: integer("trial_start", { mode: "timestamp" }),
  trialEnd: integer("trial_end", { mode: "timestamp" }),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).default(false),
  cancelAt: integer("cancel_at", { mode: "timestamp" }),
  canceledAt: integer("canceled_at", { mode: "timestamp" }),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  seats: integer("seats"),
  billingInterval: text("billing_interval"),
  stripeScheduleId: text("stripe_schedule_id"),
});

/**
 * Durable retry queue for the billing plan bridge (issue #451). Written by
 * `syncWorkspacePlan` (src/billing-bridge.ts) when the `POST
 * /internal/billing/plan` call to apps/api fails, drained by the cron in
 * src/billing-outbox.ts.
 *
 * `referenceId` (the organization id) is the primary key, so a repeat failure
 * for the same org replaces its pending row instead of queueing a duplicate.
 *
 * Deliberately carries NO plan column: the drain recomputes the desired plan
 * from the `subscription` table at retry time, so a queued row can never
 * re-apply a plan that a later event has already superseded.
 *
 * Paired migration: `migrations/20260723150000_billing_plan_outbox.sql`.
 */
export const billingPlanOutbox = sqliteTable("billing_plan_outbox", {
  referenceId: text("reference_id").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * Drizzle relations for Better Auth `experimental.joins` (adapter needs these
 * on the same schema object as the tables). No SQL/migration impact.
 *
 * session has two FKs to user (`userId`, `impersonatedBy`) so both sides use
 * matching `relationName`s — see better-auth drizzle adapter docs.
 */
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session, { relationName: "session_userId" }),
  impersonatedSessions: many(session, { relationName: "session_impersonatedBy" }),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
    relationName: "session_userId",
  }),
  impersonatedByUser: one(user, {
    fields: [session.impersonatedBy],
    references: [user.id],
    relationName: "session_impersonatedBy",
  }),
  activeOrganization: one(organization, {
    fields: [session.activeOrganizationId],
    references: [organization.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
  sessions: many(session),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
export type AuthAccount = typeof account.$inferSelect;
export type AuthVerification = typeof verification.$inferSelect;
export type AuthRateLimit = typeof rateLimit.$inferSelect;
export type AuthOrganization = typeof organization.$inferSelect;
export type AuthMember = typeof member.$inferSelect;
export type AuthInvitation = typeof invitation.$inferSelect;
export type AuthDeviceCode = typeof deviceCode.$inferSelect;
export type AuthOauthClient = typeof oauthClient.$inferSelect;
export type AuthOauthWorkspaceChoice = typeof oauthWorkspaceChoice.$inferSelect;
export type AuthSubscription = typeof subscription.$inferSelect;
export type AuthBillingPlanOutbox = typeof billingPlanOutbox.$inferSelect;
