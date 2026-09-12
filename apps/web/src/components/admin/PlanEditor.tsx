/**
 * Plan section of the workspace drawer — the React port of the imperative
 * page's `renderPlanSelector`. Same wire contract (`GET`/`PATCH
 * /admin-ui/workspaces/:name/plan`, issue #445 subscription enrichment): the
 * plan-source badge, self-serve availability, subscription status + Stripe
 * deep link, customer tenure, and the legacy "no plan applied" caveat all
 * carry over unchanged. `stripeCustomerId` is admin-ui-only (never sent to
 * /me) and only present when a subscription row exists.
 */
import { useEffect, useState } from "react";
import { Badge } from "@uploads/ui/components/ui/badge";
import { Button } from "@uploads/ui/components/ui/button";
import { formatDate } from "../../lib/subscription-copy";
import type { AdminApi, AdminPlanResponse } from "../../lib/admin-api";
import { SELECT_SM } from "./field-classes";
import { Muted, SectionHeading, StatusLine } from "./StatusLine";

const PLAN_OPTIONS: { id: "free" | "pro"; label: string }[] = [
  { id: "free", label: "Free" },
  { id: "pro", label: "Pro (unavailable to self-serve)" },
];

// Badge tone per plan source — the at-a-glance signal a paid workspace should
// be instantly distinguishable by, versus free and versus admin-comped. Free
// gets no badge; there's nothing "upgraded" to call out.
const PLAN_BADGE: Record<
  AdminPlanResponse["planSource"],
  { label: string; variant: "default" | "secondary" } | null
> = {
  stripe: { label: "Pro · Stripe", variant: "default" },
  admin: { label: "Pro · comped", variant: "secondary" },
  none: null,
};

/** Months elapsed between an ISO date and now, floored, minimum 0. */
function monthsSince(iso: string): number {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 0;
  const now = new Date();
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  if (now.getDate() < then.getDate()) months -= 1;
  return Math.max(0, months);
}

export function PlanEditor({ api, workspace }: { api: AdminApi; workspace: string }) {
  const [data, setData] = useState<AdminPlanResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<string>("free");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ state: "error" | "ok"; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getPlan(workspace)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setSelected(d.plan);
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [api, workspace]);

  if (loadError) return <Muted>Failed to load plan.</Muted>;
  if (!data) return <Muted>Loading plan…</Muted>;

  const badge = PLAN_BADGE[data.planSource];
  const sub = data.subscription;
  const periodEndText = sub ? formatDate(sub.periodEnd) : null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);
    setSaving(true);
    try {
      const updated = await api.savePlan(workspace, selected);
      setData(updated);
      setSelected(updated.plan);
      setStatus({ state: "ok", message: "Saved." });
    } catch (err) {
      setStatus({
        state: "error",
        message: err instanceof Error && err.message ? err.message : "Couldn't save plan.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeading>
        Plan{" "}
        {badge && (
          <Badge variant={badge.variant} className="ml-1 align-middle">
            {badge.label}
          </Badge>
        )}
      </SectionHeading>
      <Muted>{data.available ? "Available" : "Not available for self-serve upgrade"}</Muted>
      {sub && (
        <Muted>
          Subscription: {sub.status}
          {sub.cancelAtPeriodEnd && periodEndText
            ? ` · cancels on ${periodEndText}`
            : periodEndText
              ? ` · renews ${periodEndText}`
              : ""}
          {sub.stripeCustomerId ? (
            <>
              {" · "}
              <a
                href={`https://dashboard.stripe.com/customers/${encodeURIComponent(sub.stripeCustomerId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                View in Stripe
              </a>
            </>
          ) : null}
        </Muted>
      )}
      {data.paidSince && (
        <Muted>
          Customer since {formatDate(data.paidSince) ?? data.paidSince} (
          {monthsSince(data.paidSince)} mo)
        </Muted>
      )}
      {!data.planApplied && (
        <Muted>
          No plan applied (legacy) — limits shown are the enforcement truth (explicit-or-unlimited),
          not this plan's defaults.
        </Muted>
      )}
      <form onSubmit={save} className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className={SELECT_SM}
          style={{ width: "auto" }}
          aria-label="Plan"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {PLAN_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" size="sm" disabled={saving}>
          Save plan
        </Button>
        {status && (
          <div className="w-full">
            <StatusLine state={status.state}>{status.message}</StatusLine>
          </div>
        )}
      </form>
    </div>
  );
}
