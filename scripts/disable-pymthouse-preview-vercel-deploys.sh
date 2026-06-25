#!/usr/bin/env bash
# Disconnect the legacy pymthouse-preview Vercel project from GitHub so it stops
# creating deployments. Preview deploys are owned by the pymthouse project via
# .github/workflows/deploy-staging.yml (CI prebuilt deploy + staging.pymthouse.com alias).
#
# Also set Ignored Build Step → "Don't build anything" in the pymthouse-preview
# dashboard if PR checks still show timed-out deployments.
#
# Usage:
#   export VERCEL_TOKEN=...
#   bash scripts/disable-pymthouse-preview-vercel-deploys.sh
#   bash scripts/disable-pymthouse-preview-vercel-deploys.sh --dry-run
set -euo pipefail

VERCEL_ORG_ID="${VERCEL_ORG_ID:-team_JoeNhmK7pgiuSeOwgQASAUFl}"
PREVIEW_PROJECT_NAME="${PREVIEW_PROJECT_NAME:-pymthouse-preview}"
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  auth_path="${HOME}/.local/share/com.vercel.cli/auth.json"
  if [[ -f "$auth_path" ]]; then
    VERCEL_TOKEN="$(jq -r '.token' "$auth_path")"
  fi
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "VERCEL_TOKEN is required (export it or run: vercel login)" >&2
  exit 1
fi

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local query="${4:-teamId=${VERCEL_ORG_ID}}"
  local -a curl_args=(
    -sS
    -X "$method"
    -H "Authorization: Bearer ${VERCEL_TOKEN}"
    -H "Content-Type: application/json"
  )
  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi
  curl "${curl_args[@]}" "https://api.vercel.com${path}?${query}"
}

echo "Looking up Vercel project: ${PREVIEW_PROJECT_NAME}"
projects_json="$(api GET "/v9/projects" "" "teamId=${VERCEL_ORG_ID}&search=${PREVIEW_PROJECT_NAME}")"
project_id="$(echo "$projects_json" | jq -r --arg name "$PREVIEW_PROJECT_NAME" '
  (.projects // [])[] | select(.name == $name) | .id' | head -n1)"

if [[ -z "$project_id" || "$project_id" == "null" ]]; then
  echo "Project ${PREVIEW_PROJECT_NAME} not found under team ${VERCEL_ORG_ID}." >&2
  echo "If it was already removed, nothing to do." >&2
  exit 0
fi

project_json="$(api GET "/v9/projects/${project_id}")"
link_type="$(echo "$project_json" | jq -r '.link.type // empty')"
repo="$(echo "$project_json" | jq -r '.link.repo // empty')"

echo "Found ${PREVIEW_PROJECT_NAME} (${project_id})"
if [[ -n "$link_type" ]]; then
  echo "  Git link: ${link_type} → ${repo:-<unknown repo>}"
else
  echo "  Git link: none (already disconnected)"
  exit 0
fi

if $DRY_RUN; then
  echo "Dry run: would PATCH /v9/projects/${project_id} with link=null"
  exit 0
fi

echo "Disconnecting Git repository from ${PREVIEW_PROJECT_NAME}..."
response="$(api PATCH "/v9/projects/${project_id}" '{"link":null}')"
updated_link="$(echo "$response" | jq -r '.link // empty')"

if [[ -n "$updated_link" && "$updated_link" != "null" ]]; then
  echo "Vercel API did not clear the Git link. Response:" >&2
  echo "$response" | jq . >&2
  exit 1
fi

echo "Done. ${PREVIEW_PROJECT_NAME} no longer deploys from Git pushes."
echo "Preview deploys: push any non-main branch → deploy-staging.yml → pymthouse (Preview) → staging.pymthouse.com"
