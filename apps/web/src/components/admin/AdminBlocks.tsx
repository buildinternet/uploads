/**
 * The operator "Blocked URLs" view (`/admin/blocks`): block one hosted URL
 * with a reason, list current blocks, and unblock. Reads and writes
 * `/admin-ui/blocks`; the API writes the `read_gate` row the hosted
 * read-gate Worker checks.
 */
import { useMemo, useState, type FormEvent } from "react";
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
import { errMessage, makeAdminApi, type AdminUrlBlock } from "../../lib/admin-api";
import { ADMIN_BTN, ADMIN_BTN_DANGER, formatAdminDate } from "../../lib/admin-ui";
import { FIELD_LABEL, INPUT_TEXT } from "./field-classes";
import { useAdminResource } from "./use-admin-resource";

export interface AdminBlocksProps {
  apiOrigin: string;
}

function Blocks({ apiOrigin }: AdminBlocksProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const blocks = useAdminResource(() => api.listUrlBlocks(), [api]);
  const [url, setUrl] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function block(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const added = await api.blockUrl(url.trim(), reason.trim());
      blocks.setData([added, ...(blocks.data ?? []).filter((b) => b.url !== added.url)]);
      setUrl("");
      setReason("");
      setStatus(`Blocked ${added.objectKey}.`);
    } catch (err) {
      setStatus(errMessage(err, "Block failed"));
    } finally {
      setBusy(false);
    }
  }

  async function unblock(row: AdminUrlBlock) {
    if (!window.confirm(`Unblock ${row.url}?`)) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.unblockUrl(row.url);
      blocks.setData((blocks.data ?? []).filter((b) => b.url !== row.url));
      setStatus(
        result.stillHeld
          ? `Unblocked ${row.objectKey}. It stays hidden because it is still held for review.`
          : `Unblocked ${row.objectKey}.`,
      );
    } catch (err) {
      setStatus(errMessage(err, "Unblock failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 min-w-0">
      <form className="grid gap-3 max-w-2xl" onSubmit={(e) => void block(e)}>
        <label className={FIELD_LABEL}>
          URL
          <input
            className={`${INPUT_TEXT} w-full`}
            type="url"
            required
            placeholder="https://storage.uploads.sh/<workspace>/<file>"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className={FIELD_LABEL}>
          Reason
          <input
            className={`${INPUT_TEXT} w-full`}
            required
            maxLength={500}
            placeholder="DMCA notice from …, abuse report #…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={`${ADMIN_BTN} ${ADMIN_BTN_DANGER}`} disabled={busy}>
            Block URL
          </button>
          {status ? (
            <span className="text-(length:--text-micro) text-muted-foreground" role="status">
              {status}
            </span>
          ) : null}
        </div>
      </form>

      {blocks.error ? (
        <p className="m-0 text-destructive text-(length:--text-micro)">
          Couldn't load blocked URLs.
        </p>
      ) : !blocks.data ? (
        <Skeleton className="h-24 w-full" />
      ) : blocks.data.length === 0 ? (
        <p className="m-0 text-muted-foreground text-(length:--text-micro)">No blocked URLs.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Blocked</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {blocks.data.map((row) => (
                <TableRow key={row.url}>
                  <TableCell className="min-w-0">
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-(length:--text-micro) text-foreground break-all"
                    >
                      {row.objectKey}
                    </a>
                  </TableCell>
                  <TableCell className="text-(length:--text-micro) whitespace-normal">
                    {row.reason}
                  </TableCell>
                  <TableCell className="text-(length:--text-micro) text-muted-foreground">
                    {formatAdminDate(row.blockedAt)}
                    <br />
                    {row.blockedBy}
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      className={ADMIN_BTN}
                      disabled={busy}
                      onClick={() => void unblock(row)}
                    >
                      Unblock
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function AdminBlocks(props: AdminBlocksProps) {
  return (
    <IslandErrorBoundary>
      <Blocks {...props} />
    </IslandErrorBoundary>
  );
}
