/**
 * The operator "Classifier" view (`/admin/classifier`): metrics from
 * `/admin-ui/classifier/overview` and a filterable list of flagged uploads
 * from `/admin-ui/classifier/flagged`. Client-rendered; the page mounts it
 * with `createIslandMounter` like the Workspaces island.
 *
 * "Flagged" is a stored non-clean safety answer. A missing safety key means
 * the file was not classified (or the answer was under the confidence
 * floor), so it is never counted as clean here.
 */
import { useMemo, useState } from "react";
import { Badge } from "@uploads/ui/components/ui/badge";
import { Skeleton } from "@uploads/ui/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@uploads/ui/components/ui/table";
import "@uploads/ui/styles.css";
import { IslandErrorBoundary } from "../IslandErrorBoundary";
import {
  ADMIN_METRIC_WINDOWS,
  CLASSIFIER_CLEAN_VALUES,
  CLASSIFIER_SAFETY_FIELDS,
  type ClassifierAdminWindow,
  type ClassifierDailyPoint,
  type ClassifierFlaggedFile,
  type ClassifierOverview,
  type ClassifierSafetyField,
  type ClassifierValueCount,
} from "@uploads/api/classifier-admin-wire";
import { makeAdminApi } from "../../lib/admin-api";
import { ADMIN_BTN, ADMIN_BTN_DANGER } from "../../lib/admin-ui";
import {
  coverageLabel,
  flaggedFileHref,
  flagLabel,
  flagTitle,
  flagVariant,
  sharePercent,
  topFlaggedValues,
  withShares,
} from "../../lib/admin-classifier";
import { lastUpdatedLabel } from "../../lib/workspace-screenshots";
import { useCursorList } from "../files/useCursorList";
import { useAdminResource } from "./use-admin-resource";

export interface AdminClassifierProps {
  apiOrigin: string;
}

const ago = (iso: string) => lastUpdatedLabel(iso, new Date());

/** One stacked series of the daily chart; the legend reads the same list. */
const SERIES = [
  { key: "classified", label: "Classified", fill: "fill-primary", swatch: "bg-primary" },
  {
    key: "skipped",
    label: "Skipped",
    fill: "fill-muted-foreground",
    swatch: "bg-muted-foreground",
  },
  { key: "failed", label: "Failed", fill: "fill-destructive", swatch: "bg-destructive" },
] as const;

const BREAKDOWNS = [
  ["Versions", "versions"],
  ["Skip reasons", "skipReasons"],
  ["Errors", "errorReasons"],
  ["Kind", "kinds"],
  ["Surface", "surfaces"],
  ["Screen", "screens"],
] as const satisfies ReadonlyArray<readonly [string, keyof ClassifierOverview]>;

const FIELD_CLASS =
  "h-8 rounded-sm border border-border bg-transparent px-2 text-(length:--text-meta) text-foreground";
