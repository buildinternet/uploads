/**
 * Shared presentation helpers for account workspace pages.
 */

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

export function isWorkspaceAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

export function operatorInviteCommand(workspace: string): string {
  return `uploads admin invite create --workspace ${workspace} --email teammate@example.com`;
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

/** Copy-to-clipboard for `button[data-copy]` under `root`. */
export function bindCopyButtons(root: ParentNode): void {
  root.addEventListener("click", (event) => {
    void (async () => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy]");
      if (!button || !root.contains(button)) return;
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
        const previous = button.textContent;
        button.textContent = "copied ✓";
        setTimeout(() => {
          button.textContent = previous;
        }, 1500);
      } catch {
        // Clipboard blocked — leave the label.
      }
    })();
  });
}
