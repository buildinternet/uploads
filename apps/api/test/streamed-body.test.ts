import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openStreamedBody, STREAM_HEAD_BYTES } from "../src/streamed-body";

function chunked(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, (offset += chunkSize)));
    },
  });
}

function sample(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31) % 251);
}

const read = (stream: ReadableStream<Uint8Array>) =>
  new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));

describe("openStreamedBody", () => {
  it("peeks the head and passes the whole body through with its hash", async () => {
    const bytes = sample(STREAM_HEAD_BYTES * 3 + 7);
    const opened = await openStreamedBody({
      stream: chunked(bytes, 5000),
      size: bytes.byteLength,
    });
    expect(opened.head).toEqual(bytes.subarray(0, STREAM_HEAD_BYTES));
    expect(await read(opened.stream)).toEqual(bytes);
    expect(opened.sha256()).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("handles a body shorter than the head", async () => {
    const bytes = sample(100);
    const opened = await openStreamedBody({ stream: chunked(bytes, 30), size: 100 });
    expect(opened.head).toEqual(bytes);
    expect(await read(opened.stream)).toEqual(bytes);
  });

  it("errors when the body is shorter or longer than its declared size", async () => {
    const bytes = sample(STREAM_HEAD_BYTES * 2);
    const short = await openStreamedBody({
      stream: chunked(bytes, 4096),
      size: bytes.byteLength + 1,
    });
    await expect(read(short.stream)).rejects.toThrow(/Content-Length/);
    const long = await openStreamedBody({
      stream: chunked(bytes, 4096),
      size: bytes.byteLength - 1,
    });
    await expect(read(long.stream)).rejects.toThrow(/Content-Length/);
  });
});
