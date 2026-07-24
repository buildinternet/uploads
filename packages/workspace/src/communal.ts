/**
 * Identity of the communal workspace — the one shared tenant every account
 * belongs to, as opposed to the workspaces a user creates or is invited to.
 *
 * It is privileged in several unrelated places: its slug is reserved against
 * self-serve registration (`slug-policy.ts`), it is exempt from the free-plan
 * member cap (`routes/internal-billing.ts`) and from the workspace reaper, and
 * the account UI skips it when choosing which workspace to open. Those rules
 * are enforced in different workers, so the slug itself lives here — one home
 * that both `apps/api` and `apps/web` can import — rather than being spelled
 * out at each site where a rename would have to be applied in lockstep with no
 * compiler help.
 *
 * Note the distinction this package does *not* erase: server code may compare
 * against the slug, but clients should be *told* whether a workspace is
 * communal (`/me/workspaces` stamps `communal` on each entry) instead of
 * re-deriving a business rule from a naming convention. The one client-side
 * comparison left is `apps/web`'s `mapMyWorkspace`, which falls back to the
 * slug only when the field is absent — i.e. against an api build older than
 * the flag, since web and api deploy independently.
 */
export const COMMUNAL_WORKSPACE = "default";

/** Whether `name` is the communal workspace. */
export function isCommunalWorkspace(name: string): boolean {
  return name === COMMUNAL_WORKSPACE;
}
