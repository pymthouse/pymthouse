#!/usr/bin/env bash
# Enable deploy-production-vercel.yml on push to main.
# Requires: gh auth login, VERCEL_TOKEN secret, write access to pymthouse/pymthouse
#
#   bash scripts/set-github-production-vercel-vars.sh
#   bash scripts/set-github-production-vercel-vars.sh --dry-run
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

set_var VERCEL_PRODUCTION_AUTO_DEPLOY "true"

echo "Done. Requires GitHub secret VERCEL_TOKEN (same as staging deploy)."
echo ""
echo "Optional: on Vercel → pymthouse project → Settings → Git → Ignored Build Step:"
echo "  exit 1"
echo "so native Git pushes do not double-deploy with this workflow."
