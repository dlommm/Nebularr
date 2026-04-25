#!/usr/bin/env bash
# Build the Nebularr app image with Buildx and **no** SLSA provenance / SBOM attestations.
# That matches what we recommend for `docker push` in docs/skills: fewer spurious
# package rows in Docker Hub Scout (e.g. Go stdlib) that come from attestation metadata,
# not the runtime root filesystem. Trade-off: less supply-chain attestation on the image.
#
# Prereq: `cd frontend && npm run build` so src/arrsync/web/dist is current.
# Usage:
#   ./scripts/docker-release-build.sh --load
#   ./scripts/docker-release-build.sh --push
#   IMAGE=yourname/nebularr ./scripts/docker-release-build.sh --load

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mode="${1:-}"
if [[ "$mode" != "--load" && "$mode" != "--push" ]]; then
  echo "Usage: $0 --load| --push" >&2
  exit 1
fi

PY_GET_VER='import tomllib, pathlib; print(tomllib.loads(pathlib.Path("pyproject.toml").read_text())["project"]["version"])'
APP_VERSION="$(python3 -c "$PY_GET_VER")"
GIT_SHA="$(git rev-parse --short HEAD)"
IMAGE="${IMAGE:-dendlomm/nebularr}"

# --provenance / --sbom: omit attestations to keep Hub Scout closer to runtime content.
docker buildx build \
  --provenance=false \
  --sbom=false \
  -f Dockerfile \
  --build-arg "APP_VERSION=${APP_VERSION}" \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  -t "${IMAGE}:latest" \
  -t "${IMAGE}:${APP_VERSION}" \
  ${mode} \
  .

echo "Built ${IMAGE}:latest and ${IMAGE}:${APP_VERSION} (git ${GIT_SHA}, app ${APP_VERSION})"
