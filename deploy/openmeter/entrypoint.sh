#!/bin/sh
# Render Railway config (postgres password) then exec OpenMeter binary.
set -eu

PASS="${OPENMETER_POSTGRES_PASSWORD:-postgres}"
sed "s|\${OPENMETER_POSTGRES_PASSWORD}|${PASS}|g" \
  /etc/openmeter/config.railway.yaml >/etc/openmeter/config.yaml

if [ "${1:-}" = "openmeter" ]; then
  shift
  exec openmeter --address "0.0.0.0:${PORT:-8888}" --config /etc/openmeter/config.yaml "$@"
fi

if [ "$#" -gt 0 ]; then
  exec "$@" --config /etc/openmeter/config.yaml
fi

exec openmeter --address "0.0.0.0:${PORT:-8888}" --config /etc/openmeter/config.yaml
