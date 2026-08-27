/**
 * Free-plan member cap enforcement (issue #450).
 *
 * Members and pending invitations live in this worker's D1; the plan that
 * decides the cap lives in apps/api's KV. So the count happens here and the
 * cap is fetched over the `API` service binding —
 * `GET /internal/billing/member-cap` (apps/api routes/internal-billing.ts),
 * authed with the same `x-internal-billing-key` secret `billing-bridge.ts`
 * uses in the other direction.
 *
 * Both invite-creation paths call `memberCapDenial`, because either one alone
 * would leave a hole:
 *
 * - `POST /internal/invite` (internal-routes.ts) — what all three apps/api
 *   invite routes funnel into.
 * - `organizationHooks.beforeCreateInvitation` (auth.ts) — Better Auth's own
 *   `POST /api/auth/organization/invite-member`, which is publicly reachable
 *   with a session cookie and would otherwise be a direct bypass of exactly
 *   the quota-pooling this cap closes.
 *
 * Enforcement is at invite creation ONLY. Nothing here ejects, blocks, or
 * re-checks an existing member, and accepting an already-pending invitation
 * is never affected — a workspace that is over cap (a downgrade, or an
 * operator lowering an override) keeps everyone and just can't invite.
 *
 * Fails open. A missing binding, missing secret, non-ok response, or thrown
 * fetch leaves invites working, matching `billing-bridge.ts`'s treatment of
 * the same binding: an apps/api outage must not take invitations down.
 */
import { and, count, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";

/** Same intersection pattern as billing-bridge.ts — `API` and
 * `BILLING_INTERNAL_KEY` are optional and live on the ambient `Env`. */
type MemberCapEnv = AuthEnv & Pick<Env, "API" | "BILLING_INTERNAL_KEY">;

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface MemberCapDenial {
  code: "member_cap_reached";
  message: string;
}

/**
 * Discriminated outcome of the member-cap lookup: `ok: true` with `cap: null`
 * means no cap applies (unlimited plan, or the binding isn't configured at
 * all — e.g. local/test); `ok: false` means the lookup itself failed (thrown
 * fetch, non-OK response, malformed body) and no conclusion could be drawn.
 * `fetchMemberCap` below collapses both "no cap" cases into `null` for the
 * existing fail-open callers; `resolveMemberCapStrict` keeps the distinction
 * for the one caller that must fail closed instead.
 */
type MemberCapLookup =
  | { ok: true; cap: number; message: string | null }
  | { ok: true; cap: null }
  | { ok: false };

async function lookupMemberCap(env: MemberCapEnv, slug: string): Promise<MemberCapLookup> {
  if (!env.API || !env.BILLING_INTERNAL_KEY) return { ok: true, cap: null };

  const url = `https://internal/internal/billing/member-cap?workspace=${encodeURIComponent(slug)}`;
  let response: Response;
  try {
    response = await env.API.fetch(url, {
      headers: { "x-internal-billing-key": env.BILLING_INTERNAL_KEY },
    });
  } catch (error) {
    console.error(`memberCap: GET /internal/billing/member-cap for ${slug} threw`, error);
    return { ok: false };
  }
  if (!response.ok) {
    console.error(
      `memberCap: GET /internal/billing/member-cap for ${slug} failed with status ${response.status}`,
    );
    return { ok: false };
  }
  const body = (await response.json().catch(() => null)) as {
    cap?: unknown;
    message?: unknown;
  } | null;
  if (body === null) {
    console.error(
      `memberCap: GET /internal/billing/member-cap for ${slug} returned malformed JSON`,
    );
    return { ok: false };
  }
  const cap = body.cap;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return { ok: true, cap: null };
  return { ok: true, cap, message: typeof body.message === "string" ? body.message : null };
}

/** The resolved cap for a workspace, or `null` when unlimited/unknown —
 * fail-open: a lookup failure is indistinguishable here from "no cap". */
async function fetchMemberCap(
  env: MemberCapEnv,
  slug: string,
): Promise<{ cap: number; message: string | null } | null> {
  const result = await lookupMemberCap(env, slug);
  if (!result.ok || result.cap === null) return null;
  return { cap: result.cap, message: result.message };
}

/**
 * Current members plus pending invitations for an org. Pending invites count
 * toward the cap, or the cap is fiction: three pending invitations on a free
 * workspace already spend every seat.
 */
async function countSeatsInUse(db: Db, organizationId: string): Promise<number> {
  const [[members], [invites]] = await Promise.all([
    db
      .select({ value: count() })
      .from(schema.member)
      .where(eq(schema.member.organizationId, organizationId)),
    db
      .select({ value: count() })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, organizationId),
          eq(schema.invitation.status, "pending"),
        ),
      ),
  ]);
  return (members?.value ?? 0) + (invites?.value ?? 0);
}

/**
 * The denial for creating one more invitation in this org, or `null` when the
 * invite may proceed.
 *
 * `inviterIsGlobalAdmin` bypasses the cap outright: operators comp an
 * exception by raising the workspace's `maxMembers` override, and shouldn't
 * be blocked mid-support-task by a cap they're allowed to change.
 *
 * `organizationSlug` is the workspace name — the org<->workspace mapping is
 * 1:1 by slug today (see apps/api's org-workspaces.ts).
 */
export async function memberCapDenial(
  env: MemberCapEnv,
  db: Db,
  args: { organizationId: string; organizationSlug: string; inviterIsGlobalAdmin?: boolean },
): Promise<MemberCapDenial | null> {
  if (args.inviterIsGlobalAdmin) return null;

  try {
    const resolved = await fetchMemberCap(env, args.organizationSlug);
    if (!resolved) return null;

    const inUse = await countSeatsInUse(db, args.organizationId);
    if (inUse < resolved.cap) return null;

    return {
      code: "member_cap_reached",
      message: resolved.message ?? `This workspace includes ${resolved.cap} members — cap reached.`,
    };
  } catch (error) {
    // Fail open: an invite is worth more than a perfectly enforced cap.
    console.error(`memberCap: check failed for ${args.organizationSlug}`, error);
    return null;
  }
}

/** The resolved cap for redemption-time enforcement (`POST /internal/join`
 * only) — distinct from `null`-collapsing `fetchMemberCap`/`memberCapDenial`
 * above so that caller can fail CLOSED on a lookup failure instead of
 * treating it as "no cap". */
export type MemberCapResolution =
  | { status: "unlimited" }
  | { status: "capped"; cap: number; message: string | null }
  | { status: "unavailable" };

/**
 * Strict counterpart to `memberCapDenial`, for `/internal/join`'s
 * redemption-time check only — every other caller (mint-time checks, the
 * email-invite path) keeps `memberCapDenial`'s fail-open posture unchanged.
 * A lookup failure here returns `"unavailable"` instead of being silently
 * treated as unlimited, so the caller can deny the join rather than let it
 * through uncounted.
 */
export async function resolveMemberCapStrict(
  env: MemberCapEnv,
  slug: string,
): Promise<MemberCapResolution> {
  try {
    const result = await lookupMemberCap(env, slug);
    if (!result.ok) return { status: "unavailable" };
    if (result.cap === null) return { status: "unlimited" };
    return { status: "capped", cap: result.cap, message: result.message };
  } catch (error) {
    console.error(`memberCap: strict check failed for ${slug}`, error);
    return { status: "unavailable" };
  }
}
