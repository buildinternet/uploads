---
"@buildinternet/uploads": patch
---

Sharpen the server-side reputation pre-filter for gated SVG/XML uploads (`containsActiveMarkup`): event-handler attribute matching no longer false-positives on ordinary attributes like `online=`/`once=`, and entity-encoded evasions (`&#106;avascript:`, SMIL `<set attributeName="onclick">`) are now rejected. The actual security control remains the sandboxing CSP on the serving lane; this filter is defense in depth.
