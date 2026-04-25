"""Generate pgAdmin servers.json and PostgreSQL .pgpass from container environment."""

from __future__ import annotations

import os
from pathlib import Path

PGADMIN_DIR = Path("/var/lib/pgadmin")
SERVERS_PATH = PGADMIN_DIR / "servers.json"
PGPASS_PATH = PGADMIN_DIR / ".pgpass"

POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres")
POSTGRES_PORT = int(os.environ.get("POSTGRES_PORT", "5432"))
POSTGRES_DB = os.environ.get("POSTGRES_DB", "arranalytics")
POSTGRES_USER = os.environ.get("POSTGRES_USER", "arradmin")
POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "arradmin")
ARRAPP_USER = os.environ.get("ARRAPP_USER", "arrapp")
ARRAPP_PASSWORD = os.environ.get("ARRAPP_PASSWORD", "arrapp")

# pgAdmin container runs this script as root before the real entrypoint; data dir must exist.
PGADMIN_UID = int(os.environ.get("PGADMIN_UID", "5050"))
PGADMIN_GID = int(os.environ.get("PGADMIN_GID", "5050"))


def main() -> None:
    PGADMIN_DIR.mkdir(parents=True, exist_ok=True)

    pgpass_lines = [
        f"{POSTGRES_HOST}:{POSTGRES_PORT}:*:{POSTGRES_USER}:{POSTGRES_PASSWORD}",
        f"{POSTGRES_HOST}:{POSTGRES_PORT}:{POSTGRES_DB}:{ARRAPP_USER}:{ARRAPP_PASSWORD}",
    ]
    PGPASS_PATH.write_text("\n".join(pgpass_lines) + "\n", encoding="utf-8")
    os.chmod(PGPASS_PATH, 0o600)
    os.chown(PGPASS_PATH, PGADMIN_UID, PGADMIN_GID)

    servers = {
        "Servers": {
            "1": {
                "Name": f"Nebularr ({POSTGRES_USER})",
                "Group": "Nebularr",
                "Host": POSTGRES_HOST,
                "Port": POSTGRES_PORT,
                "MaintenanceDB": POSTGRES_DB,
                "Username": POSTGRES_USER,
                "SSLMode": "prefer",
                "Comment": "Database owner / admin user (matches POSTGRES_USER).",
                "ConnectionParameters": {
                    "sslmode": "prefer",
                    "passfile": str(PGPASS_PATH),
                },
            },
            "2": {
                "Name": f"Nebularr app ({ARRAPP_USER})",
                "Group": "Nebularr",
                "Host": POSTGRES_HOST,
                "Port": POSTGRES_PORT,
                "MaintenanceDB": POSTGRES_DB,
                "Username": ARRAPP_USER,
                "SSLMode": "prefer",
                "Comment": "Application role used by Nebularr (app + warehouse schemas).",
                "ConnectionParameters": {
                    "sslmode": "prefer",
                    "passfile": str(PGPASS_PATH),
                },
            },
        }
    }

    import json

    SERVERS_PATH.write_text(json.dumps(servers, indent=2), encoding="utf-8")
    os.chmod(SERVERS_PATH, 0o600)
    os.chown(SERVERS_PATH, PGADMIN_UID, PGADMIN_GID)


if __name__ == "__main__":
    main()
