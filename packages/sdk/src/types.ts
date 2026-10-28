/** Scoped-operator-token permission scope. */
export type TokenScope =
  | "files:read"
  | "files:write"
  | "files:delete"
  | "operator:read"
  | "operator:write"
  | "workspace:invite"
  | "workspace:manage";

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  /** Hydrate each row's queryable D1 metadata (`?metadata=1`). */
  metadata?: boolean;
}

/** Page cap for `findFilesAll` / `uploads find --all`, so draining search stays bounded. */
export const FIND_FILES_MAX_PAGES = 20;

export interface FindFilesOptions {
  prefix?: string;
  limit?: number;
  /**
   * Case-insensitive substring match on object keys (`?name=`).
   * At least one of non-empty `filters` or `name` is required.
   */
  name?: string;
  /**
   * Opaque continuation from a previous result. Pass it back unchanged with
   * the same filters/name/prefix; don't hand-build one.
   */
  cursor?: string;
}

export interface FindFilesItem {
  key: string;
  url: string | null;
  metadata: Record<string, string>;
}

export interface FindFilesResult {
  items: FindFilesItem[];
  cursor: string | null;
  /** Present when a `name` term was used — true if the underlying query hit its cap. */
  truncated?: boolean;
}

export interface MetadataKeysResult {
  keys: Array<{ key: string; count: number; distinctValues: number }>;
  truncated: boolean;
}

export interface MetadataValuesResult {
  key: string;
  values: Array<{ value: string; count: number }>;
  truncated: boolean;
}

export interface GetMetadataResult {
  metadata: Record<string, string>;
}

export interface PatchMetadataOptions {
  set?: Record<string, string>;
  delete?: string[];
}

export interface ListItem {
  key: string;
  url: string | null;
  embedUrl?: string | null;
  /** Canonical `/f/` page URL when the API provides it. Absent on older API deployments. */
  pageUrl?: string;
  size?: number;
  uploaded?: string;
  /** Present only when listed with `metadata: true`, and only for keys that have rows. */
  metadata?: Record<string, string>;
}

export interface ListResult {
  items: ListItem[];
  cursor: string | null;
}

export interface HeadResult {
  key: string;
  url: string | null;
  embedUrl?: string | null;
  size: number;
  contentType: string;
  uploaded?: string;
  /** The R2 provenance bag. Queryable metadata needs `getMetadata(key)`. */
  provenance?: Record<string, string>;
}

export interface DeleteResult {
  key: string;
  deleted: boolean;
}

/** One row of `GET /v1/workspaces/:workspace/files/held`. */
export interface HeldFile {
  key: string;
  /** `secret: api_key`, `pii: financial`, or null. */
  reason: string | null;
  /** True when the bytes moved out of the public bucket while held. */
  moved: boolean;
  /** Content hash of the held bytes, when the server knows it. */
  sha?: string | null;
}

/**
 * `POST /v1/workspaces/:workspace/files/approve?key=`. `approved: false`
 * with `reason: "not_held"` means the file was not held (already approved,
 * never flagged, or unknown).
 */
export type ApproveResult =
  | { key: string; approved: true }
  | { key: string; approved: false; reason: "not_held" };

/** A workspace-owned, publicly visible ordered media gallery. */
export interface GalleryItem {
  id: string;
  objectKey: string;
  position: number;
  caption: string | null;
  altText: string | null;
  createdAt: string;
  status: "available" | "missing";
  url: string | null;
  /** Dual-host embed URL when available. */
  embedUrl?: string | null;
  /** Standalone web page for this item (gallery URL + item id). Absent on older API deployments. */
  pageUrl?: string;
  contentType: string | null;
  size: number | null;
}

export interface Gallery {
  id: string;
  /** Canonical public URL returned by the API; clients must not construct it. */
  url: string;
  workspace: string;
  title: string;
  description: string | null;
  visibility: "public";
  coverItemId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: GalleryItem[];
}

export type GallerySummary = Omit<Gallery, "items">;

export interface GalleryListOptions {
  limit?: number;
  cursor?: string;
}

export interface GalleryListResult {
  galleries: GallerySummary[];
  nextCursor: string | null;
}

export interface CreateGalleryOptions {
  title: string;
  description?: string | null;
  /** Reuse this key to safely retry the same create request. Generated when omitted. */
  idempotencyKey?: string;
}

export interface AddGalleryItemOptions {
  expectedVersion: number;
  caption?: string | null;
  altText?: string | null;
}

export interface DeleteGalleryOptions {
  expectedVersion: number;
}

export interface GalleryExternalReference {
  id: string;
  provider: "github";
  resourceType: "item";
  coordinate: string;
  canonicalUrl: string | null;
  createdAt: string;
}

export interface GalleryExternalReferenceListResult {
  references: GalleryExternalReference[];
}

export interface LinkGalleryExternalReferenceOptions {
  expectedVersion: number;
  provider: "github";
  coordinate: string;
}

export interface UnlinkGalleryExternalReferenceOptions {
  expectedVersion: number;
}

export interface FindGalleriesByReferenceOptions {
  provider: "github";
  coordinate: string;
  limit?: number;
  cursor?: string;
}

