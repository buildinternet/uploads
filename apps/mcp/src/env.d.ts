// Runtime Worker secrets are not declared in wrangler.jsonc, so Wrangler does
// not generate them. Keep this augmentation aligned with the shared API code.
interface Env {
  WORKSPACE_SECRETS_KEY?: string;
  WORKSPACE_SECRETS_KEY_PREVIOUS?: string;
  // GitHub App identity (apps/api/src/github-app.ts, pulled in transitively
  // via uploader-identity.ts for issue #345). This worker has no App
  // configured — githubAppConfig() degrades to null (unauthenticated GitHub
  // API calls, lower rate limit) exactly like uploaderTags()'s other
  // best-effort failure modes. Declared here only so the shared module
  // typechecks against this worker's Env; not set in wrangler.jsonc.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_HOME_INSTALLATION_ID?: string;
  // Public OpenAI plugin domain-verification token. Served as raw text at
  // /.well-known/openai-apps-challenge. Set with `wrangler secret put
  // OPENAI_APPS_CHALLENGE --config apps/mcp/wrangler.jsonc` when submitting
  // the plugin; unset or blank → 404.
  OPENAI_APPS_CHALLENGE?: string;
  /**
   * Per-workspace write rate limit (uploads#754 item 3), shared with apps/api
   * via `@uploads/api/guards`'s `allowWrite` — fails open when absent. This
   * worker binds it unconditionally in wrangler.jsonc, but a self-hoster may
   * delete that `unsafe.bindings` block and run without the burst guard.
   */
  WRITE_LIMITER?: RateLimit;
}
