#!/usr/bin/env bash
# Deploy the current branch to pymthouse Preview.
#
# Environment variables are read from the pymthouse Vercel project
# dashboard — this script does not push or modify secrets.
#
# Prerequisites: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

vercel link --project pymthouse --yes >/dev/null
vercel deploy --yes

echo "Deployed branch $(git rev-parse --abbrev-ref HEAD) to pymthouse preview."
