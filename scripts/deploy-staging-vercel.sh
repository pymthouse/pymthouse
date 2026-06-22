#!/usr/bin/env bash
# Deploy the current checkout to pymthouse staging (Vercel Preview + staging.pymthouse.com alias).
#
# Deploys any branch — staging is a shared, single-deployment alias, so the last
# run wins. Environment variables come from the pymthouse Vercel project dashboard
# (Preview scope); run scripts/apply-pymthouse-preview-vercel-env.sh once to sync.
#
# Requires: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set. The alias
# only works because pymthouse.com is a verified team domain under ecs-vercel
# (TXT verification, no nameserver migration); without that, `vercel alias set`
# fails with "you don't have access to the domain".
#
# Note: this deploys only the Vercel half. For a full staging bring-up (paired
# Railway preview backend + Vercel app) use the "Deploy staging" GitHub workflow.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGING_DOMAIN="${VERCEL_PREVIEW_ALIAS_DOMAIN:-staging.pymthouse.com}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

export NEXTAUTH_URL="https://${STAGING_DOMAIN}"

vercel link --project pymthouse --yes >/dev/null
deployment_url="$(vercel deploy --yes)"
vercel alias set "$deployment_url" "$STAGING_DOMAIN"
if [[ "${ASSIGN_STAGING_DOMAIN_BRANCH:-}" == "1" ]]; then
  if [[ "$BRANCH" == "HEAD" ]]; then
    echo "Skipping staging domain branch assignment: detached HEAD checkout" >&2
  else
    STAGING_GIT_BRANCH="$BRANCH" bash scripts/assign-staging-domain-branch.sh
  fi
fi
echo "Deployed branch $BRANCH"
echo "  deployment: $deployment_url"
echo "  staging:    https://$STAGING_DOMAIN"
