# Livepeer MCP

Platform-wide, **user-scoped** MCP on PymtHouse. Callers authenticate as a developer, end-user, or M2M client; tools and network capabilities follow that principal’s app discovery settings (network manifest + discovery profiles).

| Mode | Where | Tools |
| --- | --- | --- |
| **Hosted** | This app: `POST/GET /api/v1/mcp` | App network catalog + discovery profiles + `create_signer_session` |
| **Local client** | [`livepeer-python-gateway/examples/comfypeer-mcp`](https://github.com/livepeer/livepeer-python-gateway) | Same discovery/session + live-runner / BYOC / LV2V execution |

## Auth (no fixed app M2M behind the MCP)

Hosted MCP authenticates **to** the caller credential:

| Scheme | Credential |
| --- | --- |
| `Authorization: Bearer …` | App user API key (`pmth_…` or composite `app_…_…`), or developer/end-user JWT |
| `Authorization: Basic …` | App M2M `client_id:client_secret` (mints a signer session for the app owner) |

Kong Dev Portal / OIDC clients authenticate the same way — pass the resulting Bearer to `/api/v1/mcp`. PymtHouse does **not** keep a shared ComfyPeer M2M secret to proxy auth.

Optional infra only:

- `DISCOVERY_SERVICE_URL` (or `DISCOVERY_URL`) for orchestrator query / freshness

## Hosted MCP

```bash
# Metadata (no auth)
curl -s "$NEXTAUTH_URL/api/v1/mcp" | jq .

# Cursor / MCP client
# url: https://<pymthouse-host>/api/v1/mcp
# headers: Authorization: Bearer <api-key-or-jwt>
```

Hosted tools:

- `livepeer_mcp_info`
- `list_network_capabilities` — app network manifest (exclusions / allowlist)
- `list_discovery_profiles` — plans + discovery profile bundles
- `query_network_orchestrators` — discovery-service query, filtered to the app allowlist
- `get_discovery_freshness`
- `create_signer_session` — `SignerSession` (+ optional `sdk_token` for local gateway)

Customize what agents see with the app’s **Network** settings (manifest exclusions and discovery profiles) in the Builder UI / Builder API.

## Local execution client

```bash
cd /path/to/livepeer-python-gateway/examples/comfypeer-mcp
cp .env.example .env
uv sync && uv run comfypeer-mcp
# http://127.0.0.1:8090/mcp — ALLOW_LOOPBACK_DISCOVERY=1 for localhost:8935
```

## Builder paths

| Need | Path |
| --- | --- |
| API key → signer JWT | `POST /api/v1/apps/{clientId}/oidc/token` (RFC 8693) |
| App network manifest | `GET /api/v1/apps/{id}/manifest` |
| Catalog (raw) | discovery-service `/v1/discovery/*` |

## Kong Dev Portal

Wire portal OIDC to PymtHouse (`pymthouse-oidc-prod` or equivalent). Clients use the issued access token (or an API key) as the Livepeer MCP Bearer.
