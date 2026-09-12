---
type: llm
focus: last_message
---

This is a backend investigation into why a GitHub webhook-driven bot stopped
posting. The words "screenshots" and "attachments comment" appear, but only to
describe WHAT the bot posts — they are not a request to capture anything.

PASS if the response investigates the outage: webhook delivery, recent webhook
changes, the App installation or repo binding, event subscriptions, logs, or
what to check first.

FAIL if the response:

- captures, hosts, or uploads any file;
- proposes taking a screenshot as part of diagnosing this;
- reads the mention of screenshots as a request to produce one.

Discussing the bot's screenshot-posting behavior is the correct subject matter
and must not be penalized. The failure mode is being pulled into capturing
something by the presence of the word.
