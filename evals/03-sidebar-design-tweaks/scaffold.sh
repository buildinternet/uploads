#!/usr/bin/env bash
set -euo pipefail
export CASE_BRANCH="feat/sidebar-tweaks"
exec bash "$(dirname "$0")/../fixture/scaffold.sh"
