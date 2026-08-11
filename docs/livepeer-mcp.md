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
| `Basic` | App M2M `m2m_…:client_secret` (linked via `m2m_oidc_client_id` only) |
| **OAuth (Claude)** | Auth code + PKCE via Claude’s connector UI — paste only the MCP URL |

`create_signer_session` with M2M Basic requires `sign:job` on both the M2M client and the public app client (same gates as OIDC `client_credentials` owner `sign:job`).

No platform-fixed M2M behind the MCP.

### Connect Claude (URL only)

1. In Claude, add a custom connector / remote MCP server.
2. Paste your hosted MCP URL, e.g. `https://pymthouse.com/api/v1/mcp` (no query tokens).
3. Claude discovers OAuth from the `401` `WWW-Authenticate: Bearer resource_metadata=…` challenge, registers a public client (open DCR), and opens the browser login.
4. Sign in to PymtHouse, **select the Builder app** Claude should act as, and approve.
5. Access tokens are audience-bound to the MCP URL and include claim `pymthouse_app` (the app’s public `app_…` client id).

Discovery endpoints:

| Spec | Path |
| --- | --- |
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/v1/mcp` |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server/api/v1/oidc` |
| OpenID discovery | `/.well-known/openid-configuration` (includes `registration_endpoint`) |

Claude hosted redirect URIs accepted by DCR: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`. Claude Code loopback `http://localhost…/callback` / `http://127.0.0.1…/callback` is also allowed.

Optional: `DISCOVERY_SERVICE_URL` (aliases `DISCOVERY_URL`, `LIVEPEER_DISCOVERY_SERVICE_URL`) for orchestrator query / freshness. Set it to the **full raw endpoint**, matching the dashboard convention:

```
DISCOVERY_SERVICE_URL=https://discovery-service-production-8955.up.railway.app/v1/discovery/raw
```

`readDiscoveryServiceUrl()` takes the origin from that value to build `/v1/discovery/*` API calls; `readDiscoveryRawUrl()` returns it unchanged for `livepeer-python-gateway --token` payloads. A bare origin is also accepted (the raw path is backfilled). A value that is not an absolute http(s) URL throws rather than silently falling back to the hosted default. Both forms are reported by `livepeer_mcp_info` as `discovery_service_url` and `discovery_raw_url`.

```bash
curl -s "$NEXTAUTH_URL/api/v1/mcp" | jq .
# Unauthenticated MCP call → 401 + resource_metadata challenge
curl -si -X POST "$NEXTAUTH_URL/api/v1/mcp" -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' -d '{}' | head
```

Tools: `livepeer_mcp_info`, `list_capabilities`, `list_discovery_profiles`, `query_orchestrators`, `get_discovery_freshness`, `create_signer_session`.

Local execution client adds Storyboard-aligned network verbs: `run_capability`, `start_stream` / `write_stream_control` / `stop_stream`, `call_live_runner`.
