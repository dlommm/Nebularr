#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git config core.hooksPath .githooks
chmod +x .githooks/commit-msg 2>/dev/null || true

echo "Set core.hooksPath to .githooks (commit-msg strips Cursor Co-authored-by lines)."
echo "Unset with: git config --unset core.hooksPath"