const H3 = "m-0 mb-2 text-(length:--text-micro) font-semibold tracking-[0.04em] uppercase";

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border border-border rounded-md px-3.5 py-3">
      <dt className="text-(length:--text-micro) uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      {note ? (
        <dd className="m-0 mt-0.5 text-(length:--text-micro) text-muted-foreground">{note}</dd>
      ) : null}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: ClassifierValueCount[] }) {
  const shared = withShares(rows);
  return (
    <section className="min-w-0">
      <h3 className={H3}>{title}</h3>
      {shared.length === 0 ? (
        <p className="m-0 text-(length:--text-meta) text-muted-foreground">None yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Value</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shared.map((r) => (
              <TableRow key={r.value}>
                <TableCell className="font-mono">{r.value}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.count.toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.share}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function DailyChart({ daily }: { daily: ClassifierDailyPoint[] }) {
  const first = daily[0]?.day;
  const last = daily.at(-1)?.day;
  if (!first || !last) {
    return <p className="m-0 text-(length:--text-meta) text-muted-foreground">No activity.</p>;
  }
  const W = 960;
  const H = 180;
  const max = Math.max(1, ...daily.map((d) => d.classified + d.skipped + d.failed));
  const slot = W / daily.length;
  const bar = Math.max(1, slot * 0.7);
  const scale = (n: number) => (n / max) * (H - 4);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Classified, skipped, and failed files per day, ${first} to ${last}, peak ${max}.`}
        className="w-full h-auto max-h-48"
      >
        {daily.map((d, i) => {
          const x = i * slot + (slot - bar) / 2;
          let top = H;
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${d.classified} classified, ${d.skipped} skipped, ${d.failed} failed`}</title>
              {SERIES.map((s) => {
                const h = scale(d[s.key]);
                top -= h;
                return <rect key={s.key} x={x} y={top} width={bar} height={h} className={s.fill} />;
              })}
            </g>
          );
        })}
      </svg>
      <p className="m-0 mt-1 flex gap-4 text-(length:--text-micro) text-muted-foreground">
        {SERIES.map((s) => (
          <LegendItem key={s.key} swatch={s.swatch}>
            {s.label}
          </LegendItem>
        ))}
        <span>
          {first} to {last} (UTC)
        </span>
      </p>
    </div>
  );
}

