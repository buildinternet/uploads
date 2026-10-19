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

/** https://docs.slack.dev/reference/events/app_home_opened */
export interface AppHomeOpenedEvent extends SlackEvent {
  type: "app_home_opened";
  user: string;
  tab: "home" | "messages";
}

/**
 * A Work Object flexpane was opened or refreshed.
 * https://docs.slack.dev/reference/events/entity_details_requested
 */
export interface EntityDetailsRequestedEvent extends SlackEvent {
  type: "entity_details_requested";
  user?: string;
  trigger_id: string;
  external_ref?: { id: string; type?: string };
  /** The entity's canonical `url`. */
  entity_url?: string;
  /** The exact URL that was unfurled. */
  app_unfurl_url?: string;
  link?: { url: string; domain?: string };
}

/** The slice of an interactivity `block_actions` payload this app reads. */
export interface BlockActionsPayload {
  type: "block_actions";
  team?: { id: string } | null;
  user?: { id: string; team_id?: string };
  /** A button carries `value`; a select menu carries `selected_option`. */
  actions?: Array<{ action_id: string; value?: string; selected_option?: { value?: string } }>;
  /** Where to send a reply that replaces the message the button was on. */
  response_url?: string;
  trigger_id?: string;
  /** For a Work Object button, `type` is `entity_detail` (flexpane) or `message_attachment` (unfurl). */
  container?: { type?: string; app_unfurl_url?: string; entity_url?: string };
}
