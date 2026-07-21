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
}
