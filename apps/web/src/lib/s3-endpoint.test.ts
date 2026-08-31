import { describe, expect, it } from "vitest";
import { parseS3Endpoint } from "./s3-endpoint";

describe("parseS3Endpoint", () => {
  it("parses the plain AWS endpoint into a region, no bucket", () => {
    expect(parseS3Endpoint("https://s3.us-east-1.amazonaws.com")).toEqual({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: undefined,
    });
  });

  it("parses a virtual-hosted-style AWS endpoint into bucket + region + canonical endpoint", () => {
    expect(parseS3Endpoint("https://my-bucket.s3.eu-west-2.amazonaws.com")).toEqual({
      endpoint: "https://s3.eu-west-2.amazonaws.com",
      region: "eu-west-2",
      bucket: "my-bucket",
    });
  });

  it("assumes https for a bare host with no scheme", () => {
    expect(parseS3Endpoint("s3.us-east-1.amazonaws.com")).toEqual({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: undefined,
    });
  });

  it("returns endpoint only (no region) for a non-AWS host", () => {
    expect(parseS3Endpoint("https://minio.example.com")).toEqual({
      endpoint: "https://minio.example.com",
      region: undefined,
      bucket: undefined,
    });
  });

  it("keeps the port for a non-AWS host that specifies one", () => {
    expect(parseS3Endpoint("https://minio.example.com:9000")).toEqual({
      endpoint: "https://minio.example.com:9000",
      region: undefined,
      bucket: undefined,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseS3Endpoint("  https://s3.us-east-1.amazonaws.com  ")).toEqual({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: undefined,
    });
  });

  it("returns null for junk input", () => {
    expect(parseS3Endpoint("not a url")).toBeNull();
  });

  it("returns null for empty/whitespace-only input", () => {
    expect(parseS3Endpoint("   ")).toBeNull();
  });

  it("returns null for an http (non-https) endpoint", () => {
    expect(parseS3Endpoint("http://minio.example.com")).toBeNull();
  });

  it("drops a trailing slash on a non-AWS endpoint", () => {
    expect(parseS3Endpoint("https://minio.example.com/")).toEqual({
      endpoint: "https://minio.example.com",
      region: undefined,
      bucket: undefined,
    });
  });
});
