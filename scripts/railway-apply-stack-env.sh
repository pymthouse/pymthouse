#!/usr/bin/env bash
# Apply clearinghouse stack env vars to a Railway environment from the current shell.
# Used by CI (secrets → env) and locally: source a filled .env then run this script.
#
#   export RAILWAY_API_TOKEN=...   # Account → Tokens (best for GitHub Actions)
#   # or export RAILWAY_TOKEN=...  # Project → Settings → Tokens (production)
#   export RAILWAY_ENVIRONMENT=production
#   export OPENMETER_POSTGRES_PASSWORD=...
#   bash scripts/railway-apply-stack-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=lib/railway-auth.sh
source "$ROOT/scripts/lib/railway-auth.sh"
# shellcheck source=lib/railway-signer-env.sh
source "$ROOT/scripts/lib/railway-signer-env.sh"

ENV="${RAILWAY_ENVIRONMENT:-production}"
PROJECT_ID="$(railway_default_project_id)"
PE_FLAGS="$(railway_pe_flags "$ENV")"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

railway_export_auth || exit 1

if [[ -z "${OPENMETER_URL:-}" ]]; then
  echo "OPENMETER_URL is required (hosted OpenMeter/Konnect API base)" >&2
  exit 1
fi
if [[ -z "${OPENMETER_API_KEY:-}" ]]; then
  echo "OPENMETER_API_KEY is required for collector ingest" >&2
  exit 1
fi
if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "WEBHOOK_SECRET is required for remote signer webhook auth" >&2
  exit 1
fi

set_kv() {
  local service="$1"
  shift
  # shellcheck disable=SC2086
  railway_retry railway variable set "$@" --service "$service" $PE_FLAGS --skip-deploys >/dev/null
  echo "  $service: set $# variable(s)"
}

echo "Applying stack env to Railway environment: $ENV (project $PROJECT_ID)"

# Warm up API connectivity before bulk writes (CI runners sometimes hit a slow first request).
# shellcheck disable=SC2086
railway_retry railway variables --service pymthouse $PE_FLAGS >/dev/null
echo "Railway API reachable."

# Railway private DNS — ignore docker-compose localhost defaults from sourced .env files.
if [[ -n "${RAILWAY_ENVIRONMENT:-}" ]]; then
  KAFKA_BROKERS="kafka.railway.internal:9092"
  unset OIDC_ISSUER OIDC_AUDIENCE JWKS_URI
  if [[ "${REMOTE_SIGNER_WEBHOOK_URL:-}" == *localhost* \
    || "${REMOTE_SIGNER_WEBHOOK_URL:-}" == *host.docker.internal* \
    || -z "${REMOTE_SIGNER_WEBHOOK_URL:-}" ]]; then
    REMOTE_SIGNER_WEBHOOK_URL="${NEXTAUTH_URL:-https://pymthouse.com}/webhooks/remote-signer"
  fi
fi

# Kafka bus for signer monitor events.
set_kv kafka \
  "CLUSTER_ID=ca497efe-9f82-4b84-890b-d9969a9a2e1c"

KAFKA_BROKERS="${KAFKA_BROKERS:-kafka.railway.internal:9092}"
KAFKA_GATEWAY_TOPIC="${KAFKA_GATEWAY_TOPIC:-livepeer-gateway-events}"
ETH_USD_PRICE="${ETH_USD_PRICE:-3500}"

REMOTE_SIGNER_WEBHOOK_URL="${REMOTE_SIGNER_WEBHOOK_URL:-${NEXTAUTH_URL:-https://pymthouse.com}/webhooks/remote-signer}"

OPENMETER_INGEST_URL="${OPENMETER_INGEST_URL:-${OPENMETER_URL}/events}"

set_kv openmeter-collector \
  "KAFKA_BROKERS=${KAFKA_BROKERS}" \
  "KAFKA_GATEWAY_TOPIC=${KAFKA_GATEWAY_TOPIC}" \
  "OPENMETER_URL=${OPENMETER_URL}" \
  "OPENMETER_INGEST_URL=${OPENMETER_INGEST_URL}" \
  "OPENMETER_API_KEY=${OPENMETER_API_KEY}" \
  "ETH_USD_PRICE=${ETH_USD_PRICE}"

# Signer DMZ (pymthouse service). For signer-only updates use scripts/railway-apply-signer-env.sh.
export NEXTAUTH_URL="${NEXTAUTH_URL:-https://pymthouse.com}"
export KAFKA_BROKERS
export KAFKA_GATEWAY_TOPIC
export REMOTE_SIGNER_WEBHOOK_URL
export WEBHOOK_SECRET
railway_apply_signer_env pymthouse "$PE_FLAGS"

echo "Done. Run scripts/railway-deploy-stack.sh $ENV to deploy."
