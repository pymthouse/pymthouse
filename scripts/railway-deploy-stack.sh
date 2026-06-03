#!/usr/bin/env bash
# Deploy the full PymtHouse Railway stack (OpenMeter + signer DMZ) to preview or production.
#
# Prerequisites:
#   - RAILWAY_API_TOKEN (account) or RAILWAY_TOKEN (project production token)
#   - Env applied: scripts/railway-apply-stack-env.sh (or dashboard)
#   - Volumes on stateful services (first-time): see docs/openmeter-railway.md
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

# Stateful images: deploy from configured source (works for first deploy in a new environment).
for svc in openmeter-postgres openmeter-redis openmeter-kafka openmeter-clickhouse; do
  echo "Deploying $svc from source ..."
  # shellcheck disable=SC2086
  railway redeploy --service "$svc" $PE_FLAGS --from-source --yes
done

# OpenMeter images from repo
bash "$ROOT/scripts/railway-deploy-openmeter.sh" openmeter openmeter "$ENV"
bash "$ROOT/scripts/railway-deploy-openmeter.sh" openmeter-sink-worker openmeter-sink-worker "$ENV"
bash "$ROOT/scripts/railway-deploy-openmeter.sh" openmeter-balance-worker openmeter-balance-worker "$ENV"

# Signer DMZ (service name: pymthouse)
bash "$ROOT/scripts/railway-deploy-signer.sh" pymthouse "$ENV"

echo "=== Stack deploy triggered for $ENV ==="
echo "After openmeter is healthy, bootstrap: OPENMETER_URL=https://<openmeter-domain> npm run openmeter:railway:bootstrap"
