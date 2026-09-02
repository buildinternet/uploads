---
title: "Uploads take PDFs, logs, JSON, and zips"
date: 2026-09-02T18:00:00Z
tags: [platform, cli]
---

The upload allowlist now covers PDF, zip, gzip, MOV, and text files (plain,
markdown, CSV, JSON, logs) alongside images and video. Test reports, Lighthouse
output, build logs, and bundles get the same stable URLs and appear in the PR's
attachments comment as links. MOV uploads and plays on its file page. Size caps
are the plan's file cap; MOV uses the video cap.

Uploads are public. The text families — logs, CI JSON, env dumps — are the ones
that tend to carry secrets in practice, so scrub those before uploading.

SVG and HTML stay out: served inline, either can run script on our storage
origin. SVG support is planned behind a sandboxing header.
