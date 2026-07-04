#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f ".env" ]]; then
  echo "error: .env is missing. Copy .env.example to .env, edit values for your environment, then retry." >&2
  echo "See README Quickstart and docs/SECRETS.md." >&2
  exit 1
fi

# New installs should not run with the documented default Postgres password:
# replace the placeholder with a generated one before the database first initializes.
if grep -qE '^POSTGRES_PASSWORD=(arradmin)?$' .env; then
  generated_pw="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
  tmp_env="$(mktemp)"
  sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${generated_pw}/" .env > "$tmp_env"
  mv "$tmp_env" .env
  echo "POSTGRES_PASSWORD was the default placeholder; generated a random one in .env."
  echo "Use it in the setup wizard's PostgreSQL step (it is stored only in your local .env)."
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

docker compose up --build -d

echo
echo "Nebularr core stack is starting."
echo "- App:     http://localhost:${APP_PORT:-8080}"
if [[ "$bundled" == true ]]; then
  echo "- Postgres: localhost:${POSTGRES_PORT:-5432} (bundled compose service; host port only if published)"
else
  echo "- Postgres: not started by this compose file (external DB — use Web UI setup with your host)"
fi
