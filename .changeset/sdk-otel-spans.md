---
"@buildinternet/uploads-sdk": minor
---

Emit OpenTelemetry client spans (`uploads.<method>`) on the tracer your app registered. No new dependency; does nothing without a tracer. New `tracer` client option picks a tracer or turns spans off.
