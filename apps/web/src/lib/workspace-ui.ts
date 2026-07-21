/**
 * Shared presentation helpers for account workspace pages.
 */

/** Minimal shape the consent-page workspace picker needs to order orgs. */
export interface OrderableOrg {
  slug: string;
  createdAt?: string | Date;
}

/**
 * Orders orgs oldest-first by `createdAt` for the OAuth consent workspace
 * picker (issue #231). Display order only — the picker's *default selection*
 * comes from the AS's GET /oauth2/workspace-choice resolution (org creation
 * time is not membership age, and a client-side default would overwrite the
 * stored choice on Allow); this sort just keeps the list stable and roughly
 * chronological. Entries without a parseable `createdAt` keep their given
 * relative order (stable sort) and sort after every entry that does have
 * one.
 */
export function orderOrgsOldestFirst<T extends OrderableOrg>(orgs: T[]): T[] {
  const withIndex = orgs.map((org, index) => ({ org, index }));
  withIndex.sort((a, b) => {
    const aTime = a.org.createdAt ? new Date(a.org.createdAt).getTime() : NaN;
    const bTime = b.org.createdAt ? new Date(b.org.createdAt).getTime() : NaN;
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid && aTime !== bTime) return aTime - bTime;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return a.index - b.index;
  });
  return withIndex.map((entry) => entry.org);
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

export type UsageSnapshot = {
  bytes: number;
  objects: number;
  uploadsInPeriod: number;
  maxStorageBytes?: number;
  maxUploadsPerPeriod?: number;
};

function formatUsagePlain(usage: UsageSnapshot): string {
  const parts = [
    formatBytes(usage.bytes),
    `${usage.objects} object${usage.objects === 1 ? "" : "s"}`,
  ];
  if (usage.uploadsInPeriod > 0) parts.push(`${usage.uploadsInPeriod} uploads this month`);
  return parts.join(" · ");
}

/** 0–100, one decimal. Missing/invalid caps → no bar. */
function usagePct(value: number, max: number | undefined): number | null {
  if (typeof max !== "number" || !(max > 0) || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round((value / max) * 1000) / 10));
}

/** One labeled meter — keep markup in sync with `Progress` in @uploads/ui. */
function progressRowHtml(label: string, detail: string, pct: number): string {
  let levelAttr = "";
  if (pct >= 100) levelAttr = ' data-level="full"';
  else if (pct >= 85) levelAttr = ' data-level="high"';
  return `<div class="ul-progress__row">
    <div class="ul-progress__head">
      <span class="ul-progress__label">${escapeHtml(label)}</span>
      <span class="ul-progress__value">${escapeHtml(detail)}</span>
    </div>
    <div class="ul-progress__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${escapeHtml(label)}">
      <div class="ul-progress__fill"${levelAttr} style="width:${pct}%"></div>
    </div>
  </div>`;
}

export function renderUsageHtml(usage: UsageSnapshot): string {
  const meters: { label: string; detail: string; pct: number }[] = [];
  const storagePct = usagePct(usage.bytes, usage.maxStorageBytes);
  if (storagePct !== null && usage.maxStorageBytes) {
    meters.push({
      label: "Storage",
      detail: `${formatBytes(usage.bytes)} of ${formatBytes(usage.maxStorageBytes)}`,
      pct: storagePct,
    });
  }
  const uploadsPct = usagePct(usage.uploadsInPeriod, usage.maxUploadsPerPeriod);
  if (uploadsPct !== null && usage.maxUploadsPerPeriod) {
    meters.push({
      label: "Uploads this month",
      detail: `${usage.uploadsInPeriod} of ${usage.maxUploadsPerPeriod}`,
      pct: uploadsPct,
    });
  }
  if (!meters.length) {
    return `<div class="usage-text">${escapeHtml(formatUsagePlain(usage))}</div>`;
  }
  const objects = `${usage.objects} object${usage.objects === 1 ? "" : "s"}`;
  return `<div class="ul-progress">${meters.map((m) => progressRowHtml(m.label, m.detail, m.pct)).join("")}</div><div class="usage-meta">${escapeHtml(objects)}</div>`;
}

/** Minimal member shape `renderMembersHtml` needs — api-client's `WorkspaceMember` satisfies it. */
export interface MemberRow {
  id?: string;
  email: string;
  name: string;
  role: string;
}

export interface MemberRowOptions {
  /** Viewer is owner/admin — enables controls when the per-row matrix allows. */
  canManage?: boolean;
  /** Org role of the viewer (`owner` | `admin`). Admins only manage members. */
  viewerRole?: string;
  /** Viewer's email — no controls on their own row. */
  selfEmail?: string;
}

/** Mirrors auth `memberManageDenied`: owner|admin on members; owner-only on admins. */
export function canManageMemberRow(member: MemberRow, opts: MemberRowOptions): boolean {
  if (!opts.canManage || !member.id) return false;
  if (member.role === "owner") return false;
  if (opts.selfEmail && member.email === opts.selfEmail) return false;
  // Admin → members only. Owner (or canManage without role) → members + admins.
  if (opts.viewerRole === "admin") return member.role === "member";
  return true;
}

