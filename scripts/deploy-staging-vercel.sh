#!/usr/bin/env bash
# Deploy the current branch to pymthouse Preview and alias staging.pymthouse.com.
#
# Environment variables are read from the pymthouse Vercel project dashboard.
# Run scripts/apply-pymthouse-preview-vercel-env.sh once to sync Preview secrets/URLs.
#
# Prerequisites: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGING_DOMAIN="${VERCEL_PREVIEW_ALIAS_DOMAIN:-staging.pymthouse.com}"

vercel link --project pymthouse --yes >/dev/null
deployment_url="$(vercel deploy --yes)"
vercel alias set "$deployment_url" "$STAGING_DOMAIN" >/dev/null

echo "Deployed branch $(git rev-parse --abbrev-ref HEAD)"
echo "  deployment: $deployment_url"
echo "  staging:    https://$STAGING_DOMAIN"
