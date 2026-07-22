/**
 * Minimal stand-in for the `MEDIA` (Media Transformations) binding. Frame
 * extraction has no Miniflare/local simulation — `"remote": true` always
 * proxies to the real service — so tests substitute this instead, mirroring
 * `FakeBrowser` and `FakeR2Bucket`.
 */
export interface FakeMediaCall {
  transform: unknown;
  output: unknown;
}

export class FakeMedia {
  calls: FakeMediaCall[] = [];
  private constructor(private readonly result: () => Promise<Uint8Array>) {}

  input = (_stream: ReadableStream<Uint8Array>) => {
    let transform: unknown;
    const chain = {
      transform: (options: unknown) => {
        transform = options;
        return chain;
      },
      output: (options: unknown) => {
        this.calls.push({ transform, output: options });
        return {
          response: async () => {
            return new Response(await this.result(), {
              headers: { "content-type": "image/jpeg" },
            });
          },
        };
      },
    };
    return chain;
  };

  /** A successful frame extraction returning the given JPEG bytes. */
  static jpeg(bytes: Uint8Array): FakeMedia {
    return new FakeMedia(async () => bytes);
  }

  /** A transform that throws the way the real binding does. */
  static failing(code: string): FakeMedia {
    return new FakeMedia(() => {
      const err = new Error(`media transform failed: ${code}`) as Error & { code: string };
      err.code = code;
      return Promise.reject(err);
    });
  }
}
