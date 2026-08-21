/**
 * Shared markup for the workspace billing tab (issue #699 — SSR-first) so
 * SSR and the client paint the same current-plan card + plan-cards grid.
 * Mirrors developers-ui.ts's loader/renderer split: `loadBillingPageData`
 * is the server-safe loader, everything else is pure string-building with
 * no DOM access, called by both billing.astro's frontmatter and its client
 * `<script>` reconcile path.
 */
import {
  getWorkspaceBilling,
  type WorkspaceBilling,
  type WorkspaceBillingLimits,
} from "./api-client";
import { resolveBillingCta } from "./billing-cta";
import { fetchProPrice, type PlanPrice } from "./plan-prices";
import { resolveSubscriptionCopy, type SubscriptionCopyState } from "./subscription-copy";
import { escapeHtml, formatBytes, formatMarketedBytes, skeletonBarHtml } from "./workspace-ui";

import { PLANS, type PlanDefinition } from "@uploads/billing";

export interface BillingPageData {
  billing: WorkspaceBilling | null;
  proPrice: PlanPrice | null;
}

/**
 * Server-side loader for the billing tab. `cookie` empty/blank means no
 * session on the request (SSR can't authenticate) — returns nulls rather
 * than attempting the fetch, same contract as `loadDevelopersPageData`.
 * `fetchProPrice` needs no cookie (public, uncredentialed endpoint) so it's
 * always attempted alongside the billing fetch.
 */
export async function loadBillingPageData(
  apiOrigin: string,
  authOrigin: string,
  workspace: string,
  cookie: string,
  authFetchImpl?: typeof fetch,
): Promise<BillingPageData> {
  if (!cookie.trim()) return { billing: null, proPrice: null };
  const [billingResult, proPrice] = await Promise.all([
    getWorkspaceBilling(apiOrigin, workspace, { cookie }),
    fetchProPrice(authOrigin, authFetchImpl),
  ]);
  return {
    billing: billingResult.kind === "ok" ? billingResult.billing : null,
    proPrice,
  };
}

export function planLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * The current-plan card's one line that isn't already covered by the
 * workspace rail (which shows storage + uploads-this-month usage) — the
 * enforced max file/video size, so that information isn't lost when the
 * standalone "Limits & usage" section is removed.
 */
export function renderFileLimitsText(limits: WorkspaceBillingLimits): string {
  const parts: string[] = [];

  if (limits.maxUploadBytes !== null) {
    parts.push(`files up to ${formatBytes(limits.maxUploadBytes)}`);
  }
  if (limits.maxVideoUploadBytes !== null && limits.maxVideoUploadBytes !== limits.maxUploadBytes) {
    parts.push(`videos up to ${formatBytes(limits.maxVideoUploadBytes)}`);
  }

  return parts.length ? `Max upload size: ${parts.join(", ")}.` : "";
}

/**
 * Honest copy: a record with no plan actually applied isn't on free-tier
 * marketing caps — it's running whatever `limits` says. When a subscription
 * status line will render ("Included with your workspace." / "Renews on
 * …"), it already says the plan is active, so the generic blurb stays empty
 * rather than repeating it.
 */
export function renderPlanBlurbText(billing: WorkspaceBilling, hasStatusLine: boolean): string {
  if (!billing.planApplied) return "Your current limits are shown below.";
  if (!billing.available) return "This plan isn’t available for self-serve upgrade yet.";
  return hasStatusLine ? "" : "This plan is active on your workspace.";
}

function renderSubscriptionStatusHtml(state: SubscriptionCopyState | null): string {
  if (!state) {
    return `<p id="ws-subscription-status" hidden></p>`;
  }
  const roleAttr = state.tone === "alert" ? "alert" : "status";
  const dataStateAttr = state.tone === "alert" ? ` data-state="error"` : "";
  return `<p id="ws-subscription-status" class="muted" role="${roleAttr}"${dataStateAttr}>${escapeHtml(state.text)}</p>`;
}

/**
 * The current-plan card's inner HTML (name/blurb/file-limits/subscription
 * status) — the `#ws-plan-card` region's entire content, painted by SSR via
 * `set:html` and re-painted verbatim by the client on reconcile so the two
 * never drift.
 */
export function renderPlanCardBodyHtml(
  billing: WorkspaceBilling,
  proPriceCopy: string | null,
): string {
  const statusState = resolveSubscriptionCopy({
    planSource: billing.planSource,
    subscription: billing.subscription,
    priceText: proPriceCopy,
  });
  const blurbText = renderPlanBlurbText(billing, statusState !== null);
  const fileLimitsText = renderFileLimitsText(billing.limits);

  return (
    `<p><strong id="ws-plan-name">${escapeHtml(`${planLabel(billing.plan)} plan`)}</strong></p>` +
    `<p class="muted" id="ws-plan-blurb"${blurbText ? "" : " hidden"}>${escapeHtml(blurbText)}</p>` +
    `<p class="muted" id="ws-plan-file-limits">${escapeHtml(fileLimitsText)}</p>` +
    renderSubscriptionStatusHtml(statusState)
  );
}

