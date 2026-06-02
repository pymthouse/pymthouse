#!/usr/bin/env bash
# Bootstrap meters/features on a Railway-hosted OpenMeter (or any remote URL).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${OPENMETER_URL:-}" ]]; then
  echo "OPENMETER_URL is required (e.g. https://openmeter-production.up.railway.app)" >&2
  exit 1
fi

OPENMETER_URL="${OPENMETER_URL%/}"
echo "[openmeter-railway-bootstrap] waiting for ${OPENMETER_URL} ..."

for i in $(seq 1 60); do
  if curl -sf "${OPENMETER_URL}/api/v1/debug/metrics" >/dev/null; then
    echo "[openmeter-railway-bootstrap] API healthy"
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "[openmeter-railway-bootstrap] timed out waiting for OpenMeter" >&2
    exit 1
  fi
  sleep 5
done

export OPENMETER_URL
npm run openmeter:bootstrap

echo "[openmeter-railway-bootstrap] done — set Vercel OPENMETER_URL=${OPENMETER_URL}"
