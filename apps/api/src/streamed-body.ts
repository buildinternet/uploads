/**
 * A request body `putObject` writes to storage as it arrives instead of
 * buffering it (signed MCP uploads above the buffer threshold). Workers have
 * 128 MB per isolate, shared across concurrent requests, so a 100 MB video
 * can't sit in memory.
 *
 * What the buffered path reads from the whole body, the streamed path reads
 * from the first {@link STREAM_HEAD_BYTES}: type sniffing and image
 * dimensions. The SHA-256 is computed chunk by chunk while the body streams
 * to storage, so it is only known after the write.
 */
import { createHash } from "node:crypto";
import { ValidationError } from "@uploads/errors";

export interface StreamedBody {
  stream: ReadableStream<Uint8Array>;
  /** Exact byte count (the request's Content-Length). Storage needs it up front. */
  size: number;
}

/** Enough for every magic-number check and most image headers. */
export const STREAM_HEAD_BYTES = 64 * 1024;

/**
 * Reads up to {@link STREAM_HEAD_BYTES} off the front of `body` and returns
 * them along with a stream that writes the whole body (head included) at
 * exactly `size` bytes, hashing it as it goes. `sha256()` is valid once that
 * stream has been fully read.
 */
export async function openStreamedBody(body: StreamedBody): Promise<{
  head: Uint8Array;
  stream: ReadableStream<Uint8Array>;
  sha256: () => string;
}> {
  const reader = body.stream.getReader();
  const buffered: Uint8Array[] = [];
  let headLength = 0;
  let done = false;
  while (headLength < STREAM_HEAD_BYTES) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    buffered.push(next.value);
    headLength += next.value.byteLength;
  }
  const head = concat(buffered).subarray(0, STREAM_HEAD_BYTES);

  const hash = createHash("sha256");
  let seen = 0;
  const mismatch = () =>
    new ValidationError(`The body did not match its Content-Length of ${body.size} bytes.`, {
      code: "length_mismatch",
    });
  const counted = (chunk: Uint8Array, controller: ReadableStreamDefaultController<Uint8Array>) => {
    seen += chunk.byteLength;
    if (seen > body.size) throw mismatch();
    hash.update(chunk);
    controller.enqueue(chunk);
  };
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) counted(chunk, controller);
      buffered.length = 0;
      if (done) finish(controller);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) finish(controller);
      else counted(next.value, controller);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  function finish(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (seen !== body.size) throw mismatch();
    controller.close();
  }

  let digest: string | undefined;
  return {
    head,
    stream: fixedLengthStream(source, body.size),
    sha256: () => (digest ??= hash.digest("hex")),
  };
}

/**
 * R2 only accepts a stream whose length it knows: a request body, or the
 * readable side of a Workers `FixedLengthStream`. Node (tests) has no
 * `FixedLengthStream` and the fake bucket reads any stream.
 */
export function fixedLengthStream(
  stream: ReadableStream<Uint8Array>,
  size: number,
): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream })
    .FixedLengthStream;
  return Fixed ? stream.pipeThrough(new Fixed(size)) : stream;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
