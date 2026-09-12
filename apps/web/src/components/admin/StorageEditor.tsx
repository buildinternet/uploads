/**
 * Storage / BYO-bucket section of the workspace drawer — the React port of the
 * imperative page's `renderStorageForm` (issue #583 Task 3.3). Read-out of the
 * workspace's storage mode, the `byoBucketEnabled` gate, and configure/verify
 * provenance (masked/presence fields only — never a credential value, matching
 * the /me storage projection), plus `configuredBy` (admin-ui-only). The only
 * write is the `byoBucketEnabled` kill-switch; lane activation/removal stays on
 * the workspace's own settings page.
 */
import { useEffect, useState } from "react";
import { Button } from "@uploads/ui/components/ui/button";
import { formatDate } from "../../lib/subscription-copy";
import type { AdminApi, AdminStorageResponse } from "../../lib/admin-api";
import { Muted, SectionHeading, StatusLine } from "./StatusLine";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex justify-between gap-2 text-(length:--text-micro) text-body">
      <span>{label}</span>
      <span className="font-mono font-medium">{children}</span>
    </li>
  );
}

export function StorageEditor({ api, workspace }: { api: AdminApi; workspace: string }) {
  const [data, setData] = useState<AdminStorageResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ state: "error" | "ok"; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getStorage(workspace)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setEnabled(d.byoBucketEnabled);
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [api, workspace]);

  if (loadError) return <Muted>Failed to load storage.</Muted>;
  if (!data) return <Muted>Loading storage…</Muted>;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);
    setSaving(true);
    try {
      const updated = await api.saveStorage(workspace, enabled);
      setData(updated);
      setEnabled(updated.byoBucketEnabled);
      setStatus({ state: "ok", message: "Saved." });
    } catch (err) {
      setStatus({
        state: "error",
        message:
          err instanceof Error && err.message ? err.message : "Couldn't save storage settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  const lanes = data.lanes ?? [];

  return (
    <div>
      <SectionHeading>Storage</SectionHeading>
      <Muted>Mode: {data.mode === "byo" ? "Bring your own bucket" : "Shared"}</Muted>
      {data.mode === "byo" ? (
        <ul className="mt-2 grid list-none gap-1.5 p-0">
          {data.bucket && <Row label="Bucket">{data.bucket}</Row>}
          {data.accountIdMasked && <Row label="Account">{data.accountIdMasked}</Row>}
          {data.accessKeyIdLast4 && <Row label="Access key">{data.accessKeyIdLast4}</Row>}
          {data.publicBaseUrl && <Row label="Public URL">{data.publicBaseUrl}</Row>}
          <Row label="Configured">
            {data.configuredAt ? (
              <>
                {formatDate(data.configuredAt) ?? data.configuredAt}
                {data.configuredBy ? ` by ${data.configuredBy}` : ""}
              </>
            ) : (
              <span className="text-muted-foreground">Not configured</span>
            )}
          </Row>
          <Row label="Verified">
            {data.verifiedAt ? (
              (formatDate(data.verifiedAt) ?? data.verifiedAt)
            ) : (
              <span className="text-muted-foreground">Not verified</span>
            )}
          </Row>
        </ul>
      ) : (
        <Muted>Using the shared platform bucket.</Muted>
      )}
      {lanes.length > 0 && (
        <ul className="mt-2 grid list-none gap-1.5 p-0">
          {lanes.map((lane, i) => (
            <li
              key={`${lane.bucket}-${i}`}
              className="flex justify-between gap-2 text-(length:--text-micro) text-body"
            >
              <span className="text-muted-foreground">
                {lane.role === "fallback" ? "Previous" : "Saved"}
              </span>
              <span className="font-mono font-medium">
                {lane.bucket}
                {lane.lastActiveAt
                  ? ` — until ${formatDate(lane.lastActiveAt) ?? lane.lastActiveAt}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={save} className="mt-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-(length:--text-meta) text-body">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{" "}
          Allow bring-your-own bucket
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={saving}>
          Save
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
