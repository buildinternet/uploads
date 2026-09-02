import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBilling } from "./api-client";
import {
  loadBillingPageData,
  planCardLimitRows,
  planCardPriceLine,
  planLabel,
  renderFileLimitsText,
  renderPlanBlurbText,
  renderPlanCardBodyHtml,
  renderPlanCardPlaceholderHtml,
  renderPlanCardsGridHtml,
} from "./billing-ui";

function makeBilling(overrides: Partial<WorkspaceBilling> = {}): WorkspaceBilling {
  return {
    workspace: "acme",
    organization: { id: "org_1", slug: "acme", name: "Acme" },
    plan: "free",
    available: true,
    planApplied: true,
    limits: {
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 25_000_000,
    },
    usage: null,
    planSource: "none",
    subscription: null,
    ...overrides,
  };
}

describe("loadBillingPageData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null billing/proPrice without attempting a fetch when there is no cookie", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadBillingPageData("https://api.uploads.sh", "https://auth.uploads.sh", "acme", ""),
    ).resolves.toEqual({ billing: null, proPrice: null });
    await expect(
      loadBillingPageData("https://api.uploads.sh", "https://auth.uploads.sh", "acme", "   "),
    ).resolves.toEqual({ billing: null, proPrice: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches billing and the pro price together when a cookie is present", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/billing/prices")) {
        return Response.json({
          prices: { pro: { unitAmount: 1000, currency: "usd", interval: "month" } },
        });
      }
      return Response.json({
        workspace: "acme",
        organization: { id: "org_1", slug: "acme", name: "Acme" },
        plan: "pro",
        available: true,
        planApplied: true,
        limits: {},
        usage: null,
        planSource: "stripe",
        subscription: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadBillingPageData(
      "https://api.uploads.sh",
      "https://auth.uploads.sh",
      "acme",
      "better-auth.session=abc",
    );
    expect(result.billing?.plan).toBe("pro");
    expect(result.proPrice).toEqual({ unitAmount: 1000, currency: "usd", interval: "month" });
  });

  it("returns null billing (but keeps the price fetch) when the billing fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/billing/prices")) {
          return Response.json({ prices: { pro: null } });
        }
        return new Response("nope", { status: 500 });
      }),
    );

    const result = await loadBillingPageData(
      "https://api.uploads.sh",
      "https://auth.uploads.sh",
      "acme",
      "better-auth.session=abc",
    );
    expect(result.billing).toBeNull();
    expect(result.proPrice).toBeNull();
  });

  it("passes the given authFetchImpl through to the price fetch only (#731 phase B)", async () => {
    const globalFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workspace: "acme",
            organization: { id: "org_1", slug: "acme", name: "Acme" },
            plan: "free",
            available: true,
            planApplied: true,
            limits: {},
            usage: null,
            planSource: "none",
            subscription: null,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", globalFetch);
    const authFetchImpl = vi.fn(async () =>
      Response.json({ prices: { pro: { unitAmount: 1000, currency: "usd", interval: "month" } } }),
    );

    const result = await loadBillingPageData(
      "https://api.uploads.sh",
      "",
      "acme",
      "better-auth.session=abc",
      undefined,
      authFetchImpl,
    );

    expect(authFetchImpl).toHaveBeenCalledWith("/billing/prices", expect.anything());
    expect(result.proPrice).toEqual({ unitAmount: 1000, currency: "usd", interval: "month" });
    // getWorkspaceBilling still goes through global fetch, not authFetchImpl.
    expect(globalFetch).toHaveBeenCalled();
  });
});

describe("planLabel", () => {
  it("capitalizes the plan id", () => {
    expect(planLabel("free")).toBe("Free");
    expect(planLabel("pro")).toBe("Pro");
  });
});

describe("renderFileLimitsText", () => {
  it("renders both caps when the video ceiling differs from the upload ceiling", () => {
    expect(
      renderFileLimitsText({
        maxStorageBytes: null,
        maxUploadsPerPeriod: null,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      }),
    ).toBe("Max upload size: files up to 25 MB, videos up to 8 MB.");
  });

  it("omits the video line when it equals the upload ceiling", () => {
    expect(
      renderFileLimitsText({
        maxStorageBytes: null,
        maxUploadsPerPeriod: null,
        maxUploadBytes: 100_000_000,
        maxVideoUploadBytes: 100_000_000,
      }),
    ).toBe("Max upload size: files up to 100 MB.");
  });

  it("returns an empty string when both caps are null", () => {
    expect(
      renderFileLimitsText({
        maxStorageBytes: null,
        maxUploadsPerPeriod: null,
        maxUploadBytes: null,
        maxVideoUploadBytes: null,
      }),
    ).toBe("");
  });
});

