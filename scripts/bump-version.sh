#!/usr/bin/env bash
# Bump the project version everywhere it is hardcoded. Usage: ./scripts/bump-version.sh 2.1.0
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

new_version="${1:-}"
if [[ -z "$new_version" ]] || ! [[ "$new_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <semver, e.g. 2.1.0>" >&2
  exit 1
fi

PY_GET_VER='import tomllib, pathlib; print(tomllib.loads(pathlib.Path("pyproject.toml").read_text())["project"]["version"])'
old_version="$(python3 -c "$PY_GET_VER")"
echo "Bumping ${old_version} -> ${new_version}"

python3 - "$old_version" "$new_version" <<'EOF'
import sys
from pathlib import Path

old, new = sys.argv[1], sys.argv[2]
replacements = {
    "pyproject.toml": (f'version = "{old}"', f'version = "{new}"'),
    "frontend/package.json": (f'"version": "{old}"', f'"version": "{new}"'),
    "Dockerfile": (f"ARG APP_VERSION={old}", f"ARG APP_VERSION={new}"),
    "docker-compose.yml": (f"APP_VERSION:-{old}", f"APP_VERSION:-{new}"),
    ".env.example": (f"APP_VERSION={old}", f"APP_VERSION={new}"),
    "src/arrsync/config.py": (f'app_version: str = "{old}"', f'app_version: str = "{new}"'),
    "deploy/unraid/docker-compose.yml": (
        f"dendlomm/nebularr:{old}",
        f"dendlomm/nebularr:{new}",
    ),
}
for path, (old_str, new_str) in replacements.items():
    p = Path(path)
    text = p.read_text()
    if old_str not in text:
        raise SystemExit(f"{path}: expected {old_str!r} not found")
    p.write_text(text.replace(old_str, new_str, 1))
    print(f"updated {path}")
EOF

(cd frontend && npm install --package-lock-only --silent)
echo "Done. Verify with ./scripts/check-version-sync.sh, then commit and tag v${new_version}."
