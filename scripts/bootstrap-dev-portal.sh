#!/usr/bin/env bash
# Print Kong Dev Portal packaging checklist (OpenAPI slices in openapi/).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cat <<EOF
Kong Dev Portal packaging (optional):

  Specs:
    ${ROOT}/openapi/livepeer-control.openapi.json
    ${ROOT}/openapi/discovery-service.openapi.yaml

  Docs:
    ${ROOT}/docs/kong-dev-portal.md

  Auth strategy issuer:
    https://pymthouse.com/api/v1/oidc

  MCP metadata (after Livepeer MCP is deployed):
    GET https://pymthouse.com/api/v1/mcp
EOF
