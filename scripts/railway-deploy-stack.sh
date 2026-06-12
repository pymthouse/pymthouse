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

# Image services: deploy from configured source.
for svc in kafka openmeter-collector; do
  echo "Deploying $svc from source ..."
  # shellcheck disable=SC2086
  railway_retry railway redeploy --service "$svc" $PE_FLAGS --from-source --yes
done

# Signer DMZ (service name: pymthouse)
bash "$ROOT/scripts/railway-deploy-signer.sh" pymthouse "$ENV"

echo "=== Stack deploy triggered for $ENV ==="
echo "After deploy, run a signed-ticket request and confirm collector events in OpenMeter."
