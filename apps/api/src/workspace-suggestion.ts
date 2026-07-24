/**
 * A suggested workspace name for a user who is about to create their first
 * one (issue #506), derived from their linked GitHub login.
 *
 * This is a *hint*, never a decision. Nothing is provisioned here and no name
 * is claimed — the caller renders the result into an editable field and the
 * user confirms it. That framing is what makes the derivation tractable: the
 * mapping from GitHub login to workspace slug is lossy in several ways (case,
 * a 1-char length floor, reserved names, the profanity blocklist, collisions
 * with existing workspaces), and every one of those is allowed to resolve to
 * "no suggestion" here. An empty field is exactly today's behavior, so a
 * failure at any step costs the user a prefill, never an error.
 *
 * Auto-*provisioning* from the same signal was considered and rejected: it
 * would have to invent an answer for each of those cases (a suffix policy, a
 * silent fallback ladder) and would claim a slug on every signup whether or
 * not the account was ever used.
 */
import { validateSlug } from "./slug-policy";
import { resolveUploaderLogin } from "./uploader-identity";
import { isWorkspaceNameTaken } from "./workspace";

/**
 * Reduce a GitHub login to a candidate slug, or null when it cannot become
 * one. GitHub allows alphanumerics and single hyphens, 1–39 chars; our slugs
 * are lowercase, 2–63, and must start alphanumeric — so lowercasing plus a
 * defensive scrub covers the shape, and the length floor is a real rejection
 * (1-char logins like `t` exist and cannot be represented).
 */
export function slugFromGithubLogin(login: string): string | null {
  const candidate = login
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return candidate.length >= 2 ? candidate : null;
}

/**
 * The name to prefill for `userId`, or null for "offer nothing".
 *
 * Null on every one of: no linked GitHub account, a login lookup that failed
 * or was rate-limited, a login that cannot become a valid slug, a slug that is
 * reserved or blocklisted, and a slug already taken.
 *
 * "Taken" goes through `isWorkspaceNameTaken`, the same raw-occupancy check
 * `POST /v1/workspaces` uses — NOT `loadWorkspaceRecord`, which hides
 * soft-deleted records and purged tombstones even though they still hold the
 * slug. Using the lenient lookup here would prefill names that creation then
 * rejects with `workspace_name_taken`.
 *
 * That check is deliberately the *only* availability lookup exposed here, and
 * it runs against a server-derived candidate, never a client-supplied string —
 * so this cannot be turned into a name-enumeration oracle. Learning that your
 * own login is taken is no more than you'd learn by trying to create it.
 */
export async function suggestWorkspaceName(env: Env, userId: string): Promise<string | null> {
  // No repo hint: `resolveUploaderLogin` falls through to the unauthenticated
  // GitHub endpoint, which is IP-rate-limited. Acceptable because the result
  // is cached per user in KV and a miss simply means no suggestion.
  const login = await resolveUploaderLogin(env, userId, undefined);
  if (!login) return null;

  const candidate = slugFromGithubLogin(login);
  if (!candidate) return null;
  if (!validateSlug(candidate).ok) return null;

  return (await isWorkspaceNameTaken(env, candidate)) ? null : candidate;
}
