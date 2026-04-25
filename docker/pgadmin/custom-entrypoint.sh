#!/bin/sh
set -e
# Generate servers.json + .pgpass from env (same defaults as docker-compose postgres service).
python3 /bootstrap.py
export PGADMIN_SERVER_JSON_FILE="${PGADMIN_SERVER_JSON_FILE:-/var/lib/pgadmin/servers.json}"
export PGPASS_FILE="${PGPASS_FILE:-/var/lib/pgadmin/.pgpass}"
exec /entrypoint.sh "$@"
