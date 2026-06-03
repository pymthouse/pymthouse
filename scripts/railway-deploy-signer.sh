#!/usr/bin/env bash
# Deploy signer DMZ (Apache + go-livepeer) to the pymthouse Railway service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICE="${1:-pymthouse}"
ENV="${2:-${RAILWAY_ENVIRONMENT:-production}}"

if [[ -z "${RAILWAY_TOKEN:-}" ]]; then
  echo "RAILWAY_TOKEN is required" >&2
  exit 1
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

SIGNER_MANIFEST="$ROOT/deploy/pymthouse/railway.json"
TMP_MANIFEST="$(mktemp)"
cp "$SIGNER_MANIFEST" "$TMP_MANIFEST"

HAD_ROOT_MANIFEST=0
[[ -f "$ROOT/railway.json" ]] && HAD_ROOT_MANIFEST=1
LEGACY_ROOT=""
if [[ -f "$ROOT/railway.json" ]]; then
  LEGACY_ROOT="$(mktemp)"
  cp "$ROOT/railway.json" "$LEGACY_ROOT"
fi

restore_manifest() {
  if [[ "$HAD_ROOT_MANIFEST" -eq 1 && -n "$LEGACY_ROOT" ]]; then
    cp "$LEGACY_ROOT" "$ROOT/railway.json"
    rm -f "$LEGACY_ROOT"
  elif [[ "$HAD_ROOT_MANIFEST" -eq 0 ]]; then
    rm -f "$ROOT/railway.json"
  fi
  rm -f "$TMP_MANIFEST"
}
trap restore_manifest EXIT

cp "$TMP_MANIFEST" "$ROOT/railway.json"

export RAILWAY_TOKEN
railway link -p "${RAILWAY_PROJECT_ID:-dab233aa-dd5f-429d-8cc4-9042e8735e2b}" -e "$ENV" >/dev/null
railway service link "$SERVICE"
railway up -s "$SERVICE" -d -m "signer DMZ deploy ($ENV)"

echo "Deployed signer DMZ to $SERVICE in $ENV"
