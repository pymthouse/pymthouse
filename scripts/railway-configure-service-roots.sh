#!/usr/bin/env bash
# Set Railway service root directories + config-as-code paths for the clearinghouse stack.
#
# Root railway.json points at signer-dmz; kafka and openmeter-collector must use their own
# deploy/*/railway.json via per-service rootDirectory + railwayConfigFile (GraphQL only).
#
# Usage:
#   bash scripts/railway-configure-service-roots.sh [preview|production|all]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=lib/railway-auth.sh
source "$ROOT/scripts/lib/railway-auth.sh"

SCOPE="${1:-all}"
PROJECT_ID="$(railway_default_project_id)"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: npm install -g @railway/cli" >&2
  exit 1
fi

railway_export_auth || exit 1

RAILWAY_TOKEN="${RAILWAY_API_TOKEN:-${RAILWAY_TOKEN:-}}"
if [[ -z "$RAILWAY_TOKEN" ]]; then
  RAILWAY_TOKEN="$(python3 -c "import json; print(json.load(open('$HOME/.railway/config.json'))['user'].get('accessToken') or '')")"
fi
if [[ -z "$RAILWAY_TOKEN" ]]; then
  echo "Railway token required (RAILWAY_API_TOKEN or railway login)." >&2
  exit 1
fi

read_env_ids() {
  python3 -c "
import json
with open('$ROOT/config/railway/stack.json') as f:
    d = json.load(f)
for name, eid in d['environments'].items():
    print(name, eid)
"
}

service_instance_update() {
  local service_id="$1"
  local env_id="$2"
  local root_dir="$3"
  local config_file="$4"
  local payload
  payload="$(python3 -c "
import json
query = 'mutation(\$serviceId: String!, \$environmentId: String!, \$input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: \$serviceId, environmentId: \$environmentId, input: \$input) }'
print(json.dumps({
  'query': query,
  'variables': {
    'serviceId': '$service_id',
    'environmentId': '$env_id',
    'input': {
      'rootDirectory': '$root_dir',
      'railwayConfigFile': '$config_file',
      'dockerfilePath': 'Dockerfile',
    },
  },
}))
")"
  curl -sf https://backboard.railway.com/graphql/v2 \
    -H "Authorization: Bearer $RAILWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

configure_stack_roots() {
  local env_name="$1"
  local env_id="$2"
  echo "Configuring service roots for $env_name ($env_id) ..."
  service_instance_update "1e8249c5-55c4-4c3d-a989-82dd8819ff34" "$env_id" "deploy/kafka" "/deploy/kafka/railway.json"
  service_instance_update "6e59ba96-de2e-41ac-bf55-08480f88962d" "$env_id" "deploy/openmeter-collector" "/deploy/openmeter-collector/railway.json"
}

while read -r env_name env_id; do
  case "$SCOPE" in
    all)
      configure_stack_roots "$env_name" "$env_id"
      ;;
    preview|production)
      if [[ "$env_name" == "$SCOPE" ]]; then
        configure_stack_roots "$env_name" "$env_id"
      fi
      ;;
    *)
      echo "Unknown scope: $SCOPE (use preview, production, or all)" >&2
      exit 1
      ;;
  esac
done < <(read_env_ids)

echo "Service root directories configured (project $PROJECT_ID, scope=$SCOPE)."
