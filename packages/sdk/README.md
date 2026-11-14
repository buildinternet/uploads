# @buildinternet/uploads-sdk

TypeScript client for the [uploads.sh](https://uploads.sh) API. It has no dependencies and uses only `fetch`, so it runs in Node 22+, Bun, Deno, Cloudflare Workers and browsers.

```bash
npm install @buildinternet/uploads-sdk
```

```ts
import { createUploadsClient } from "@buildinternet/uploads-sdk";

const uploads = createUploadsClient({
  token: process.env.UPLOADS_TOKEN!, // up_<workspace>_… or a service token
  workspace: "acme",
});

const file = await uploads.put("screenshots/settings.png", bytes, {
  contentType: "image/png",
  metadata: { path: "/settings" },
});
console.log(file.url);

// Attach this workspace's uploads to a pull request as the uploads.sh comment.
await uploads.upsertGithubComment({ repo: "acme/web", num: 42, kind: "pull" });
```

Tokens are workspace-wide, so keep them on a server. Never ship one to a browser.

## What it covers

- **Files:** `put`, `previewPut`, `head`, `delete`, `list`, `listAll`, `findFiles`, `findFilesAll`, `getMetadata`, `patchMetadata`, `listMetadataKeys`, `listMetadataValues`
- **Review holds:** `listHeld`, `approve`
- **Galleries:** `createGallery`, `getGallery`, `listGalleries`, `deleteGallery`, `addGalleryItem`, and external references
- **Live links (feeds):** `createFeed`, `getFeed`, `listFeeds`, `deleteFeed`
- **GitHub:** `upsertGithubComment`
- **Usage:** `usage`, `reconcile`, `purgeExpired`, `health`

For any other public route, `uploads.request(method, path, options)` sends an authenticated request and returns the parsed JSON. The guide is at [uploads.sh/docs/sdk](https://uploads.sh/docs/sdk), the full API reference at [uploads.sh/docs/api](https://uploads.sh/docs/api), and the OpenAPI document at `https://uploads.sh/.well-known/openapi.json`.

## Errors and retries

Every method throws `UploadsError` on a non-2xx response. `code` is a stable string such as `UNAUTHORIZED`, `INSUFFICIENT_SCOPE`, `NOT_FOUND`, `KEY_EXISTS`, `STORAGE_QUOTA` or `NETWORK`, and `status` is the HTTP status.

Requests time out after 15 seconds (60 seconds for uploads). A GET, or a PUT or POST that has an `Idempotency-Key`, is retried once on a network error, 429 or 503. Pass `onRetry` to log the retry.

## Options

```ts
createUploadsClient(
  { token, workspace, apiUrl: "https://api.uploads.sh" },
  {
    fetch, // a custom fetch, e.g. for tests
    tracer, // an OpenTelemetry tracer, or false (see Tracing)
    userAgent, // sent where the runtime allows it
    onRetry: ({ reason, delayMs }) => {},
    onTokenExpiry: (expiresAt) => {}, // the API reports when the token expires
  },
);
```

## Tracing

If your app runs OpenTelemetry, each call becomes an `uploads.<method>` client span on the tracer your app registered. The SDK has no OpenTelemetry dependency and does nothing without a registered tracer. Attributes are the workspace, API host, file size and content type for `put`, and the error code on failure: never the token, keys, metadata or file contents. Pass `tracer` to pick one, or `tracer: false` to turn spans off. Span names are experimental. Details at [uploads.sh/docs/sdk#tracing](https://uploads.sh/docs/sdk#tracing).
