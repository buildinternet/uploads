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
import { useEffect, useMemo, useState } from "react";
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
  makeAdminApi,
  type ClassifierAdminWindow,
  type ClassifierFlaggedFile,
  type ClassifierOverview,
  type ClassifierSafetyField,
  type ClassifierValueCount,
} from "../../lib/admin-api";
import { ADMIN_BTN } from "../../lib/admin-ui";
import {
  CLASSIFIER_FIELDS,
  CLASSIFIER_WINDOWS,
  coverageLabel,
  flaggedFileHref,
  flaggedRate,
  flagLabel,
  flagTitle,
  flagVariant,
  relativeTime,
  topFlaggedValues,
  withShares,
} from "../../lib/admin-classifier";
import { useAdminResource } from "./use-admin-resource";

export interface AdminClassifierProps {
  apiOrigin: string;
}

const CLEAN: Record<ClassifierSafetyField, string> = {
  rating: "safe",
  content: "none",
  secret: "none",
  pii: "none",
};

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

function DailyChart({ daily }: { daily: ClassifierOverview["daily"] }) {
  if (daily.length === 0) {
    return <p className="m-0 text-(length:--text-meta) text-muted-foreground">No activity.</p>;
  }
  const W = 960;
  const H = 180;
  const max = Math.max(1, ...daily.map((d) => d.classified + d.skipped + d.failed));
  const slot = W / daily.length;
  const bar = Math.max(1, slot * 0.7);
  const scale = (n: number) => (n / max) * (H - 4);
  const summary = `Classified, skipped, and failed files per day, ${daily[0]?.day} to ${
    daily[daily.length - 1]?.day
  }, peak ${max}.`;
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={summary}
        className="w-full h-auto max-h-48"
      >
        {daily.map((d, i) => {
          const x = i * slot + (slot - bar) / 2;
          const hc = scale(d.classified);
          const hs = scale(d.skipped);
          const hf = scale(d.failed);
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${d.classified} classified, ${d.skipped} skipped, ${d.failed} failed`}</title>
              <rect x={x} y={H - hc} width={bar} height={hc} className="fill-primary" />
              <rect
                x={x}
                y={H - hc - hs}
                width={bar}
                height={hs}
                className="fill-muted-foreground"
              />
              <rect
                x={x}
                y={H - hc - hs - hf}
                width={bar}
                height={hf}
                className="fill-destructive"
              />
            </g>
          );
        })}
      </svg>
      <p className="m-0 mt-1 flex gap-4 text-(length:--text-micro) text-muted-foreground">
        <LegendItem swatch="bg-primary">Classified</LegendItem>
        <LegendItem swatch="bg-muted-foreground">Skipped</LegendItem>
        <LegendItem swatch="bg-destructive">Failed</LegendItem>
        <span>
          {daily[0]?.day} to {daily[daily.length - 1]?.day} (UTC)
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
          const top = topFlaggedValues(f.values, CLEAN[f.field]);
          return (
            <TableRow key={f.field}>
              <TableCell className="font-mono">{f.field}</TableCell>
              <TableCell className="text-right tabular-nums">
                {f.answered.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {f.flagged.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">{flaggedRate(f)}</TableCell>
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
        {CLASSIFIER_WINDOWS.map((d) => (
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
            Updated {relativeTime(data.generatedAt)}
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
            <Breakdown title="Versions" rows={data.versions} />
            <Breakdown title="Skip reasons" rows={data.skipReasons} />
            <Breakdown title="Errors" rows={data.errorReasons} />
            <Breakdown title="Kind" rows={data.kinds} />
            <Breakdown title="Surface" rows={data.surfaces} />
            <Breakdown title="Screen" rows={data.screens} />
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
  const [files, setFiles] = useState<ClassifierFlaggedFile[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setError(false);
    api
      .listClassifierFlagged({ field, highOnly, workspace, limit: 25 })
      .then((page) => {
        if (!alive) return;
        setFiles(page.files);
        setCursor(page.nextCursor);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [api, field, highOnly, workspace]);

  const loadMore = () => {
    if (!cursor) return;
    setLoadingMore(true);
    api
      .listClassifierFlagged({ field, highOnly, workspace, cursor, limit: 25 })
      .then((page) => {
        setFiles((prev) => [...(prev ?? []), ...page.files]);
        setCursor(page.nextCursor);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  };

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
            {CLASSIFIER_FIELDS.map((f) => (
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

      {error && !files ? (
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
                    <TableCell title={f.flaggedAt}>{relativeTime(f.flaggedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {error ? (
            <p role="alert" className="m-0 text-(length:--text-meta) text-destructive">
              Failed to load more.
            </p>
          ) : null}
          {cursor ? (
            <button type="button" className={ADMIN_BTN} onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

export function AdminClassifier(props: AdminClassifierProps) {
  return (
    <IslandErrorBoundary>
      <div className="grid gap-8 min-w-0">
        <OverviewSection {...props} />
        <FlaggedSection {...props} />
      </div>
    </IslandErrorBoundary>
  );
}
