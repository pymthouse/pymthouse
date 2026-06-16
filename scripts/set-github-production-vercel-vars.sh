#!/usr/bin/env bash
# Enable deploy-production-vercel.yml on v* tag push (or via release.yml).
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

echo "Done. Requires GitHub secret VERCEL_TOKEN (same token used for preview deploys)."
echo ""
echo "Next: bash scripts/set-github-deploy-url-vars.sh"
echo ""
echo "Vercel → pymthouse → Settings → Git:"
echo "  Ignored Build Step: exit 1 (CI owns production deploys)"
echo "  Optional: disable Pull Request Comments to reduce GitHub deployment noise"
