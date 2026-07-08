# API

All `/v1` routes require the workspace's `Authorization: Bearer <token>`.
Unknown workspaces and bad tokens are indistinguishable (both 401).

## Routes

| Route                                             | Description                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health`                                     | Liveness (no auth)                                                                        |
| `PUT /v1/:workspace/files/:key`                   | Upload raw body; `Content-Type` header is stored. Returns `{ workspace, key, url, size }` |
| `GET /v1/:workspace/files?prefix=&limit=&cursor=` | List objects                                                                              |
| `GET /v1/:workspace/files/:key`                   | Object metadata                                                                           |
| `DELETE /v1/:workspace/files/:key`                | Delete object                                                                             |

`url` in responses is the public URL when the workspace has a
`publicBaseUrl`, otherwise `null`.

## Example

```bash
curl -X PUT https://api.uploads.sh/v1/default/files/screenshots/myapp/42/shot.png \
  -H "Authorization: Bearer $UPLOADS_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @shot.png
```

## CLI

The `@buildinternet/uploads` package wraps the API for GitHub image embeds:

```bash
pnpm uploads put <file> --env-file .env
pnpm uploads put <file> --pr <num> --comment   # PR attachment + managed GitHub comment
```

See `skills/uploads-cli/SKILL.md` for agent-oriented usage.
