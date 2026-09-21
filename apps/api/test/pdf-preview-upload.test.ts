import { describe, expect, it } from "vitest";
import { getMetadataForKeys } from "../src/file-metadata";
import { putObject } from "../src/files-core";
import { installPdfPreviewRenderer } from "../src/pdf-preview";
import { posterKeyFor } from "../src/poster";
import { objectVisibility } from "../src/visibility";
import { PDF } from "./helpers/media-fixtures";
import { pdfWithText } from "./pdf-fixture";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";

installPdfPreviewRenderer();

describe("PDF preview on upload", () => {
  it("stores a first-page JPEG and stamps pdf.poster", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const body = pdfWithText("Quarterly report");
    const result = await putObject(env, ws, "docs/report.pdf", body, WORKSPACE);
    const posterKey = posterKeyFor(result.key);
    const stored = bucket.store.get(`default/${posterKey}`);
    expect(stored?.contentType).toBe("image/jpeg");
    expect(stored?.data[0]).toBe(0xff);
    const meta = (await getMetadataForKeys(env.DB, WORKSPACE, [result.key])).get(result.key);
    expect(meta?.["pdf.poster"]).toBe("1");
    expect(meta?.["pdf.pages"]).toBe("1");
    expect(meta?.["video.poster"]).toBeUndefined();
  });

  it("counts preview bytes in the usage ledger", async () => {
    const { env, db, ws } = makePosterEnv();
    const body = pdfWithText("Ledger");
    await putObject(env, ws, "docs/report.pdf", body, WORKSPACE);
    const posterKey = posterKeyFor("docs/report.pdf");
    const usage = db.usage.get(WORKSPACE);
    const poster = (await getMetadataForKeys(env.DB, WORKSPACE, ["docs/report.pdf"])).get(
      "docs/report.pdf",
    );
    expect(poster?.["pdf.poster"]).toBe("1");
    expect(usage?.objects).toBe(2);
    expect(usage?.bytes).toBeGreaterThan(body.byteLength);
    expect(posterKey.endsWith(".pdf.jpg")).toBe(true);
  });

  it("inherits private visibility onto the preview", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const result = await putObject(env, ws, "docs/report.pdf", pdfWithText("Secret"), WORKSPACE, {
      visibility: "private",
    });
    const stored = bucket.store.get(`default/${posterKeyFor(result.key)}`);
    expect(objectVisibility(stored?.customMetadata)).toBe("private");
  });

  it("is a no-op when the flag is off", async () => {
    const { env, bucket, ws } = makePosterEnv();
    (env as unknown as { FLAGS: { getBooleanValue: () => Promise<boolean> } }).FLAGS = {
      getBooleanValue: async () => false,
    };
    await putObject(env, ws, "docs/report.pdf", pdfWithText("Off"), WORKSPACE);
    const internal = [...bucket.store.keys()].filter((key) => key.includes("_internal/"));
    expect(internal).toHaveLength(0);
  });

  it("is a no-op when the workspace opted out", async () => {
    const { env, bucket, ws } = makePosterEnv();
    await putObject(
      env,
      { ...ws, pdfPosterEnabled: false },
      "docs/report.pdf",
      pdfWithText("No"),
      WORKSPACE,
    );
    const internal = [...bucket.store.keys()].filter((key) => key.includes("_internal/"));
    expect(internal).toHaveLength(0);
  });

  it("skips a malformed PDF and does not throw", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const result = await putObject(env, ws, "docs/broken.pdf", PDF, WORKSPACE);
    expect(result.contentType).toBe("application/pdf");
    expect(bucket.store.has(`default/${posterKeyFor(result.key)}`)).toBe(false);
  });

  it("drops a stale preview when a PDF is replaced by an image", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const put1 = await putObject(env, ws, "docs/report.pdf", pdfWithText("One"), WORKSPACE);
    const posterKey = posterKeyFor(put1.key);
    expect(bucket.store.has(`default/${posterKey}`)).toBe(true);
    await putObject(env, ws, "docs/report.pdf", PNG, WORKSPACE, { replace: true });
    expect(bucket.store.has(`default/${posterKey}`)).toBe(false);
    const meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put1.key])).get(put1.key);
    expect(meta?.["pdf.poster"]).toBeUndefined();
  });

  it("drops a stale preview when a replacement PDF cannot be rasterized", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const put1 = await putObject(env, ws, "docs/report.pdf", pdfWithText("One"), WORKSPACE);
    expect(bucket.store.has(`default/${posterKeyFor(put1.key)}`)).toBe(true);
    await putObject(env, ws, "docs/report.pdf", PDF, WORKSPACE, { replace: true });
    expect(bucket.store.has(`default/${posterKeyFor(put1.key)}`)).toBe(false);
    const meta = (await getMetadataForKeys(env.DB, WORKSPACE, [put1.key])).get(put1.key);
    expect(meta?.["pdf.poster"]).toBeUndefined();
  });
});
