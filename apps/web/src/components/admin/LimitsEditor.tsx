/**
 * Limits section of the workspace drawer — the React port of the imperative
 * page's `renderLimitsForm` + `buildLimitsBody`. Same semantics, unchanged:
 *
 * - A field with no explicit override, on a plan-applied record, is pre-filled
 *   with the plan default and tagged "plan default" (issue #613). An untouched
 *   default row is NOT sent as an override — leaving it absent keeps the plan
 *   driving that cap across a later plan change (the `defaultValue` skip).
 * - `Unlimited` sends `null`; a checked box disables the row's inputs.
 * - Storage/uploads usage shows a compact percent-full bar (≥80% warns, ≥100%
 *   over), omitted for an unlimited cap.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@uploads/ui/components/ui/button";
import type { AdminApi, AdminLimitsResponse } from "../../lib/admin-api";
import {
  formatBytes,
  LIMIT_FIELDS,
  LIMIT_UNITS,
  multForUnit,
  splitBytes,
} from "../../lib/admin-limits";
import { INPUT_NUM, SELECT_SM } from "./field-classes";
import { Muted, SectionHeading, StatusLine } from "./StatusLine";

interface FieldState {
  value: string;
  unit: string;
  unlimited: boolean;
}

type LimitKey = (typeof LIMIT_FIELDS)[number]["key"];

/** Per-field editable state seeded from a limits response. */
function seedFields(data: AdminLimitsResponse): Record<LimitKey, FieldState> {
  const out = {} as Record<LimitKey, FieldState>;
  for (const f of LIMIT_FIELDS) {
    const raw = data.limits[f.key];
    if (raw === null) {
      out[f.key] = { value: "", unit: "MB", unlimited: true };
    } else if (f.byte) {
      const split = splitBytes(raw);
      out[f.key] = { value: String(split.value), unit: split.unit, unlimited: false };
    } else {
      out[f.key] = { value: String(raw), unit: "MB", unlimited: false };
    }
  }
  return out;
}

/**
 * Compact inline percent-full bar; renders nothing for an unlimited/zero cap.
 * Self-contained (Tailwind + inline fill) so the drawer needs no page CSS:
 * ≥80% is orange, ≥100% red, else accent — the same thresholds the imperative
 * `.limit-storage-bar` used.
 */
function StorageBar({ used, cap }: { used: number; cap: number | null }) {
  if (cap === null || cap <= 0) return null;
  const pct = Math.round((used / cap) * 100);
  const fill = Math.min(100, pct);
  const color = pct >= 100 ? "var(--red)" : pct >= 80 ? "var(--orange, #d97706)" : "var(--accent)";
  return (
    <>
      <span className="relative block h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-muted/25">
        <span
          className="block h-full rounded-full"
          style={{ width: `${fill}%`, background: color }}
        />
      </span>{" "}
      <span className="tabular-nums">{pct}%</span>
    </>
  );
}

