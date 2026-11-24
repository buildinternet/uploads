/**
 * MCP File Uploads extension (`io.modelcontextprotocol/files`, draft) for
 * `put`. A client that supports it fills `put`'s `file` argument with the
 * file's metadata instead of base64, and the file reaches us one of two ways:
 *
 * - Inline: `file.data` carries base64 up to {@link MAX_INLINE_BYTES}, and
 *   `put` treats it like `contentBase64`.
 * - Out of band: `put` answers `resultType: "upload_required"` with a
 *   `PUT /u/<ticket>` URL (the same route as `sign_upload_url`) and a signed
 *   `requestState`. The client uploads the bytes there, which runs the whole
 *   `put` and saves its result under the state's slot in KV. The client then
 *   repeats the call with `requestState`, and `put` returns that result.
 *
 * Spec: https://github.com/modelcontextprotocol/experimental-ext-file-uploads
 */
import { DEFAULT_ALLOWED_CONTENT_TYPES } from "@uploads/api/guards";
import { sha256Hex } from "@uploads/api/workspace";

export const FILES_EXTENSION_ID = "io.modelcontextprotocol/files";

/** Largest total of inline `file.data` per call. Bigger files go out of band. */
export const MAX_INLINE_BYTES = 1024 * 1024;

/** The largest file `put` asks for out of band (Cloudflare's request limit). */
export const FILE_MAX_BYTES = 100_000_000;

/** Server settings for `server/discover`'s `capabilities.extensions`. */
export const FILES_CAPABILITY = { upload: {}, maxInlineBytes: MAX_INLINE_BYTES };

/** `put`'s `file` argument. Only listed for clients that declare the extension. */
export const FILE_INPUT_SCHEMA = {
  type: "object",
  description:
    "A file your client attached (MCP File Uploads extension). The client fills this in; do not build it by hand. Cannot combine with contentBase64, contentUrl, or files. `filename` overrides its name.",
  "x-mcp-file": { accept: [...DEFAULT_ALLOWED_CONTENT_TYPES], maxSize: FILE_MAX_BYTES },
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    name: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer", minimum: 0 },
    digest: {
      type: "object",
      properties: {
        algorithm: { const: "sha-256" },
        value: { type: "string" },
      },
      required: ["algorithm", "value"],
    },
    data: { type: "string" },
  },
  required: ["id", "mimeType", "size"],
};

export interface FileInput {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
  digest?: { algorithm: "sha-256"; value: string };
  data?: string;
}

/** Whether this request's declared capabilities allow an `upload_required` result. */
export function clientCanUpload(clientCapabilities: Record<string, unknown> | undefined): boolean {
  const extensions = clientCapabilities?.extensions as Record<string, unknown> | undefined;
  const files = extensions?.[FILES_EXTENSION_ID] as Record<string, unknown> | undefined;
  return typeof files?.upload === "object" && files.upload !== null;
}

/** Key order doesn't change the digest, so equal arguments always match. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Binds a `requestState` to the exact arguments (and uploader) of its call. */
export function argsDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** KV key (REGISTRY) where the ticketed PUT saves `put`'s result for the retry. */
export function fileSlotKey(workspace: string, slot: string): string {
  return `mcpfile:${workspace}:${slot}`;
}

/** Saved results outlive the state that points at them. */
export const FILE_SLOT_TTL_S = 2 * 60 * 60;

/** Base64url (no padding) SHA-256, the extension's digest encoding. */
export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bodies over this size are tool calls carrying bytes, not a `tools/list`. */
const DECLARATION_SCAN_MAX_BYTES = 64 * 1024;

/**
 * Whether `put` should list its `file` argument for this request: the client
 * declared the extension in `_meta`, or the body is too big to check cheaply
 * (only a tool call with bytes is, and listing it there is harmless).
 */
export async function requestMayUseFiles(request: Request): Promise<boolean> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && !(Number(declared) <= DECLARATION_SCAN_MAX_BYTES)) return true;
  try {
    const text = await request.clone().text();
    if (text.length > DECLARATION_SCAN_MAX_BYTES) return true;
    if (!text.includes(FILES_EXTENSION_ID)) return false;
    const params = (JSON.parse(text) as { params?: { _meta?: Record<string, unknown> } } | null)
      ?.params;
    const capabilities = params?._meta?.["io.modelcontextprotocol/clientCapabilities"] as
      | { extensions?: Record<string, unknown> }
      | undefined;
    return capabilities?.extensions?.[FILES_EXTENSION_ID] !== undefined;
  } catch {
    return false;
  }
}
