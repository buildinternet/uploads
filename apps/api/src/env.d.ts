// ADMIN_TOKEN is a runtime Worker secret (see .dev.vars.example), not declared
// in wrangler.jsonc, so `wrangler types` does not generate it. Augment Env here.
interface Env {
  ADMIN_TOKEN?: string;
}
