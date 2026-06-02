#!/usr/bin/env bash
# Build local signer-dmz (Apache JWT DMZ + go-livepeer from ../go-livepeer).
#
# 1. go-livepeer via lpclearinghouse/scripts/build-remote-signer.sh (official
#    docker/Dockerfile with CGO + FFmpeg — do not inline a golang-bookworm build).
# 2. pymthouse/signer-dmz:local by copying the livepeer binary from that image.
#
# Usage:
#   ./scripts/build-local-signer.sh
#   GO_LIVEPEER_DIR=/path/to/go-livepeer ./scripts/build-local-signer.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GO_LIVEPEER_DIR="${GO_LIVEPEER_DIR:-${ROOT}/../go-livepeer}"
LPCLEARINGHOUSE_DIR="${LPCLEARINGHOUSE_DIR:-${ROOT}/../lpclearinghouse}"
REMOTE_SIGNER_IMAGE="${REMOTE_SIGNER_IMAGE:-go-livepeer-remote-signer:local}"
SIGNER_DMZ_IMAGE="${SIGNER_DMZ_IMAGE:-pymthouse/signer-dmz:local}"

BUILD_REMOTE_SIGNER="${LPCLEARINGHOUSE_DIR}/scripts/build-remote-signer.sh"
if [[ ! -f "${BUILD_REMOTE_SIGNER}" ]]; then
  echo "lpclearinghouse build script not found at ${BUILD_REMOTE_SIGNER}" >&2
  echo "Set LPCLEARINGHOUSE_DIR to your lpclearinghouse checkout." >&2
  exit 1
fi

export GO_LIVEPEER_DIR REMOTE_SIGNER_IMAGE
bash "${BUILD_REMOTE_SIGNER}"

echo "Building ${SIGNER_DMZ_IMAGE} (signer-dmz-local, livepeer from ${REMOTE_SIGNER_IMAGE})..."
docker build \
  -f "${ROOT}/docker/signer-dmz/Dockerfile" \
  --target signer-dmz-local \
  -t "${SIGNER_DMZ_IMAGE}" \
  "${ROOT}"

echo "Done. Start the stack:"
echo "  cd ${ROOT} && docker compose up -d signer-dmz"
