# @buildinternet/uploads-sdk

## 0.2.0

### Minor Changes

- 51a3ce6: Emit OpenTelemetry client spans (`uploads.<method>`) on the tracer your app registered. No new dependency; does nothing without a tracer. New `tracer` client option picks a tracer or turns spans off.

## 0.1.1

### Patch Changes

- 40150de: Publish with npm provenance, and link the npm page to the SDK guide at uploads.sh/docs/sdk, the issue tracker and the supported Node versions.

## 0.1.0

### Minor Changes

- 862c678: First release of `@buildinternet/uploads-sdk`, a dependency-free TypeScript client for the uploads.sh API. It runs anywhere `fetch` does: Node 18+, Bun, Deno, Cloudflare Workers and browsers.
