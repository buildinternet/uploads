/** The slices of Slack's Events API payloads this app reads. */

export interface UrlVerificationPayload {
  type: "url_verification";
  challenge: string;
}

export interface EventCallbackPayload<E extends SlackEvent = SlackEvent> {
  type: "event_callback";
  team_id: string;
  api_app_id?: string;
  event_id?: string;
  event: E;
}

export type EventsApiPayload = UrlVerificationPayload | EventCallbackPayload;

export interface SlackEvent {
  type: string;
}

/** https://api.slack.com/events/link_shared */
export interface LinkSharedEvent extends SlackEvent {
  type: "link_shared";
  channel: string;
  message_ts: string;
  user?: string;
  /** Present on current payloads; preferred over channel + ts for chat.unfurl. */
  unfurl_id?: string;
  source?: "composer" | "conversations_history";
  links: Array<{ domain: string; url: string }>;
}

/** https://docs.slack.dev/reference/events/tokens_revoked */
export interface TokensRevokedEvent extends SlackEvent {
  type: "tokens_revoked";
  tokens?: { oauth?: string[]; bot?: string[] };
}
