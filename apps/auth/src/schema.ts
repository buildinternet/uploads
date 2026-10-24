/**
 * Better Auth's D1 schema, scoped to this worker. snake_case columns,
 * camelCase keys, integer timestamp and boolean modes: Better Auth's
 * canonical drizzle D1 shape.
 *
 * This file and ./migrations/*.sql are hand-synced; no generator runs in CI.
 * Each table names the migrations that created it; keep that current.
 * Drizzle `relations()` are TS-only (for `advanced.database.joins`) and need
 * no migration.
 */
import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Non-null integer `timestamp` column with a JS-side default of "now". */
const timestampCol = (name: string) =>
  integer(name, { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

/**
 * Core identity table. `role`/`banned`/`banExpires` are written by the
 * `admin` plugin.
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
  /** `@better-auth/stripe`'s `user` addition. Paired migration:
   * `migrations/20260722190000_stripe_subscription.sql`. */
  stripeCustomerId: text("stripe_customer_id"),
  /** Per-user pref: email me when someone joins a workspace I administer.
   * Default on. A better-auth additionalField, so update-user writes it and
   * the session returns it. */
  notifyMemberJoin: integer("notify_member_join", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => true),
  /** Per-user pref: email me when a workspace I administer nears its usage
   * limit (50/90/100% of storage or monthly uploads). Default on. Same
   * additionalField mechanism as notifyMemberJoin. */
  notifyUsageLimits: integer("notify_usage_limits", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => true),
  /** Per-user pref: message me in Slack when an upload is held for review
   * (apps/api/src/slack-hold-notify.ts). Default on; inert until the user
   * connects Slack. Same additionalField mechanism as notifyMemberJoin. */
  notifySlackHolds: integer("notify_slack_holds", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => true),
  /** Per-user pref: email me when an upload is held for review
   * (apps/api/src/hold-email-notify.ts). Default off, since holds can be
   * noisy. Same additionalField mechanism as notifyMemberJoin. */
  notifyEmailHolds: integer("notify_email_holds", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => false),
  /** Per-user pref: email me product updates and announcements. Default on;
   * unticked at sign-up via src/product-updates.ts. Only operator-run
   * campaigns send these (apps/api/src/cli-upgrade-campaign.ts). */
  notifyProductUpdates: integer("notify_product_updates", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => true),
  /**
   * Retired account-wide weekly digest flags; live preferences are on
   * `member`. Kept for rollout. New mail doesn't read them.
   */
  notifyWeeklyDigest: integer("notify_weekly_digest", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => false),
  notifyWeeklyWorkspaceDigest: integer("notify_weekly_workspace_digest", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => false),
});

/**
 * Signed-in sessions. `cookieCache` (src/auth.ts) keeps most `get-session`
 * calls off this table.
 *
 * Paired migrations: `migrations/20260712200000_better_auth_core.sql` (core
 * columns), `migrations/20260712210000_admin_plugin.sql` (`impersonated_by`),
 * `migrations/20260712220000_organization.sql` (`active_organization_id`),
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
 * Linked identity provider accounts (GitHub). `password` is unused but part
 * of Better Auth's canonical shape.
 *
 * Accounts are keyed by `(providerId, accountId)`. The old `issuer` column is
 * dropped by a later migration, after this worker deploys, because the
 * previous worker still selects it.
 *
 * Paired migrations: `apps/api/migrations/20260822120000_auth_tables.sql`.
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
  (t) => [
    index("idx_account_user_id").on(t.userId),
    // One row per provider identity: findAccountByKey throws on a duplicate,
    // which blocks that user's GitHub sign-in. Migration 20261005000000.
    uniqueIndex("idx_account_provider_account_id").on(t.providerId, t.accountId),
  ],
);

/**
 * Single-use verification records (hashed magic-link tokens).
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
 * Better Auth's database rate-limit model, unused: rate limiting uses a
 * Durable Object or in-memory storage, never D1 (src/auth.ts). Kept so
 * deployments don't need a drop migration. `count`/`lastRequest` are epoch-ms
 * integers.
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
 * Organizations: `organization.slug` is the workspace name, 1:1 (see
 * apps/api/src/org-workspaces.ts). No teams. Created only via
 * `/internal/orgs` or the backfill script.
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
  /** `@better-auth/stripe`'s `organization` addition. Paired migration:
   * `migrations/20260722190000_stripe_subscription.sql`. */
  stripeCustomerId: text("stripe_customer_id"),
});

