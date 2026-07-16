#!/usr/bin/env bash
# Assign staging.pymthouse.com to a Git branch on the pymthouse Vercel project.
#
# After assignment, Vercel auto-points the domain at the latest Preview deployment
# from that branch on every git push — no per-deploy `vercel alias set` needed for
# git-triggered builds. CI deploy-staging still runs `vercel alias set` after
# prebuilt deploys because those deployments are not always picked up by branch
# routing alone.
#
# Equivalent to: Project → Settings → Domains → staging.pymthouse.com → Edit →
# "Connect to an environment" → Preview → Git Branch.
#
# Usage:
#   bash scripts/assign-staging-domain-branch.sh
#   STAGING_GIT_BRANCH=feat/staging-fix bash scripts/assign-staging-domain-branch.sh
set -euo pipefail

STAGING_DOMAIN="${STAGING_DOMAIN:-staging.pymthouse.com}"
STAGING_GIT_BRANCH="${STAGING_GIT_BRANCH:-staging}"
VERCEL_ORG_ID="${VERCEL_ORG_ID:-team_JoeNhmK7pgiuSeOwgQASAUFl}"
VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-prj_oldvnmdXcGDc7Db5ohPCOUGBZOaG}"

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "VERCEL_TOKEN is required (export it or run after vercel login — token from ~/.local/share/com.vercel.cli/auth.json)" >&2
  exit 1
fi

body="$(jq -n --arg branch "$STAGING_GIT_BRANCH" '{gitBranch: $branch}')"
api_url="https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/domains/${STAGING_DOMAIN}?teamId=${VERCEL_ORG_ID}"

echo "Assigning ${STAGING_DOMAIN} → git branch ${STAGING_GIT_BRANCH} (project ${VERCEL_PROJECT_ID})"

response_file="$(mktemp)"
http_status="$(curl -sS -o "$response_file" -w '%{http_code}' -X PATCH "$api_url" \
  -H "Authorization: Bearer ${VERCEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$body")"
response="$(<"$response_file")"

if [[ "$http_status" == "404" ]] &&
  jq -e '.error.code == "not_found" and .error.message == "Project Domain not found."' \
    <<<"$response" >/dev/null 2>&1; then
  echo "${STAGING_DOMAIN} is not a project domain yet; adding it with the branch assignment"
  body="$(jq -n \
    --arg name "$STAGING_DOMAIN" \
    --arg branch "$STAGING_GIT_BRANCH" \
    '{name: $name, gitBranch: $branch}')"
  api_url="https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/domains?teamId=${VERCEL_ORG_ID}"
  http_status="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST "$api_url" \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$body")"
  response="$(<"$response_file")"
fi

rm -f "$response_file"

if (( http_status < 200 || http_status >= 300 )); then
  echo "Vercel API request failed (HTTP $http_status)" >&2
  if echo "$response" | jq . >/dev/null 2>&1; then
    echo "$response" | jq . >&2
  else
    echo "$response" >&2
  fi
  exit 1
fi

echo "$response" | jq '{name, gitBranch, verified, projectId}'
echo "Done. Push to ${STAGING_GIT_BRANCH} to refresh https://${STAGING_DOMAIN}."
