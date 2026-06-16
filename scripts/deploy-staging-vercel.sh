#!/usr/bin/env bash
# Deploy the current checkout to pymthouse staging (Preview + staging.pymthouse.com alias).
#
# Intended for use on main. Environment variables are read from the pymthouse Vercel
# project dashboard. Run scripts/apply-pymthouse-preview-vercel-env.sh once to sync
# Preview secrets/URLs.
#
# Prerequisites: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGING_DOMAIN="${VERCEL_PREVIEW_ALIAS_DOMAIN:-staging.pymthouse.com}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ "$BRANCH" != "main" ]]; then
  echo "Error: deploy-staging-vercel.sh must be run from main (current branch: $BRANCH)" >&2
  exit 1
fi

export NEXTAUTH_URL="${VERCEL_PREVIEW_URL:-https://staging.pymthouse.com}"

vercel link --project pymthouse --yes >/dev/null
deployment_url="$(vercel deploy --yes)"
vercel alias set "$deployment_url" "$STAGING_DOMAIN"
echo "Deployed branch $BRANCH"
echo "  deployment: $deployment_url"
echo "  staging:    https://$STAGING_DOMAIN"
