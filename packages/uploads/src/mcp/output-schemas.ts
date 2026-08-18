/**
 * JSON Schema for MCP tool `structuredContent`. The SDK validates successful
 * results against the advertised `outputSchema`, so every property a handler
 * actually returns must be listed. Roots are always `type: object` — a
 * oneOf/anyOf root is treated as non-object by the 2025-era codec and wraps
 * the result as `{ result: … }`.
 */
export type JsonSchema = Record<string, unknown>;

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const stringMap: JsonSchema = {
  type: "object",
  additionalProperties: { type: "string" },
};

const nullableString: JsonSchema = { type: ["string", "null"] };
const nullableNumber: JsonSchema = { type: ["number", "null"] };

/** Hosted + stdio `comment` / `put.comment` — all PostCommentResult variants. */
export const commentResultSchema: JsonSchema = objectSchema(
  {
    posted: { type: "boolean" },
    reason: {
      type: "string",
      enum: [
        "app_unconfigured",
        "not_installed",
        "not_authorized",
        "actor_not_authorized",
        "unavailable",
        "forbidden",
      ],
    },
    message: { type: "string" },
    fixUrl: { type: "string" },
    required: { type: "array", items: { type: "string" } },
    action: { type: "string", enum: ["skipped", "created", "updated"] },
    count: { type: "number" },
    commentUrl: { type: "string" },
  },
  ["posted"],
);

const promoteResultSchema: JsonSchema = objectSchema(
  {
    promoted: { type: "array", items: { type: "string" } },
    skipped: {
      type: "array",
      items: objectSchema({ key: { type: "string" }, reason: { type: "string" } }, [
        "key",
        "reason",
      ]),
    },
  },
  ["promoted", "skipped"],
);

/** Hosted `promote` tool's `attached[]` entry (issue #702, `AttachExistingResponse`). */
const attachExistingResultSchema: JsonSchema = objectSchema(
  {
    key: { type: "string" },
    url: nullableString,
    embedUrl: nullableString,
    pageUrl: { type: "string" },
    moved: { type: "boolean" },
    source: objectSchema({ key: { type: "string" } }, ["key"]),
    comment: commentResultSchema,
  },
  ["key", "url", "embedUrl", "moved", "source", "comment"],
);

/** Hosted `promote` tool's `attachFailures[]` entry — one per bad `keys` source. */
const attachFailureSchema: JsonSchema = objectSchema(
  {
    key: { type: "string" },
    error: objectSchema(
      {
        message: { type: "string" },
        code: { type: "string" },
        status: { type: "number" },
      },
      ["message"],
    ),
  },
  ["key", "error"],
);

const putObjectFields: Record<string, JsonSchema> = {
  key: { type: "string" },
  url: nullableString,
  embedUrl: nullableString,
  size: { type: "number" },
  contentType: { type: "string" },
  replaced: { type: "boolean" },
  markdown: { type: "string" },
  provenance: stringMap,
  metadata: stringMap,
  visibility: { type: "string" },
};

/** Hosted `PostCommentResult` or stdio `AttachmentsCommentResult` (`via`/`action`). */
const putCommentSchema: JsonSchema = objectSchema({
  posted: { type: "boolean" },
  reason: {
    type: "string",
    enum: [
      "app_unconfigured",
      "not_installed",
      "not_authorized",
      "actor_not_authorized",
      "unavailable",
      "forbidden",
    ],
  },
  message: { type: "string" },
  fixUrl: { type: "string" },
  required: { type: "array", items: { type: "string" } },
  action: { type: "string", enum: ["skipped", "created", "updated"] },
  count: { type: "number" },
  commentUrl: { type: "string" },
  via: { type: "string", enum: ["bot", "gh"] },
});

const putExtras: Record<string, JsonSchema> = {
  comment: putCommentSchema,
  commentError: { type: "string" },
  promotion: promoteResultSchema,
  promoteError: { type: "string" },
};

const putFailure: JsonSchema = objectSchema(
  {
    file: { type: "string" },
    error: objectSchema(
      {
        message: { type: "string" },
        code: { type: "string" },
        status: { type: "number" },
      },
      ["message"],
    ),
  },
  ["file", "error"],
);

