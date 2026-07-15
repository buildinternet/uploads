import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentFromText,
  buildReportPayload,
  loadReportAttachment,
  MAX_REPORT_ATTACHMENT_BYTES,
  parseReportType,
  submitReport,
  validateReportMessage,
} from "../src/report.js";

process.env.UPLOADS_TELEMETRY_TEST = "1";

describe("validateReportMessage / parseReportType", () => {
  it("enforces length bounds", () => {
    expect(validateReportMessage("hi").ok).toBe(false);
    expect(validateReportMessage("this is fine").ok).toBe(true);
    expect(validateReportMessage("x".repeat(4001)).ok).toBe(false);
  });

  it("parses types", () => {
    expect(parseReportType("bug")).toBe("bug");
    expect(parseReportType("nope")).toBeUndefined();
  });
});

describe("attachments", () => {
  it("loads a text file", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-report-"));
    const path = join(dir, "trace.log");
    writeFileSync(path, "line1\nline2\n");
    const att = loadReportAttachment(path);
    expect(att.filename).toBe("trace.log");
    expect(att.body).toContain("line1");
    expect(att.contentType).toMatch(/text\/plain/);
  });

  it("rejects oversized in-memory attachments", () => {
    expect(() => attachmentFromText("x".repeat(MAX_REPORT_ATTACHMENT_BYTES + 1))).toThrow(
      /exceeds/,
    );
  });
});

describe("buildReportPayload / submitReport", () => {
  const prevDisabled = process.env.UPLOADS_TELEMETRY_DISABLED;
  const prevDnt = process.env.DO_NOT_TRACK;

  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.UPLOADS_TELEMETRY_DISABLED;
    else process.env.UPLOADS_TELEMETRY_DISABLED = prevDisabled;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
  });

  it("omits anonId when telemetry is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-report-"));
    process.env.UPLOADS_TELEMETRY_DISABLED = "1";
    delete process.env.DO_NOT_TRACK;
    const payload = buildReportPayload(
      "something broke during put",
      { type: "error", command: "put", errorCode: "KEY_POLICY" },
      { dataDir: dir, version: "0.10.0" },
    );
    expect(payload.anonId).toBeUndefined();
    expect(payload.command).toBe("put");
    expect(payload.errorCode).toBe("KEY_POLICY");
    expect(payload.cliVersion).toBe("0.10.0");
  });

  it("POSTs payload and returns id", async () => {
    const result = await submitReport(
      buildReportPayload("something broke during put", { type: "bug" }, { version: "0.10.0" }),
      {
        apiUrl: "https://api.example.test",
        fetchImpl: async (input, init) => {
          expect(String(input)).toBe("https://api.example.test/v1/reports");
          const body = JSON.parse(String(init?.body)) as { message: string; type: string };
          expect(body.message).toMatch(/broke/);
          expect(body.type).toBe("bug");
          return new Response(JSON.stringify({ ok: true, id: "rpt_abc", hasAttachment: false }), {
            status: 202,
          });
        },
      },
    );
    expect(result).toEqual({ ok: true, id: "rpt_abc", hasAttachment: false });
  });
});
