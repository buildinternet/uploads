import { describe, expect, it } from "vitest";
import {
  hostedActiveContentDetail,
  renderHostedActiveContentStatusHtml,
} from "./storage-settings-ui";

describe("hostedActiveContentDetail", () => {
  it("puts the verification timestamp in the detail, not a heading sentence", () => {
    expect(hostedActiveContentDetail("9/15/2026, 2:01:13 AM")).toBe(
      "SVG and XML verified 9/15/2026, 2:01:13 AM. " +
        "Hosted storage serves them behind a sandboxing Content-Security-Policy.",
    );
  });

  it("phrases a known closed-gate reason", () => {
    expect(hostedActiveContentDetail(undefined, "this host hasn't passed the check")).toBe(
      "SVG and XML not verified — this host hasn't passed the check.",
    );
  });

  it("falls back when no stamp and no reason", () => {
    expect(hostedActiveContentDetail(undefined)).toBe("SVG and XML not verified.");
  });
});

describe("renderHostedActiveContentStatusHtml", () => {
  it("renders a quiet ok icon whose tooltip carries the timestamp", () => {
    const detail = hostedActiveContentDetail("9/15/2026, 2:01:13 AM");
    const html = renderHostedActiveContentStatusHtml({ ok: true, detail });
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("9/15/2026, 2:01:13 AM");
    expect(html).not.toContain("SVG &amp; XML");
    expect(html).not.toMatch(/Verified 9\/15/);
  });

  it("renders a warn icon and escapes the detail", () => {
    const html = renderHostedActiveContentStatusHtml({
      ok: false,
      detail: 'not verified — <script>alert("x")</script>',
    });
    expect(html).toContain('data-state="warn"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
