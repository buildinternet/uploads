import { describe, expect, it, vi } from "vitest";
import { listR2Buckets, parseListBucketsXml } from "./r2-list-buckets";

const CREDS = {
  accountId: "a".repeat(32),
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t",
};

const LIST_BUCKETS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>abc</ID><DisplayName>abc</DisplayName></Owner>
  <Buckets>
    <Bucket><Name>my-bucket</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>
    <Bucket><Name>other-bucket</Name><CreationDate>2026-01-02T00:00:00.000Z</CreationDate></Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;

describe("parseListBucketsXml", () => {
  it("extracts bucket names from a real-shaped ListBuckets response", () => {
    expect(parseListBucketsXml(LIST_BUCKETS_XML)).toEqual(["my-bucket", "other-bucket"]);
  });

  it("returns an empty list for an account with no buckets", () => {
    const xml = `<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`;
    expect(parseListBucketsXml(xml)).toEqual([]);
  });

  it("decodes XML entities in bucket names", () => {
    const xml = `<Buckets><Bucket><Name>a&amp;b</Name></Bucket></Buckets>`;
    expect(parseListBucketsXml(xml)).toEqual(["a&b"]);
  });
});

describe("listR2Buckets", () => {
  it("returns the bucket list on a 200 from the default endpoint", async () => {
    const fetchImpl = vi.fn(async (req: Request) => {
      expect(req.url).toBe(`https://${CREDS.accountId}.r2.cloudflarestorage.com/`);
      return new Response(LIST_BUCKETS_XML, { status: 200 });
    });
    const result = await listR2Buckets(CREDS, { fetch: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({
      ok: true,
      buckets: ["my-bucket", "other-bucket"],
      jurisdiction: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses the given jurisdiction's endpoint without probing when one is supplied", async () => {
    const fetchImpl = vi.fn(async (req: Request) => {
      expect(req.url).toBe(`https://${CREDS.accountId}.eu.r2.cloudflarestorage.com/`);
      return new Response(LIST_BUCKETS_XML, { status: 200 });
    });
    const result = await listR2Buckets(
      { ...CREDS, jurisdiction: "eu" },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("probes default, then eu, then fedramp, and records whichever answers", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      seen.push(req.url);
      if (req.url.includes(".fedramp.")) return new Response(LIST_BUCKETS_XML, { status: 200 });
      return new Response("", { status: 400 });
    });
    const result = await listR2Buckets(CREDS, { fetch: fetchImpl as unknown as typeof fetch });
    expect(seen).toEqual([
      `https://${CREDS.accountId}.r2.cloudflarestorage.com/`,
      `https://${CREDS.accountId}.eu.r2.cloudflarestorage.com/`,
      `https://${CREDS.accountId}.fedramp.r2.cloudflarestorage.com/`,
    ]);
    expect(result).toMatchObject({ ok: true, jurisdiction: "fedramp" });
  });

  it("returns a distinguishable access_denied shape on a 403, so the UI can fall back to a plain bucket field", async () => {
    const fetchImpl = vi.fn(async () => new Response("<Error/>", { status: 403 }));
    const result = await listR2Buckets(CREDS, { fetch: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, reason: "access_denied" });
  });

  it("treats a 403 at every jurisdiction as access_denied rather than a generic error", async () => {
    const fetchImpl = vi.fn(async () => new Response("<Error/>", { status: 403 }));
    const result = await listR2Buckets(CREDS, { fetch: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, reason: "access_denied" });
  });

  it("reports a non-403, non-200 status as a generic error", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const result = await listR2Buckets(CREDS, { fetch: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: expect.stringContaining("500"),
    });
  });

  it("rejects a malformed account id before any request is made", async () => {
    const fetchImpl = vi.fn();
    const result = await listR2Buckets(
      { ...CREDS, accountId: "not-hex" },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: expect.stringContaining("accountId"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid jurisdiction before any request is made", async () => {
    const fetchImpl = vi.fn();
    const result = await listR2Buckets(
      { ...CREDS, jurisdiction: "us" },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: expect.stringContaining("jurisdiction"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never echoes credential values in any result", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const result = await listR2Buckets(CREDS, { fetch: fetchImpl as unknown as typeof fetch });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CREDS.secretAccessKey);
    expect(serialized).not.toContain(CREDS.accessKeyId);
  });
});
