#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f ".env" ]]; then
  cp ".env.example" ".env"
  echo "Created .env from .env.example"
fi

docker compose up --build -d

echo
echo "Nebularr core stack is starting."
echo "- App:     http://localhost:${APP_PORT:-8080}"
echo "- Postgres: localhost:${POSTGRES_PORT:-5432}"
