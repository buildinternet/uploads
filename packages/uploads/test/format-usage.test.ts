import { describe, expect, it } from "vitest";
import {
  formatProgressBar,
  formatUsageHuman,
  formatUsageTimestamp,
  isUsageMetered,
  usageLevel,
  usagePct,
} from "../src/format-usage.js";

describe("usagePct / usageLevel", () => {
  it("mirrors web 0–100 one-decimal math", () => {
    expect(usagePct(1_590_024, 2_500_000_000)).toBe(0.1);
    expect(usagePct(78, 10_000)).toBe(0.8);
    expect(usagePct(850, 1000)).toBe(85);
    expect(usagePct(1000, 1000)).toBe(100);
    expect(usagePct(1200, 1000)).toBe(100);
    expect(usagePct(10, undefined)).toBeNull();
    expect(usagePct(10, 0)).toBeNull();
  });

  it("maps high / full thresholds like the web meters", () => {
    expect(usageLevel(0)).toBe("normal");
    expect(usageLevel(84.9)).toBe("normal");
    expect(usageLevel(85)).toBe("high");
    expect(usageLevel(99.9)).toBe("high");
    expect(usageLevel(100)).toBe("full");
  });
});

describe("formatProgressBar", () => {
  it("renders a fixed-width track and percent label", () => {
    expect(formatProgressBar(0, { width: 10 })).toBe("[░░░░░░░░░░]    0%");
    expect(formatProgressBar(50, { width: 10 })).toBe("[█████░░░░░]   50%");
    expect(formatProgressBar(100, { width: 10 })).toBe("[██████████]  100%");
  });

  it("shows at least one fill cell for tiny non-zero usage", () => {
    expect(formatProgressBar(0.1, { width: 20 })).toBe("[█░░░░░░░░░░░░░░░░░░░]  0.1%");
  });
});

describe("formatUsageTimestamp", () => {
  it("formats in the requested zone with a short zone name", () => {
    const s = formatUsageTimestamp("2026-07-15T12:16:51.147Z", "America/New_York");
    expect(s).toMatch(/Jul 15, 2026/);
    expect(s).toMatch(/8:16\s*AM/);
    expect(s).toMatch(/EDT|EST|GMT-4|GMT-5/);
  });

  it("passes through unparseable input", () => {
    expect(formatUsageTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("isUsageMetered", () => {
  it("is true only when a positive cap is present", () => {
    expect(
      isUsageMetered({
        workspace: "w",
        bytes: 1,
        objects: 1,
        uploadsInPeriod: 1,
        periodStart: "2026-07",
        updatedAt: "2026-07-11T00:00:00.000Z",
        maxStorageBytes: 1000,
      }),
    ).toBe(true);
    expect(
      isUsageMetered({
        workspace: "w",
        bytes: 1,
        objects: 1,
        uploadsInPeriod: 1,
        periodStart: "2026-07",
        updatedAt: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("formatUsageHuman", () => {
  it("adds progress bars when limits are set (cloud / capped workspace)", () => {
    const lines = formatUsageHuman(
      {
        workspace: "default",
        bytes: 1_590_024,
        objects: 63,
        uploadsInPeriod: 78,
        periodStart: "2026-07",
        updatedAt: "2026-07-15T12:16:51.147Z",
        maxStorageBytes: 2_500_000_000,
        storageRemainingBytes: 2_498_409_976,
        maxUploadsPerPeriod: 10_000,
        uploadsRemaining: 9_922,
      },
      { timeZone: "America/New_York" },
    );
    expect(lines[0]).toBe("workspace: default");
    expect(lines[1]).toMatch(
      /^storage:   \[█░░░░░░░░░░░░░░░░░░░\]\s+0\.1%\s+1\.5 MB \/ 2\.3 GB \(2\.3 GB free\)$/,
    );
    expect(lines[2]).toBe("objects:   63");
    expect(lines[3]).toMatch(
      /^uploads:   \[█░░░░░░░░░░░░░░░░░░░\]\s+0\.8%\s+78 \/ 10,000 this period \(2026-07\)$/,
    );
    expect(lines[4]).toMatch(/^updated:   Jul 15, 2026, 8:16 AM /);
    expect(lines.some((l) => l.startsWith("note:"))).toBe(false);
  });

  it("meters only the capped dimensions (partial quotas)", () => {
    const lines = formatUsageHuman(
      {
        workspace: "ops",
        bytes: 500,
        objects: 2,
        uploadsInPeriod: 9,
        periodStart: "2026-07",
        updatedAt: "2026-07-11T00:00:00.000Z",
        maxStorageBytes: 1000,
        storageRemainingBytes: 500,
      },
      { timeZone: "UTC" },
    );
    expect(lines.find((l) => l.startsWith("storage:"))).toMatch(/\[/);
    expect(lines.find((l) => l.startsWith("uploads:"))).toBe("uploads:   9 this period (2026-07)");
    expect(lines.some((l) => l.startsWith("note:"))).toBe(false);
  });

  it("omits bars and explains unmetered when no limits (self-host / unlimited)", () => {
    const lines = formatUsageHuman(
      {
        workspace: "test",
        bytes: 10,
        objects: 1,
        uploadsInPeriod: 2,
        periodStart: "2026-07",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      { timeZone: "UTC" },
    );
    expect(lines).toEqual([
      "workspace: test",
      "storage:   10 B",
      "objects:   1",
      "uploads:   2 this period (2026-07)",
      "updated:   Jul 11, 2026, 12:00 AM UTC",
      "note:      unmetered — no storage or upload quotas on this workspace",
    ]);
  });

  it("shows plan on paid workspaces only", () => {
    const pro = formatUsageHuman(
      {
        workspace: "acme",
        bytes: 10,
        objects: 1,
        uploadsInPeriod: 2,
        periodStart: "2026-07",
        updatedAt: "2026-07-11T00:00:00.000Z",
        plan: "pro",
      },
      { timeZone: "UTC" },
    );
    expect(pro[0]).toBe("workspace: acme");
    expect(pro[1]).toBe("plan:      Pro");

    const free = formatUsageHuman(
      {
        workspace: "acme",
        bytes: 10,
        objects: 1,
        uploadsInPeriod: 2,
        periodStart: "2026-07",
        updatedAt: "2026-07-11T00:00:00.000Z",
        plan: "free",
      },
      { timeZone: "UTC" },
    );
    expect(free.some((l) => l.startsWith("plan:"))).toBe(false);
  });
});
