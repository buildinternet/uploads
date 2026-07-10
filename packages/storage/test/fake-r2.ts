/**
 * Minimal in-memory stand-in for a Workers R2Bucket binding — just enough
 * surface for the files-sdk r2 adapter's binding-mode I/O. `store` is exposed
 * so tests can assert on the RAW keys actually written to the bucket.
 */
interface StoredObject {
  data: Uint8Array;
  contentType?: string;
}

export class FakeR2Bucket {
  store = new Map<string, StoredObject>();

  private meta(key: string, obj: StoredObject) {
    return {
      key,
      size: obj.data.byteLength,
      etag: "fake-etag",
      httpEtag: '"fake-etag"',
      uploaded: new Date(0),
      version: "1",
      storageClass: "Standard",
      checksums: {},
      httpMetadata: { contentType: obj.contentType },
      customMetadata: {},
      writeHttpMetadata() {},
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array> | null,
    opts?: { httpMetadata?: { contentType?: string } | Headers },
  ) {
    let data: Uint8Array;
    if (typeof value === "string") data = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) data = new Uint8Array(value);
    else if (value && ArrayBuffer.isView(value))
      data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (value) {
      const chunks: Uint8Array[] = [];
      const reader = value.getReader();
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk);
      }
      data = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const c of chunks) {
        data.set(c, offset);
        offset += c.byteLength;
      }
    } else data = new Uint8Array(0);

    const httpMetadata = opts?.httpMetadata;
    const contentType =
      httpMetadata instanceof Headers
        ? (httpMetadata.get("content-type") ?? undefined)
        : httpMetadata?.contentType;
    const obj = { data, contentType };
    this.store.set(key, obj);
    return this.meta(key, obj);
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
      async json() {
        return JSON.parse(new TextDecoder().decode(data));
      },
      async blob() {
        // Cast keeps this typechecking under every consumer's lib config —
        // apps/mcp has no BlobPart (Workers types own globals there).
        return new Blob([data as unknown as ArrayBuffer]);
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

  async list(opts?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }) {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    return {
      objects: keys.map((k) => this.meta(k, this.store.get(k)!)),
      truncated: false as const,
      delimitedPrefixes: [] as string[],
    };
  }
}
