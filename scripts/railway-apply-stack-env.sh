#!/usr/bin/env bash
# Apply OpenMeter + signer env vars to a Railway environment from the current shell.
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

if [[ -z "${OPENMETER_POSTGRES_PASSWORD:-}" ]]; then
  echo "OPENMETER_POSTGRES_PASSWORD is required for the OpenMeter stack" >&2
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

# Postgres
set_kv openmeter-postgres \
  "POSTGRES_USER=postgres" \
  "POSTGRES_DB=postgres" \
  "POSTGRES_PASSWORD=${OPENMETER_POSTGRES_PASSWORD}" \
  "OPENMETER_POSTGRES_PASSWORD=${OPENMETER_POSTGRES_PASSWORD}" \
  "PGDATA=/var/lib/postgresql/data/pgdata"

# ClickHouse
CLICKHOUSE_PASSWORD="${OPENMETER_CLICKHOUSE_SECRET:-default}"
set_kv openmeter-clickhouse \
  "CLICKHOUSE_USER=default" \
  "CLICKHOUSE_DB=openmeter" \
  "CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}"

# Kafka (must match docker-compose.openmeter.railway.yml)
set_kv openmeter-kafka \
  "CLUSTER_ID=ca497efe-9f82-4b84-890b-d9969a9a2e1c" \
  "KAFKA_BROKER_ID=0" \
  "KAFKA_PROCESS_ROLES=broker,controller" \
  "KAFKA_CONTROLLER_QUORUM_VOTERS=0@openmeter-kafka:9093" \
  "KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER" \
  "KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL" \
  "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT" \
  "KAFKA_ADVERTISED_LISTENERS=INTERNAL://openmeter-kafka:9092" \
  "KAFKA_LISTENERS=INTERNAL://openmeter-kafka:9092,CONTROLLER://openmeter-kafka:9093" \
  "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1" \
  "KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0" \
  "KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1" \
  "KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1" \
  "KAFKA_AUTO_CREATE_TOPICS_ENABLE=false"

# OpenMeter app services
REDIS_ADDR="${OPENMETER_REDIS_ADDRESS:-}"
if [[ -z "$REDIS_ADDR" ]]; then
  if [[ "$ENV" == "production" ]]; then
    REDIS_ADDR="openmeter-redis-prod.railway.internal:6379"
  else
    REDIS_ADDR="openmeter-redis.railway.internal:6379"
  fi
fi
for svc in openmeter openmeter-sink-worker openmeter-balance-worker; do
  args=("OPENMETER_POSTGRES_PASSWORD=${OPENMETER_POSTGRES_PASSWORD}")
  if [[ -n "${OPENMETER_API_KEY:-}" ]]; then
    args+=("OPENMETER_API_KEY=${OPENMETER_API_KEY}")
  fi
  if [[ -n "$REDIS_ADDR" ]]; then
    args+=("OPENMETER_REDIS_ADDRESS=${REDIS_ADDR}")
  fi
  set_kv "$svc" "${args[@]}"
done

# Signer DMZ (pymthouse service). For signer-only updates use scripts/railway-apply-signer-env.sh.
export NEXTAUTH_URL="${NEXTAUTH_URL:-https://pymthouse.com}"
railway_apply_signer_env pymthouse "$PE_FLAGS"

echo "Done. Run scripts/railway-deploy-stack.sh $ENV to deploy."
