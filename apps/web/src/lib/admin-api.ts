/**
 * Session-cookie-authenticated wrappers for apps/api's `/admin-ui/*` operator
 * surface, used by the `AdminWorkspacesTable` island. Same conventions as the
 * `/admin-ui` fetches the page shipped with when it was imperative Astro:
 * `credentials: "include"` (the cross-subdomain session cookie), `cache:
 * "no-store"` (an operator wants the live record, not a stale one), and error
 * bodies unwrapped as `{ error: { message } }` so a failed PATCH surfaces the
 * server's reason inline instead of a bare status code.
 *
 * The security boundary is `/admin-ui/*` itself (requireAdminUser over the
 * AUTH binding) — these helpers add no gate of their own, matching the
 * AdminLayout comment that client-side admin gating is a UX affordance only.
 *
 * Wire types are imported from the producing route module (`@uploads/api/
 * admin-ui`, the #896 inferred-serializer pattern) so a server/client drift is
 * a compile error, never a silent shape mismatch.
 */
import type {
  AdminGithubLink,
  AdminLimitsResponse,
  AdminPlanResponse,
  AdminStorageResponse,
  AdminWorkspaceSummary,
  OpenEnrollment,
  OrgInvite,
  OrgMember,
} from "@uploads/api/admin-ui";
import { trimOrigin } from "./api-client";

export type {
  AdminGithubLink,
  AdminLimitsResponse,
  AdminPlanResponse,
  AdminStorageResponse,
  AdminWorkspaceSummary,
  OpenEnrollment,
  OrgInvite,
  OrgMember,
};

/** Pull `{ error: { message } }` out of a non-OK body, falling back to status. */
async function failure(res: Response, fallback: string): Promise<Error> {
  const payload = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return new Error(payload?.error?.message || `${fallback}: ${res.status}`);
}

/** A caught error's message, or `fallback` when it carries none — the editors'
 *  shared idiom for turning a rejected save into an inline status string. */
export function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The `/admin-ui/*` client bound to one resolved api origin. */
export interface AdminApi {
  listWorkspaces(): Promise<AdminWorkspaceSummary[]>;
  getMembers(workspace: string): Promise<OrgMember[]>;
  getInvites(workspace: string): Promise<OrgInvite[]>;
  createInvite(workspace: string, body: { email: string; role: string }): Promise<void>;
  getPlan(workspace: string): Promise<AdminPlanResponse>;
  savePlan(workspace: string, plan: string): Promise<AdminPlanResponse>;
  getLimits(workspace: string): Promise<AdminLimitsResponse>;
  saveLimits(workspace: string, body: Record<string, number | null>): Promise<AdminLimitsResponse>;
  getStorage(workspace: string): Promise<AdminStorageResponse>;
  saveStorage(workspace: string, byoBucketEnabled: boolean): Promise<AdminStorageResponse>;
  getGithubLinks(workspace: string): Promise<AdminGithubLink[]>;
  getInviteLinks(workspace: string): Promise<OpenEnrollment[]>;
  createInviteLink(workspace: string, body: { label?: string; scopes: string[] }): Promise<string>;
  revokeInviteLink(workspace: string, id: string): Promise<void>;
}

export function makeAdminApi(apiOrigin: string): AdminApi {
  const base = trimOrigin(apiOrigin);
  const ws = (name: string) => `${base}/admin-ui/workspaces/${encodeURIComponent(name)}`;

  async function get<T>(url: string, label: string): Promise<T> {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw await failure(res, label);
    return (await res.json()) as T;
  }

  async function send<T>(
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    label: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await failure(res, label);
    return (await res.json().catch(() => null)) as T;
  }

  return {
    async listWorkspaces() {
      const { workspaces } = await get<{ workspaces: AdminWorkspaceSummary[] }>(
        `${base}/admin-ui/workspaces`,
        "load workspaces failed",
      );
      return workspaces;
    },
    async getMembers(workspace) {
      const { members } = await get<{ members: OrgMember[] }>(
        `${ws(workspace)}/members`,
        "load members failed",
      );
      return members;
    },
    async getInvites(workspace) {
      const { invites } = await get<{ invites: OrgInvite[] }>(
        `${ws(workspace)}/invites`,
        "load invites failed",
      );
      return invites;
    },
    async createInvite(workspace, body) {
      await send(`${ws(workspace)}/invites`, "POST", "invite failed", body);
    },
    getPlan(workspace) {
      return get<AdminPlanResponse>(`${ws(workspace)}/plan`, "load plan failed");
    },
    savePlan(workspace, plan) {
      return send<AdminPlanResponse>(`${ws(workspace)}/plan`, "PATCH", "save plan failed", {
        plan,
      });
    },
    getLimits(workspace) {
      return get<AdminLimitsResponse>(`${ws(workspace)}/limits`, "load limits failed");
    },
    saveLimits(workspace, body) {
      return send<AdminLimitsResponse>(
        `${ws(workspace)}/limits`,
        "PATCH",
        "save limits failed",
        body,
      );
    },
    getStorage(workspace) {
      return get<AdminStorageResponse>(`${ws(workspace)}/storage`, "load storage failed");
    },
    saveStorage(workspace, byoBucketEnabled) {
      return send<AdminStorageResponse>(
        `${ws(workspace)}/storage`,
        "PATCH",
        "save storage failed",
        {
          byoBucketEnabled,
        },
      );
    },
    async getGithubLinks(workspace) {
      const { links } = await get<{ links: AdminGithubLink[] }>(
        `${ws(workspace)}/github-links`,
        "load github links failed",
      );
      return links;
    },
    async getInviteLinks(workspace) {
      const { links } = await get<{ links: OpenEnrollment[] }>(
        `${ws(workspace)}/invite-links`,
        "load invite links failed",
      );
      return links;
    },
    async createInviteLink(workspace, body) {
      const { url } = await send<{ url: string }>(
        `${ws(workspace)}/invite-links`,
        "POST",
        "invite link failed",
        body,
      );
      return url;
    },
    async revokeInviteLink(workspace, id) {
      await send(
        `${ws(workspace)}/invite-links/${encodeURIComponent(id)}`,
        "DELETE",
        "revoke failed",
      );
    },
  };
}
