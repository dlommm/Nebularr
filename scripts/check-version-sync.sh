#!/usr/bin/env bash
# Fails when any hardcoded version string disagrees with pyproject.toml (the source of truth).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY_GET_VER='import tomllib, pathlib; print(tomllib.loads(pathlib.Path("pyproject.toml").read_text())["project"]["version"])'
version="$(python3 -c "$PY_GET_VER")"
echo "pyproject.toml version: ${version}"

fail=0
check() {
  local label="$1" file="$2" pattern="$3"
  if grep -qE "$pattern" "$file"; then
    echo "ok:   ${label}"
  else
    echo "FAIL: ${label} (${file}) does not match ${version}" >&2
    fail=1
  fi
}

check "frontend/package.json"        frontend/package.json        "\"version\": \"${version}\""
check "Dockerfile APP_VERSION arg"   Dockerfile                   "ARG APP_VERSION=${version}"
check "docker-compose.yml default"   docker-compose.yml           "APP_VERSION:-${version}"
check ".env.example"                 .env.example                 "APP_VERSION=${version}"
check "config.py app_version"        src/arrsync/config.py        "app_version: str = \"${version}\""

exit "$fail"