/** Skeleton fallback for `#ws-plan-card` when there is no server-fetched billing yet. */
export function renderPlanCardPlaceholderHtml(): string {
  return (
    `<p><strong id="ws-plan-name">${skeletonBarHtml("72px")}</strong></p>` +
    `<p class="muted" id="ws-plan-blurb">${skeletonBarHtml("80%")}</p>` +
    `<p class="muted" id="ws-plan-file-limits">${skeletonBarHtml("60%")}</p>` +
    `<p id="ws-subscription-status" role="status" hidden></p>`
  );
}

/** Marketed limits for a plan card — storage + max file size for every
 * plan, plus free's separate video ceiling (see plans.ts's comment: on pro
 * the video ceiling equals the upload ceiling, so it isn't worth a separate
 * line there) and the member cap. `maxUploadsPerPeriod` is an internal
 * abuse guard and is deliberately never marketed here. */
export function planCardLimitRows(plan: PlanDefinition): string {
  const { defaultLimits } = plan;
  const rows = [
    `<li>${
      defaultLimits.maxStorageBytes === undefined
        ? "Unlimited storage"
        : `${formatMarketedBytes(defaultLimits.maxStorageBytes)} storage`
    }</li>`,
    `<li>${
      defaultLimits.maxUploadBytes === undefined
        ? "Unlimited file size"
        : `Files up to ${formatMarketedBytes(defaultLimits.maxUploadBytes)}`
    }</li>`,
  ];
  // A separate video line only when the plan actually carves a distinct
  // video ceiling out of its upload cap — catalog-driven, not per-plan.
  if (
    defaultLimits.maxVideoUploadBytes !== undefined &&
    defaultLimits.maxVideoUploadBytes !== defaultLimits.maxUploadBytes
  ) {
    rows.push(`<li>Videos up to ${formatMarketedBytes(defaultLimits.maxVideoUploadBytes)}</li>`);
  }
  // Members: free markets its cap ("3 members"); pro's maxMembers is an
  // unmarketed abuse guard, so its card says "Unlimited members" and the
  // seatless positioning holds. Driven by the catalog's marketsMemberCap
  // flag rather than a plan-id special case (issue #450).
  rows.push(
    `<li>${
      plan.marketsMemberCap && defaultLimits.maxMembers !== undefined
        ? `${defaultLimits.maxMembers} member${defaultLimits.maxMembers === 1 ? "" : "s"}`
        : "Unlimited members"
    }</li>`,
  );
  return rows.join("");
}

export function planCardPriceLine(plan: PlanDefinition, proPriceCopy: string | null): string {
  if (plan.id === "free") return "$0";
  // Live price fetched from the auth origin; omitted gracefully (no
  // placeholder, no "$NaN") until it's known.
  return proPriceCopy ?? "";
}

/** Renders one card per catalog plan that's `available`, plus the
 * workspace's current plan even if it's since been marked unavailable
 * (e.g. a legacy/custom plan) so the tab never hides where the workspace
 * actually stands. This is `#ws-plan-cards`'s entire content — the
 * manage-billing button/notes live outside this region and are toggled
 * separately from `resolveBillingCta`, same inputs this function uses
 * internally for the Pro card's footer. */
export function renderPlanCardsGridHtml(
  billing: WorkspaceBilling,
  proPriceCopy: string | null,
): string {
  const currentPlanId = billing.plan;
  const cardPlans = Object.values(PLANS).filter(
    (plan) => plan.available || plan.id === currentPlanId,
  );

  const cta = resolveBillingCta({
    proAvailable: PLANS.pro.available,
    plan: billing.plan,
    planSource: billing.planSource,
  });

  return cardPlans
    .map((plan) => {
      const isCurrent = plan.id === currentPlanId;
      const priceLine = planCardPriceLine(plan, proPriceCopy);
      // The current card already carries the "Current plan" badge — no
      // footer button, so the label doesn't appear twice.
      let footer = "";
      if (!isCurrent && plan.id === "pro") {
        footer =
          cta.kind === "unavailable"
            ? `<button type="button" class="plan-card__cta" disabled>Coming soon</button>`
            : `<button type="button" class="plan-card__cta" data-cta="upgrade" data-plan="pro">Upgrade to Pro</button>`;
      }
      return `
              <div class="plan-card${isCurrent ? " is-current" : ""}" data-plan="${plan.id}">
                ${isCurrent ? `<span class="plan-card__badge">Current plan</span>` : ""}
                <p class="plan-card__name">${escapeHtml(plan.name)}</p>
                ${priceLine ? `<p class="plan-card__price">${escapeHtml(priceLine)}</p>` : ""}
                <p class="muted plan-card__blurb">${escapeHtml(plan.blurb)}</p>
                <ul class="plan-card__limits muted">${planCardLimitRows(plan)}</ul>
                ${footer}
              </div>`;
    })
    .join("");
}
