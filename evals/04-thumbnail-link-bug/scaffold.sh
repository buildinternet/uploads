#!/usr/bin/env bash
set -euo pipefail
export CASE_BRANCH="fix/thumbnail-anchors"
exec bash "$(dirname "$0")/../fixture/scaffold.sh"
