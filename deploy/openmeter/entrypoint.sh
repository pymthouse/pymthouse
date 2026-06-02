#!/bin/sh
# Render Railway config (postgres password) then exec OpenMeter binary.
set -eu

CONFIG_OUT="/tmp/openmeter.config.yaml"
PASS="${OPENMETER_POSTGRES_PASSWORD:-postgres}"
sed "s|\${OPENMETER_POSTGRES_PASSWORD}|${PASS}|g" \
  /etc/openmeter/config.railway.yaml >"${CONFIG_OUT}"

CMD="${1:-openmeter}"
shift || true

case "$CMD" in
  openmeter)
    exec openmeter --address "0.0.0.0:${PORT:-8888}" --config "${CONFIG_OUT}" "$@"
    ;;
  openmeter-sink-worker | openmeter-balance-worker)
    exec "$CMD" --config "${CONFIG_OUT}" "$@"
    ;;
  *)
    echo "entrypoint: unknown command ${CMD} (expected openmeter, openmeter-sink-worker, or openmeter-balance-worker)" >&2
    exit 1
    ;;
esac
