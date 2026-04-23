#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"

echo "Checking ${BASE_URL}/healthz"
curl -fsS "${BASE_URL}/healthz" >/dev/null

echo "Checking ${BASE_URL}/metrics"
curl -fsS "${BASE_URL}/metrics" >/dev/null

echo "Smoke check passed"
