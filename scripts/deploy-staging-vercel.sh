#!/usr/bin/env bash
# Deploy the current branch to pymthouse-staging as Production (not Preview).
#
# Environment variables are read from the pymthouse-staging Vercel project
# dashboard — this script does not push or modify secrets.
#
# Prerequisites: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

vercel link --project pymthouse-staging --yes >/dev/null
vercel deploy --prod --yes

echo "Deployed branch $(git rev-parse --abbrev-ref HEAD) to pymthouse-staging production."
echo "URL: https://pymthouse-staging.vercel.app"
