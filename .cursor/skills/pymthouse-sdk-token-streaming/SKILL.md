---
name: pymthouse-sdk-token-streaming
description: >-
  Get a PymtHouse application streaming token (base64 livepeer-python-gateway
  --token / sdkToken) for an app user API key, decode its signer/discovery
  payload, and stream live-video-to-video with the Python gateway. Use when
  minting app keys, building sdkToken, debugging eyJzaWduZXIi… tokens, or
  running write_frames / start_lv2v with --token.
---

<!-- Keep in sync with .claude/skills/pymthouse-sdk-token-streaming/SKILL.md -->

# PymtHouse app SDK token + streaming

This skill covers the **gateway `--token`** (also returned as `sdkToken` when minting keys), not OIDC access JWTs or M2M client credentials.

Related OAuth / Builder flows: skill `pymthouse-integrations`. Paid jobs / 402 spend gates: skill `pymthouse-payment-integration`.

## What the token is

The streaming token is **base64(JSON)**. Decoded shape:

```json
{
  "signer": "https://<client-signer-base-url>",
  "discovery": "https://<discovery>/v1/discovery/raw",
  "signer_headers": {
    "Authorization": "Bearer app_<24hex>_<secret>"
  }
}
```

| Field | Meaning |
| --- | --- |
| `signer` | Public remote-signer base URL clients call (from `getClientSignerApiUrl`) |
| `discovery` | Orchestrator discovery URL (`DISCOVERY_URL`, else `ORCH_WEBHOOK_URL`) |
| `signer_headers.Authorization` | Composite app-user API key as `Bearer app_<publicClientId>_<bareKey>` |

Example decode:

```bash
echo "$SDK_TOKEN" | base64 -d | jq .
```

Implementation: `src/lib/livepeer-python-sdk-token.ts` (`createLivepeerPythonSdkToken`).

**Do not confuse:**

| Credential | Use |
| --- | --- |
| `sdkToken` / `--token` (base64 JSON) | `livepeer-python-gateway` CLI/SDK |
| `apiKey` (`app_<24hex>_<secret>`) | `Authorization: Bearer` on signer, or RFC 8693 `subject_token` |
| OIDC JWT / signer-session JWT | Short-lived `sign:job` after token exchange |
| `m2m_…` + secret | Builder API Basic auth only — never put in `--token` |

## 1. Get a token for an application

You need the app’s **public** `client_id` (`app_…`) and an **app user** (`externalUserId`). Minting requires `users:write` (M2M Basic, machine Bearer, or provider dashboard session).

### A. Dashboard (quickest)

