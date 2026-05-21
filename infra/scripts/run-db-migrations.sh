#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/pymthouse/pymthouse-control-plane}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

docker run \
  --rm \
  --name "${CONTAINER_NAME:-pymthouse-db-migrate}" \
  -e DATABASE_URL="$DATABASE_URL" \
  "$IMAGE_NAME:$IMAGE_TAG" \
  node scripts/db-migrate.ts
