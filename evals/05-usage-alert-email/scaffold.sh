#!/usr/bin/env bash
set -euo pipefail
export CASE_BRANCH="feat/usage-alerts"
exec bash "$(dirname "$0")/../fixture/scaffold.sh"
