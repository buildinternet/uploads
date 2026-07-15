---
"@buildinternet/uploads": minor
---

Anonymous, opt-out usage telemetry for the CLI and MCP server (command name, version, OS/arch, exit code, duration, optional error code — never paths or tokens). Opt out with `UPLOADS_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or `uploads telemetry disable`.

Also adds explicit opt-in diagnostic reports: `uploads report` and the MCP `report` tool can send a short message plus an optional text log/trace (max 256 KiB) when the user asks — never automatic.
