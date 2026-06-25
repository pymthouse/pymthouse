#!/usr/bin/env bash
# Deploy main to the pymthouse Vercel project (pymthouse.com production).
#
# Environment variables are read from the pymthouse Vercel project dashboard.
#
# Prerequisites: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export VERCEL_ORG_ID="${VERCEL_ORG_ID:-team_JoeNhmK7pgiuSeOwgQASAUFl}"
export VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-prj_oldvnmdXcGDc7Db5ohPCOUGBZOaG}"

if [[ -z "${VERCEL_TOKEN:-}" ]] && ! vercel whoami >/dev/null 2>&1; then
  echo "Set VERCEL_TOKEN or run: vercel login" >&2
  exit 1
fi

vercel pull --yes --environment=production ${VERCEL_TOKEN:+--token="$VERCEL_TOKEN"}
vercel build --prod ${VERCEL_TOKEN:+--token="$VERCEL_TOKEN"}
deployment_url=$(vercel deploy --prebuilt --prod ${VERCEL_TOKEN:+--token="$VERCEL_TOKEN"})
vercel promote "$deployment_url" --yes ${VERCEL_TOKEN:+--token="$VERCEL_TOKEN"}

echo "Deployed and promoted to pymthouse production (https://pymthouse.com)."
