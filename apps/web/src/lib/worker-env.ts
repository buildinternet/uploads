/**
 * Re-exports the Workers runtime `env` singleton from a non-hidden directory.
 *
 * oxlint's type-aware checker (typeAware/typeCheck in .oxlintrc.json) fails
 * to resolve the ambient `cloudflare:workers` module for any file that lives
 * directly under a dot-directory (e.g. `src/pages/.well-known/**`), even
 * though `tsc`/`astro check` resolve it fine — verified by reproducing with
 * an otherwise-identical file outside `.well-known`. Well-known route files
 * import `env` from here instead of `cloudflare:workers` directly to avoid
 * that lint false-positive.
 */
export { env } from "cloudflare:workers";
