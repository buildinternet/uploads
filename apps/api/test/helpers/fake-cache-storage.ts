/**
 * In-memory stand-in for the Workers `caches` global (Cache API). Node has no
 * `caches`, so code that checks for it falls back to its uncached path unless
 * a test installs this fake. Ignores `Cache-Control`: entries live until the
 * test drops the instance.
 */
interface StoredEntry {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

export class FakeCache {
  readonly entries = new Map<string, StoredEntry>();

  async match(request: Request | string): Promise<Response | undefined> {
    const entry = this.entries.get(typeof request === "string" ? request : request.url);
    if (!entry) return undefined;
    return new Response(entry.body, { status: entry.status, headers: entry.headers });
  }

  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(typeof request === "string" ? request : request.url, {
      status: response.status,
      headers: [...response.headers.entries()],
      body: await response.text(),
    });
  }

  async delete(request: Request | string): Promise<boolean> {
    return this.entries.delete(typeof request === "string" ? request : request.url);
  }
}

export class FakeCacheStorage {
  readonly default = new FakeCache();
  readonly named = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.named.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.named.set(name, cache);
    }
    return cache;
  }

  /** Put this fake on `globalThis.caches`. */
  install(): this {
    Object.defineProperty(globalThis, "caches", { value: this, configurable: true });
    return this;
  }

  /** Remove `globalThis.caches` again. */
  static uninstall(): void {
    Reflect.deleteProperty(globalThis, "caches");
  }
}
