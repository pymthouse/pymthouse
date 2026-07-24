#!/usr/bin/env bash
# Print Livepeer MCP env checklist for hosted MCP + local gateway example.
set -euo pipefail

cat <<'EOF'
Livepeer MCP (PymtHouse hosted /api/v1/mcp):

  No fixed COMFYPEER_* / PYMTHOUSE_M2M_* required behind the MCP.
  Callers authenticate with their own Bearer API key/JWT or Basic M2M.

Optional:
  DISCOVERY_SERVICE_URL=https://discovery-service-production-8955.up.railway.app

Hosted: GET/POST /api/v1/mcp
Local:  livepeer-python-gateway/examples/comfypeer-mcp

See docs/livepeer-mcp.md
EOF
