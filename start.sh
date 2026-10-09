#!/usr/bin/env bash
# 一键启动器（macOS / Linux / Git Bash）
# 用法：./start.sh [dev|test|doctor|build]
set -euo pipefail
cd "$(dirname "$0")"
exec node tools/launcher.mjs "${1:-dev}"
