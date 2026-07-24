# Kong Dev Portal (optional)

Publish sliced OpenAPI specs from this repo to a Kong Konnect Dev Portal so
integrators can browse Control + Discovery APIs (and Livepeer MCP connect
metadata) without exposing billing/admin surfaces.

## Specs

| File | Use |
| --- | --- |
| [`openapi/livepeer-control.openapi.json`](../openapi/livepeer-control.openapi.json) | PymtHouse Builder slice: apps, signing, catalog, `/api/v1/mcp` |
| [`openapi/discovery-service.openapi.yaml`](../openapi/discovery-service.openapi.yaml) | Standalone discovery-service API |

These files are **portal packaging only** — they do not change the runtime API.

## Auth

Use a Konnect **application auth strategy** pointed at the PymtHouse OIDC issuer:

- Issuer: `https://pymthouse.com/api/v1/oidc`
- Discovery: `https://pymthouse.com/api/v1/oidc/.well-known/openid-configuration`

Portal login / application registration should issue tokens callers can pass to
PymtHouse as `Authorization: Bearer …` (including Livepeer MCP at `/api/v1/mcp`).

## Publish checklist

1. Create or select a Kong Dev Portal in Konnect.
2. Attach the PymtHouse OIDC application auth strategy (e.g. `pymthouse-oidc-prod`).
3. Upload / link both OpenAPI documents as portal API products (or portal pages).
4. Add a Connect page for Livepeer MCP:
   - URL: `https://pymthouse.com/api/v1/mcp`
   - Auth: Bearer API key or JWT from the portal strategy
5. Smoke-test: open the portal, sign in, hit Control health + MCP metadata GET.

## Local preview of specs

```bash
# Control (JSON)
jq '.info, (.paths | keys)' openapi/livepeer-control.openapi.json

# Discovery (YAML)
python3 -c 'import yaml; print(yaml.safe_load(open("openapi/discovery-service.openapi.yaml"))["info"])'
```
