#!/usr/bin/env bash
# Enable staging CI deploy workflows (staging branch → Railway preview + Vercel staging).
# Requires: gh auth login, RAILWAY_API_TOKEN + VERCEL_TOKEN secrets
#
#   bash scripts/set-github-preview-deploy-vars.sh
#   bash scripts/set-github-preview-deploy-vars.sh --dry-run
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

set_var RAILWAY_PREVIEW_AUTO_DEPLOY "true"
set_var VERCEL_PREVIEW_AUTO_DEPLOY "true"

echo "Done."
echo "Also run: bash scripts/set-github-deploy-url-vars.sh"
