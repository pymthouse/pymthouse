# livepeer-mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes the **Livepeer
network** to MCP clients, powered by [PymtHouse](https://pymthouse.com). It
organizes the network around **capabilities**: clients first see capabilities at
a summary level, then run **discovery by capability**, then **start jobs** —
with authentication handled seamlessly through PymtHouse's device-code login.

It is a thin server over
[`livepeer-gateway-client`](https://github.com/pymthouse/livepeer-gateway-client),
which provides the OIDC login flows and the live (lv2v) gateway job client.

## Tool surface

| Tool | Auth | What it does |
| --- | --- | --- |
| `login` | — | Begin device-code sign-in; returns a verification URL + user code. Completes in the background. |
| `auth_status` | — | Whether a valid session is cached. |
| `logout` | — | Clear the cached token. |
| `list_capabilities` | none | Summary-level capabilities — pipelines and their models (`GET /pipeline-catalog`). |
| `discover_by_capability` | none | Concrete providers + pricing for a pipeline/model (`GET /pipeline-pricing`). |
| `start_job` | required | Connect a live (lv2v) job; returns a handle and a `publish_url`. |
| `get_job_status` | required | Status of a started job. |
| `get_job_result` | required | The job's live publish endpoint (see note on live jobs below). |
| `stop_job` | required | Tear down a job's session. |
| `list_jobs` | — | Live jobs tracked by this process. |

### A note on "results"

Livepeer jobs here are **live video-to-video** streaming sessions. `start_job`
negotiates a payment session with an orchestrator (paid with your device-auth
token) and returns a `publish_url`. The "result" is the live stream produced
from frames you publish into that URL with a media client — there is no static
result file to download. `get_job_result` therefore returns the streaming
endpoint, not a blob.

## Install

Requires Python ≥ 3.10.

```bash
pip install -e .
# or, without cloning:
# pip install git+https://github.com/pymthouse/livepeer-mcp-server.git
```

This pulls in `livepeer-gateway-client` (and its PyAV dependency) from the
PymtHouse org repo.

## Configure

All settings are environment variables; defaults target PymtHouse staging. See
[`.env.example`](./.env.example).

| Variable | Default | Notes |
| --- | --- | --- |
| `PYMTHOUSE_BASE_URL` | `https://staging.pymthouse.com` | Single knob; issuer + API base derive from it. |
| `LIVEPEER_OIDC_BASE_URL` | `${PYMTHOUSE_BASE_URL}/api/v1/oidc` | OIDC issuer for device login. |
| `PYMTHOUSE_API_BASE_URL` | `${PYMTHOUSE_BASE_URL}/api/v1` | Capability/pricing REST base. |
| `LIVEPEER_CLIENT_ID` | `livepeer-sdk` | Public OIDC client id. |
| `LIVEPEER_SCOPES` | `openid profile gateway` | Requested scopes. |
| `LIVEPEER_DISCOVERY_URL` | — | **Required for `start_job`** — orchestrator discovery service. |
| `LIVEPEER_MODEL_ID` | — | Optional default model for `start_job`. |

## Run

```bash
livepeer-mcp        # stdio transport
# or: python -m livepeer_mcp
```

### Register with an MCP client

```json
{
  "mcpServers": {
    "livepeer": {
      "command": "livepeer-mcp",
      "env": {
        "PYMTHOUSE_BASE_URL": "https://staging.pymthouse.com",
        "LIVEPEER_DISCOVERY_URL": "https://discovery.example.com/v1/discovery/raw"
      }
    }
  }
}
```

## End-to-end example

A typical client conversation (list → discover → auth → start → result):

1. **`list_capabilities`** →
   ```json
   { "count": 1, "capabilities": [
     { "id": "live-video-to-video", "name": "Live V2V", "models": ["streamdiffusion-sdxl"] }
   ] }
   ```
2. **`discover_by_capability`** `{ "pipeline": "live-video-to-video", "model": "streamdiffusion-sdxl" }` →
   ```json
   { "count": 2, "providers": [
     { "orchAddress": "0x…", "priceWeiPerUnit": "…", "pixelsPerUnit": "…", "isWarm": true }
   ] }
   ```
3. **`login`** → returns `verification_uri` + `user_code`; approve in a browser.
   Poll **`auth_status`** until `authenticated: true`. (Token is cached for reuse.)
4. **`start_job`** `{ "model_id": "streamdiffusion-sdxl" }` →
   ```json
   { "job_id": "a1b2c3d4e5f6", "status": "connected",
     "publish_url": "https://…", "manifest_id": "…" }
   ```
5. Stream frames into `publish_url` from your media client, then **`stop_job`**
   `{ "job_id": "a1b2c3d4e5f6" }`.

## Development

```bash
pip install -e ".[dev]"
pytest
```

The `config` and `pymthouse` modules are covered by unit tests (no network, no
credentials). Auth and job modules are thin wrappers over
`livepeer-gateway-client` and are exercised against a live PymtHouse instance.

## License

MIT
