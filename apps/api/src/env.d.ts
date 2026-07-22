// Runtime Worker secrets (see .dev.vars.example), not declared in wrangler.jsonc,
// so `wrangler types` does not generate them. Augment Env here.
interface Env {
  ADMIN_TOKEN?: string;
  /** Current AES master for BYO credentials at rest in KV (optional). */
  WORKSPACE_SECRETS_KEY?: string;
  /**
   * Previous master during rotation. Decrypt tries current, then previous.
   * Remove after reencrypt-workspace-secrets.mjs completes.
   */
  WORKSPACE_SECRETS_KEY_PREVIOUS?: string;
  /**
   * Optional embed CDN base (GitHub Camo dual-host). Unset = default twin for
   * storage/store.uploads.sh; empty = never emit embedUrl; URL = self-host.
   */
  EMBED_PUBLIC_BASE_URL?: string;
  /**
   * Kill switch for anonymous CLI/MCP telemetry intake (`POST /v1/telemetry`).
   * Set to "1" or "true" to accept and drop events without writing D1.
   */
  TELEMETRY_DISABLED?: string;
  /**
   * Kill switch for explicit diagnostic reports (`POST /v1/reports`).
   * Set to "1" or "true" to reject new reports.
   */
  REPORTS_DISABLED?: string;
  /**
   * GitHub App private key, PKCS#8 PEM (converted via openssl pkcs8 -topk8).
   * The App ids live in wrangler.jsonc vars (they're public); this is the one
   * true secret, so unset still disables title resolution gracefully.
   */
  GITHUB_APP_PRIVATE_KEY?: string;
  /**
   * HMAC secret for GitHub App webhook deliveries (X-Hub-Signature-256), set via
   * `wrangler secret put`. Declared here (not only in the generated
   * worker-configuration.d.ts) because that file is git-ignored and regenerated
   * in CI without remote secrets — same reason GITHUB_APP_PRIVATE_KEY is here.
   * Unset/empty disables the webhook endpoint (503).
   */
  GITHUB_APP_WEBHOOK_SECRET?: string;
  /**
   * Video poster generation (issue #299). Declared optional here (rather than
   * relying solely on each app's generated worker-configuration.d.ts) because
   * apps/mcp's wrangler.jsonc has none of these three bindings, yet its
   * program transitively type-checks files-core.ts/poster.ts through the
   * `@uploads/api/files` export — posterGenerationAllowed already treats all
   * three as possibly absent at runtime (fails closed), so `?` here matches
   * both apps' actual binding shape instead of only apps/api's.
   */
  MEDIA?: MediaBinding;
  FLAGS?: Flagship;
  POSTER_LIMITER?: RateLimit;
}
