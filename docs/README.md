# Docs

Start on the product site, not this folder:

- [uploads.sh/docs](https://uploads.sh/docs) — install, the staged loop, GitHub App, agents, limits
- [llms.txt](https://uploads.sh/llms.txt) — short index for agents
- [llms-full.txt](https://uploads.sh/llms-full.txt) — one-file agent guide
- [auth.md](https://uploads.sh/auth.md) — device login and token scopes

This folder is the repo companion: CLI and API reference, then contributor and operator material. It is not the getting-started path.

## Product and CLI

| Doc                                           | Contents                                  |
| --------------------------------------------- | ----------------------------------------- |
| [cli](cli.md)                                 | Everyday CLI                              |
| [api](api.md)                                 | REST routes                               |
| [private-attachments](private-attachments.md) | Private-repo URL prefixes                 |
| [enrollment](enrollment.md)                   | uploads login, scopes, and token lifetime |
| [mcp-cimd-interop](mcp-cimd-interop.md)       | Generic MCP client OAuth/CIMD failures    |

## Contributors

| Doc                                   | Contents                    |
| ------------------------------------- | --------------------------- |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, checks, and PR shape |
| [AGENTS.md](../AGENTS.md)             | Agent working conventions   |
| [local-dev](local-dev.md)             | Bootstrap and the dev stack |
| [roadmap](roadmap.md)                 | Planned work                |

## Operators and self-hosting

ops, deploy, releasing, contract-testing, admin-tokens, workspaces, and deletion assume you run or deploy the service. They are not getting-started docs.

docs/superpowers/ is historical implementation plans, not product docs.
