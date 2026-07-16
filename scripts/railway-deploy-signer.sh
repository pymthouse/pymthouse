#!/usr/bin/env bash
# Deploy signer DMZ (Apache + go-livepeer) to the pymthouse Railway service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICE="${1:-pymthouse}"
ENV="${2:-${RAILWAY_ENVIRONMENT:-production}}"

# shellcheck source=lib/railway-auth.sh
source "$ROOT/scripts/lib/railway-auth.sh"
PE_FLAGS="$(railway_pe_flags "$ENV")"

if [[ "$ENV" == "production" ]] && railway_is_preview_only_service "$SERVICE"; then
  echo "refusing: $SERVICE is preview-only (not deployed to production)" >&2
  exit 1
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

railway_export_auth || exit 1

SIGNER_MANIFEST="$ROOT/deploy/pymthouse/railway.json"
_stack_manifest="$(railway_service_manifest "$SERVICE")"
if [[ -n "$_stack_manifest" ]]; then
  if [[ ! -f "$ROOT/$_stack_manifest" ]]; then
    echo "error: configured manifest $_stack_manifest for $SERVICE not found" >&2
    exit 1
  fi
  SIGNER_MANIFEST="$ROOT/$_stack_manifest"
fi

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

if ! cmp -s "$TMP_MANIFEST" "$ROOT/railway.json" 2>/dev/null; then
  cp "$TMP_MANIFEST" "$ROOT/railway.json"
fi

railway_apply_livepeer_image "$SERVICE" "$PE_FLAGS"

# shellcheck disable=SC2086
railway_retry railway up -s "$SERVICE" $PE_FLAGS -d -m "signer DMZ deploy ($ENV)"

echo "Deployed signer DMZ to $SERVICE in $ENV"
