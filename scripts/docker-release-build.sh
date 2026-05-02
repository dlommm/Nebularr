#!/usr/bin/env bash
# Multi-platform Hub release builds (default: SBOM + SLSA provenance for Docker Scout policies).
#
# **Attestations (default ON for `--push`):** attaches BuildKit SBOM and provenance (mode=max) to
# the registry manifest so Docker Scout "Missing supply chain attestation(s)" policies can clear.
# Opt out noisy/experimental scanners: `DOCKER_ATTESTATIONS=0 ./scripts/docker-release-build.sh --push`
#
# If push fails with attestation/driver errors on self-hosted builders, switch the builder driver:
#   docker buildx create --name nb --driver docker-container --use --bootstrap
# or disable attestations with DOCKER_ATTESTATIONS=0 above.
#
# **--push** builds a manifest list (linux/amd64 + linux/arm64 default).
#
# **--load** stays single-arch and keeps attestations off (manifest index + `--load` is unsupported).
#
# Prereq: `cd frontend && npm run build` so src/arrsync/web/dist is current.

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
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

DO_ATTEST="${DOCKER_ATTESTATIONS:-1}"

attestation_flags=(--provenance=false --sbom=false)
if [[ "$mode" == "--push" && "$DO_ATTEST" == "1" ]]; then
  attestation_flags=(--provenance=mode=max --sbom=true)
fi

common_flags=(
  "${attestation_flags[@]}"
  -f Dockerfile
  --build-arg "APP_VERSION=${APP_VERSION}"
  --build-arg "GIT_SHA=${GIT_SHA}"
  -t "${IMAGE}:latest"
  -t "${IMAGE}:${APP_VERSION}"
)

if [[ "$mode" == "--push" ]]; then
  docker buildx build \
    "${common_flags[@]}" \
    --platform "${PLATFORMS}" \
    --push \
    .
  echo "Pushed ${IMAGE}:latest and ${IMAGE}:${APP_VERSION}" \
    "(platforms: ${PLATFORMS}, git ${GIT_SHA}, app ${APP_VERSION}, attestations: ${DO_ATTEST})"
else
  docker buildx build \
    "${common_flags[@]}" \
    --load \
    .
  echo "Loaded ${IMAGE}:latest and ${IMAGE}:${APP_VERSION}" \
    "(local single-arch, git ${GIT_SHA}, app ${APP_VERSION}; attestations off for --load)"
fi
