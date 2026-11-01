/**
 * One Analytics Engine point per hosted GET. Capture only: nothing reads
 * this dataset yet, and nothing here touches D1. `writeDataPoint` queues
 * the write and returns, so it never delays the response. An absent
 * binding (tests, local dev) is a no-op, and a write error is swallowed.
 *
 * No IP, user agent, or full referrer is stored. The referrer is reduced
 * to a class.
 */

/**
 * Blob positions are the read contract. Analytics Engine has no column
 * names, only ordinals. Append new fields at the end. Never reorder.
 */
export const VIEW_BLOB_ORDER = ["workspace", "objectKey", "referrer", "gate"] as const;

/** Doubles, same rule as the blobs. */
export const VIEW_DOUBLE_ORDER = ["status", "contentLength"] as const;

export type ReferrerClass = "github_camo" | "slack" | "cdn_cgi_image" | "direct" | "other";

/** allow: passed through. block: held card or 404. fail_open: D1 error, passed through. */
export type GateOutcome = "allow" | "block" | "fail_open";

/** Analytics Engine caps an index at 96 bytes. */
const MAX_INDEX_BYTES = 96;

export function referrerClass(request: Request, transform: boolean): ReferrerClass {
  if (transform) return "cdn_cgi_image";
  const agent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (agent.includes("github-camo")) return "github_camo";
  if (agent.includes("slack")) return "slack";
  const referer = request.headers.get("referer");
  if (!referer) return "direct";
  try {
    const host = new URL(referer).hostname.toLowerCase();
    if (host === "slack.com" || host.endsWith(".slack.com")) return "slack";
  } catch {
    // An unparseable referrer is still a referrer.
  }
  return "other";
}

/**
 * The image resizer fetches the source through this Worker with
 * `Via: image-resizing`. The transform request was already counted.
 */
export function isResizerFetch(request: Request): boolean {
  return /\bimage-resizing\b/i.test(request.headers.get("via") ?? "");
}

function indexValue(workspace: string): string {
  const bytes = new TextEncoder().encode(workspace);
  if (bytes.length <= MAX_INDEX_BYTES) return workspace;
  return new TextDecoder().decode(bytes.slice(0, MAX_INDEX_BYTES)).replace(/�$/, "");
}

export interface ViewPoint {
  objectKey: string;
  referrer: ReferrerClass;
  gate: GateOutcome;
  status: number;
  /** -1 when the response has no Content-Length (chunked or unknown). */
  contentLength: number;
}

export function writeViewPoint(dataset: AnalyticsEngineDataset | undefined, view: ViewPoint): void {
  if (!dataset) return;
  const slash = view.objectKey.indexOf("/");
  const workspace = slash === -1 ? "" : view.objectKey.slice(0, slash);
  try {
    dataset.writeDataPoint({
      // Sampling key: one busy workspace does not crowd out the rest.
      indexes: [indexValue(workspace)],
      blobs: [workspace, view.objectKey, view.referrer, view.gate],
      doubles: [view.status, view.contentLength],
    });
  } catch (err) {
    console.error({ event: "read_gate_view_write_failed", err });
  }
}

export function contentLengthOf(response: Response): number {
  const raw = response.headers.get("content-length");
  if (raw == null) return -1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : -1;
}
