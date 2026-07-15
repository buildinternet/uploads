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
}
