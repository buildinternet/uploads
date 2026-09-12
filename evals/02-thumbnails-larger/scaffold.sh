#!/usr/bin/env bash
set -euo pipefail
export CASE_BRANCH="feat/larger-thumbnails"
exec bash "$(dirname "$0")/../fixture/scaffold.sh"