describe("renderPlanBlurbText", () => {
  it("reports unapplied plans honestly rather than free-tier marketing copy", () => {
    expect(renderPlanBlurbText(makeBilling({ planApplied: false }), false)).toBe(
      "Your current limits are shown below.",
    );
  });

  it("flags an applied-but-unavailable plan", () => {
    expect(renderPlanBlurbText(makeBilling({ planApplied: true, available: false }), false)).toBe(
      "This plan isn’t available for self-serve upgrade yet.",
    );
  });

  it("states the plan is active when there is no subscription status line", () => {
    expect(renderPlanBlurbText(makeBilling({ planApplied: true, available: true }), false)).toBe(
      "This plan is active on your workspace.",
    );
  });

  it("stays empty when the subscription status line will already say so", () => {
    expect(renderPlanBlurbText(makeBilling({ planApplied: true, available: true }), true)).toBe("");
  });
});

describe("renderPlanCardPlaceholderHtml", () => {
  it("renders skeleton bars for all four fields with the same ids the real render uses", () => {
    const html = renderPlanCardPlaceholderHtml();
    expect(html).toContain('id="ws-plan-name"');
    expect(html).toContain('id="ws-plan-blurb"');
    expect(html).toContain('id="ws-plan-file-limits"');
    expect(html).toContain('id="ws-subscription-status" role="status" hidden');
    expect(html).toContain("ws-skel");
  });
});

describe("renderPlanCardBodyHtml", () => {
  it("renders the plan name, blurb, and file limits for a free workspace", () => {
    const html = renderPlanCardBodyHtml(makeBilling(), null);
    expect(html).toContain('<strong id="ws-plan-name">Free plan</strong>');
    expect(html).toContain("This plan is active on your workspace.");
    expect(html).toContain("Max upload size: files up to 25 MB.");
    expect(html).toContain('id="ws-subscription-status" hidden');
  });

  it("hides the blurb paragraph when the blurb text is empty", () => {
    const html = renderPlanCardBodyHtml(
      makeBilling({
        plan: "pro",
        planSource: "admin",
      }),
      null,
    );
    expect(html).toContain('id="ws-plan-blurb" hidden');
  });

  it("renders an alert-toned subscription status line with data-state", () => {
    const html = renderPlanCardBodyHtml(
      makeBilling({
        plan: "pro",
        planSource: "stripe",
        subscription: { status: "past_due", periodEnd: null, cancelAtPeriodEnd: false },
      }),
      null,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-state="error"');
    expect(html).toContain("Payment past due");
  });

  it("renders a muted renewing status line with the live price appended", () => {
    const html = renderPlanCardBodyHtml(
      makeBilling({
        plan: "pro",
        planSource: "stripe",
        subscription: {
          status: "active",
          periodEnd: "2026-09-01T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
      }),
      "$10 per month",
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain("data-state");
    expect(html).toContain("Renews on September 1, 2026 · $10 per month");
  });

  it("escapes plan/limit text", () => {
    const html = renderPlanCardBodyHtml(makeBilling({ plan: "<b>evil</b>" }), null);
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
  });
});

describe("planCardLimitRows / planCardPriceLine", () => {
  it("marks free's member cap and omits pro's (unmarketed abuse guard)", () => {
    const free = {
      id: "free" as const,
      name: "Free",
      blurb: "",
      available: true,
      marketsMemberCap: true,
      byoBucket: true,
      defaultLimits: { maxStorageBytes: 250_000_000, maxUploadBytes: 25_000_000, maxMembers: 3 },
    };
    const pro = {
      id: "pro" as const,
      name: "Pro",
      blurb: "",
      available: true,
      marketsMemberCap: false,
      byoBucket: true,
      defaultLimits: {
        maxStorageBytes: 10_000_000_000,
        maxUploadBytes: 100_000_000,
        maxMembers: 25,
      },
    };
    expect(planCardLimitRows(free)).toContain("3 members");
    expect(planCardLimitRows(pro)).toContain("Unlimited members");
    expect(planCardPriceLine(free, "$10 per month")).toBe("$0");
    expect(planCardPriceLine(pro, "$10 per month")).toBe("$10 per month");
    expect(planCardPriceLine(pro, null)).toBe("");
  });
});

describe("renderPlanCardsGridHtml", () => {
  it("badges the current plan and offers an upgrade CTA on the pro card for a free workspace", () => {
    const html = renderPlanCardsGridHtml(makeBilling({ plan: "free", planSource: "none" }), null);
    expect(html).toContain('data-plan="free"');
    expect(html).toContain("plan-card__badge");
    expect(html).toContain('data-cta="upgrade" data-plan="pro"');
  });

  it("renders no footer CTA on the current (pro) card when a Stripe subscription backs it", () => {
    const html = renderPlanCardsGridHtml(
      makeBilling({ plan: "pro", planSource: "stripe" }),
      "$10 per month",
    );
    const proCard = html.slice(html.indexOf('data-plan="pro"'));
    expect(proCard).toContain("plan-card__badge");
    expect(proCard).not.toContain("data-cta=");
  });
});