/**
 * People-tab member list. Name leads when set (email sub-line); manageable
 * rows get role `<select>` + remove. `[]` → `""`.
 */
export function renderMembersHtml(members: MemberRow[], opts: MemberRowOptions = {}): string {
  return members
    .map((m) => {
      const lead = m.name || m.email;
      const sub = m.name ? `<span class="member-row__email">${escapeHtml(m.email)}</span>` : "";
      const controls = canManageMemberRow(m, opts)
        ? `<span class="member-row__actions">` +
          `<select class="member-row__role-select" data-member-id="${escapeHtml(m.id!)}" aria-label="Role for ${escapeHtml(m.email)}">` +
          `<option value="member"${m.role === "member" ? " selected" : ""}>member</option>` +
          `<option value="admin"${m.role === "admin" ? " selected" : ""}>admin</option>` +
          `</select>` +
          `<button type="button" class="text-btn member-row__remove" data-member-id="${escapeHtml(m.id!)}" data-member-email="${escapeHtml(m.email)}">Remove</button>` +
          `</span>`
        : `<span class="member-row__role">${escapeHtml(m.role)}</span>`;
      return `<div class="member-row"><span class="member-row__who"><span class="member-row__name">${escapeHtml(lead)}</span>${sub}</span>${controls}</div>`;
    })
    .join("");
}

/**
 * Pending invites as people-list rows (same `.member-row` surface as members).
 * Status badge + revoke. `[]` → `""` (caller omits the block).
 */
export function renderInvitesHtml(
  invites: { id: string; email: string; status: string }[],
): string {
  return invites
    .map((inv) => {
      const status = inv.status || "pending";
      return (
        `<div class="member-row member-row--pending">` +
        `<span class="member-row__who"><span class="member-row__name">${escapeHtml(inv.email)}</span></span>` +
        `<span class="member-row__actions">` +
        `<span class="member-row__role member-row__role--pending">${escapeHtml(status)}</span>` +
        `<button type="button" class="text-btn invite-row__revoke" data-invite-id="${escapeHtml(inv.id)}" data-invite-email="${escapeHtml(inv.email)}">Revoke</button>` +
        `</span></div>`
      );
    })
    .join("");
}

export function isWorkspaceAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function suggestedWorkspaceName(email: string | undefined): string {
  const local = (email ?? "").split("@")[0] ?? "";
  const sanitized = local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return WORKSPACE_NAME_RE.test(sanitized) ? sanitized : "";
}

/**
 * Sanitize a `?next=` return path to a same-origin absolute path (with
 * optional query/hash). Rejects anything that could navigate off-origin:
 * absolute URLs, protocol-relative `//host`, and the backslash variant
 * `/\host` browsers normalize to `//host`. Returns null when unusable so
 * callers fall back to their default destination.
 */
export function safeSameOriginPath(raw: string | null | undefined): string | null {
  if (!raw || raw[0] !== "/") return null;
  if (raw[1] === "/" || raw[1] === "\\") return null;
  if (raw.includes("://")) return null;
  return raw;
}

export function createErrorCopy(code: string): string {
  switch (code) {
    case "invalid_workspace_name":
      return "Use 2–63 lowercase letters, digits, or hyphens.";
    case "reserved_workspace_name":
      return "That name is reserved — pick another.";
    case "workspace_name_taken":
      return "That name is taken — pick another.";
    case "workspace_cap_reached":
      return "You've reached the workspace limit for this account.";
    default:
      return "Workspace creation failed — try again.";
  }
}

/**
 * Copy-to-clipboard via event delegation under `root`.
 *
 * Safe after ClientRouter swaps when bound once on a long-lived root (e.g.
 * `document` with a page-scoped selector) or re-bound on a fresh container
 * each `astro:page-load`. Narrow `selector` when binding on `document` so
 * other shells' copy buttons are not double-handled after soft nav.
 *
 * `Node`, not `ParentNode`: this only needs `addEventListener`/`contains`
 * (both on `Node`), and worker-configuration.d.ts's HTMLRewriter `Element`
 * ambiently redeclares `append()`, which makes DOM elements unassignable to
 * `ParentNode`. Same wrangler-types drift worked around in oauth/consent.astro.
 */
export function bindCopyButtons(root: Node, selector = "button[data-copy]"): void {
  root.addEventListener("click", (event) => {
    void (async () => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(selector);
      if (!button || !root.contains(button)) return;
      const previous = button.textContent;
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
        if (!root.contains(button)) return;
        button.textContent = "copied ✓";
        button.classList.add("done");
        setTimeout(() => {
          if (!root.contains(button)) return;
          button.textContent = previous;
          button.classList.remove("done");
        }, 1500);
      } catch {
        // Clipboard blocked — leave the label.
      }
    })();
  });
}
