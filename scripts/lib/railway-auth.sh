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
  if [[ -n "${RAILWAY_API_TOKEN:-}" ]]; then
    export RAILWAY_API_TOKEN
    return 0
  fi
  if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
    export RAILWAY_TOKEN
    return 0
  fi
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
