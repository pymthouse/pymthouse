#!/bin/sh
# Render Railway config (postgres password) then exec OpenMeter binary.
set -eu

CONFIG_OUT="/tmp/openmeter.config.yaml"
PASS="${OPENMETER_POSTGRES_PASSWORD:-postgres}"
sed "s|\${OPENMETER_POSTGRES_PASSWORD}|${PASS}|g" \
  /etc/openmeter/config.railway.yaml >"${CONFIG_OUT}"

if [ "${1:-}" = "openmeter" ]; then
  shift
  exec openmeter --address "0.0.0.0:${PORT:-8888}" --config "${CONFIG_OUT}" "$@"
fi

if [ "$#" -gt 0 ]; then
  exec "$@" --config "${CONFIG_OUT}"
fi

exec openmeter --address "0.0.0.0:${PORT:-8888}" --config "${CONFIG_OUT}"
