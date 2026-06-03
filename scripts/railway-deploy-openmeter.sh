#!/usr/bin/env bash
# Deploy OpenMeter API or workers to Railway via CLI upload.
# Root railway.json is signer-only; OpenMeter uses deploy/openmeter/railway.json for uploads.
#
# Usage:
#   RAILWAY_API_TOKEN=... bash scripts/railway-deploy-openmeter.sh openmeter openmeter production
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=lib/railway-auth.sh
source "$ROOT/scripts/lib/railway-auth.sh"

CMD="${1:-openmeter}"
SERVICE="${2:-openmeter}"
ENV="${3:-${RAILWAY_ENVIRONMENT:-preview}}"
PE_FLAGS="$(railway_pe_flags "$ENV")"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

railway_export_auth || exit 1

case "$CMD" in
  openmeter | openmeter-sink-worker | openmeter-balance-worker) ;;
  *)
    echo "usage: $0 <openmeter|openmeter-sink-worker|openmeter-balance-worker> [service-name]" >&2
    exit 1
    ;;
esac

if [[ ! -f docker/signer-dmz/railway.json ]]; then
  echo "missing docker/signer-dmz/railway.json" >&2
  exit 1
fi

# Temporarily use OpenMeter config as upload manifest (Railway CLI reads ./railway.json).
SIGNER_MANIFEST=""
if [[ -f railway.json ]]; then
  SIGNER_MANIFEST="$ROOT/railway.json"
elif [[ -f docker/signer-dmz/railway.json ]]; then
  SIGNER_MANIFEST="$ROOT/docker/signer-dmz/railway.json"
fi

OM_MANIFEST="$ROOT/deploy/openmeter/railway.json"
TMP_MANIFEST="$(mktemp)"
cp "$OM_MANIFEST" "$TMP_MANIFEST"
python3 - "$TMP_MANIFEST" "$CMD" <<'PY'
import json, sys
path, cmd = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
deploy = data.setdefault("deploy", {})
deploy["startCommand"] = f"/entrypoint.sh {cmd}"
# Railway service health checks can fail before the full OpenMeter stack settles.
deploy.pop("healthcheckPath", None)
deploy.pop("healthcheckTimeout", None)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

HAD_ROOT_MANIFEST=0
[[ -f "$ROOT/railway.json" ]] && HAD_ROOT_MANIFEST=1

restore_manifest() {
  if [[ "$HAD_ROOT_MANIFEST" -eq 1 && -n "$SIGNER_MANIFEST" ]]; then
    cp "$SIGNER_MANIFEST" "$ROOT/railway.json"
  else
    rm -f "$ROOT/railway.json"
  fi
  rm -f "$TMP_MANIFEST"
}
trap restore_manifest EXIT

cp "$TMP_MANIFEST" "$ROOT/railway.json"

# shellcheck disable=SC2086
railway up -s "$SERVICE" $PE_FLAGS -d -m "openmeter $CMD"

echo "Deployed $CMD to service $SERVICE in $ENV"
