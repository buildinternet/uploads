// Runtime Worker secrets (see .dev.vars.example), not declared in wrangler.jsonc,
// so `wrangler types` does not generate them. Augment Env here.
interface Env {
  ADMIN_TOKEN?: string;
  /** AES master for BYO accessKeyId/secretAccessKey at rest in KV (optional). */
  WORKSPACE_SECRETS_KEY?: string;
}
