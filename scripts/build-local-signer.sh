#!/usr/bin/env bash
# Build pymthouse/signer-dmz:local (Apache JWT DMZ + go-livepeer livepeer binary).
#
# Default (fast): pull a published go-livepeer image and copy livepeer into the DMZ.
#   ./scripts/build-local-signer.sh
#   LIVEPEER_IMAGE=livepeer/go-livepeer:sha-33380bc9088cbd26b3797387dc6a783a68a69f84 ./scripts/build-local-signer.sh
#
# From local checkout (slow — full CGO/FFmpeg build via lpclearinghouse):
#   LIVEPEER_IMAGE= ./scripts/build-local-signer.sh
#   GO_LIVEPEER_DIR=/path/to/go-livepeer LIVEPEER_IMAGE= ./scripts/build-local-signer.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GO_LIVEPEER_DIR="${GO_LIVEPEER_DIR:-${ROOT}/../go-livepeer}"
LPCLEARINGHOUSE_DIR="${LPCLEARINGHOUSE_DIR:-${ROOT}/../lpclearinghouse}"
LIVEPEER_IMAGE="${LIVEPEER_IMAGE:-livepeer/go-livepeer:sha-33380bc9088cbd26b3797387dc6a783a68a69f84}"
SIGNER_DMZ_IMAGE="${SIGNER_DMZ_IMAGE:-pymthouse/signer-dmz:local}"

if [[ -n "${LIVEPEER_IMAGE}" ]]; then
  echo "Pulling ${LIVEPEER_IMAGE}..."
  docker pull "${LIVEPEER_IMAGE}"
else
  REMOTE_SIGNER_IMAGE="${REMOTE_SIGNER_IMAGE:-go-livepeer-remote-signer:local}"
  BUILD_REMOTE_SIGNER="${LPCLEARINGHOUSE_DIR}/scripts/build-remote-signer.sh"
  if [[ ! -f "${BUILD_REMOTE_SIGNER}" ]]; then
    echo "lpclearinghouse build script not found at ${BUILD_REMOTE_SIGNER}" >&2
    echo "Set LPCLEARINGHOUSE_DIR or use LIVEPEER_IMAGE=livepeer/go-livepeer:<tag>." >&2
    exit 1
  fi
  export GO_LIVEPEER_DIR REMOTE_SIGNER_IMAGE
  bash "${BUILD_REMOTE_SIGNER}"
  LIVEPEER_IMAGE="${REMOTE_SIGNER_IMAGE}"
fi

echo "Building ${SIGNER_DMZ_IMAGE} (signer-dmz-local, livepeer from ${LIVEPEER_IMAGE})..."
docker build \
  -f "${ROOT}/docker/signer-dmz/Dockerfile" \
  --target signer-dmz-local \
  --build-arg "LIVEPEER_IMAGE=${LIVEPEER_IMAGE}" \
  -t "${SIGNER_DMZ_IMAGE}" \
  "${ROOT}"

echo "Done. Start the full clearinghouse stack (signer + kafka + collector):"
echo "  cd ${ROOT} && docker compose -f docker-compose.clearinghouse.railway.yml --env-file .env.local up -d --build"
