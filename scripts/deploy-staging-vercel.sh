#!/usr/bin/env bash
# Deploy the current branch to pymthouse Preview.
#
# When Vercel project Domains maps staging.pymthouse.com → Preview → git branch
# feat/openmeter-hosted, matching preview deploys receive the domain automatically
# (no manual vercel alias needed).
#
# Environment variables are read from the pymthouse Vercel project dashboard.
# Run scripts/apply-pymthouse-preview-vercel-env.sh once to sync Preview secrets/URLs.
#
# Prerequisites: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGING_DOMAIN="${VERCEL_PREVIEW_ALIAS_DOMAIN:-staging.pymthouse.com}"
STAGING_ALIAS_BRANCH="${VERCEL_PREVIEW_ALIAS_BRANCH:-feat/openmeter-hosted}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

export NEXTAUTH_URL="${VERCEL_PREVIEW_URL:-https://staging.pymthouse.com}"

vercel link --project pymthouse --yes >/dev/null
deployment_url="$(vercel deploy --yes)"
echo "Deployed branch $BRANCH"
echo "  deployment: $deployment_url"
if [[ "$BRANCH" == "$STAGING_ALIAS_BRANCH" ]]; then
  echo "  staging:    https://$STAGING_DOMAIN (auto-assigned when gitBranch matches in Vercel Domains)"
fi
