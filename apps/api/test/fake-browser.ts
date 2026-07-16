/**
 * Minimal stand-in for the `BROWSER` (Browser Run) binding. quickAction has no
 * Miniflare/local simulation — `"remote": true` always proxies to the real
 * metered service — so route tests substitute this instead, mirroring how
 * `FakeR2Bucket` fakes R2.
 */
export class FakeBrowser {
  calls: Array<{ action: string; options: unknown }> = [];
  private response: () => Response;

  constructor(response: () => Response) {
    this.response = response;
  }

  async quickAction(action: string, options: unknown): Promise<Response> {
    this.calls.push({ action, options });
    return this.response();
  }

  /** A successful `screenshot` action returning the given PNG bytes. */
  static pngResponse(png: Uint8Array): FakeBrowser {
    return new FakeBrowser(
      () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    );
  }

  /** A Browser Run `BrowserRunErrorResponse` at the given status. */
  static errorResponse(status: number, message = "browser run error"): FakeBrowser {
    return new FakeBrowser(
      () =>
        new Response(JSON.stringify({ success: false, errors: [{ message }] }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
  }
}
