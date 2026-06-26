#!/usr/bin/env bash
# Migrate Railway preview from self-hosted OpenMeter to the clearinghouse stack
# (kafka + openmeter-collector + pymthouse signer DMZ → hosted Konnect).
#
# Removes legacy OpenMeter services from the preview environment only (production
# is untouched). Creates kafka + openmeter-collector if missing, applies env, deploys.
#
# Required env (source .env.local or export manually):
#   OPENMETER_URL          https://us.api.konghq.com/v3/openmeter
#   OPENMETER_API_KEY      Konnect personal access token
#   WEBHOOK_SECRET         must match Vercel staging REMOTE_SIGNER webhook secret
#
# Optional:
#   NEXTAUTH_URL           default https://staging.pymthouse.com
#   RAILWAY_PROJECT_ID     default from config/railway/stack.json
#
# Usage:
#   set -a && source .env.local && set +a
#   export WEBHOOK_SECRET=...   # if not in .env.local
#   bash scripts/railway-migrate-preview-clearinghouse.sh
#   bash scripts/railway-migrate-preview-clearinghouse.sh --skip-delete
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV=preview
SKIP_DELETE=false
if [[ "${1:-}" == "--skip-delete" ]]; then
  SKIP_DELETE=true
fi

# shellcheck source=lib/railway-auth.sh
source "$ROOT/scripts/lib/railway-auth.sh"
PE_FLAGS="$(railway_pe_flags "$ENV")"
PROJECT_ID="$(railway_default_project_id)"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

railway_export_auth || exit 1

export RAILWAY_ENVIRONMENT="$ENV"
# Preview signer must match Vercel staging — do not inherit localhost from .env.local.
export NEXTAUTH_URL="${RAILWAY_PREVIEW_NEXTAUTH_URL:-${NEXTAUTH_URL:-https://staging.pymthouse.com}}"
if [[ "$NEXTAUTH_URL" == *localhost* ]]; then
  export NEXTAUTH_URL="https://staging.pymthouse.com"
fi

if [[ -z "${OPENMETER_URL:-}" || -z "${OPENMETER_API_KEY:-}" || -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "OPENMETER_URL, OPENMETER_API_KEY, and WEBHOOK_SECRET are required." >&2
  echo "Example: set -a && source .env.local && set +a && export WEBHOOK_SECRET=..." >&2
  exit 1
fi

service_exists() {
  local name="$1"
  railway service list -p "$PROJECT_ID" -e "$ENV" --json 2>/dev/null \
    | python3 -c "import json,sys; data=json.load(sys.stdin); print('yes' if any(s.get('name')==sys.argv[1] for s in data) else 'no')" "$name"
}

ensure_service() {
  local name="$1"
  if [[ "$(service_exists "$name")" == "yes" ]]; then
    echo "Service $name already exists."
    return 0
  fi
  echo "Creating service $name ..."
  railway_retry railway add --service "$name" --json >/dev/null
}

configure_kafka_image() {
  if [[ "$(service_exists kafka)" != "yes" ]]; then
    return 0
  fi
  echo "Configuring kafka image source ..."
  # shellcheck disable=SC2086
  railway_retry railway service source connect \
    --service kafka \
    --image redpandadata/redpanda:v24.2.4 \
    $PE_FLAGS
}

LEGACY_SERVICES=(
  openmeter
  openmeter-balance-worker
  openmeter-clickhouse
  openmeter-kafka
  openmeter-postgres
  openmeter-redis
  openmeter-sink-worker
)

echo "=== Preview clearinghouse migration (project $PROJECT_ID) ==="

ensure_service kafka
ensure_service openmeter-collector

echo "Configuring service root directories (monorepo railway.json isolation) ..."
bash "$ROOT/scripts/railway-configure-service-roots.sh" preview

configure_kafka_image

if ! $SKIP_DELETE; then
  echo "Removing legacy OpenMeter services from preview environment ..."
  for svc in "${LEGACY_SERVICES[@]}"; do
    if [[ "$(service_exists "$svc")" != "yes" ]]; then
      echo "  skip $svc (not in preview)"
      continue
    fi
    echo "  delete $svc from $ENV"
    # shellcheck disable=SC2086
    railway_retry railway service delete --service "$svc" $PE_FLAGS --yes
  done
else
  echo "Skipping legacy service deletion (--skip-delete)."
fi

echo "Applying clearinghouse env vars ..."
bash "$ROOT/scripts/railway-apply-stack-env.sh"

echo "Deploying clearinghouse stack ..."
bash "$ROOT/scripts/railway-deploy-stack.sh" "$ENV"

echo "=== Preview migration complete ==="
echo "Signer: https://pymthouse-preview.up.railway.app"
echo "Point Vercel preview OPENMETER_URL at: $OPENMETER_URL"
echo "Ensure Vercel preview WEBHOOK_SECRET matches Railway pymthouse WEBHOOK_SECRET."
