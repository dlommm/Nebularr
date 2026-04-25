#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f ".env" ]]; then
  echo "error: .env is missing. Copy .env.example to .env, edit values for your environment, then retry." >&2
  echo "See README Quickstart and docs/SECRETS.md." >&2
  exit 1
fi

if [[ -f ".env" ]]; then
  _helper="$(cd "$(dirname "$0")" && pwd)/export-compose-relevant-env.sh"
  eval "$("$_helper")"
fi

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

docker compose up --build -d

echo
echo "Nebularr core stack is starting."
echo "- App:     http://localhost:${APP_PORT:-8080}"
if [[ "$bundled" == true ]]; then
  echo "- Postgres: localhost:${POSTGRES_PORT:-5432} (bundled compose service; host port only if published)"
else
  echo "- Postgres: not started by this compose file (external DB — use Web UI setup with your host)"
fi
