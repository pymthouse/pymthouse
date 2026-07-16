#!/usr/bin/env bash
# Push signer DMZ + Turnkey env to Railway (pymthouse + pymthouse-signer-test A/B).
#
#   cp config/railway/signer.env.example config/railway/signer.env
#   $EDITOR config/railway/signer.env
#   bash scripts/railway-apply-signer-env.sh production
#   bash scripts/railway-apply-signer-env.sh production --deploy
#
# Override env file: SIGNER_RAILWAY_ENV_FILE=/path/to.env bash scripts/...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_NAME="${1:-production}"
DEPLOY=0
if [[ "${2:-}" == "--deploy" ]]; then
  DEPLOY=1
fi

ENV_FILE="${SIGNER_RAILWAY_ENV_FILE:-$ROOT/config/railway/signer.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "Copy config/railway/signer.env.example → config/railway/signer.env and fill Turnkey secrets." >&2
  exit 1
fi

# shellcheck source=lib/railway-auth.sh
source "$ROOT/scripts/lib/railway-auth.sh"
# shellcheck source=lib/railway-signer-env.sh
source "$ROOT/scripts/lib/railway-signer-env.sh"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

railway_export_auth || exit 1

PE_FLAGS="$(railway_pe_flags "$ENV_NAME")"
PROJECT_ID="$(railway_default_project_id)"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "Applying signer env from $(basename "$ENV_FILE") → Railway ($ENV_NAME, project $PROJECT_ID)"
railway_apply_signer_env pymthouse "$PE_FLAGS"
if railway_service_in_environment pymthouse-signer-test "$ENV_NAME"; then
  railway_apply_signer_env pymthouse-signer-test "$PE_FLAGS"
fi

if [[ "$DEPLOY" -eq 1 ]]; then
  echo "Deploying signer DMZ (stable)..."
  bash "$ROOT/scripts/railway-deploy-signer.sh" pymthouse "$ENV_NAME"
  if railway_service_in_environment pymthouse-signer-test "$ENV_NAME"; then
    echo "Deploying signer DMZ (A/B latest)..."
    bash "$ROOT/scripts/railway-deploy-signer.sh" pymthouse-signer-test "$ENV_NAME"
  fi
else
  echo "Done. Redeploy with: bash scripts/railway-apply-signer-env.sh $ENV_NAME --deploy"
  echo "  or: bash scripts/railway-deploy-signer.sh pymthouse $ENV_NAME"
  echo "      bash scripts/railway-deploy-signer.sh pymthouse-signer-test $ENV_NAME"
fi
