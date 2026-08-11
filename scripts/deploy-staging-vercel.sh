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

# Bare hostname, so a full URL and an already-bare host compare equal.
host_of() {
  local value="${1#http://}"
  value="${value#https://}"
  printf '%s' "${value%%/*}"
}

vercel link --project pymthouse --yes >/dev/null

# `vercel deploy` prints a bare URL on a TTY but a JSON envelope under
# --non-interactive (the default once the CLI detects an agent), so its stdout
# cannot be read as a URL directly. That mismatch used to leave the alias step
# failing on a deploy that otherwise looked successful, which silently kept
# staging on old code. Ask for JSON where the CLI documents --format, and keep
# scraping as the fallback for CLIs that predate it.
deploy_args=(deploy --yes)
if vercel deploy --help 2>&1 | grep -q -- '--format'; then
  deploy_args+=(--format json)
fi
deploy_output="$(vercel "${deploy_args[@]}")"

deployment_id="$(printf '%s' "$deploy_output" | jq -r 'if type == "object" then (.deployment.id // .id // empty) else empty end' 2>/dev/null || true)"
deployment_url="$(printf '%s' "$deploy_output" | jq -r 'if type == "object" then (.deployment.url // .url // empty) else empty end' 2>/dev/null || true)"
if [[ -z "$deployment_url" ]]; then
  deployment_url="$(printf '%s\n' "$deploy_output" | grep -Eo 'https://[A-Za-z0-9._-]+\.vercel\.app' | tail -n1 || true)"
fi
if [[ -z "$deployment_url" ]]; then
  echo "ERROR: could not read a deployment URL from \`vercel deploy\` output;" >&2
  echo "       $STAGING_DOMAIN was NOT re-aliased. Raw output:" >&2
  printf '%s\n' "$deploy_output" >&2
  exit 1
fi

if ! vercel alias set "$deployment_url" "$STAGING_DOMAIN"; then
  echo "ERROR: \`vercel alias set\` failed — https://$STAGING_DOMAIN still serves the previous deployment." >&2
  exit 1
fi

# A deployment that exists but is not aliased means staging keeps serving old
# code while the deploy looks fine, so assert the domain really moved.
aliased_json="$(vercel inspect "$STAGING_DOMAIN" --format json 2>/dev/null || true)"
aliased_id="$(printf '%s' "$aliased_json" | jq -r '.id // empty' 2>/dev/null || true)"
aliased_url="$(printf '%s' "$aliased_json" | jq -r '.url // empty' 2>/dev/null || true)"
if [[ -z "$aliased_url" ]]; then
  aliased_url="$(vercel inspect "$STAGING_DOMAIN" 2>&1 | grep -Eo 'https://[A-Za-z0-9._-]+\.vercel\.app' | head -n1 || true)"
fi

if [[ -n "$deployment_id" && -n "$aliased_id" ]]; then
  expected="$deployment_id"
  actual="$aliased_id"
else
  expected="$(host_of "$deployment_url")"
  actual="$(host_of "$aliased_url")"
fi
if [[ -z "$actual" ]]; then
  echo "ERROR: could not read which deployment $STAGING_DOMAIN points at;" >&2
  echo "       treat staging as unverified rather than deployed." >&2
  exit 1
fi
if [[ "$actual" != "$expected" ]]; then
  echo "ERROR: $STAGING_DOMAIN points at $actual, not the deployment just created ($expected)." >&2
  exit 1
fi
echo "Verified $STAGING_DOMAIN -> $expected"
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
