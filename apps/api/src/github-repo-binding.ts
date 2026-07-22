/**
 * The read-only slice of `github-repo-links.ts` that other workers may import
 * (issue #427). `@uploads/api`'s package exports point at THIS module, not at
 * `github-repo-links.ts`, so a cross-worker consumer can answer "who is this
 * repo bound to, relative to me?" without also gaining import-level access to
 * the mutation side of that module — `setRepoLink` (the operator hard-override
 * for reassigning someone else's stuck binding), the strict deletes, and the
 * workspace-scoped listing. Those stay reachable only from inside apps/api,
 * behind the admin route's auth gate (routes/admin-ui.ts), so a future change
 * to that gate can't be bypassed by a direct import.
 *
 * Same intent as `./github-comment-service`'s narrow surface: export the
 * function the other worker actually needs, not the module that contains it.
 * In-package callers keep importing `./github-repo-links` directly.
 */
export {
  deriveRepoBinding,
  findRepoLink,
  type RepoBinding,
  type RepoLink,
} from "./github-repo-links";
