#!/usr/bin/env bash
# Sync pymthouse Preview env vars for a staging branch on Vercel.
#
# Vercel Preview vars are branch-scoped when a custom domain is tied to a branch.
# Default branch: current git branch, or set PREVIEW_GIT_BRANCH.
#
# Usage:
#   set -a && source .env.local && set +a
#   bash scripts/apply-pymthouse-preview-vercel-env.sh
#   PREVIEW_GIT_BRANCH=staging bash scripts/apply-pymthouse-preview-vercel-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  set -a && source .env.local && set +a
fi

STAGING_URL="${STAGING_URL:-https://staging.pymthouse.com}"
STAGING_URL="${STAGING_URL%/}"
SIGNER_BASE="${SIGNER_BASE:-https://pymthouse-preview.up.railway.app}"
_git_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -z "${PREVIEW_GIT_BRANCH:-}" ]]; then
  if [[ -z "$_git_branch" || "$_git_branch" == "HEAD" ]]; then
    PREVIEW_GIT_BRANCH="staging"
  else
    PREVIEW_GIT_BRANCH="$_git_branch"
  fi
fi
OIDC_ISSUER_VAL="${STAGING_URL}/api/v1/oidc"

if [[ -z "${OPENMETER_URL:-}" ]]; then
  echo "OPENMETER_URL is required (source .env.local or export Konnect URL)" >&2
  exit 1
fi

add_preview_env() {
  local key="$1" val="$2"
  local -a extra=()
  case "$key" in
    DATABASE_URL|NEXTAUTH_SECRET|AUTH_TOKEN_PEPPER|OPENMETER_API_KEY|WEBHOOK_SECRET)
      extra+=(--sensitive)
      ;;
    *)
      ;;
  esac
  vercel env add "$key" preview "$PREVIEW_GIT_BRANCH" \
    --value "$val" --yes --force "${extra[@]}" >/dev/null
  echo "  set $key (preview / $PREVIEW_GIT_BRANCH)"
}

vercel link --project pymthouse --yes >/dev/null

echo "Applying Preview env for branch: $PREVIEW_GIT_BRANCH"

add_preview_env NEXTAUTH_URL "$STAGING_URL"
add_preview_env OIDC_ISSUER "$OIDC_ISSUER_VAL"
add_preview_env PLATFORM_JWKS_URL "${STAGING_URL}/api/v1/oidc/jwks"
add_preview_env SIGNER_INTERNAL_URL "$SIGNER_BASE"
add_preview_env SIGNER_CLI_URL "${SIGNER_BASE}/__signer_cli"
add_preview_env OPENMETER_URL "${OPENMETER_URL%/}"
add_preview_env OPENMETER_ROUTE_MODE "${OPENMETER_ROUTE_MODE:-hosted}"

if [[ -n "${OPENMETER_API_KEY:-}" ]]; then
  add_preview_env OPENMETER_API_KEY "$OPENMETER_API_KEY"
fi
if [[ -n "${WEBHOOK_SECRET:-}" ]]; then
  add_preview_env WEBHOOK_SECRET "$WEBHOOK_SECRET"
fi

echo "Done. Redeploy preview so runtime picks up vars."
echo "  NEXTAUTH_URL=$STAGING_URL"
echo "  OPENMETER_URL=${OPENMETER_URL%/}"
echo ""
echo "Assign domain to branch:"
echo "  STAGING_GIT_BRANCH=$PREVIEW_GIT_BRANCH bash scripts/assign-staging-domain-branch.sh"