/** A workspace-owned, query-backed public repo change feed. */
export interface FeedItem {
  id: string;
  objectKey: string;
  filename: string;
  status: "available" | "missing" | "withheld";
  url: string | null;
  embedUrl: string | null;
  /** Canonical `/c/<id>/<item>` page when the API computed one. */
  pageUrl?: string;
  contentType: string | null;
  size: number | null;
  uploaded: string | null;
  modified: string | null;
  path: string | null;
  state: string | null;
  posterUrl?: string;
  videoDimensions?: { width: number; height: number };
}

export interface Feed {
  id: string;
  /** Canonical public URL returned by the API; clients must not construct it. */
  url: string;
  workspace: string;
  repo: string;
  path: string | null;
  number: number | null;
  kind: "pull" | "issue" | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: FeedItem[];
}

export type FeedSummary = Omit<Feed, "items">;

export interface FeedListOptions {
  limit?: number;
  cursor?: string;
}

export interface FeedListResult {
  feeds: FeedSummary[];
  nextCursor: string | null;
}

export interface CreateFeedOptions {
  repo: string;
  path?: string | null;
  number?: number | null;
  kind?: "pull" | "issue" | null;
  pr?: number | null;
  issue?: number | null;
}

/**
 * Reasons the bot didn't post. The CLI falls back to local `gh` for all but
 * `not_authorized` (repo bound to another workspace), where the user's own
 * credentials would bypass the server-side gate.
 */
export type GithubCommentDeclineReason =
  | "app_unconfigured"
  | "not_installed"
  | "forbidden"
  | "not_authorized"
  | "actor_not_authorized"
  | "unavailable";

export type GithubCommentResult =
  | {
      posted: true;
      action: "created" | "updated" | "skipped";
      count: number;
      commentUrl?: string;
      /** Files on the PR or issue held for review, when any. */
      held?: number;
    }
  | {
      posted: false;
      reason: GithubCommentDeclineReason;
      // On `forbidden` (App installed, write pending approval): a message and
      // fix link for the CLI to show.
      message?: string;
      fixUrl?: string;
      required?: string[];
    };

export interface HealthResult {
  ok: boolean;
}

export interface UsageResult {
  workspace: string;
  bytes: number;
  objects: number;
  uploadsInPeriod: number;
  periodStart: string;
  updatedAt: string;
  maxStorageBytes?: number;
  storageRemainingBytes?: number;
  maxUploadsPerPeriod?: number;
  uploadsRemaining?: number;
  /** Bytes still on hosted storage (shared-lane residue). */
  sharedBytes?: number;
  /** Objects still on hosted storage (shared-lane residue). */
  sharedObjects?: number;
  /** "shared" = BYO bucket active: the storage cap meters only hosted
   * residue. */
  storageBudgetBasis?: "total" | "shared";
  /** Lane summary. Missing on older servers. */
  storage?: {
    mode: "shared" | "byo";
    /** Demoted former-active lanes that still serve previously uploaded files. */
    fallbackLanes: number;
    health: { ok: boolean; code?: string; message?: string; since?: string };
  };
  /** File scopes of the presented token. Missing on older servers. */
  scopes?: Array<TokenScope>;
  /** Plan catalog id (`free` | `pro`). Missing on older servers. */
  plan?: string;
}

export interface ReconcileResult {
  workspace: string;
  bytes: number;
  objects: number;
  previous: { bytes: number; objects: number };
  changed: boolean;
  usage: UsageResult;
}

export interface PurgeExpiredResult {
  workspace: string;
  retentionDays: number;
  cutoff: string;
  deleted: number;
  freedBytes: number;
  keys: string[];
  keysTruncated: boolean;
  reconcile: ReconcileResult;
}

export type PurgeExpiredResponse = PurgeExpiredResult | { skipped: true; reason: string };

/** Options for {@link UploadsClient.put}. */
export interface PutOptions {
  /** Sent as `Content-Type`. Omit it and the API sniffs the type from the bytes. */
  contentType?: string;
  /**
   * Metadata stored with the file, sent as `X-Uploads-Meta-<key>` headers.
   * The API stores allowlisted provenance keys (`client`, `source-name`, ...)
   * on the object and the rest as queryable metadata.
   */
  metadata?: Record<string, string | undefined>;
  /**
   * Overwrite an existing object on a strict (non-`gh/`) key. Without it such
   * a put throws `UploadsError` `KEY_EXISTS`. Managed `gh/` paths always
   * hot-swap.
   */
  replace?: boolean;
  /** Reuse to safely retry the same upload. Not generated; omit and no header is sent. */
  idempotencyKey?: string;
}

export interface PutResult {
  workspace: string;
  key: string;
  /** Null when the workspace has no public URL. */
  url: string | null;
  embedUrl: string | null;
  size: number;
  contentType: string;
  /** True when the put overwrote an existing key. */
  replaced?: boolean;
  /** `pending` when the classifier may still hold this file for review. */
  holdCheck?: "pending";
  /** The object's provenance (`client`, `source-name`, `content-sha256`). */
  provenance?: Record<string, string>;
  /** The queryable metadata this put stored. Absent when the put carried none. */
  metadata?: Record<string, string>;
}

/** `PUT ...?dryRun=1`: where a put would land, without writing. */
export interface PutPreview {
  workspace: string;
  key: string;
  url: string | null;
  embedUrl?: string | null;
  /** True when an object already lives at the key. */
  replaced?: boolean;
  /** True when a real put would be refused (strict key, existing object, no `replace`). */
  wouldRefuse?: boolean;
}