export function LimitsEditor({ api, workspace }: { api: AdminApi; workspace: string }) {
  const [data, setData] = useState<AdminLimitsResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [fields, setFields] = useState<Record<LimitKey, FieldState> | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ state: "error" | "ok"; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getLimits(workspace)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setFields(seedFields(d));
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [api, workspace]);

  // The inherited plan-default value per field (only when plan-applied and not
  // an explicit override), used to skip an untouched default row on save.
  const defaults = useMemo(() => {
    const out: Partial<Record<LimitKey, number>> = {};
    if (!data) return out;
    for (const f of LIMIT_FIELDS) {
      const raw = data.limits[f.key];
      if (data.planApplied && !data.overrides.includes(f.key) && raw !== null) {
        out[f.key] = raw;
      }
    }
    return out;
  }, [data]);

  if (loadError) return <Muted>Failed to load limits.</Muted>;
  if (!data || !fields) return <Muted>Loading limits…</Muted>;

  function update(key: LimitKey, patch: Partial<FieldState>) {
    setFields((prev) => (prev ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));
  }

  /** Read the form into a PATCH body; throws on empty non-unlimited fields. */
  function buildBody(): Record<string, number | null> {
    const body: Record<string, number | null> = {};
    for (const f of LIMIT_FIELDS) {
      const state = fields![f.key];
      if (state.unlimited) {
        body[f.key] = null;
        continue;
      }
      const num = Number(state.value);
      if (!state.value || !Number.isInteger(num) || num < 1) {
        throw new Error(`Enter a whole number ≥ 1 for "${f.key}", or check Unlimited.`);
      }
      const value = f.byte ? Math.floor(num * multForUnit(state.unit)) : num;
      // An untouched plan-default row is not an override — leave it absent.
      if (defaults[f.key] !== undefined && defaults[f.key] === value) continue;
      body[f.key] = value;
    }
    return body;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);
    let body: Record<string, number | null>;
    try {
      body = buildBody();
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Invalid input." });
      return;
    }
    setSaving(true);
    try {
      const updated = await api.saveLimits(workspace, body);
      setData(updated);
      setFields(seedFields(updated));
      setStatus({ state: "ok", message: "Saved. Changes apply within ~60s." });
    } catch (err) {
      setStatus({
        state: "error",
        message: err instanceof Error && err.message ? err.message : "Couldn't save limits.",
      });
    } finally {
      setSaving(false);
    }
  }

  const usage = data.usage;

  return (
    <div>
      <SectionHeading>Limits</SectionHeading>
      {usage && (
        <p className="m-0 flex flex-wrap items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
          {formatBytes(usage.bytes)}
          {data.limits.maxStorageBytes !== null
            ? ` of ${formatBytes(data.limits.maxStorageBytes)}`
            : ""}{" "}
          stored
          <StorageBar used={usage.bytes} cap={data.limits.maxStorageBytes} />· {usage.uploads}
          {data.limits.maxUploadsPerPeriod !== null
            ? ` of ${data.limits.maxUploadsPerPeriod}`
            : ""}{" "}
          uploads this month
          {data.limits.maxUploadsPerPeriod !== null && (
            <StorageBar used={usage.uploads} cap={data.limits.maxUploadsPerPeriod} />
          )}
        </p>
      )}
      <form onSubmit={save} className="mt-2 flex flex-col gap-2">
        {LIMIT_FIELDS.map((f) => {
          const state = fields[f.key];
          const isDefault = defaults[f.key] !== undefined;
          return (
            <div key={f.key} className="flex flex-wrap items-center gap-2">
              <label className="w-[130px] text-(length:--text-meta) text-body">{f.label}</label>
              <input
                type="number"
                min="1"
                step="1"
                className={`${INPUT_NUM} w-[110px]`}
                value={state.value}
                disabled={state.unlimited}
                onChange={(e) => update(f.key, { value: e.target.value })}
              />
              {f.byte && (
                <select
                  className={SELECT_SM}
                  style={{ width: "auto" }}
                  aria-label={`${f.label} unit`}
                  value={state.unit}
                  disabled={state.unlimited}
                  onChange={(e) => update(f.key, { unit: e.target.value })}
                >
                  {LIMIT_UNITS.map((u) => (
                    <option key={u.label} value={u.label}>
                      {u.label}
                    </option>
                  ))}
                </select>
              )}
              <label className="inline-flex items-center gap-1 whitespace-nowrap text-(length:--text-micro) text-muted-foreground">
                <input
                  type="checkbox"
                  checked={state.unlimited}
                  onChange={(e) => update(f.key, { unlimited: e.target.checked })}
                />{" "}
                Unlimited
              </label>
              {isDefault && (
                <span className="whitespace-nowrap text-(length:--text-micro) text-muted-foreground">
                  plan default
                </span>
              )}
            </div>
          );
        })}
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="mt-1 self-start"
          disabled={saving}
        >
          Save limits
        </Button>
        {status && <StatusLine state={status.state}>{status.message}</StatusLine>}
      </form>
    </div>
  );
}
