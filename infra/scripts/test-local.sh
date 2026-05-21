#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
POSTGRES_DB="${POSTGRES_DB:-pymthouse_test}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
CONTAINER_NAME="${CONTAINER_NAME:-pymthouse-test-db-$(date +%s)-$RANDOM}"
KEEP_DB="${KEEP_DB:-0}"
SKIP_OIDC_SEED="${SKIP_OIDC_SEED:-0}"

cleanup() {
  if [[ "$KEEP_DB" != "1" ]]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

echo "[test:local] Starting disposable PostgreSQL container: $CONTAINER_NAME"
docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -P \
  "$POSTGRES_IMAGE" >/dev/null

echo "[test:local] Waiting for PostgreSQL readiness"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
  echo "[test:local] PostgreSQL did not become ready in time" >&2
  exit 1
fi

HOST_PORT="$(docker port "$CONTAINER_NAME" 5432/tcp | awk -F: 'END {print $NF}')"
if [[ -z "$HOST_PORT" ]]; then
  echo "[test:local] Could not determine mapped PostgreSQL port" >&2
  exit 1
fi

export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${HOST_PORT}/${POSTGRES_DB}"

echo "[test:local] DATABASE_URL=${DATABASE_URL}"
(
  cd "$ROOT_DIR"
  npm run db:prepare
  if [[ "$SKIP_OIDC_SEED" != "1" ]]; then
    npm run oidc:seed
  fi
  npm test
)

if [[ "$KEEP_DB" == "1" ]]; then
  echo "[test:local] Keeping database container running: $CONTAINER_NAME"
fi
