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
# The lockfile's own version lives in two root fields; read them directly, since a
# grep count also matches dependencies that happen to share the version.
lock_versions="$(python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(d.get("version"), d.get("packages", {}).get("", {}).get("version"))' frontend/package-lock.json)"
if [[ "$lock_versions" == "${version} ${version}" ]]; then
  echo "ok:   frontend/package-lock.json (root + packages[\"\"])"
else
  echo "FAIL: frontend/package-lock.json root versions are '${lock_versions}', expected ${version}" >&2
  fail=1
fi
check "Dockerfile APP_VERSION arg"   Dockerfile                   "ARG APP_VERSION=${version}"
check "docker-compose.yml default"   docker-compose.yml           "APP_VERSION:-${version}"
check ".env.example"                 .env.example                 "APP_VERSION=${version}"
check "config.py app_version"        src/arrsync/config.py        "app_version: str = \"${version}\""
check "unraid compose image tag"     deploy/unraid/docker-compose.yml "dendlomm/nebularr:${version}"

exit "$fail"