function LegendItem({ swatch, children }: { swatch: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block size-2 rounded-[2px] ${swatch}`} />
      {children}
    </span>
  );
}

function FlagStats({ flags }: { flags: ClassifierOverview["flags"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Field</TableHead>
          <TableHead className="text-right">Answered</TableHead>
          <TableHead className="text-right">Flagged</TableHead>
          <TableHead className="text-right">Rate</TableHead>
          <TableHead>Flagged confidence</TableHead>
          <TableHead>Top flagged values</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {flags.map((f) => {
          const top = topFlaggedValues(f.values, CLASSIFIER_CLEAN_VALUES[f.field]);
          return (
            <TableRow key={f.field}>
              <TableCell className="font-mono">{f.field}</TableCell>
              <TableCell className="text-right tabular-nums">
                {f.answered.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {f.flagged.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {sharePercent(f.flagged, f.answered)}
              </TableCell>
              <TableCell className="tabular-nums">
                high {f.flaggedConfidence.high} · med {f.flaggedConfidence.medium} · low{" "}
                {f.flaggedConfidence.low}
              </TableCell>
              <TableCell>
                {top.length === 0
                  ? "-"
                  : top.map((v) => `${v.value} (${v.count.toLocaleString()})`).join(", ")}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function OverviewSection({ apiOrigin }: AdminClassifierProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const [days, setDays] = useState<ClassifierAdminWindow>(30);
  const res = useAdminResource(() => api.getClassifierOverview(days), [api, days]);
  const [refreshing, setRefreshing] = useState(false);
  const data = res.data;

  // Bypasses the server cache once, then shows the fresh payload.
  const refresh = () => {
    setRefreshing(true);
    api
      .getClassifierOverview(days, true)
      .then((d) => res.setData(d))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="grid gap-6 min-w-0">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Time window">
        {ADMIN_METRIC_WINDOWS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={d === days}
            onClick={() => setDays(d)}
            className={`${ADMIN_BTN} aria-pressed:bg-primary aria-pressed:text-background aria-pressed:border-primary`}
          >
            {d} days
          </button>
        ))}
        <button type="button" className={ADMIN_BTN} onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {data ? (
          <span className="text-(length:--text-micro) text-muted-foreground">
            Updated {ago(data.generatedAt)}
          </span>
        ) : null}
      </div>

      {res.error && !data ? (
        <p role="alert" className="m-0 text-(length:--text-meta) text-destructive">
          Failed to load classifier metrics.
        </p>
      ) : !data ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <dl className="grid gap-3.5 m-0 p-0 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
            <Tile label="Classified" value={data.classified.toLocaleString()} note="All time" />
            <Tile label="Skipped" value={data.skipped.toLocaleString()} note="All time" />
            <Tile label="Failed" value={data.failed.toLocaleString()} note="All time" />
            <Tile label="Flagged files" value={data.flaggedFiles.toLocaleString()} />
            <Tile label="Workspaces" value={data.workspaces.toLocaleString()} />
            <Tile
              label="Coverage (approx.)"
              value={coverageLabel(data.daily, data.windowUploads) ?? "-"}
              note={`Last ${data.days} days. Only allowlisted workspaces are classified.`}
            />
          </dl>

          <section>
            <h3 className={H3}>Daily activity</h3>
            <DailyChart daily={data.daily} />
          </section>

          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))]">
            {BREAKDOWNS.map(([title, key]) => (
              <Breakdown key={key} title={title} rows={data[key]} />
            ))}
          </div>

          <section>
            <h3 className={H3}>Safety flags</h3>
            <p className="m-0 mb-2 text-(length:--text-micro) text-muted-foreground">
              Rates use answered files only. A file with no stored answer is not counted as clean.
            </p>
            <div className="overflow-x-auto">
              <FlagStats flags={data.flags} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function FlaggedSection({ apiOrigin }: AdminClassifierProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const [field, setField] = useState<ClassifierSafetyField | "">("");
  const [highOnly, setHighOnly] = useState(false);
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [workspace, setWorkspace] = useState("");
  // Shared cursor-list hook: a filter change resets the list, and a Load
  // more that lands after the reset is dropped by its generation guard.
  const { state, loadMore } = useCursorList<ClassifierFlaggedFile>({
    queryKey: JSON.stringify([apiOrigin, field, highOnly, workspace]),
    keyOf: (f) => `${f.workspace}/${f.key}`,
    load: (cursor) =>
      api
        .listClassifierFlagged({ field, highOnly, workspace, cursor, limit: 25 })
        .then((page) => ({
          ok: true as const,
          value: { rows: page.files, nextCursor: page.nextCursor },
        }))
        .catch(() => ({ ok: false as const })),
  });
  const files = state.status === "ready" ? state.rows : null;

  return (
    <section className="grid gap-3 min-w-0">
      <h3 className={H3}>Flagged uploads</h3>
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setWorkspace(workspaceInput.trim());
        }}
      >
        <label className="flex items-center gap-1.5 text-(length:--text-meta)">
          Field
          <select
            className={FIELD_CLASS}
            value={field}
            onChange={(e) => setField(e.target.value as ClassifierSafetyField | "")}
          >
            <option value="">All</option>
            {CLASSIFIER_SAFETY_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-(length:--text-meta)">
          <input
            type="checkbox"
            checked={highOnly}
            onChange={(e) => setHighOnly(e.target.checked)}
          />
          High confidence only
        </label>
        <label className="flex items-center gap-1.5 text-(length:--text-meta)">
          Workspace
          <input
            type="text"
            className={`${FIELD_CLASS} w-40`}
            value={workspaceInput}
            onChange={(e) => setWorkspaceInput(e.target.value)}
            onBlur={() => setWorkspace(workspaceInput.trim())}
            placeholder="any"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </form>

      {state.status === "error" ? (
        <p role="alert" className="m-0 text-(length:--text-meta) text-destructive">
          Failed to load flagged uploads.
        </p>
      ) : !files ? (
        <Skeleton className="h-32 w-full" />
      ) : files.length === 0 ? (
        <p className="m-0 text-(length:--text-meta) text-muted-foreground">
          No flagged uploads match these filters.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Kind / screen</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Flagged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => (
                  <TableRow key={`${f.workspace}/${f.key}`}>
                    <TableCell className="font-mono">{f.workspace}</TableCell>
                    <TableCell className="max-w-72">
                      <a
                        href={flaggedFileHref(f)}
                        title={f.key}
                        className="block truncate font-mono text-primary hover:underline"
                      >
                        {f.key}
                      </a>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {f.flags.map((flag) => (
                          <Badge
                            key={flag.field}
                            variant={flagVariant(flag.confidence)}
                            title={flagTitle(flag)}
                          >
                            {flagLabel(flag)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>{[f.kind, f.screen].filter(Boolean).join(" / ") || "-"}</TableCell>
                    <TableCell className="font-mono">{f.classifier ?? "-"}</TableCell>
                    <TableCell title={f.flaggedAt}>{ago(f.flaggedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {state.more === "error" ? (
            <p role="alert" className="m-0 text-(length:--text-meta) text-destructive">
              Failed to load more.
            </p>
          ) : null}
          {state.nextCursor ? (
            <button
              type="button"
              className={ADMIN_BTN}
              onClick={loadMore}
              disabled={state.more === "loading"}
            >
              {state.more === "loading" ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Held uploads (upload-hold.ts) and the operator release: approves every
 * pending hold, or one workspace's, in server-sized batches until none are
 * left or a batch releases nothing. The kill switch for new holds is the
 * Flagship `upload-holds` flag, not this button.
 */
function HoldsSection({ apiOrigin }: AdminClassifierProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const res = useAdminResource(() => api.getClassifierHolds(), [api]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = res.data;

  const release = async (workspace: string) => {
    setBusy(true);
    setConfirming(null);
    let released = 0;
    let failed = 0;
    try {
      for (;;) {
        const batch = await api.releaseClassifierHolds(workspace || undefined);
        released += batch.released;
        failed += batch.failed;
        setStatus(`Released ${released}…`);
        if (batch.remaining === 0 || batch.released === 0) break;
      }
      setStatus(
        `Released ${released} held file${released === 1 ? "" : "s"}` +
          (failed > 0 ? `. ${failed} could not be restored and stay held.` : "."),
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Release failed.");
    } finally {
      setBusy(false);
      res.reload();
    }
  };

  return (
    <section className="grid gap-3 min-w-0">
      <h3 className={H3}>Held uploads</h3>
      {res.error ? (
        <p className="m-0 text-(length:--text-meta) text-destructive">Could not load holds.</p>
      ) : !data ? (
        <Skeleton className="h-16 w-full" />
      ) : data.total === 0 ? (
        <p className="m-0 text-(length:--text-meta) text-muted-foreground">
          Nothing is held. New holds stop when the Flagship <code>upload-holds</code> flag is off.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead className="text-right">Held</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.workspaces.map((row) => (
                <TableRow key={row.workspace}>
                  <TableCell className="font-mono">{row.workspace}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      className={ADMIN_BTN}
                      disabled={busy}
                      onClick={() => setConfirming(row.workspace)}
                    >
                      Release
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-2">
            {confirming !== null ? (
              <>
                <span className="text-(length:--text-meta)">
                  {confirming
                    ? `Release every held file in ${confirming}?`
                    : `Release all ${data.total} held files?`}{" "}
                  Their URLs work again and they return to PR comments.
                </span>
                <button
                  type="button"
                  className={ADMIN_BTN_DANGER}
                  disabled={busy}
                  onClick={() => void release(confirming)}
                >
                  Release
                </button>
                <button type="button" className={ADMIN_BTN} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className={ADMIN_BTN_DANGER}
                disabled={busy}
                onClick={() => setConfirming("")}
              >
                Release all holds
              </button>
            )}
          </div>
        </>
      )}
      {status ? (
        <p className="m-0 text-(length:--text-meta) text-muted-foreground" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

export function AdminClassifier(props: AdminClassifierProps) {
  return (
    <IslandErrorBoundary>
      <div className="grid gap-8 min-w-0">
        <OverviewSection {...props} />
        <HoldsSection {...props} />
        <FlaggedSection {...props} />
      </div>
    </IslandErrorBoundary>
  );
}
