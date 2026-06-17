#!/usr/bin/env bash
# One-time / rare sync of staging env vars from local .env.local → Vercel dashboard.
#
# Normal deploys (scripts/deploy-staging-vercel.sh or .github/workflows/deploy-staging.yml) do NOT
# run this script. Secrets should live in the Vercel dashboard; never commit
# .env.vercel.production or .env.vercel.preview.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env.local ]]; then
  echo "Missing .env.local" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a && source .env.local && set +a
# shellcheck disable=SC1091
[[ -f /tmp/pymthouse-staging-secrets.env ]] && source /tmp/pymthouse-staging-secrets.env

STAGING_URL="${STAGING_URL:-https://pymthouse-staging.vercel.app}"
STAGING_URL="${STAGING_URL%/}"
SIGNER_BASE="${SIGNER_BASE:-https://pymthouse-preview.up.railway.app}"
# Issuer matches staging host (same as NEXTAUTH_URL + /api/v1/oidc); signer DMZ must trust this + staging JWKS.
OIDC_ISSUER_VAL="${OIDC_ISSUER_VAL:-${STAGING_URL}/api/v1/oidc}"

add_env() {
  local key="$1" val="$2"
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf '%s' "$val" | vercel env add "$key" production >/dev/null 2>&1
  echo "  set $key"
}

vercel link --project pymthouse-staging --yes >/dev/null

add_env DATABASE_URL "$DATABASE_URL"
add_env NEXTAUTH_URL "$STAGING_URL"
add_env NEXTAUTH_SECRET "${NEXTAUTH_SECRET:-$(openssl rand -base64 32)}"
add_env AUTH_TOKEN_PEPPER "$AUTH_TOKEN_PEPPER"
add_env OIDC_ISSUER "$OIDC_ISSUER_VAL"
add_env SIGNER_INTERNAL_URL "$SIGNER_BASE"
add_env SIGNER_CLI_URL "${SIGNER_BASE}/__signer_cli"
add_env SIGNER_NETWORK "${SIGNER_NETWORK:-arbitrum-one-mainnet}"
add_env ETH_RPC_URL "${ETH_RPC_URL:-https://arb1.arbitrum.io/rpc}"
add_env OPENMETER_TRIAL_FEATURE_KEY "${OPENMETER_TRIAL_FEATURE_KEY:-network_spend}"
add_env PLATFORM_JWKS_URL "${STAGING_URL}/api/v1/oidc/jwks"

# Starter plan included allowance (USD micros). Legacy .env.local name still accepted.
STARTER_INCLUDED_USD_MICROS="${OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS:-${OPENMETER_DEV_AUTO_GRANT_USD_MICROS:-5000000}}"
STARTER_INCLUDED_USD_MICROS="${STARTER_INCLUDED_USD_MICROS%%#*}"
STARTER_INCLUDED_USD_MICROS="$(echo "$STARTER_INCLUDED_USD_MICROS" | tr -d '[:space:]')"
add_env OPENMETER_DEFAULT_STARTER_INCLUDED_USD_MICROS "$STARTER_INCLUDED_USD_MICROS"

if [[ -n "${INGEST_SHARED_SECRET:-}" ]]; then
  add_env INGEST_SHARED_SECRET "$INGEST_SHARED_SECRET"
fi

if [[ -n "${OPENMETER_URL:-}" ]]; then
  add_env OPENMETER_URL "$OPENMETER_URL"
fi
if [[ -n "${OPENMETER_API_KEY:-}" ]]; then
  add_env OPENMETER_API_KEY "$OPENMETER_API_KEY"
fi
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  add_env GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
  add_env GOOGLE_CLIENT_SECRET "${GOOGLE_CLIENT_SECRET:-}"
fi
if [[ -n "${GITHUB_CLIENT_ID:-}" ]]; then
  add_env GITHUB_CLIENT_ID "$GITHUB_CLIENT_ID"
  add_env GITHUB_CLIENT_SECRET "${GITHUB_CLIENT_SECRET:-}"
fi
if [[ -n "${NEXT_PUBLIC_ORGANIZATION_ID:-}" ]]; then
  add_env NEXT_PUBLIC_ORGANIZATION_ID "$NEXT_PUBLIC_ORGANIZATION_ID"
  add_env NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID "${NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID:-}"
fi

echo "Vercel pymthouse-staging env configured (NEXTAUTH_URL=$STAGING_URL)"
