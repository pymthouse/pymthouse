# shellcheck shell=bash
# Apply signer DMZ + Turnkey env to a Railway service (default: pymthouse).
# Requires NEXTAUTH_URL and railway_pe_flags / railway_retry from railway-auth.sh.

railway_apply_signer_env() {
  local service="${1:-pymthouse}"
  local pe_flags="${2:-}"

  local nextauth_url="${NEXTAUTH_URL:-https://pymthouse.com}"
  nextauth_url="${nextauth_url%/}"
  local issuer="${OIDC_ISSUER:-${nextauth_url}/api/v1/oidc}"
  local audience="${OIDC_AUDIENCE:-$issuer}"
  local jwks_uri="${JWKS_URI:-${nextauth_url}/api/v1/oidc/jwks}"

  local -a signer_args=(
    "SIGNER_NETWORK=${SIGNER_NETWORK:-arbitrum-one-mainnet}"
    "ETH_RPC_URL=${ETH_RPC_URL:-https://arb1.arbitrum.io/rpc}"
    "KAFKA_BROKERS=${KAFKA_BROKERS:-kafka:9092}"
    "KAFKA_GATEWAY_TOPIC=${KAFKA_GATEWAY_TOPIC:-livepeer-gateway-events}"
    "REMOTE_SIGNER_WEBHOOK_URL=${REMOTE_SIGNER_WEBHOOK_URL:-${nextauth_url}/webhooks/remote-signer}"
    "WEBHOOK_SECRET=${WEBHOOK_SECRET:?WEBHOOK_SECRET is required for signer DMZ webhook auth}"
    "NEXTAUTH_URL=${nextauth_url}"
    "OIDC_ISSUER=${issuer}"
    "OIDC_AUDIENCE=${audience}"
    "JWKS_URI=${jwks_uri}"
    "SIGNER_DMZ_ENABLE_CLI_LISTENER=${SIGNER_DMZ_ENABLE_CLI_LISTENER:-0}"
    "SIGNER_REMOTE_DISCOVERY=${SIGNER_REMOTE_DISCOVERY:-0}"
    "TURNKEY_WALLET_NAME=${TURNKEY_WALLET_NAME:-livepeer-remote-signer}"
    "TURNKEY_API_HOST=${TURNKEY_API_HOST:-api.turnkey.com}"
  )

  if [[ -n "${ORCH_WEBHOOK_URL:-}" ]]; then
    signer_args+=("ORCH_WEBHOOK_URL=${ORCH_WEBHOOK_URL}")
  fi
  if [[ -n "${LIVE_AI_CAP_REPORT_INTERVAL:-}" ]]; then
    signer_args+=("LIVE_AI_CAP_REPORT_INTERVAL=${LIVE_AI_CAP_REPORT_INTERVAL}")
  fi

  if [[ -n "${TURNKEY_ORG_ID:-}" ]]; then
    signer_args+=("TURNKEY_ORG_ID=${TURNKEY_ORG_ID}")
  fi
  if [[ -n "${SIGNER_ETH_ADDR:-}" ]]; then
    signer_args+=("SIGNER_ETH_ADDR=${SIGNER_ETH_ADDR}")
  fi

  # shellcheck disable=SC2086
  railway_retry railway variable set "${signer_args[@]}" --service "$service" $pe_flags --skip-deploys >/dev/null
  echo "  $service: set ${#signer_args[@]} plain variable(s)"

  local turnkey_secret_count=0
  if [[ -n "${TURNKEY_API_PUBLIC_KEY:-}" ]]; then
    # shellcheck disable=SC2086
    railway_retry railway variable set "TURNKEY_API_PUBLIC_KEY=${TURNKEY_API_PUBLIC_KEY}" --service "$service" $pe_flags --skip-deploys >/dev/null
    turnkey_secret_count=$((turnkey_secret_count + 1))
  fi
  if [[ -n "${TURNKEY_API_PRIVATE_KEY:-}" ]]; then
    # shellcheck disable=SC2086
    railway_retry railway variable set "TURNKEY_API_PRIVATE_KEY=${TURNKEY_API_PRIVATE_KEY}" --service "$service" $pe_flags --skip-deploys >/dev/null
    turnkey_secret_count=$((turnkey_secret_count + 1))
  fi
  if [[ -n "${SIGNER_ETH_KEYSTORE_PASSWORD:-}" ]]; then
    # shellcheck disable=SC2086
    railway_retry railway variable set "SIGNER_ETH_KEYSTORE_PASSWORD=${SIGNER_ETH_KEYSTORE_PASSWORD}" --service "$service" $pe_flags --skip-deploys >/dev/null
    turnkey_secret_count=$((turnkey_secret_count + 1))
  fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    # shellcheck disable=SC2086
    railway_retry railway variable set "DATABASE_URL=${DATABASE_URL}" --service "$service" $pe_flags --skip-deploys >/dev/null
    echo "  $service: set DATABASE_URL"
  fi
  if [[ -n "${AUTH_TOKEN_PEPPER:-}" ]]; then
    # shellcheck disable=SC2086
    railway_retry railway variable set "AUTH_TOKEN_PEPPER=${AUTH_TOKEN_PEPPER}" --service "$service" $pe_flags --skip-deploys >/dev/null
    echo "  $service: set AUTH_TOKEN_PEPPER"
  fi
  if [[ -n "${NEXTAUTH_SECRET:-}" ]]; then
    # shellcheck disable=SC2086
    railway_retry railway variable set "NEXTAUTH_SECRET=${NEXTAUTH_SECRET}" --service "$service" $pe_flags --skip-deploys >/dev/null
    echo "  $service: set NEXTAUTH_SECRET"
  fi

  if [[ -n "${TURNKEY_ORG_ID:-}" ]] && [[ "$turnkey_secret_count" -lt 3 ]]; then
    echo "  $service: WARNING Turnkey needs org id + 3 secrets; got ${turnkey_secret_count}/3" >&2
  elif [[ -n "${TURNKEY_ORG_ID:-}" ]]; then
    echo "  $service: Turnkey bootstrap enabled"
  elif [[ "$turnkey_secret_count" -gt 0 ]]; then
    echo "  $service: WARNING Turnkey secrets set but TURNKEY_ORG_ID missing" >&2
  fi

  echo "  $service: NEXTAUTH_URL=${nextauth_url}"
  return 0
}
