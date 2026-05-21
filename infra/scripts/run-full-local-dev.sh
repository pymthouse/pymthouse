#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT_DIR"

exec docker compose \
  --env-file .env.local \
  -f infra/dev/docker-compose.full.local.yml \
  up -d --build
