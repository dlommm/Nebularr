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

# Stricter variant: the version must appear the expected number of times and the
# previous version must not appear at all. frontend/package-lock.json records the
# version twice (top level, and the "" entry under packages), and the bump script
# has silently left it behind before — it drifted from 2.8.0 across three releases
# because nothing here checked it.
check_exact() {
  local label="$1" file="$2" pattern="$3" want="$4"
  local got
  got="$(grep -cE "$pattern" "$file" || true)"
  if [[ "$got" == "$want" ]]; then
    echo "ok:   ${label} (${got}x)"
  else
    echo "FAIL: ${label} (${file}) matched ${got}x, expected ${want}x for ${version}" >&2
    fail=1
  fi
}

check "frontend/package.json"        frontend/package.json        "\"version\": \"${version}\""
check_exact "frontend/package-lock.json" frontend/package-lock.json "\"version\": \"${version}\"" 2
check "Dockerfile APP_VERSION arg"   Dockerfile                   "ARG APP_VERSION=${version}"
check "docker-compose.yml default"   docker-compose.yml           "APP_VERSION:-${version}"
check ".env.example"                 .env.example                 "APP_VERSION=${version}"
check "config.py app_version"        src/arrsync/config.py        "app_version: str = \"${version}\""
check "unraid compose image tag"     deploy/unraid/docker-compose.yml "dendlomm/nebularr:${version}"

exit "$fail"
