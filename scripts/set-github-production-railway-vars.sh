#!/usr/bin/env bash
# Set recommended GitHub repository variables for deploy-railway-production.yml.
# Requires: gh auth login, write access to pymthouse/pymthouse
#
#   bash scripts/set-github-production-railway-vars.sh
#   bash scripts/set-github-production-railway-vars.sh --dry-run
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

set_var RAILWAY_PRODUCTION_NEXTAUTH_URL "https://pymthouse.com"
set_var RAILWAY_PRODUCTION_OPENMETER_REDIS_ADDRESS "openmeter-redis-prod.railway.internal:6379"

echo "Done. Enable deploys with: gh variable set RAILWAY_PRODUCTION_AUTO_DEPLOY --body true -R $REPO"
echo ""
echo "CI also needs: gh secret set RAILWAY_API_TOKEN -R $REPO"
echo "  (Railway → Account → Tokens — workspace scope; not Project → Settings → Tokens)"