/**
 * Org membership. `role` is the org-scoped `owner`/`admin`/`member`, distinct
 * from the global `user.role`.
 *
 * Paired migrations: `migrations/20260712220000_organization.sql`,
 * `apps/api/migrations/20261012150000_auth_member_weekly_digest.sql`
 * (`notify_weekly_digest`, `notify_weekly_workspace_digest`).
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
    /** Weekly summary of this workspace. Default off. */
    notifyWeeklyDigest: integer("notify_weekly_digest", { mode: "boolean" })
      .notNull()
      .$defaultFn(() => false),
    /** Weekly admin pulse for this workspace. Default off. Admins and owners only. */
    notifyWeeklyWorkspaceDigest: integer("notify_weekly_workspace_digest", { mode: "boolean" })
      .notNull()
      .$defaultFn(() => false),
  },
  (t) => [
    index("idx_member_organization_id").on(t.organizationId),
    index("idx_member_user_id").on(t.userId),
  ],
);

/**
 * Pending org invitations. `id` is the `/accept-invitation/<id>` path segment.
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
 * RFC 8628 device-authorization requests for `uploads login`. The field set
 * is mandated by the plugin, with no created/updated timestamps.
 * `expires_at`/`last_polled_at` are nullable epoch seconds, so they don't use
 * `timestampCol`. The adapter key must stay the camelCase model name.
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
    // null until a signed-in session claims or approves the request.
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
    // Unique lookup indexes (migration 20260821120000 dedups first).
    uniqueIndex("idx_device_code_device_code").on(t.deviceCode),
    uniqueIndex("idx_device_code_user_code").on(t.userCode),
    // Retention sweep: expires_at < now. Migration: 20260722180000_retention_expires_at_idx.sql
    index("idx_device_code_expires_at").on(t.expiresAt),
  ],
);

/**
 * `jwt()` plugin keyset: the OAuth access-token signing keypair, encrypted
 * under the Better Auth secret. Model name fixed at "jwks".
 *
 * Paired migrations: `migrations/20260717000000_oauth_provider.sql`,
 * `migrations/20260821120000_better_auth_1_7.sql` (`alg`, `crv`).
 */
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestampCol("created_at"),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  alg: text("alg"),
  crv: text("crv"),
});

