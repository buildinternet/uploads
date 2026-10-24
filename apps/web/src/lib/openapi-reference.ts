// Flattens the published OpenAPI document (public/.well-known/openapi.json)
// into the rows /docs/api renders: refs resolved, path- and operation-level
// parameters merged, and request/response bodies reduced to their top-level
// fields. The spec itself is guarded against the routes by
// apps/api/src/openapi-contract.test.ts, so this page inherits that check.

type Json = Record<string, unknown>;

export interface SchemaLike {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  items?: SchemaLike;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  allOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  description?: string;
  format?: string;
  default?: unknown;
}

export interface ApiField {
  name: string;
  /** Where the field travels: path, query, header, or body. */
  location: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ApiResponse {
  status: string;
  description: string;
  fields: string[];
}

export interface ApiOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  /** Required bearer scopes; empty for public, unauthenticated routes. */
  scopes: string[];
  isPublic: boolean;
  params: ApiField[];
  bodyContentType: string | null;
  responses: ApiResponse[];
}

export interface ApiGroup {
  id: string;
  title: string;
  operations: ApiOperation[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Section for a path, in display order. Unmatched paths land in "Other". */
const GROUPS: { id: string; title: string; match: (path: string) => boolean }[] = [
  {
    id: "files",
    title: "Files",
    match: (p) => p.startsWith("/v1/") && p.includes("/files") && !p.includes("/scope/"),
  },
  {
    id: "galleries",
    title: "Galleries",
    match: (p) => p.startsWith("/v1/") && p.includes("/galleries"),
  },
  { id: "feeds", title: "Live links", match: (p) => p.startsWith("/v1/") && p.includes("/feeds") },
  {
    id: "github",
    title: "Pull requests",
    match: (p) => /\/(pulls|repos|scope|github)(\/|$)/.test(p),
  },
  { id: "usage", title: "Usage", match: (p) => p.includes("/usage") },
  { id: "public", title: "Public reads", match: (p) => p.startsWith("/public/") },
];

function resolve<T>(spec: Json, value: T): T {
  let current: unknown = value;
  const seen = new Set<string>();
  while (current && typeof current === "object" && "$ref" in current) {
    const ref = (current as { $ref: string }).$ref;
    if (seen.has(ref)) break;
    seen.add(ref);
    current = ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((node, key) => (node as Json | undefined)?.[key], spec);
  }
  return current as T;
}

/** Merges allOf members so a body's top-level properties can be listed. */
function flatten(spec: Json, schema: SchemaLike | undefined): SchemaLike {
  const resolved = resolve(spec, schema ?? {});
  if (!resolved.allOf) return resolved;
  const parts = resolved.allOf.map((part) => flatten(spec, part));
  return {
    type: "object",
    properties: Object.assign({}, ...parts.map((part) => part.properties ?? {})),
    required: parts.flatMap((part) => part.required ?? []),
  };
}

/** A schema as a short type label: `string[]`, `"pull" | "issue"`, `FileHead`. */
export function typeLabel(spec: Json, schema: SchemaLike | undefined): string {
  if (!schema) return "any";
  if (schema.$ref) {
    const target = resolve(spec, schema);
    if (target.type && target.type !== "object" && !target.properties)
      return typeLabel(spec, target);
    return schema.$ref.split("/").pop() ?? "object";
  }
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.oneOf) return schema.oneOf.map((part) => typeLabel(spec, part)).join(" | ");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? "object"];
  return types
    .map((type) => (type === "array" ? `${typeLabel(spec, schema.items)}[]` : type))
    .join(" | ");
}

function topLevelFields(spec: Json, schema: SchemaLike | undefined): string[] {
  const resolved = resolve(spec, schema ?? {});
  const variants = resolved.oneOf ?? [resolved];
  const names = variants.flatMap((variant) => Object.keys(flatten(spec, variant).properties ?? {}));
  return [...new Set(names)];
}

function jsonSchemaOf(content: unknown): SchemaLike | undefined {
  const media = (content as Record<string, { schema?: SchemaLike }> | undefined)?.[
    "application/json"
  ];
  return media?.schema;
}

export function buildApiReference(spec: Json): ApiGroup[] {
  const paths = spec.paths as Record<string, Json>;
  const operations: ApiOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const shared = ((item.parameters as unknown[]) ?? []).map((p) => resolve(spec, p) as Json);
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const own = ((op.parameters as unknown[]) ?? []).map((p) => resolve(spec, p) as Json);
      const byKey = new Map<string, Json>();
      for (const param of [...shared, ...own]) byKey.set(`${param.in}:${param.name}`, param);

      const params: ApiField[] = [...byKey.values()].map((param) => ({
        name: String(param.name),
        location: String(param.in),
        type: typeLabel(spec, param.schema as SchemaLike),
        required: param.required === true,
        description: String(param.description ?? ""),
      }));

      const body = resolve(spec, op.requestBody as Json | undefined);
      const bodyContent = body?.content as Json | undefined;
      const bodyContentType = bodyContent ? (Object.keys(bodyContent)[0] ?? null) : null;
      const bodySchema = flatten(spec, jsonSchemaOf(bodyContent));
      const bodyRequired = new Set(bodySchema.required ?? []);
      for (const [name, schema] of Object.entries(bodySchema.properties ?? {})) {
        params.push({
          name,
          location: "body",
          type: typeLabel(spec, schema),
          required: bodyRequired.has(name),
          description: resolve(spec, schema).description ?? schema.description ?? "",
        });
      }

      const security = op.security as { bearerAuth?: string[] }[] | undefined;
      const isPublic = Array.isArray(security) && security.length === 0;
      const scopes = isPublic ? [] : (security ?? []).flatMap((entry) => entry.bearerAuth ?? []);

      const responses = Object.entries((op.responses as Json) ?? {}).map(([status, raw]) => {
        const response = resolve(spec, raw as Json);
        const ok = status.startsWith("2");
        return {
          status,
          description: String(response.description ?? ""),
          fields: ok ? topLevelFields(spec, jsonSchemaOf(response.content)) : [],
        };
      });

      operations.push({
        id: String(op.operationId ?? `${method}-${path}`),
        method: method.toUpperCase(),
        path,
        summary: String(op.summary ?? ""),
        description: String(op.description ?? ""),
        scopes,
        isPublic,
        params,
        bodyContentType,
        responses,
      });
    }
  }

  const groups: ApiGroup[] = GROUPS.map(({ id, title }) => ({ id, title, operations: [] }));
  const other: ApiGroup = { id: "other", title: "Other", operations: [] };
  for (const operation of operations) {
    const index = GROUPS.findIndex((group) => group.match(operation.path));
    (index >= 0 ? groups[index] : other).operations.push(operation);
  }
  return [...groups, other].filter((group) => group.operations.length > 0);
}