/** Single-file put (flat) or multi-file `{ uploads, failures }`, plus optional comment/promote extras. */
export const putResultSchema: JsonSchema = objectSchema({
  workspace: { type: "string" },
  ...putObjectFields,
  file: { type: "string" },
  uploads: {
    type: "array",
    items: {
      type: "object",
      properties: { file: { type: "string" }, ...putObjectFields },
      additionalProperties: true,
    },
  },
  failures: { type: "array", items: putFailure },
  ...putExtras,
  // stdio put adds client-side optimize/frame provenance and dry-run flags.
  optimize: { type: "object", additionalProperties: true },
  frame: { type: "object", additionalProperties: true },
  dryRun: { type: "boolean" },
  hint: { type: "string" },
});

export const listResultSchema: JsonSchema = objectSchema({
  items: {
    type: "array",
    items: objectSchema({
      key: { type: "string" },
      url: nullableString,
      embedUrl: nullableString,
      size: { type: "number" },
      contentType: { type: "string" },
      uploaded: { type: "string" },
      visibility: { type: "string" },
      pageUrl: { type: "string" },
    }),
  },
  cursor: nullableString,
  prefixes: { type: "array", items: { type: "string" } },
});

export const deleteResultSchema: JsonSchema = objectSchema(
  {
    key: { type: "string" },
    deleted: { type: "boolean" },
    dryRun: { type: "boolean" },
  },
  ["key"],
);

export const metadataResultSchema: JsonSchema = objectSchema({ metadata: stringMap }, ["metadata"]);

export const findFilesResultSchema: JsonSchema = objectSchema(
  {
    items: {
      type: "array",
      items: objectSchema(
        {
          key: { type: "string" },
          url: nullableString,
          metadata: stringMap,
        },
        ["key"],
      ),
    },
    cursor: nullableString,
    truncated: { type: "boolean" },
  },
  ["items"],
);

/** `meta keys` or `meta values <key>`. */
export const metadataFacetsResultSchema: JsonSchema = objectSchema({
  keys: {
    type: "array",
    items: objectSchema(
      {
        key: { type: "string" },
        count: { type: "number" },
        distinctValues: { type: "number" },
      },
      ["key", "count", "distinctValues"],
    ),
  },
  truncated: { type: "boolean" },
  key: { type: "string" },
  values: {
    type: "array",
    items: objectSchema({ value: { type: "string" }, count: { type: "number" } }, [
      "value",
      "count",
    ]),
  },
});

export const repoLinkStatusResultSchema: JsonSchema = objectSchema(
  { binding: { type: "string", enum: ["self", "other", "none"] } },
  ["binding"],
);

export const usageResultSchema: JsonSchema = objectSchema({
  workspace: { type: "string" },
  bytes: { type: "number" },
  objects: { type: "number" },
  uploadsInPeriod: { type: "number" },
  periodStart: { type: "string" },
  updatedAt: { type: "string" },
  maxStorageBytes: { type: "number" },
  storageRemainingBytes: { type: "number" },
  maxUploadsPerPeriod: { type: "number" },
  uploadsRemaining: { type: "number" },
});

export const reconcileResultSchema: JsonSchema = objectSchema({
  workspace: { type: "string" },
  bytes: { type: "number" },
  objects: { type: "number" },
  previous: objectSchema({ bytes: { type: "number" }, objects: { type: "number" } }, [
    "bytes",
    "objects",
  ]),
  changed: { type: "boolean" },
  usage: usageResultSchema,
  unprefixedBucket: { type: "boolean" },
});

export const purgeExpiredResultSchema: JsonSchema = objectSchema({
  skipped: { type: "boolean" },
  reason: { type: "string" },
  workspace: { type: "string" },
  retentionDays: { type: "number" },
  cutoff: { type: "string" },
  deleted: { type: "number" },
  freedBytes: { type: "number" },
  keys: { type: "array", items: { type: "string" } },
  keysTruncated: { type: "boolean" },
  reconcile: reconcileResultSchema,
});

export const healthResultSchema: JsonSchema = objectSchema({
  ok: { type: "boolean" },
  apiUrl: { type: "string" },
});

export const promoteToolResultSchema: JsonSchema = objectSchema({
  // `promotion` is optional (issue #702): a `keys`-only call (no `branch`)
  // never runs the branch sweep, so there's nothing to report under it.
  promotion: promoteResultSchema,
  attached: { type: "array", items: attachExistingResultSchema },
  attachFailures: { type: "array", items: attachFailureSchema },
  comment: commentResultSchema,
  commentError: { type: "string" },
});

