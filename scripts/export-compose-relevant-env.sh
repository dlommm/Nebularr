#!/usr/bin/env bash
# Print eval-safe "export KEY=value" lines for keys needed by compose helper scripts.
# Avoids `source .env` so cron lines (e.g. */30 * * * *) are not parsed as shell.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 <<'PY'
from __future__ import annotations

import pathlib
import shlex
import sys

keys = (
    "NEBULARR_BUNDLED_POSTGRES",
    "COMPOSE_PROFILES",
    "APP_PORT",
    "POSTGRES_PORT",
)
path = pathlib.Path(".env")
if not path.is_file():
    sys.exit(0)

vals: dict[str, str] = {k: "" for k in keys}
for raw in path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, _, value = line.partition("=")
    key = key.strip()
    if key not in keys:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    vals[key] = value

for k in keys:
    print(f"export {k}={shlex.quote(vals[k])}")
PY
