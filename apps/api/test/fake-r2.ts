/**
 * Minimal in-memory R2 binding stand-in for the route tests — just the surface
 * the files-sdk r2 adapter touches. A local copy (rather than importing the
 * storage package's fixture) keeps it inside the API's DOM-free lib, where
 * `BlobPart` and friends don't exist. `store` exposes the raw written keys.
 */
interface StoredObject {
  data: Uint8Array;
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
  /** R2 "uploaded" / last-modified; tests can backdate for retention. */
  uploaded?: Date;
}

export class FakeR2Bucket {
  store = new Map<string, StoredObject>();

  private meta(key: string, obj: StoredObject) {
    return {
      key,
      size: obj.data.byteLength,
      etag: "fake-etag",
      httpEtag: '"fake-etag"',
      uploaded: obj.uploaded ?? new Date(),
      version: "1",
      storageClass: "Standard",
      checksums: {},
      httpMetadata: { contentType: obj.contentType, cacheControl: obj.cacheControl },
      customMetadata: { ...obj.customMetadata },
      writeHttpMetadata() {},
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array> | null,
    opts?: {
      httpMetadata?: { contentType?: string; cacheControl?: string } | Headers;
      customMetadata?: Record<string, string>;
    },
  ) {
    let data: Uint8Array;
    if (typeof value === "string") data = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) data = new Uint8Array(value);
    else if (value && ArrayBuffer.isView(value))
      data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else data = new Uint8Array(0);

    const httpMetadata = opts?.httpMetadata;
    const contentType =
      httpMetadata instanceof Headers
        ? (httpMetadata.get("content-type") ?? undefined)
        : httpMetadata?.contentType;
    const cacheControl =
      httpMetadata instanceof Headers
        ? (httpMetadata.get("cache-control") ?? undefined)
        : httpMetadata?.cacheControl;
    const obj: StoredObject = {
      data,
      contentType,
      cacheControl,
      customMetadata: opts?.customMetadata ? { ...opts.customMetadata } : undefined,
      uploaded: new Date(),
    };
    this.store.set(key, obj);
    return this.meta(key, obj);
  }

  /** Test helper: set last-modified for retention purge scenarios. */
  setUploaded(key: string, uploaded: Date) {
    const obj = this.store.get(key);
    if (obj) obj.uploaded = uploaded;
  }

  async get(key: string) {
    const obj = this.store.get(key);
    if (!obj) return null;
    const data = obj.data;
    return {
      ...this.meta(key, obj),
      bodyUsed: false,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
      async bytes() {
        return data;
      },
      async text() {
        return new TextDecoder().decode(data);
      },
    };
  }

  async head(key: string) {
    const obj = this.store.get(key);
    return obj ? this.meta(key, obj) : null;
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list(opts?: { prefix?: string }) {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    return {
      objects: keys.map((k) => this.meta(k, this.store.get(k)!)),
      truncated: false as const,
      delimitedPrefixes: [] as string[],
    };
  }
}
