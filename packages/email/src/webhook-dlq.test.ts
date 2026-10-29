import { describe, expect, it } from "vitest";
import { renderWebhookDlqAlertEmail } from "./webhook-dlq";

describe("renderWebhookDlqAlertEmail", () => {
  const event = {
    keys: ["ghref:acme/app#7"],
    deliveryId: "delivery-1",
    ingest: { repo: "acme/app", kind: "pull", num: 7, source: "body" },
  };

  it("includes the compact event JSON and the replay command", () => {
    const email = renderWebhookDlqAlertEmail({ events: [event] });
    expect(email.subject).toBe("[webhook] 1 GitHub event dead-lettered");
    expect(email.text).toContain("1 GitHub webhook event was dead-lettered.");
    expect(email.text).toContain("delivery-1");
    expect(email.text).toContain(
      "node --env-file=.env apps/api/scripts/replay-github-webhook-dlq.mjs events.json",
    );
    expect(email.text).toContain(JSON.stringify([event], null, 2));
    expect(email.html).toContain("delivery-1");
  });

  it("pluralizes a batch", () => {
    const email = renderWebhookDlqAlertEmail({ events: [event, { keys: [] }] });
    expect(email.subject).toBe("[webhook] 2 GitHub events dead-lettered");
    expect(email.text).toContain("2 GitHub webhook events were dead-lettered.");
  });
});