/**
 * `@better-auth/oauth-provider` tables. Adapter keys match the plugin's model
 * names; SQL is snake_case. `string[]` columns are JSON text.
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
    /** Deprecated and ignored by the plugin; kept because dropping is
     * destructive on D1. */
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
    // Better Auth 1.7 additions (migration 20260821120000).
    clientDiscoveryId: text("client_discovery_id"),
    clientCredentialsScopes: text("client_credentials_scopes", { mode: "json" }).$type<string[]>(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: integer("backchannel_logout_session_required", {
      mode: "boolean",
    }),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", { mode: "boolean" }),
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
    // Better Auth 1.7 additions (migration 20260821120000): RFC 8707 resource
    // binding, requested UserInfo claims, DPoP confirmation, revocation stamp.
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources", { mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }).$type<string[]>(),
    confirmation: text("confirmation", { mode: "json" }),
    revoked: integer("revoked", { mode: "timestamp" }),
    createdAt: timestampCol("created_at"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_oauth_access_token_token").on(t.token),
    index("idx_oauth_access_client_id").on(t.clientId),
    index("idx_oauth_access_session_id").on(t.sessionId),
    // Better Auth 1.7 marks authorizationCodeId indexed (code-replay revocation
    // looks tokens up by it). Migration 20260821120000.
    index("idx_oauth_access_authorization_code_id").on(t.authorizationCodeId),
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
    // Better Auth 1.7 additions (migration 20260821120000): resource binding,
    // requested claims, refresh-token rotation-replay window, DPoP confirmation.
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources", { mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }).$type<string[]>(),
    rotatedAt: integer("rotated_at", { mode: "timestamp" }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: integer("rotation_replay_expires_at", { mode: "timestamp" }),
    confirmation: text("confirmation", { mode: "json" }),
    createdAt: timestampCol("created_at"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_oauth_refresh_token_token").on(t.token),
    index("idx_oauth_refresh_client_id").on(t.clientId),
    index("idx_oauth_refresh_session_id").on(t.sessionId),
    // Better Auth 1.7 marks authorizationCodeId indexed. Migration 20260821120000.
    index("idx_oauth_refresh_authorization_code_id").on(t.authorizationCodeId),
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
    // Better Auth 1.7 additions (migration 20260821120000).
    resources: text("resources", { mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }).$type<string[]>(),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_oauth_consent_user_client").on(t.userId, t.clientId)],
);

/**
 * Protected resources, seeded at boot from `oauthProvider({ resources })`
 * (insert-only, so admin edits survive). `identifier` is the RFC 8707
 * `resource`; a token's `aud` is bound to it.
 *
 * Paired migration: `migrations/20260821120000_better_auth_1_7.sql`.
 */
export const oauthResource = sqliteTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes", { mode: "json" }).$type<string[]>(),
  customClaims: text("custom_claims", { mode: "json" }),
  dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", { mode: "boolean" }),
  disabled: integer("disabled", { mode: "boolean" }),
  policyVersion: integer("policy_version"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

/**
 * Client ⋈ resource binding. Only used with `enforcePerClientResources`,
 * which this worker leaves off; present for schema parity.
 *
 * Paired migration: `migrations/20260821120000_better_auth_1_7.sql`.
 */
export const oauthClientResource = sqliteTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("idx_oauth_client_resource_client_resource").on(t.clientId, t.resourceId)],
);

/**
 * Single-use `private_key_jwt` client-assertion `jti` store for
 * `@better-auth/oauth-provider` 1.7 (RFC 7523). `id` is the `jti`; `expiresAt`
 * bounds the replay window so expired rows can be swept.
 *
 * Paired migration: `migrations/20260821120000_better_auth_1_7.sql`.
 */
export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

/**
 * A multi-workspace user's last explicit workspace pick for OAuth, one row
 * per user. Custom table, read by `resolveWorkspaceChoiceReferenceId` and
 * written by `POST /api/auth/oauth2/workspace-choice`.
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
 * `@better-auth/stripe`'s `subscription` model. Unwritten until both Stripe
 * secrets are set. The field set follows the installed plugin's schema.
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
 * Retry queue for the billing plan bridge: written when the call to apps/api
 * fails, drained by src/billing-outbox.ts. Keyed by organization id, so
 * repeats replace the pending row. No plan column: the drain recomputes the
 * plan, so a stale row can't re-apply a superseded one.
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
 * GitHub login per GitHub account. `account` has no write path for it, so
 * `mapProfileToUser` (which sees the raw profile on every callback) writes
 * here, last-write-wins for renames. Keyed by GitHub account id so it never
 * races the user/account rows of a new sign-up.
 *
 * Paired migration: `migrations/20260731120000_github_identity.sql`.
 */
export const githubIdentity = sqliteTable("github_identity", {
  /** Numeric GitHub account id, as a string (matches `account.accountId`). */
  accountId: text("account_id").primaryKey(),
  login: text("login").notNull(),
  updatedAt: timestampCol("updated_at"),
});

/**
 * Drizzle relations for Better Auth `advanced.database.joins` (adapter needs these
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
export type GithubIdentity = typeof githubIdentity.$inferSelect;
export type AuthOauthClient = typeof oauthClient.$inferSelect;
export type AuthOauthResource = typeof oauthResource.$inferSelect;
export type AuthOauthClientResource = typeof oauthClientResource.$inferSelect;
export type AuthOauthClientAssertion = typeof oauthClientAssertion.$inferSelect;
export type AuthOauthWorkspaceChoice = typeof oauthWorkspaceChoice.$inferSelect;
export type AuthSubscription = typeof subscription.$inferSelect;
export type AuthBillingPlanOutbox = typeof billingPlanOutbox.$inferSelect;
