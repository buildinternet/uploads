# OpenAI UI compatibility spike

Observed on October 25, 2026. This is an isolated experiment with synthetic
images. It does not access an uploads.sh account or change the production MCP
server. See [README.md](README.md) for reproducible commands.

## Evidence

| Layer               | Check                                                                  | Result                                                             |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Protocol            | Tool discovery, UI resource URI, global and thread entrypoints         | Passed automated smoke                                             |
| Protocol            | HTML resource MIME and bundled content                                 | Passed automated smoke                                             |
| Protocol            | Populated, empty, simulated error, invalid arguments                   | Passed automated smoke                                             |
| Protocol            | Legacy initialization                                                  | Passed automated smoke                                             |
| HTTP                | Unknown routes, invalid Host, invalid Origin                           | Passed automated smoke                                             |
| Local SDK harness   | App bridge initialization and initial result                           | Passed in the desktop in-app browser                               |
| Local SDK harness   | Empty/error transitions and recovery through tool calls                | Passed in the desktop in-app browser                               |
| Local SDK harness   | Narrow layout                                                          | Passed visually                                                    |
| Local SDK harness   | Dark theme update and return to light                                  | Passed after fixing mutable host context in the harness            |
| ChatGPT web         | Custom MCP discovery and installation through temporary HTTPS tunnel   | Passed after explicit user connection approval                     |
| ChatGPT web         | Global sidebar entry and gallery                                       | Passed; navigation includes Staged media demo                      |
| ChatGPT web         | Real bridge, populated/empty/error states and recovery                 | Passed; host reports chatgpt unknown, fullscreen                   |
| ChatGPT web         | Initial load reliability                                               | Intermittent; two observed loading failures, later retry succeeded |
| ChatGPT web         | Conversation entrypoint                                                | Not yet tested                                                     |
| Desktop plugin host | Tool invocation                                                        | Passed from the current desktop chat; returned synthetic summary   |
| Desktop plugin host | Opened MCP App panel, image rendering, Refresh, Empty, Error, recovery | Passed; chatgpt 26.1021.31345, fullscreen                          |
| Desktop plugin host | Native sidebar launch path                                             | User opened the panel; agent did not inspect native navigation     |

The local harness uses the official MCP Apps AppBridge and a real fixture MCP
endpoint. It is not proof that the OpenAI host accepts the UI extensions.
Desktop evidence comes from inspecting and operating the actual MCP App panel,
after the user opened it. It does not rely on the local harness.

In the desktop panel, Refresh increased the result count from two to three.
Empty returned zero images, Error displayed the simulated failure, and Populated
restored both images. The final result count was six. The host reported
`chatgpt 26.1021.31345` and `fullscreen`. The native sidebar launch path and a
separate thread entrypoint remain unverified; native app control is unavailable.

The installed personal plugin is `Uploads UI Spike`. Its global route is
`/mcp-app/asdk_app_6ade4e6bf8148191ab5fd78a93d409e7/show_staged_media_demo`.
The successful web render used the original metadata and bundle. No compatibility
workaround was needed. The gallery reported a connected bridge and received five
results after initial loading, Empty, Error, and recovery to Populated.

Startup is not reliable enough to call production-ready. The host twice showed
"Couldn't display Uploads UI Spike" after loading. A later Try again succeeded.
The user also reported intermittent success. During one failed reload, the local
transport returned three HTTP 200 responses in 26, 8, and 9 milliseconds. This
does not identify which host operation failed or rule out tunnel/client issues.
The successful retry did not call the resource callback after tracing was enabled,
which is consistent with a cached resource. Root cause remains unresolved.

The first dark-mode test failed because the harness mutated the context object
retained by AppBridge before sending the update. Replacing it immutably fixed
the event. The gallery also merges partial host-context notifications.

Screenshots are stored locally under `.context/openai-ui-spike/`. The narrow
dark screenshot is staged for `codex/openai-ui-compatibility-spike`:
[view the harness evidence](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-openai-ui-compatibility-spike/harness-narrow-dark.webp).
The [wide light screenshot](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-openai-ui-compatibility-spike/harness-wide-light.webp)
is staged on the same branch.
The [real ChatGPT gallery screenshot](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-openai-ui-compatibility-spike/chatgpt-global-connected.webp)
shows the connected bridge in fullscreen mode.
The [desktop panel screenshot](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-openai-ui-compatibility-spike/desktop-panel-connected.webp)
shows the desktop build and six received results after recovery.

## Production implications

The compatibility spike supports proceeding with a staged-media MCP App. The
same bundle rendered in ChatGPT web and the desktop panel without a host-specific
adapter. Resolve intermittent startup and validate the remaining launch paths
before treating the integration as production-ready.

The repository's existing shared MCP server only registers tools. The spike
uses an independent dependency set with resource support. A production UI
requires deliberate resource registration and metadata plumbing; adding
entrypoint metadata alone is insufficient.

Keep live data integration separate. A later staged-media read must enforce
workspace authentication and filter by repository, branch, and staged status.
Do not treat an empty page as the end when its cursor is non-null.