const galleryItemSchema: JsonSchema = objectSchema({
  id: { type: "string" },
  objectKey: { type: "string" },
  filename: { type: "string" },
  position: { type: "number" },
  caption: nullableString,
  altText: nullableString,
  createdAt: { type: "string" },
  status: { type: "string", enum: ["available", "missing", "withheld"] },
  url: nullableString,
  embedUrl: nullableString,
  pageUrl: { type: "string" },
  contentType: nullableString,
  size: nullableNumber,
  uploaded: nullableString,
  modified: nullableString,
  posterUrl: { type: "string" },
  videoDimensions: {
    type: "object",
    additionalProperties: true,
  },
});

const galleryReferenceSchema: JsonSchema = objectSchema({
  id: { type: "string" },
  provider: { type: "string" },
  resourceType: { type: "string" },
  coordinate: { type: "string" },
  canonicalUrl: nullableString,
  createdAt: { type: "string" },
  title: { type: "string" },
  kind: { type: "string", enum: ["pull", "issue"] },
});

export const galleryResultSchema: JsonSchema = objectSchema({
  id: { type: "string" },
  url: { type: "string" },
  workspace: { type: "string" },
  title: { type: "string" },
  description: nullableString,
  visibility: { type: "string" },
  coverItemId: nullableString,
  version: { type: "number" },
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
  items: { type: "array", items: galleryItemSchema },
  itemCount: { type: "number" },
  references: { type: "array", items: galleryReferenceSchema },
});

export const galleryFindResultSchema: JsonSchema = objectSchema({
  galleries: { type: "array", items: galleryResultSchema },
  nextCursor: nullableString,
});

/** Hosted catalog — every tool must have an entry. */
export const hostedOutputSchemas: Record<string, JsonSchema> = {
  gallery_create: galleryResultSchema,
  gallery_get: galleryResultSchema,
  gallery_add: galleryItemSchema,
  gallery_link: galleryReferenceSchema,
  gallery_find_by_reference: galleryFindResultSchema,
  put: putResultSchema,
  list: listResultSchema,
  delete: deleteResultSchema,
  comment: commentResultSchema,
  promote: promoteToolResultSchema,
  get_metadata: metadataResultSchema,
  set_metadata: metadataResultSchema,
  find_files: findFilesResultSchema,
  list_metadata_keys: metadataFacetsResultSchema,
  repo_link_status: repoLinkStatusResultSchema,
  usage: usageResultSchema,
  reconcile: reconcileResultSchema,
  purge_expired: purgeExpiredResultSchema,
  health: healthResultSchema,
};

/** Shared-shape stdio tools. Hosted-only tools (`promote`, `repo_link_status`) omitted. */
export const stdioOutputSchemas: Record<string, JsonSchema> = {
  gallery_create: galleryResultSchema,
  gallery_get: galleryResultSchema,
  gallery_add: galleryItemSchema,
  gallery_link: galleryReferenceSchema,
  gallery_find_by_reference: galleryFindResultSchema,
  put: putResultSchema,
  list: listResultSchema,
  delete: deleteResultSchema,
  comment: objectSchema({
    posted: { type: "boolean" },
    reason: { type: "string" },
    message: { type: "string" },
    fixUrl: { type: "string" },
    required: { type: "array", items: { type: "string" } },
    action: { type: "string", enum: ["skipped", "created", "updated"] },
    count: { type: "number" },
    commentUrl: { type: "string" },
    repo: { type: "string" },
    kind: { type: "string" },
    num: { type: "number" },
    via: { type: "string", enum: ["bot", "gh"] },
  }),
  get_metadata: metadataResultSchema,
  set_metadata: metadataResultSchema,
  find_files: findFilesResultSchema,
  list_metadata_keys: metadataFacetsResultSchema,
  usage: usageResultSchema,
  reconcile: reconcileResultSchema,
  purge_expired: purgeExpiredResultSchema,
  health: healthResultSchema,
  report: objectSchema(
    {
      ok: { type: "boolean" },
      id: { type: "string" },
      hasAttachment: { type: "boolean" },
    },
    ["ok"],
  ),
};

export function withOutputSchemas<T extends { name: string }>(
  tools: T[],
  schemas: Record<string, JsonSchema>,
  opts: { required: boolean },
): Array<T & { outputSchema?: JsonSchema }> {
  return tools.map((tool) => {
    const outputSchema = schemas[tool.name];
    if (!outputSchema) {
      if (opts.required) {
        throw new Error(`missing output schema for MCP tool ${tool.name}`);
      }
      return tool;
    }
    return { ...tool, outputSchema };
  });
}
