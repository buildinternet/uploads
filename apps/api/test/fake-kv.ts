/** In-process KV fake: get/put with recorded TTLs. Mirrors the repo's fake-r2 pattern. */
export class FakeKv {
  store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, expirationTtl: opts?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
