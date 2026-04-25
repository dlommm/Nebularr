#!/usr/bin/env bash
# Local Docker testing: use the project .env only (no shell overrides for DATABASE_URL / COMPOSE_PROFILES).
# Creates .env from .env.example if missing so you do not have to prepare it by hand.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example (local testing; file is gitignored)." >&2
fi

_helper="$(cd "$(dirname "$0")" && pwd)/export-compose-relevant-env.sh"
eval "$("$_helper")"

bundled=true
case "${NEBULARR_BUNDLED_POSTGRES:-true}" in
[Ff][Aa][Ll][Ss][Ee] | 0 | [Nn][Oo]) bundled=false ;;
esac

if [[ "$bundled" == true ]]; then
  if [[ ",${COMPOSE_PROFILES:-}," != *",nebularr-bundled-postgres,"* ]]; then
    export COMPOSE_PROFILES="nebularr-bundled-postgres${COMPOSE_PROFILES:+,${COMPOSE_PROFILES}}"
  fi
else
  new_cp=""
  IFS=',' read -ra PARTS <<< "${COMPOSE_PROFILES:-}"
  for x in "${PARTS[@]}"; do
    x="${x//[[:space:]]/}"
    [[ -z "$x" || "$x" == "nebularr-bundled-postgres" ]] && continue
    new_cp="${new_cp:+$new_cp,}$x"
  done
  export COMPOSE_PROFILES="$new_cp"
fi

docker compose up -d --build

echo
echo "Local stack is up (values from .env only; Compose read .env for interpolation)."
echo "- App: http://localhost:${APP_PORT:-8080}"
