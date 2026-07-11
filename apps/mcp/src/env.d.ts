// Runtime Worker secrets are not declared in wrangler.jsonc, so Wrangler does
// not generate them. Keep this augmentation aligned with the shared API code.
interface Env {
  WORKSPACE_SECRETS_KEY?: string;
  WORKSPACE_SECRETS_KEY_PREVIOUS?: string;
}
