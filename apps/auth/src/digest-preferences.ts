/**
 * Per-membership weekly digest switches. Account → Profile lists one row
 * per workspace. The admin pulse can be changed only by an admin or owner
 * of that workspace.
 */
import { createAuthEndpoint, sessionMiddleware, APIError } from "better-auth/api";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  digestPreferencesResponse,
  isDigestAdminRole,
  type DigestWorkspacePreference,
} from "./digest-preferences-wire";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function listDigestPreferences(
  db: Db,
  userId: string,
): Promise<DigestWorkspacePreference[]> {
  const rows = await db
    .select({
      organizationId: schema.member.organizationId,
      slug: schema.organization.slug,
      name: schema.organization.name,
      role: schema.member.role,
      notifyWeeklyDigest: schema.member.notifyWeeklyDigest,
      notifyWeeklyWorkspaceDigest: schema.member.notifyWeeklyWorkspaceDigest,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.organization.name), asc(schema.organization.slug));

  return rows.map((row) => ({
    organizationId: row.organizationId,
    slug: row.slug,
    name: row.name,
    role: row.role,
    admin: isDigestAdminRole(row.role),
    notifyWeeklyDigest: row.notifyWeeklyDigest,
    notifyWeeklyWorkspaceDigest: row.notifyWeeklyWorkspaceDigest,
  }));
}

export async function updateDigestPreference(
  db: Db,
  userId: string,
  organizationId: string,
  patch: { notifyWeeklyDigest?: boolean; notifyWeeklyWorkspaceDigest?: boolean },
): Promise<DigestWorkspacePreference> {
  const [membership] = await db
    .select({
      id: schema.member.id,
      role: schema.member.role,
      slug: schema.organization.slug,
      name: schema.organization.name,
      notifyWeeklyDigest: schema.member.notifyWeeklyDigest,
      notifyWeeklyWorkspaceDigest: schema.member.notifyWeeklyWorkspaceDigest,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, organizationId)))
    .limit(1);

  if (!membership) {
    throw new APIError("FORBIDDEN", {
      code: "not_a_member",
      message: "You are not a member of that workspace.",
    });
  }

  if (patch.notifyWeeklyWorkspaceDigest !== undefined && !isDigestAdminRole(membership.role)) {
    throw new APIError("FORBIDDEN", {
      code: "not_an_admin",
      message: "The admin pulse is for workspace admins and owners.",
    });
  }

  const next = {
    notifyWeeklyDigest: patch.notifyWeeklyDigest ?? membership.notifyWeeklyDigest,
    notifyWeeklyWorkspaceDigest:
      patch.notifyWeeklyWorkspaceDigest ?? membership.notifyWeeklyWorkspaceDigest,
  };
  await db.update(schema.member).set(next).where(eq(schema.member.id, membership.id));

  return {
    organizationId,
    slug: membership.slug,
    name: membership.name,
    role: membership.role,
    admin: isDigestAdminRole(membership.role),
    notifyWeeklyDigest: next.notifyWeeklyDigest,
    notifyWeeklyWorkspaceDigest: next.notifyWeeklyWorkspaceDigest,
  };
}

function readPatch(body: unknown): {
  organizationId: string;
  notifyWeeklyDigest?: boolean;
  notifyWeeklyWorkspaceDigest?: boolean;
} {
  if (!body || typeof body !== "object") {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_request",
      message: "organizationId is required.",
    });
  }
  const raw = body as {
    organizationId?: unknown;
    notifyWeeklyDigest?: unknown;
    notifyWeeklyWorkspaceDigest?: unknown;
  };
  if (typeof raw.organizationId !== "string" || raw.organizationId.length === 0) {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_request",
      message: "organizationId is required.",
    });
  }
  if (raw.notifyWeeklyDigest !== undefined && typeof raw.notifyWeeklyDigest !== "boolean") {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_request",
      message: "notifyWeeklyDigest must be a boolean.",
    });
  }
  if (
    raw.notifyWeeklyWorkspaceDigest !== undefined &&
    typeof raw.notifyWeeklyWorkspaceDigest !== "boolean"
  ) {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_request",
      message: "notifyWeeklyWorkspaceDigest must be a boolean.",
    });
  }
  if (raw.notifyWeeklyDigest === undefined && raw.notifyWeeklyWorkspaceDigest === undefined) {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_request",
      message: "Set notifyWeeklyDigest or notifyWeeklyWorkspaceDigest.",
    });
  }
  return {
    organizationId: raw.organizationId,
    ...(raw.notifyWeeklyDigest !== undefined ? { notifyWeeklyDigest: raw.notifyWeeklyDigest } : {}),
    ...(raw.notifyWeeklyWorkspaceDigest !== undefined
      ? { notifyWeeklyWorkspaceDigest: raw.notifyWeeklyWorkspaceDigest }
      : {}),
  };
}

export function digestPreferencesPlugin(db: Db) {
  return {
    id: "uploads-digest-preferences",
    endpoints: {
      digestPreferencesGet: createAuthEndpoint(
        "/digest-preferences",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const workspaces = await listDigestPreferences(db, ctx.context.session.user.id);
          return ctx.json(digestPreferencesResponse(workspaces));
        },
      ),
      digestPreferencesSet: createAuthEndpoint(
        "/digest-preferences",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const patch = readPatch(ctx.body);
          const workspace = await updateDigestPreference(
            db,
            ctx.context.session.user.id,
            patch.organizationId,
            patch,
          );
          return ctx.json({ workspace });
        },
      ),
    },
  };
}
