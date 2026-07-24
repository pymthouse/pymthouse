# Livepeer MCP

User-scoped MCP on PymtHouse (`GET/POST /api/v1/mcp`). Auth with the caller’s own credential; network tools follow that app’s discovery settings.

| Mode | Where |
| --- | --- |
| **Hosted** | `/api/v1/mcp` — manifest, discovery profiles, orchestrator query, `create_signer_session` |
| **Local** | [`livepeer-python-gateway/examples/comfypeer-mcp`](https://github.com/livepeer/livepeer-python-gateway) — same + `run_capability` / `start_stream` / `call_live_runner` |

## Auth

| Scheme | Credential |
| --- | --- |
| `Bearer` | User API key (`pmth_…` / `app_…_…`) or developer/end-user JWT |
| `Basic` | App M2M `client_id:client_secret` (owner signer session) |

No platform-fixed M2M behind the MCP. Optional: `DISCOVERY_SERVICE_URL` for orchestrator query / freshness.

```bash
curl -s "$NEXTAUTH_URL/api/v1/mcp" | jq .
# MCP client: Authorization: Bearer <api-key-or-jwt>
```

Tools: `livepeer_mcp_info`, `list_capabilities`, `list_discovery_profiles`, `query_orchestrators`, `get_discovery_freshness`, `create_signer_session`.

Local execution client adds Storyboard-aligned network verbs: `run_capability`, `start_stream` / `write_stream_control` / `stop_stream`, `call_live_runner`.
