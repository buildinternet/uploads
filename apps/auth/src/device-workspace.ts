/**
 * Device-login workspace selection (issue #362). The `/device` approval page
 * needs to know which workspace the terminal asked for — and be able to change
 * it — BEFORE it approves, so it can never show "you're signed in" for a
 * workspace the user has no access to.
 *
 * The channel is the device-code `scope` column. better-auth's
 * `deviceAuthorization` plugin stores whatever `POST /device/code` sent and
 * echoes it back to the client in the token response (`scope:
 * claimedDeviceCode.scope || ""`), so a value written here reaches the CLI at
 * exchange with no extra table and no extra round trip. Ordering is safe by
 * construction: the CLI cannot receive a token before the row is `approved`,
 * and the page writes the choice strictly before calling `/device/approve`.
 *
 * `parseDeviceScope` is mirrored in packages/uploads/src/commands/login.ts —
 * that package ships with no workspace dependencies, so the two copies are
 * deliberately independent. Keep the vocabulary in sync.
 *
 * The picker UI lives on apps/web's /device page; this file is only the
 * auth-side plumbing (pattern: src/workspace-choice.ts).
 */
import { createAuthEndpoint, sessionMiddleware, APIError } from "better-auth/api";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/** Scope token carrying the requested workspace, e.g. `workspace:acme`. */
export const WORKSPACE_SCOPE_PREFIX = "workspace:";
/** Scope token meaning "the CLI will provision this workspace after login" (`uploads login --create`). */
export const CREATE_SCOPE_TOKEN = "create";

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DeviceScope {
  workspace: string | null;
  create: boolean;
}

/** Read the workspace request out of a device-code scope string. Order-insensitive; unknown tokens ignored. */
export function parseDeviceScope(scope: string | null | undefined): DeviceScope {
  const tokens = (scope ?? "").split(/\s+/).filter(Boolean);
  const slug =
    tokens
      .find((t) => t.startsWith(WORKSPACE_SCOPE_PREFIX))
      ?.slice(WORKSPACE_SCOPE_PREFIX.length) ?? "";
  return { workspace: slug || null, create: tokens.includes(CREATE_SCOPE_TOKEN) };
}

/**
 * The scope value written when the browser records a choice. Deliberately
 * never includes `create`: a surviving `create` token is exactly how the CLI
 * tells "the browser decided" from "the browser deferred to me".
 */
export function workspaceScopeValue(slug: string): string {
  return `${WORKSPACE_SCOPE_PREFIX}${slug}`;
}

/**
 * `member` ⋈ `organization` for a user, oldest membership first. Same join and
 * ordering as `membershipSlugs` in src/workspace-choice.ts, kept separate
 * because this one needs display names too.
 */
async function memberships(db: Db, userId: string): Promise<{ slug: string; name: string }[]> {
  return db
    .select({ slug: schema.organization.slug, name: schema.organization.name })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
}

/**
 * Load a device-code row that this user may act on: it must exist, be
 * unexpired, still be `pending`, and be unclaimed or claimed by the caller —
 * the same conditions better-auth's own `/device/approve` enforces. Unlike the
 * plugin's `GET /device`, this never claims the row's `userId`.
 */
async function loadActionableRow(db: Db, rawUserCode: unknown, userId: string) {
  if (typeof rawUserCode !== "string" || rawUserCode.length === 0) {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_user_code",
      message: "`user_code` is required.",
    });
  }
  // Stored hyphen-stripped by the plugin's own routes.
  const userCode = rawUserCode.replace(/-/g, "");
  const [row] = await db
    .select()
    .from(schema.deviceCode)
    .where(eq(schema.deviceCode.userCode, userCode))
    .limit(1);
  if (!row) {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_user_code",
      message: "That code is invalid or has expired.",
    });
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new APIError("BAD_REQUEST", {
      code: "expired_user_code",
      message: "That code has expired.",
    });
  }
  if (row.status !== "pending") {
    throw new APIError("BAD_REQUEST", {
      code: "device_code_already_processed",
      message: "That request was already approved or denied.",
    });
  }
  if (row.userId && row.userId !== userId) {
    throw new APIError("FORBIDDEN", {
      code: "device_code_claimed",
      message: "That request belongs to another account.",
    });
  }
  return row;
}

export function deviceWorkspacePlugin(db: Db) {
  return {
    id: "uploads-device-workspace",
    endpoints: {
      /**
       * `GET /device/workspace?user_code=…` — what the terminal asked for plus
       * the workspaces the signed-in user can actually pick. The page turns
       * this into its panel state (apps/web/src/lib/device-workspace.ts).
       */
      deviceWorkspaceGet: createAuthEndpoint(
        "/device/workspace",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          // better-call always populates ctx.query from the URL's search
          // params, with or without a declared query schema — so no zod here
          // (apps/auth has no direct zod dependency).
          const row = await loadActionableRow(
            db,
            (ctx.query as { user_code?: unknown } | undefined)?.user_code,
            userId,
          );
          const { workspace, create } = parseDeviceScope(row.scope);
          return ctx.json({
            requested: workspace,
            create,
            workspaces: await memberships(db, userId),
          });
        },
      ),
      /**
       * `POST /device/workspace` `{ userCode, workspace }` — record the
       * workspace this device login should mint for. Validates the slug
       * against the caller's own memberships; a non-membership slug 400s
       * rather than recording a workspace the user can't use (same contract as
       * POST /oauth2/workspace-choice).
       */
      deviceWorkspaceSet: createAuthEndpoint(
        "/device/workspace",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          const body = ctx.body as { userCode?: unknown; workspace?: unknown } | undefined;
          const workspace = typeof body?.workspace === "string" ? body.workspace : "";
          if (!workspace) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_workspace",
              message: "`workspace` must be a non-empty string.",
            });
          }
          const row = await loadActionableRow(db, body?.userCode, userId);

          const slugs = (await memberships(db, userId)).map((w) => w.slug);
          if (!slugs.includes(workspace)) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_workspace",
              message: "You are not a member of that workspace.",
            });
          }

          await db
            .update(schema.deviceCode)
            .set({ scope: workspaceScopeValue(workspace) })
            .where(eq(schema.deviceCode.id, row.id));

          return ctx.json({ status: true });
        },
      ),
    },
  };
}
