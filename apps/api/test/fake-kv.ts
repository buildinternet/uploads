/** In-process KV fake: get/put with recorded TTLs. Mirrors the repo's fake-r2 pattern. */
export class FakeKv {
  store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string, type?: KvReadType): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return wantsJson(type) ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: opts?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

type KvReadType = "text" | "json" | { type?: "text" | "json" } | undefined;

/**
 * True when a KV read asked for parsed JSON, in either of the two shapes
 * Workers KV accepts (`get(key, "json")` and `get(key, { type: "json" })`).
 * A fake that ignores this and always parses is what makes a text read look
 * like an object — see `fakeRegistry` below.
 */
function wantsJson(type: KvReadType): boolean {
  if (typeof type === "string") return type === "json";
  return type?.type === "json";
}

export interface FakeRegistry {
  get: KVNamespace["get"];
  put: KVNamespace["put"];
  delete: KVNamespace["delete"];
  list: KVNamespace["list"];
  /** Raw stored blobs, keyed exactly as written (`ws:<name>`). */
  store: Map<string, string>;
  /** Every `put`, in order — for tests asserting on what was written. */
  puts: [string, string][];
  /** The parsed record stored under `ws:<name>`, or undefined. */
  record<T = Record<string, unknown>>(name: string): T | undefined;
}

/**
 * REGISTRY fake for the workspace-record write path. Unlike the ad-hoc fakes
 * it replaces, it stores serialized strings and honors the read type, because
 * `mutateWorkspaceRecord` (issue #387) verifies a write by reading the key
 * back as text and comparing bytes — against a fake that always returns parsed
 * JSON, every write would look like it lost a race.
 *
 * Seed with plain objects keyed by workspace name; `ws:` is prepended.
 */
export function fakeRegistry(records: Record<string, unknown> = {}): FakeRegistry {
  const store = new Map<string, string>();
  for (const [name, record] of Object.entries(records)) {
    store.set(name.startsWith("ws:") ? name : `ws:${name}`, JSON.stringify(record));
  }
  const puts: [string, string][] = [];

  return {
    store,
    puts,
    record<T = Record<string, unknown>>(name: string): T | undefined {
      const raw = store.get(name.startsWith("ws:") ? name : `ws:${name}`);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    get: (async (key: string, type?: KvReadType) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return wantsJson(type) ? JSON.parse(raw) : raw;
    }) as unknown as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      puts.push([key, value]);
      store.set(key, value);
    }) as unknown as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as unknown as KVNamespace["delete"],
    list: (async (opts?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((key) => !opts?.prefix || key.startsWith(opts.prefix))
        .map((name) => ({ name })),
      list_complete: true as const,
      cacheStatus: null,
    })) as unknown as KVNamespace["list"],
  };
}
