/**
 * `/v1/:workspace/github/health` — GitHub App configuration + webhook event
 * subscription check (issue #293 follow-up). Doctor-style diagnostic: the
 * App can have a green ping (URL + secret configured, `installation` events
 * flowing) while `issues`/`pull_request` are unticked under Settings →
 * Permissions & events → Subscribe to events, which silently disables
 * webhook auto-promotion and title-cache invalidation with no error anyone
 * sees. This surfaces that gap instead of requiring someone to notice via
 * `GET /app/hook/deliveries`.
 *
 * `issue_comment` is tracked separately as a recommended (non-gating) tier
 * (issue #333) — missing it never flips `ok` to false, it only surfaces a
 * hint that bot-comment self-healing isn't enabled.
 */
import { Hono } from "hono";
import {
  appEventSubscriptions,
  githubAppConfig,
  RECOMMENDED_WEBHOOK_EVENTS,
  REQUIRED_WEBHOOK_EVENTS,
} from "../github-app";
import { requireScope, type WorkspaceVars } from "../workspace";

export interface GithubHealthResult {
  /** false when GITHUB_APP_ID/PRIVATE_KEY/HOME_INSTALLATION_ID aren't all set — the whole integration is off. */
  configured: boolean;
  /** true only when configured AND every required event is subscribed. Missing recommended events never affect this. */
  ok: boolean;
  /** The App's subscribed webhook events from `GET /app`, or null if that call failed/is unknown. */
  events: string[] | null;
  /** Events uploads.sh's webhook handler needs but the App isn't subscribed to. Empty when ok. */
  missingEvents: string[];
  requiredEvents: readonly string[];
  /** Events that improve behavior but aren't required — e.g. `issue_comment` for bot-comment self-healing. */
  recommendedEvents: readonly string[];
  /** Recommended events the App isn't subscribed to. Never gates `ok`. */
  missingRecommendedEvents: string[];
  hint?: string;
}

export const githubHealth = new Hono<WorkspaceVars>().get(
  "/health",
  requireScope("files:read"),
  async (c) => {
    const cfg = githubAppConfig(c.env);
    if (!cfg) {
      return c.json<GithubHealthResult>({
        configured: false,
        ok: false,
        events: null,
        missingEvents: [...REQUIRED_WEBHOOK_EVENTS],
        requiredEvents: REQUIRED_WEBHOOK_EVENTS,
        recommendedEvents: RECOMMENDED_WEBHOOK_EVENTS,
        missingRecommendedEvents: [...RECOMMENDED_WEBHOOK_EVENTS],
        hint: "GitHub App is not configured on this worker (GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_HOME_INSTALLATION_ID)",
      });
    }

    const events = await appEventSubscriptions(cfg);
    if (events === null) {
      return c.json<GithubHealthResult>({
        configured: true,
        ok: false,
        events: null,
        missingEvents: [...REQUIRED_WEBHOOK_EVENTS],
        requiredEvents: REQUIRED_WEBHOOK_EVENTS,
        recommendedEvents: RECOMMENDED_WEBHOOK_EVENTS,
        missingRecommendedEvents: [...RECOMMENDED_WEBHOOK_EVENTS],
        hint: "could not reach GET /app to read subscribed webhook events — try again shortly",
      });
    }

    const missingEvents = REQUIRED_WEBHOOK_EVENTS.filter((e) => !events.includes(e));
    const missingRecommendedEvents = RECOMMENDED_WEBHOOK_EVENTS.filter((e) => !events.includes(e));
    return c.json<GithubHealthResult>({
      configured: true,
      ok: missingEvents.length === 0,
      events,
      missingEvents,
      requiredEvents: REQUIRED_WEBHOOK_EVENTS,
      recommendedEvents: RECOMMENDED_WEBHOOK_EVENTS,
      missingRecommendedEvents,
      hint:
        missingEvents.length > 0
          ? `subscribe to ${missingEvents.join(", ")} at github.com/settings/apps/<your-app> → Permissions & events → Subscribe to events`
          : undefined,
    });
  },
);
