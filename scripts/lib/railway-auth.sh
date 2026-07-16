# shellcheck shell=bash
# Shared Railway CLI auth for pymthouse deploy scripts.
#
# Token types (Railway docs):
#   RAILWAY_API_TOKEN — Account → Tokens (workspace scope). Use for CI + link/redeploy/up.
#   RAILWAY_TOKEN     — Project → Settings → Tokens (one env). Use for variable set / up only.
#
# Either token works when commands pass --project and --environment (no railway link).

railway_default_project_id() {
  echo "${RAILWAY_PROJECT_ID:-dab233aa-dd5f-429d-8cc4-9042e8735e2b}"
}

railway_export_auth() {
  # The Railway CLI treats RAILWAY_TOKEN as a project token whenever it is
  # PRESENT — even as an empty string (e.g. `RAILWAY_TOKEN: ${{ secrets.X }}`
  # in CI when the secret is unset). An empty project token => Unauthorized,
  # even when RAILWAY_API_TOKEN is valid. So always unset the token we are not
  # using before invoking the CLI.
  if [[ -n "${RAILWAY_API_TOKEN:-}" ]]; then
    unset RAILWAY_TOKEN
    export RAILWAY_API_TOKEN
    return 0
  fi
  if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
    unset RAILWAY_API_TOKEN
    export RAILWAY_TOKEN
    return 0
  fi
  # Neither token has a value: drop any empty vars so the CLI falls back to a
  # local `railway login` session instead of failing on an empty token.
  unset RAILWAY_API_TOKEN RAILWAY_TOKEN
  if railway whoami >/dev/null 2>&1; then
    return 0
  fi
  echo "Railway auth required. Use ONE of:" >&2
  echo "  Account token (recommended for CI): Railway → Account → Tokens → create →" >&2
  echo "    export RAILWAY_API_TOKEN=<token>" >&2
  echo "    gh secret set RAILWAY_API_TOKEN -R pymthouse/pymthouse" >&2
  echo "  Project token: PymtHouse project → Settings → Tokens → Environment production →" >&2
  echo "    export RAILWAY_TOKEN=<token>" >&2
  echo "  Local CLI login: unset RAILWAY_API_TOKEN RAILWAY_TOKEN && railway login" >&2
  return 1
}

# Args: environment name (e.g. production)
railway_pe_flags() {
  echo "-p $(railway_default_project_id) -e $1"
}

railway_stack_json() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  echo "${RAILWAY_STACK_JSON:-$here/config/railway/stack.json}"
  return 0
}

# True when service is listed in stack.json previewOnlyServices.
railway_is_preview_only_service() {
  local service="$1"
  local stack
  stack="$(railway_stack_json)"
  [[ -f "$stack" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  jq -e --arg s "$service" '(.previewOnlyServices // []) | index($s) != null' "$stack" >/dev/null 2>&1
}

# Print livepeerImage for a service from stack.json, or empty.
railway_service_livepeer_image() {
  local service="$1"
  local stack
  stack="$(railway_stack_json)"
  [[ -f "$stack" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg s "$service" '.services[$s].livepeerImage // empty' "$stack"
}

# Print services.<name>.manifest from stack.json, or empty.
railway_service_manifest() {
  local service="$1"
  local stack
  stack="$(railway_stack_json)"
  [[ -f "$stack" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg s "$service" '.services[$s].manifest // empty' "$stack"
}

# Set LIVEPEER_IMAGE from stack.json when present (Docker build ARG for signer DMZ).
railway_apply_livepeer_image() {
  local service="$1"
  local pe_flags="${2:-}"
  local img
  img="$(railway_service_livepeer_image "$service")"
  [[ -n "$img" ]] || return 0
  # shellcheck disable=SC2086
  railway_retry railway variable set "LIVEPEER_IMAGE=${img}" --service "$service" $pe_flags --skip-deploys >/dev/null
  echo "  $service: LIVEPEER_IMAGE=${img}"
}

# True when stderr looks like a transient network / API failure (retryable).
railway_retryable_failure() {
  local err_file="$1"
  grep -qiE \
    'timed out|timeout|Failed to fetch|error sending request|connection reset|connection refused|temporarily unavailable|\b502\b|\b503\b|\b429\b' \
    "$err_file"
}

# Run a Railway CLI command with exponential backoff on transient failures.
# Usage: railway_retry railway variable set KEY=val ...
railway_retry() {
  local max_attempts="${RAILWAY_CLI_MAX_ATTEMPTS:-5}"
  local delay="${RAILWAY_CLI_RETRY_DELAY_SEC:-5}"
  local attempt=1
  local rc err_file

  err_file="$(mktemp)"

  while true; do
    : >"$err_file"
    if "$@" 2>"$err_file"; then
      rm -f "$err_file"
      return 0
    fi
    rc=$?
    cat "$err_file" >&2
    if [[ $attempt -ge $max_attempts ]] || ! railway_retryable_failure "$err_file"; then
      rm -f "$err_file"
      return "$rc"
    fi
    echo "Railway CLI attempt $attempt/$max_attempts failed (transient); retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    if [[ $delay -gt 60 ]]; then
      delay=60
    fi
  done
}
