#!/usr/bin/env bash
# Apply OpenMeter + signer env vars to a Railway environment from the current shell.
# Used by CI (secrets → env) and locally: source a filled .env then run this script.
#
#   export RAILWAY_TOKEN=...
#   export RAILWAY_ENVIRONMENT=production
#   export OPENMETER_POSTGRES_PASSWORD=...
#   bash scripts/railway-apply-stack-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV="${RAILWAY_ENVIRONMENT:-production}"
PROJECT_ID="${RAILWAY_PROJECT_ID:-dab233aa-dd5f-429d-8cc4-9042e8735e2b}"

if [[ -z "${RAILWAY_TOKEN:-}" ]]; then
  echo "RAILWAY_TOKEN is required" >&2
  exit 1
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

if [[ -z "${OPENMETER_POSTGRES_PASSWORD:-}" ]]; then
  echo "OPENMETER_POSTGRES_PASSWORD is required for the OpenMeter stack" >&2
  exit 1
fi

export RAILWAY_TOKEN
railway link -p "$PROJECT_ID" -e "$ENV" >/dev/null

set_kv() {
  local service="$1"
  shift
  railway variable set "$@" --service "$service" --environment "$ENV" --skip-deploys >/dev/null
  echo "  $service: set $# variable(s)"
}

echo "Applying stack env to Railway environment: $ENV"

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
if [[ "$ENV" == "production" && -z "$REDIS_ADDR" ]]; then
  REDIS_ADDR="openmeter-redis-prod.railway.internal:6379"
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

# Signer DMZ (pymthouse service)
NEXTAUTH_URL="${NEXTAUTH_URL:-https://pymthouse.com}"
if [[ -n "$NEXTAUTH_URL" ]]; then
  ISSUER="${OIDC_ISSUER:-${NEXTAUTH_URL%/}/api/v1/oidc}"
  set_kv pymthouse \
    "SIGNER_NETWORK=${SIGNER_NETWORK:-arbitrum-one-mainnet}" \
    "ETH_RPC_URL=${ETH_RPC_URL:-https://arb1.arbitrum.io/rpc}" \
    "NEXTAUTH_URL=${NEXTAUTH_URL%/}" \
    "OIDC_ISSUER=${ISSUER}" \
    "OIDC_AUDIENCE=${OIDC_AUDIENCE:-$ISSUER}" \
    "JWKS_URI=${JWKS_URI:-${ISSUER}/jwks}"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    railway variable set "DATABASE_URL=${DATABASE_URL}" --service pymthouse --environment "$ENV" --skip-deploys >/dev/null
  fi
  if [[ -n "${AUTH_TOKEN_PEPPER:-}" ]]; then
    railway variable set "AUTH_TOKEN_PEPPER=${AUTH_TOKEN_PEPPER}" --service pymthouse --environment "$ENV" --skip-deploys >/dev/null
  fi
  if [[ -n "${NEXTAUTH_SECRET:-}" ]]; then
    railway variable set "NEXTAUTH_SECRET=${NEXTAUTH_SECRET}" --service pymthouse --environment "$ENV" --skip-deploys >/dev/null
  fi
  echo "  pymthouse: signer + optional DB/OIDC secrets"
fi

echo "Done. Run scripts/railway-deploy-stack.sh $ENV to deploy."
