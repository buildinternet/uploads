---
title: "The hosted MCP server serves skills and sends hold events"
date: 2026-11-23
tags: [platform, mcp]
---

Two additions to the hosted MCP server at `https://agents.uploads.sh/mcp`,
both built on new MCP extensions.

**Skills come with the server.** The `github-screenshots` and `uploads-cli`
skills are served over the MCP Skills extension as `skill://<name>/SKILL.md`.
A client that supports it picks them up when it connects, so an agent learns
when to capture and how to attach without a separate install. Clients without
skills support still see them under `resources/list`.

**Hold events.** The server supports
[MCP Events](https://modelcontextprotocol.io/extensions/events/overview) with
webhook delivery, the mode ChatGPT uses. A client can subscribe to
`uploads.file.held` and `uploads.file.approved`, optionally for one repo or
pull request. When a file is
[held for review](/docs/ai-labels#held-uploads), or a member approves it, the
server posts a signed event. The agent that took the shot can then pick up
where it stopped, without polling `list_held`.

Events need a signed-in user. See [Events](/docs/mcp#events) for the payload
and limits.
