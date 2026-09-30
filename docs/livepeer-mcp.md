# Livepeer MCP

Paste **only** this URL. Do not add headers, API keys, or a query token.

```
https://pymthouse.com/api/v1/mcp
```

The server is Streamable HTTP at `/api/v1/mcp`. PymtHouse is the OIDC issuer (`https://pymthouse.com/api/v1/oidc`). OAuth is CIMD + DCR + PKCE S256. Public clients only (`token_endpoint_auth_method: none`). Codex, ChatGPT, and Hermes use CIMD when the authorization server advertises `client_id_metadata_document_supported`.

Spend is the signed-in user’s **Livepeer Direct** usage — the same personal-key billing target as a `pmth_*` network key. These five clients are not Builder apps and have no plans, M2M client, or marketplace listing.

| Mode | Where |
| --- | --- |
| **Hosted** | `/api/v1/mcp` — `list_capabilities`, discovery profiles, orchestrator query, `create_signer_session` |
| **Local** | [`livepeer-python-gateway/examples/comfypeer-mcp`](https://github.com/livepeer/livepeer-python-gateway) — same + `run_capability` / `start_stream` / `call_live_runner` |

## Auth

| Scheme | Credential |
| --- | --- |
| `Bearer` | User API key (`pmth_…` / `app_…_…`) or developer/end-user JWT |
| `Basic` | App M2M `m2m_…:client_secret` (linked via `m2m_oidc_client_id` only) |
| **OAuth** | Auth code + PKCE from Claude, Hermes, Codex, ChatGPT, or Cursor |

`create_signer_session` with M2M Basic requires `sign:job` on both the M2M client and the public app client (same gates as OIDC `client_credentials` owner `sign:job`).

Unauthenticated `GET /api/v1/mcp` returns RFC 9728 protected-resource metadata and includes `resource`. Tool calls without a token return `401` with `WWW-Authenticate` `resource_metadata` pointing at this origin’s protected-resource metadata. The authorization server for that resource is the PymtHouse issuer.

Discovery endpoints:

| Spec | Path |
| --- | --- |
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/v1/mcp` |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server/api/v1/oidc` (`client_id_metadata_document_supported`, `registration_endpoint`) |
| OpenID discovery | `/.well-known/openid-configuration` |

You can also Link / Unlink these clients from the dashboard after sign-in. Linking and inbound MCP OAuth end in the same per-user grant on Livepeer Direct. Unlink revokes that client’s grant only — not personal keys or other clients.

## Claude

Settings → Connectors → Add custom connector. Paste **only** the MCP URL.

Claude will:

1. Hit `/api/v1/mcp`, receive `401` + `WWW-Authenticate` with `resource_metadata` (or read GET protected-resource metadata)
2. Read Protected Resource Metadata (`authorization_servers` = the PymtHouse issuer)
3. Identify itself with CIMD (`https://claude.ai/oauth/mcp-oauth-client-metadata` or `https://claude.com/oauth/mcp-oauth-client-metadata`) or register via DCR, then run PKCE
4. Open a browser. Sign in to PymtHouse and approve. Consent does **not** ask you to pick a Builder app.
5. Store the user JWT + refresh token. Spend is Livepeer Direct / personal-key usage.

Hosted callbacks: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`. Claude Code loopback `http://localhost…/callback` / `http://127.0.0.1…/callback` is also allowed.

## Cursor

Add a Streamable HTTP MCP server in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "livepeer-mcp": {
      "type": "http",
      "url": "https://pymthouse.com/api/v1/mcp"
    }
  }
}
```

Cursor does not publish a CIMD document. It registers with DCR, or you can set static `CLIENT_ID` `mcp_cursor`. Desktop DCR uses `cursor://anysphere.cursor-mcp/oauth/callback`. Web / Cursor Agents use `https://www.cursor.com/agents/mcp/oauth/callback` and `https://cursor.com/agents/mcp/oauth/callback`. `http://localhost:8787/callback` is RFC 8252 loopback.

Do not invent a chatgpt.com-style Cursor CIMD URL.

## Codex

In Codex Desktop: Settings → MCP servers → Add server. Transport **Streamable HTTP**, URL `https://pymthouse.com/api/v1/mcp`, then Authenticate.

Or add it in `~/.codex/config.toml` and log in:

```toml
[mcp_servers.livepeer]
url = "https://pymthouse.com/api/v1/mcp"
```

```bash
codex mcp login livepeer
```

Codex probes `GET /api/v1/mcp` first and treats a 200 as Protected Resource Metadata (RFC 9728), so that JSON includes `resource`. It then identifies itself with a ChatGPT-hosted CIMD document (`https://chatgpt.com/oauth/codex/…/client.json` or `https://chatgpt.com/oauth/codex/client.json`) and a loopback redirect (`http://127.0.0.1:<port>/callback`). The AS accepts RFC 8252 variable ports and `127.0.0.1` ↔ `localhost`. Do not invent API keys.

## ChatGPT

Paste the MCP URL as a custom connector. ChatGPT CIMD is `https://chatgpt.com/oauth/<callback_id>/client.json`. Allowlisted callbacks are `https://chatgpt.com/connector/oauth/<callback_id>` and `https://chatgpt.com/connector_platform_oauth_redirect`. Sign in when the browser opens. Spend is Livepeer Direct.

## Hermes

```bash
hermes mcp add livepeer --url https://pymthouse.com/api/v1/mcp --auth oauth
hermes mcp login livepeer
```

Hermes identifies itself with a GitHub Pages CIMD document (`https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json`) and a loopback callback (`http://127.0.0.1:<port>/callback`). If Hermes is a remote gateway, use its documented paste-back / desktop-relay OAuth path.

## After login

Hosted tools: `list_capabilities`, `list_discovery_profiles`, `query_orchestrators`, `get_discovery_freshness`, `create_signer_session` (`confirm: true`). Resource: `livepeer://mcp/info`.

Local execution client adds `run_capability`, `start_stream` / `write_stream_control` / `stop_stream`, `call_live_runner`.

Optional: `DISCOVERY_SERVICE_URL` (aliases `DISCOVERY_URL`, `LIVEPEER_DISCOVERY_SERVICE_URL`) for orchestrator query / freshness. Set it to the **full raw endpoint**:

```
DISCOVERY_SERVICE_URL=https://discovery-service-production-8955.up.railway.app/v1/discovery/raw
```

```bash
curl -s "$NEXTAUTH_URL/api/v1/mcp" | jq .
# Unauthenticated MCP call → 401 + resource_metadata challenge
curl -si -X POST "$NEXTAUTH_URL/api/v1/mcp" -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' -d '{}' | head
```
