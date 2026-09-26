#!/bin/sh
# Advisory reminder to stage screenshots before opening a PR that touches UI
# files. Runs the uploads CLI when it is installed; otherwise exits silently.
if command -v uploads >/dev/null 2>&1; then
  exec uploads hook pre-pr-screenshot
fi
exit 0
