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
          `<select class="member-row__role-select ul-select ul-select--sm" data-member-id="${escapeHtml(m.id!)}" aria-label="Role for ${escapeHtml(m.email)}">` +
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
 * Member-list placeholder.
 *
 * Mirrors `renderMembersHtml`'s two-part row — `.member-row` is a flex with
 * `justify-content: space-between`, so a single child would collapse to one
 * column and the swap to real rows would visibly rearrange, not just repaint.
 * The nested `__name` and `__role` spans also carry the font sizes the row's
 * `align-items: baseline` height is derived from.
 */
export function renderMembersPlaceholderHtml(rows = 2): string {
  const widths = ["124px", "96px"];
  return Array.from(
    { length: rows },
    (_, i) =>
      `<div class="member-row">` +
      `<span class="member-row__who"><span class="member-row__name">${skeletonBarHtml(widths[i % widths.length])}</span></span>` +
      `<span class="member-row__role">${skeletonBarHtml("42px")}</span>` +
      `</div>`,
  ).join("");
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

/** Fields the account galleries table needs (extra API fields are fine). */
export interface GalleryTableRow {
  url: string;
  title: string;
  description: string | null;
  updatedAt: string;
  itemCount?: number;
  references?: Array<{ coordinate: string; canonicalUrl: string | null }>;
}

/** Short table-cell date (e.g. "Jul 3, 2026"). Invalid ISO falls back to the raw string. */
export function formatGalleryDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const EMPTY_CELL = `<span class="muted">—</span>`;

/** Up to three linked PR/issue coordinates; remainder as "+N". */
function renderGalleryLinksHtml(
  references: Array<{ coordinate: string; canonicalUrl: string | null }>,
): string {
  if (!references.length) return EMPTY_CELL;
  const shown = references.slice(0, 3);
  const extra = references.length - shown.length;
  const chips = shown
    .map((ref) => {
      const label = escapeHtml(ref.coordinate);
      if (ref.canonicalUrl) {
        return `<a class="ws-gallery-link" href="${escapeHtml(ref.canonicalUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      return `<span class="ws-gallery-link ws-gallery-link--plain">${label}</span>`;
    })
    .join("");
  const more = extra > 0 ? `<span class="muted ws-gallery-link-more">+${extra}</span>` : "";
  return `<div class="ws-gallery-links">${chips}${more}</div>`;
}

/** Account galleries table HTML. Empty list → "" (caller paints the empty state). */
export function renderGalleriesTableHtml(galleries: GalleryTableRow[]): string {
  if (!galleries.length) return "";
  const rows = galleries
    .map((g) => {
      const itemsCell =
        typeof g.itemCount === "number" ? escapeHtml(String(g.itemCount)) : EMPTY_CELL;
      const desc = g.description?.trim()
        ? `<div class="muted ws-gallery-desc">${escapeHtml(g.description.trim())}</div>`
        : "";
      return `<tr>
  <td>
    <a class="ws-gallery-title" href="${escapeHtml(g.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(g.title)}</a>
    ${desc}
  </td>
  <td class="num">${itemsCell}</td>
  <td>${renderGalleryLinksHtml(g.references ?? [])}</td>
  <td class="muted ws-gallery-updated">${escapeHtml(formatGalleryDate(g.updatedAt))}</td>
</tr>`;
    })
    .join("");
  return `<div class="ws-table-wrap">
<table class="ws-table" aria-label="Galleries">
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col" class="num">Items</th>
      <th scope="col">Linked</th>
      <th scope="col">Updated</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
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
 * express its best guess, same as `renderGalleriesPlaceholderHtml(rows)`.
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
 * Galleries empty state.
 *
 * Built as the page's primary element rather than a muted footnote: when a
 * workspace has no galleries, "you have none, here is how to make one" *is*
 * the content, and burying it under a command block inverted the hierarchy.
 *
 * No body sentence: the page-header note above this block and the "Working
 * with galleries" details block below it already explain what a gallery is —
 * a third restatement here was stacking, not informing. This stays down to
 * the state plus the one action that resolves it.
 */
export function renderGalleriesEmptyHtml(createCmd: string): string {
  const safe = escapeHtml(createCmd);
  return `<div class="ws-empty-state">
  <p class="ws-empty-state__title">No galleries yet</p>
  <div class="command ws-empty__command">
    <code>${safe}</code>
    <button type="button" data-copy="${safe}" aria-live="polite">copy</button>
  </div>
</div>`;
}

/** Galleries table placeholder — same chrome as `renderGalleriesTableHtml`. */
export function renderGalleriesPlaceholderHtml(rows = 3): string {
  // Varying widths so the block reads as a list of distinct rows rather than
  // a solid slab.
  const widths = ["68%", "54%", "76%"];
  const body = Array.from({ length: rows }, (_, i) => {
    const w = widths[i % widths.length];
    return `<tr>
  <td>${skeletonBarHtml(w)}</td>
  <td class="num">${skeletonBarHtml("24px")}</td>
  <td>${skeletonBarHtml("92px")}</td>
  <td class="ws-gallery-updated">${skeletonBarHtml("72px")}</td>
</tr>`;
  }).join("");
  return `<div class="ws-table-wrap" aria-busy="true">
<table class="ws-table" aria-label="Galleries">
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col" class="num">Items</th>
      <th scope="col">Linked</th>
      <th scope="col">Updated</th>
    </tr>
  </thead>
  <tbody>${body}</tbody>
</table>
</div>`;
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
