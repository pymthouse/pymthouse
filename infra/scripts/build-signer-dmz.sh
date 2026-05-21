#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/pymthouse/pymthouse-signer-dmz}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"
PLATFORM="${PLATFORM:-linux/amd64}"

docker build \
  --platform "$PLATFORM" \
  -f "$ROOT_DIR/infra/docker/signer-dmz/Dockerfile" \
  -t "$IMAGE_NAME:$IMAGE_TAG" \
  "$ROOT_DIR"

echo "Built $IMAGE_NAME:$IMAGE_TAG"
