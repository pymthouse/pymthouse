#!/usr/bin/env bash
# Deploy a Railway service using a service-specific railway.json at repo root (temporary swap).
#
# Usage:
#   bash scripts/railway-deploy-from-manifest.sh <service> <environment> <manifest-dir>
# Example:
#   bash scripts/railway-deploy-from-manifest.sh kafka preview deploy/kafka
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICE="${1:?service name required}"
ENV="${2:-${RAILWAY_ENVIRONMENT:-production}}"
MANIFEST_DIR="${3:?manifest directory required (e.g. deploy/kafka)}"

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

MANIFEST_PATH="$ROOT/$MANIFEST_DIR/railway.json"
if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Missing $MANIFEST_PATH" >&2
  exit 1
fi

TMP_MANIFEST="$(mktemp)"
cp "$MANIFEST_PATH" "$TMP_MANIFEST"

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

railway_apply_livepeer_image "$SERVICE" "$PE_FLAGS"

# shellcheck disable=SC2086
railway_retry railway up -s "$SERVICE" $PE_FLAGS -d -m "deploy $SERVICE ($ENV)"

echo "Deployed $SERVICE to $ENV from $MANIFEST_DIR"
