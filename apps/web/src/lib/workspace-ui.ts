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

/**
 * Decimal (SI) human sizes for user-facing UI. Plan catalog caps are defined
 * as round decimal numbers (250 MB, 10 GB); binary units made Free look like
 * "238 MB". Used for both measured usage and marketed limits so meters match
 * plan cards.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** Alias kept for call sites that distinguish plan-card copy; same SI base. */
export function formatMarketedBytes(bytes: number): string {
  return formatBytes(bytes);
}

export type UsageSnapshot = {
  bytes: number;
  objects: number;
  uploadsInPeriod: number;
  maxStorageBytes?: number;
  maxUploadsPerPeriod?: number;
  /** Bytes still on hosted storage (shared-lane residue). */
  sharedBytes?: number;
  /** "shared" = BYO bucket active: the storage cap meters only hosted
   * residue, the customer's own bucket is unmetered. */
  storageBudgetBasis?: "total" | "shared";
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
  // BYO-active workspaces (`storageBudgetBasis: "shared"`) meter only the
  // residue still on hosted storage — bytes in the customer's own bucket are
  // unmetered, so a total-bytes meter would overstate usage against a cap
  // that doesn't apply to it.
  const byoActive = usage.storageBudgetBasis === "shared";
  const meteredBytes = byoActive ? (usage.sharedBytes ?? 0) : usage.bytes;
  const storagePct = usagePct(meteredBytes, usage.maxStorageBytes);
  if (storagePct !== null && usage.maxStorageBytes) {
    meters.push({
      label: byoActive ? "Hosted storage" : "Storage",
      detail: `${formatBytes(meteredBytes)} of ${formatBytes(usage.maxStorageBytes)}`,
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
  const byoNote = byoActive
    ? `<div class="usage-meta">Storage on your own bucket is unmetered — the plan limit only counts files on hosted storage.</div>`
    : "";
  if (!meters.length) {
    return `<div class="usage-text">${escapeHtml(formatUsagePlain(usage))}</div>${byoNote}`;
  }
  const objects = `${usage.objects} object${usage.objects === 1 ? "" : "s"}`;
  return `<div class="ul-progress">${meters.map((m) => progressRowHtml(m.label, m.detail, m.pct)).join("")}</div><div class="usage-meta">${escapeHtml(objects)}</div>${byoNote}`;
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

/** People-tab role badge — the read-only counterpart of the role `<select>`. */
const MEMBER_ROLE_BADGE_CLASS = "font-mono text-xs uppercase tracking-wider text-muted-foreground";
/** Right-hand actions cluster inside the role cell. */
const MEMBER_ROW_ACTIONS_CLASS = "inline-flex items-center gap-2";

/**
 * People table shell — same `.ws-table` chrome as the galleries tab, so the
 * two workspace lists read as one surface. `rowsHtml` is `<tr>` rows from
 * `renderMembersHtml`/`renderInvitesHtml` (concatenated: pending invites
 * render in the same table). Callers paint the empty state themselves.
 */
export function renderPeopleTableHtml(rowsHtml: string): string {
  return `<div class="ws-table-wrap">
<table class="ws-table" aria-label="People">
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Email</th>
      <th scope="col" class="actions">Role</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>
</div>`;
}

/**
 * People-tab member rows (`<tr>`s for `renderPeopleTableHtml`). Manageable
 * rows get role `<select>` + remove in the role cell. `[]` → `""`.
 */
export function renderMembersHtml(members: MemberRow[], opts: MemberRowOptions = {}): string {
  return members
    .map((m) => {
      const name = m.name
        ? `<span class="member-row__name font-semibold text-foreground">${escapeHtml(m.name)}</span>`
        : EMPTY_CELL;
      const controls = canManageMemberRow(m, opts)
        ? `<span class="${MEMBER_ROW_ACTIONS_CLASS}">` +
          `<select class="member-row__role-select ul-select ul-select--sm" style="width: auto" data-member-id="${escapeHtml(m.id!)}" aria-label="Role for ${escapeHtml(m.email)}">` +
          `<option value="member"${m.role === "member" ? " selected" : ""}>member</option>` +
          `<option value="admin"${m.role === "admin" ? " selected" : ""}>admin</option>` +
          `</select>` +
          `<button type="button" class="text-btn member-row__remove" data-member-id="${escapeHtml(m.id!)}" data-member-email="${escapeHtml(m.email)}">Remove</button>` +
          `</span>`
        : `<span class="member-row__role ${MEMBER_ROLE_BADGE_CLASS}">${escapeHtml(m.role)}</span>`;
      return `<tr class="member-row">
  <td>${name}</td>
  <td class="member-row__email">${escapeHtml(m.email)}</td>
  <td class="actions">${controls}</td>
</tr>`;
    })
    .join("");
}

/**
 * Member-table placeholder — same table chrome as the real render, so the
 * swap to real rows repaints without rearranging.
 */
export function renderMembersPlaceholderHtml(rows = 2): string {
  const widths = ["124px", "96px"];
  const body = Array.from(
    { length: rows },
    (_, i) =>
      `<tr class="member-row">
  <td>${skeletonBarHtml(widths[i % widths.length])}</td>
  <td>${skeletonBarHtml("140px")}</td>
  <td class="actions">${skeletonBarHtml("42px")}</td>
</tr>`,
  ).join("");
  return renderPeopleTableHtml(body);
}

/**
 * Pending invites as people-table rows (same `<tr>` surface as members).
 * Status badge + revoke. `[]` → `""` (caller omits the block).
 */
export function renderInvitesHtml(
  invites: { id: string; email: string; status: string }[],
): string {
  return invites
    .map((inv) => {
      const status = inv.status || "pending";
      return `<tr class="member-row member-row--pending">
  <td>${EMPTY_CELL}</td>
  <td class="member-row__email text-muted-foreground">${escapeHtml(inv.email)}</td>
  <td class="actions"><span class="${MEMBER_ROW_ACTIONS_CLASS}"><span class="member-row__role member-row__role--pending font-mono text-xs uppercase tracking-wider text-primary">${escapeHtml(status)}</span><button type="button" class="text-btn invite-row__revoke" data-invite-id="${escapeHtml(inv.id)}" data-invite-email="${escapeHtml(inv.email)}">Revoke</button></span></td>
</tr>`;
    })
    .join("");
}

/**
 * Issue #869 phase B: the People page's outstanding `kind: 'member'`
 * join-link list. Same `.ws-table` chrome as the people list so the card
 * reads as one surface. Each row shows the label (or a generic fallback),
 * expiry, and use count, plus a revoke button matching the `text-btn`
 * treatment `renderInvitesHtml`'s revoke uses. `[]` → `""` (caller
 * renders its own empty state).
 *
 * Issue #876: `expiresAt` nullable — a standing link shows "Never".
 * Uses show as "N" (unlimited) or "N/max" (capped) so a multi-use link
 * is auditable at a glance.
 */
export function renderInviteLinksHtml(
  links: {
    id: string;
    label: string | null;
    expiresAt: string | null;
    maxUses: number | null;
    useCount: number;
  }[],
): string {
  if (links.length === 0) return "";
  const rows = links
    .map((link) => {
      const label = link.label ? escapeHtml(link.label) : "Unlabeled link";
      const when = link.expiresAt
        ? new Date(link.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
        : "Never";
      const uses = link.maxUses === null ? `${link.useCount}` : `${link.useCount}/${link.maxUses}`;
      return `<tr class="invite-link-row">
  <td class="invite-link-row__label">${label}</td>
  <td class="invite-link-row__expiry text-muted-foreground">${escapeHtml(when)}</td>
  <td class="num">${escapeHtml(uses)}</td>
  <td class="actions"><button type="button" class="text-btn invite-link-row__revoke" data-link-id="${escapeHtml(link.id)}" data-link-label="${label}">Revoke</button></td>
</tr>`;
    })
    .join("");
  return `<div class="ws-table-wrap">
<table class="ws-table" aria-label="Invite links">
  <thead>
    <tr>
      <th scope="col">Label</th>
      <th scope="col">Expires</th>
      <th scope="col" class="num">Uses</th>
      <th scope="col" class="actions"><span class="sr-only">Actions</span></th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
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

const EMPTY_CELL = `<span class="muted">—</span>`;

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

/**
 * Loading placeholders.
 *
 * These live beside the real builders on purpose. Their whole job is to
 * occupy the *exact* height the real markup will occupy, so when data lands
 * nothing on the page moves — and the only way to keep that true over time is
 * for both versions of a given block to be edited in the same file, in view of
 * each other. A placeholder that drifts from its counterpart is worse than no
 * placeholder at all, because it reintroduces the shift it was added to remove.
 *
 * Deliberately unanimated: a placeholder is only ever seen on a first visit to
 * a workspace, and a pulse at that moment reads as noise rather than progress.
 */

/**
 * One masked bar. `width` drives `--ws-skel-w`.
 *
 * The value lands in a `style` attribute, which is a CSS context — HTML
 * escaping would not make an attacker-controlled value safe there. Every call
 * site passes a literal, so rather than rely on that staying true, anything
 * that isn't a plain CSS length is dropped for the default.
 */
const CSS_LENGTH = /^\d+(\.\d+)?(px|%|em|rem|ch)$/;

export function skeletonBarHtml(width: string): string {
  const safe = CSS_LENGTH.test(width) ? width : "100%";
  return `<span class="ws-skel" aria-hidden="true" style="--ws-skel-w:${safe}"></span>`;
}

/** Label/value skeleton widths for each meter row, cycled when `meters` runs past this table. */
const USAGE_METER_WIDTHS: Array<{ label: string; value: string }> = [
  { label: "52px", value: "96px" }, // "Storage"
  { label: "108px", value: "78px" }, // "Uploads this month"
];

/**
 * Empty meter chrome for the rail, guessing at `renderUsageHtml`'s shape.
 *
 * The real shape is unknowable before the first response lands: depending on
 * which caps the workspace's plan actually sets, `renderUsageHtml` renders
 * two meters, one meter, or — when no caps are set at all — a structurally
 * different single-line `usage-text` block. This placeholder can only guess;
 * `meters` (default 2, the common case of both caps set) lets a caller
 * express its best guess, same as the other placeholder builders.
 *
 * A workspace with no caps (plan never applied) still collapses once, from
 * these meters down to the one-line text, on its first visit — that shift is
 * not eliminated by this change, only made no worse than the two-meter
 * assumption already was. Most later visits paint from the cached snapshot
 * (`workspace-cache.ts`) instead of this placeholder, so the collapse is
 * uncommon after the first — but it is bounded, not impossible: the cache
 * expires (`WORKSPACE_SNAPSHOT_TTL_MS`, 24h), gets invalidated wholesale on a
 * `WORKSPACE_SNAPSHOT_VERSION` bump, and is cleared on sign-out
 * (`clearWorkspaceSnapshots`), any of which sends the next visit back here.
 */
export function renderUsagePlaceholderHtml(meters = 2): string {
  const row = (labelWidth: string, valueWidth: string): string => `<div class="ul-progress__row">
    <div class="ul-progress__head">
      <span class="ul-progress__label">${skeletonBarHtml(labelWidth)}</span>
      <span class="ul-progress__value">${skeletonBarHtml(valueWidth)}</span>
    </div>
    <div class="ul-progress__track">
      <div class="ul-progress__fill" style="width:0%"></div>
    </div>
  </div>`;
  const rows = Array.from({ length: meters }, (_, i) => {
    const w = USAGE_METER_WIDTHS[i % USAGE_METER_WIDTHS.length];
    return row(w.label, w.value);
  }).join("");
  return `<div class="ul-progress" aria-busy="true">${rows}</div><div class="usage-meta">${skeletonBarHtml("64px")}</div>`;
}

/**
 * Empty-state builder — an HTML-string mirror of the shadcn `Empty`
 * component (packages/ui/src/components/ui/empty.tsx) for signed-in Astro
 * pages, which can't mount React but can use the same Tailwind classes
 * (packages/ui/src/theme.css `@source`s apps/web/src). Keep the two in sync:
 * `data-slot` names and per-part classes here should match the component's
 * `data-slot="empty…"` parts exactly for the `card` variant.
 *
 * `title` is escaped automatically. `description` and `content` are raw
 * HTML — callers compose/escape any dynamic pieces themselves (same
 * convention as `renderMembersHtml`'s `escapeHtml(...)` calls), which is
 * what lets a description carry a real `<a>` link (e.g. "create one").
 *
 * `variant`:
 * - `"card"` (default) — the component's own centered, bordered, padded
 *   shape. Right for a block that *is* the page's primary content (e.g. a
 *   galleries grid with nothing in it).
 * - `"inline"` — a left-aligned, unpadded, unbordered shape for a one-line
 *   note sitting inside an existing form or list (e.g. "No tokens yet"),
 *   where the card's visual weight would be out of place.
 */
export interface EmptyStateOptions {
  title: string;
  description?: string;
  /** Raw icon/SVG markup for the `empty-icon` media slot. Omit for no icon. */
  mediaGlyph?: string;
  /** Raw HTML for the `empty-content` slot below the header (e.g. a copyable command). */
  content?: string;
  variant?: "card" | "inline";
}

const EMPTY_VARIANT_CLASSES: Record<
  "card" | "inline",
  { root: string; header: string; content: string }
> = {
  card: {
    root: "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance",
    header: "flex max-w-sm flex-col items-center gap-2",
    content: "flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm text-balance",
  },
  inline: {
    root: "flex w-full min-w-0 flex-col items-start gap-1 text-left text-balance",
    header: "flex flex-col items-start gap-1",
    content: "flex w-full min-w-0 flex-col items-start gap-2 text-sm text-balance",
  },
};

const EMPTY_MEDIA_CLASS =
  "mb-2 flex shrink-0 items-center justify-center bg-transparent [&_svg]:pointer-events-none [&_svg]:shrink-0";
const EMPTY_TITLE_CLASS = "text-sm font-medium tracking-tight";
const EMPTY_DESCRIPTION_CLASS =
  "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary";

export function renderEmptyStateHtml(opts: EmptyStateOptions): string {
  const shape = EMPTY_VARIANT_CLASSES[opts.variant ?? "card"];
  const media = opts.mediaGlyph
    ? `<div data-slot="empty-icon" data-variant="default" class="${EMPTY_MEDIA_CLASS}">${opts.mediaGlyph}</div>`
    : "";
  const description = opts.description
    ? `<div data-slot="empty-description" class="${EMPTY_DESCRIPTION_CLASS}">${opts.description}</div>`
    : "";
  const content = opts.content
    ? `<div data-slot="empty-content" class="${shape.content}">${opts.content}</div>`
    : "";
  return `<div data-slot="empty" class="${shape.root}"><div data-slot="empty-header" class="${shape.header}">${media}<div data-slot="empty-title" class="${EMPTY_TITLE_CLASS}">${escapeHtml(opts.title)}</div>${description}</div>${content}</div>`;
}

/**
 * Screenshots-page placeholder — byte-for-byte the markup of
 * `OverviewLoadingSkeleton` in components/ScreenshotsByPath.tsx, so the
 * server-rendered gap before the React island's dynamic import resolves
 * shows the same skeleton the component then renders: no dead space, no
 * layout jump. Change the two together.
 */
export function renderScreenshotsPlaceholderHtml(rows = 3, thumbs = 4): string {
  const filter = `<div class="wsp-filter">
  <span class="wsp-filter__project wsp-filter__skel">${skeletonBarHtml("120px")}</span>
  <span class="wsp-filter__q wsp-filter__skel">${skeletonBarHtml("60%")}</span>
</div>`;
  const group = `<div class="wsp-group">
  <div class="wsp-group__head">${skeletonBarHtml("140px")}</div>
  <div class="wsp-strip">${`<span class="wsp-thumb wsp-thumb--skel" aria-hidden="true"></span>`.repeat(thumbs)}</div>
</div>`;
  return `<div class="wsp" aria-busy="true">${filter}${group.repeat(rows)}</div>`;
}

/**
 * Workspaces-index placeholder — same `ul.dev-links li` row (link + role
 * slug) the real list renders, so the swap from placeholder to data doesn't
 * change row count or height, only content.
 */
export function renderWorkspacesPlaceholderHtml(rows = 2): string {
  const widths = ["132px", "104px"];
  return Array.from(
    { length: rows },
    (_, i) =>
      `<li>${skeletonBarHtml(widths[i % widths.length])}<span class="slug">${skeletonBarHtml("48px")}</span></li>`,
  ).join("");
}

/**
 * Generic `ul.detail-list` placeholder (profile's sign-in-methods and
 * sessions lists) — mirrors the real row's title/meta stack so a row's
 * height doesn't change when data replaces the skeleton.
 */
export function renderDetailListPlaceholderHtml(rows = 2): string {
  const widths = ["120px", "150px"];
  return Array.from(
    { length: rows },
    (_, i) =>
      `<li><div class="detail-main">` +
      `<div class="detail-title">${skeletonBarHtml(widths[i % widths.length])}</div>` +
      `<div class="detail-meta">${skeletonBarHtml("90px")}</div>` +
      `</div></li>`,
  ).join("");
}

/**
 * Files-tab placeholder for the pre-hydration mount gap in
 * `[name].astro` — the page dynamic-imports React and `WorkspaceFileTable`,
 * so the mount point is otherwise empty until that resolves. Mirrors the
 * component's own `info.status === "loading"` skeleton (same class names:
 * `wft-filter`/`wft-filterbar`, `wft-sectionhead`, `wft-head`, `wft-row`) so
 * the static-HTML-to-React handoff is visually seamless, and the real table
 * head labels (name/size/type/visibility) are static text here too since
 * they never depend on data.
 */
export function renderFilesPlaceholderHtml(rows = 6): string {
  const widths = ["62%", "48%", "70%", "40%", "55%", "35%"];
  const rowsHtml = Array.from({ length: rows }, (_, i) => {
    const w = widths[i % widths.length];
    return `<div class="wft-row">
  <span class="wft-name">${skeletonBarHtml(w)}</span>
  <span class="wft-size">${skeletonBarHtml("32px")}</span>
  <span class="wft-type">${skeletonBarHtml("28px")}</span>
  <span class="wft-vis">${skeletonBarHtml("52px")}</span>
  <span></span>
</div>`;
  }).join("");
  return `<div class="wft" aria-busy="true">
  <div class="wft-filter">
    <div class="wft-filterbar input-group">
      <span class="input-group__field wft-field-skel">${skeletonBarHtml("60%")}</span>
      <span class="input-group__action wft-field-skel">${skeletonBarHtml("28px")}</span>
    </div>
  </div>
  <div class="wft-sectionhead">
    <span class="wft-sectionhead__rule wft-sectionhead__rule--lead"></span>
    <span class="wft-sectionhead__label">files</span>
    <span class="wft-sectionhead__rule"></span>
    <span class="wft-sectionhead__count">${skeletonBarHtml("44px")}</span>
  </div>
  <div class="wft-grid">
    <div class="wft-head">
      <span>name</span>
      <span class="wft-head__size">size</span>
      <span class="wft-head__type">type</span>
      <span>visibility</span>
      <span></span>
    </div>
    ${rowsHtml}
  </div>
</div>`;
}
