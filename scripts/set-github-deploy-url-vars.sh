#!/usr/bin/env bash
# Canonical deployment URLs for GitHub Environment links (Deployments sidebar).
# Requires: gh auth login, write access to pymthouse/pymthouse
#
#   bash scripts/set-github-deploy-url-vars.sh
#   bash scripts/set-github-deploy-url-vars.sh --dry-run
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-pymthouse/pymthouse}"
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

set_var() {
  local name="$1"
  local value="$2"
  if $DRY_RUN; then
    echo "gh variable set $name --body '$value' -R $REPO"
  else
    gh variable set "$name" --body "$value" -R "$REPO"
    echo "set $name"
  fi
}

set_var VERCEL_PRODUCTION_URL "https://pymthouse.com"
set_var VERCEL_PREVIEW_URL "https://staging.pymthouse.com"
set_var RAILWAY_PREVIEW_SIGNER_URL "https://pymthouse-preview.up.railway.app"

if [[ -n "${RAILWAY_PRODUCTION_SIGNER_URL:-}" ]]; then
  set_var RAILWAY_PRODUCTION_SIGNER_URL "$RAILWAY_PRODUCTION_SIGNER_URL"
else
  echo "Optional: export RAILWAY_PRODUCTION_SIGNER_URL=https://your-prod-signer.up.railway.app"
  echo "  then re-run to set the railway / production environment link."
fi

echo "Done. GitHub deploy workflows use these for environment URLs."
