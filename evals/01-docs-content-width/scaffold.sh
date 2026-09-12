#!/usr/bin/env bash
set -euo pipefail
export CASE_BRANCH="feat/docs-content-width"
exec bash "$(dirname "$0")/../fixture/scaffold.sh"
