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
}