1. Open the app in PymtHouse → Testing / credentials.
2. Mint an owner (or user) API key.
3. Copy the **Token** format (base64 `sdkToken`), not only the Bearer key.
4. UI label points at [livepeer-python-gateway](https://github.com/livepeer/livepeer-python-gateway) `--token`.

### B. Builder API (canonical)

```bash
# Public client id in the path; authenticate as M2M (or authorized session)
export PYMTHOUSE_BASE="https://pymthouse-production.up.railway.app"   # or your host
export APP_CLIENT_ID="app_…"                                         # public app_…
export M2M_BASIC="$(printf '%s:%s' "$M2M_CLIENT_ID" "$M2M_CLIENT_SECRET" | base64 -w0)"
export EXTERNAL_USER_ID="owner-or-end-user-id"

# Upsert user (idempotent)
curl -sS -X POST "$PYMTHOUSE_BASE/api/v1/apps/$APP_CLIENT_ID/users" \
  -H "Authorization: Basic $M2M_BASIC" \
  -H "Content-Type: application/json" \
  -d "{\"externalUserId\":\"$EXTERNAL_USER_ID\",\"status\":\"active\"}"

# Mint key — secret + sdkToken shown once
curl -sS -X POST \
  "$PYMTHOUSE_BASE/api/v1/apps/$APP_CLIENT_ID/users/$(printf %s "$EXTERNAL_USER_ID" | jq -sRr @uri)/keys" \
  -H "Authorization: Basic $M2M_BASIC" \
  -H "Content-Type: application/json" \
  -d '{"label":"streaming"}'
```

Response (201) includes:

- `apiKey` — composite `app_<24hex>_<secret>` (store securely; not shown again)
- `sdkToken` — base64 `--token` for the Python gateway (preferred for streaming)

Route: `POST /api/v1/apps/{clientId}/users/{externalUserId}/keys`  
Code: `src/app/api/v1/apps/[id]/users/[externalUserId]/keys/route.ts`

### C. Build `sdkToken` from an existing API key

If you already have the composite key:

```bash
# Node one-liner against this repo’s helper, or equivalent:
# JSON → base64 with signer + discovery from env / known production URLs
python3 - <<'PY'
import base64, json, os
payload = {
  "signer": os.environ["SIGNER_URL"].rstrip("/") + "/",  # client signer base
  "discovery": os.environ["DISCOVERY_URL"],              # raw discovery URL
  "signer_headers": {
    "Authorization": f"Bearer {os.environ['API_KEY']}",  # app_…_…
  },
}
print(base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode())
PY
```

In-repo: `createLivepeerPythonSdkToken({ apiKey, signer?, discovery? })`.

Production-shaped defaults often look like:

- Signer: value from `PYMTHOUSE_CLIENT_SIGNER_API_URL` / `PYMTHOUSE_SIGNER_URL` / `SIGNER_PUBLIC_URL` (example host: `https://pymthouse-production.up.railway.app`)
- Discovery: `DISCOVERY_URL` or `ORCH_WEBHOOK_URL` (example: `https://discovery-service-production-8955.up.railway.app/v1/discovery/raw`)

## 2. Stream with the token

Use [livepeer/livepeer-python-gateway](https://github.com/livepeer/livepeer-python-gateway) (`livepeer_gateway` package). The `--token` carries signer, discovery, and Bearer key.

### Install

```bash
git clone https://github.com/livepeer/livepeer-python-gateway.git
cd livepeer-python-gateway
uv sync --extra examples
```

### Smoke-test discovery / orchestrators

```bash
export SDK_TOKEN='eyJ…'   # your sdkToken

uv run examples/get_orchestrator_info.py --token "$SDK_TOKEN"
```

### Publish frames (live-video-to-video)

```bash
# Synthetic frames (good connectivity check)
uv run examples/write_frames.py --token "$SDK_TOKEN" --model noop --count 90

# Real model once discovery shows capacity, e.g.:
uv run examples/write_frames.py --token "$SDK_TOKEN" --model streamdiffusion-sdxl
```

`write_frames.py` passes `token=` into `start_lv2v`; when `--token` is set you can omit orchestrator / `--signer`.

### Programmatic (`start_lv2v`)

```python
from livepeer_gateway.lv2v import StartJobRequest, start_lv2v

job = start_lv2v(
    orch_url=None,
    req=StartJobRequest(model_id="noop"),  # or streamdiffusion-sdxl, etc.
    token=SDK_TOKEN,  # base64 string from PymtHouse sdkToken
    timeout=5.0,
)
print(job.publish_url)
# then job.start_media(...) / write_frame — see examples/write_frames.py
await job.close()
```

Token field precedence (gateway): token `orchestrators` → explicit orch → token `discovery` → explicit discovery → signer-derived discovery. Token `signer` / `signer_headers` override missing CLI kwargs.

### Higher-level client (optional)

[pymthouse/livepeer-gateway-client](https://github.com/pymthouse/livepeer-gateway-client) wraps the same transport with JWT refresh / OIDC. For the PymtHouse-minted **base64 token**, prefer `livepeer-python-gateway` `--token` or decode and pass `signer_url` + `signer_headers` + `discovery_url` into `LivepeerClient`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `apiKey is required` / empty Bearer | Mint failed or you passed bare secret without `app_…_` prefix |
| `signer URL is required` | Env missing client signer URL when building token without `signer` |
| Discovery finds nothing | Token missing `discovery`, or URL wrong; decode and hit discovery with curl |
| 401 on signer | Key revoked, wrong app, or Bearer not the full composite `app_*_*` |
| Off-chain / unpaid jobs | Token omitted `--token` and no `--signer` → examples run offchain |
| Billing / identity | Signer webhook must accept the composite Bearer (see `docs/builder-api.md` credential types) |
| 402 / `trial_credits_exhausted` / `no_payment_method` | Token is fine; the **payer** is blocked — `GET …/billing/state` and skill `pymthouse-payment-integration` |

## Key files in this repo

| Area | Path |
| --- | --- |
| Encode `--token` | `src/lib/livepeer-python-sdk-token.ts` |
| Mint key + `sdkToken` | `src/app/api/v1/apps/[id]/users/[externalUserId]/keys/route.ts` |
| Client signer URL | `src/lib/signer-proxy.ts` → `getClientSignerApiUrl` |
| Dashboard Token/Bearer switcher | `src/components/apps/ApiKeyCredentialSwitcher.tsx` |
| Owner mint helper | `src/components/apps/mint-owner-api-key.ts` |
