#!/usr/bin/env bash
# Deploy the PymtHouse clearinghouse Railway stack (kafka + collector + signer DMZ).
#
# Prerequisites:
#   - RAILWAY_API_TOKEN (account) or RAILWAY_TOKEN (project production token)
#   - Env applied: scripts/railway-apply-stack-env.sh (or dashboard)
#   - Kafka and collector services already created in Railway project
#
# Usage:
#   RAILWAY_API_TOKEN=... bash scripts/railway-deploy-stack.sh production
#   RAILWAY_API_TOKEN=... bash scripts/railway-deploy-stack.sh preview
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV="${1:-production}"
# shellcheck source=lib/railway-auth.sh
source "$ROOT/scripts/lib/railway-auth.sh"
PE_FLAGS="$(railway_pe_flags "$ENV")"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

railway_export_auth || exit 1

echo "=== Railway stack deploy: $ENV ==="

# Image services: kafka from Dockerfile; collector bundles Benthos config.
bash "$ROOT/scripts/railway-deploy-from-manifest.sh" kafka "$ENV" deploy/kafka
bash "$ROOT/scripts/railway-deploy-from-manifest.sh" openmeter-collector "$ENV" deploy/openmeter-collector

# Signer DMZ (service name: pymthouse) — the "stable" signer.
bash "$ROOT/scripts/railway-deploy-signer.sh" pymthouse "$ENV"

# A/B "latest" signer DMZ. Runs in the environments listed in stack.json
# (preview + production); LIVEPEER_IMAGE is pinned to a newer go-livepeer build.
if railway_service_in_environment pymthouse-signer-test "$ENV"; then
  bash "$ROOT/scripts/railway-deploy-signer.sh" pymthouse-signer-test "$ENV"
fi

echo "=== Stack deploy triggered for $ENV ==="
echo "After deploy, run a signed-ticket request and confirm collector events in OpenMeter."
