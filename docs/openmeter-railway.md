# OpenMeter + Collector on Railway (PymtHouse + Vercel)

Production now uses **hosted KongHQ OpenMeter** plus a Railway clearinghouse runtime:

- `pymthouse` signer-dmz (go-livepeer remote signer)
- `kafka` (Redpanda event bus)
- `openmeter-collector` (Kafka -> OpenMeter CloudEvents)

Set `OPENMETER_URL` to the hosted Konnect endpoint (`https://{region}.api.konghq.com/v3/openmeter`) and keep self-hosted OpenMeter compose files only for local/on-prem fallback.

## Architecture

```
┌─────────────────┐     HTTPS      ┌──────────────────────────────┐
│  PymtHouse      │ ──────────────►│  Konnect/OpenMeter hosted     │
│  (Vercel)       │  OPENMETER_URL │  metering + billing API       │
└─────────────────┘                └──────────────────────────────┘
        │
        │ SIGNER_INTERNAL_URL
        ▼
┌─────────────────────────────┐
│ Railway clearinghouse stack │
│ signer-dmz + kafka +        │
│ openmeter-collector         │
└─────────────────────────────┘
```

## Collector durable-ingest repoint (fix-step (a), opt-in)

Historically the `openmeter-collector` was the only path feeding OpenMeter, and it
delivered events **fire-and-forget** straight to the OpenMeter ingest URL with no
durability and several silent-drop branches (empty `auth_id`, mapping errors).
`deploy/collector.yaml` can now repoint the collector to the **durable, idempotent,
acked** ingest endpoint added by [PR #178](https://github.com/pymthouse/pymthouse/pull/178)
(`POST /api/v1/internal/ingest/signed-ticket`) and route malformed events to an
observable dead-letter instead of dropping them.

This is **opt-in and zero-regression by default**. With `COLLECTOR_DURABLE_INGEST`
unset/false the collector behaves byte-identically to before (direct-to-OpenMeter).

| Env (on the `openmeter-collector` service) | Default | Purpose |
|---|---|---|
| `COLLECTOR_DURABLE_INGEST` | unset (OFF) | Master toggle. `true`/`1`/`yes`/`on` enables the durable repoint. |
| `COLLECTOR_DURABLE_INGEST_MODE` | `double_write` | `double_write` = fan out to BOTH the legacy OpenMeter sink and the durable endpoint (recommended rollout). `cutover` = durable endpoint only. |
| `PYMTHOUSE_INGEST_URL` | — | Base URL of the pymthouse app (e.g. `https://pymthouse.com`); the collector appends `/api/v1/internal/ingest/signed-ticket`. Required when ON. |
| `INGEST_SHARED_SECRET` | — | Shared bearer secret the endpoint (PR #178) verifies; sent as `Authorization: Bearer …`. Required when ON. |

`scripts/railway-apply-stack-env.sh` applies these to the collector **only when set**
in the calling environment, so leaving them unset keeps the legacy behavior.

Retry / idempotency semantics:

- The durable `http_client` retries with bounded backoff on connection errors and
  `429`/`5xx` (including the endpoint's transient `502`); `2xx` (including an
  idempotent duplicate) is success.
- Idempotency is enforced server-side on `(clientId, requestId)`, so retries and the
  `double_write` overlap never double-count (OpenMeter also dedupes on the
  CloudEvent `id = request_id`).
- On exhausted retries or a permanent `4xx`, the event falls through to the
  dead-letter (ERROR-logged) instead of vanishing silently. In `double_write` the
  legacy OpenMeter sink has already delivered it, so there is no metering loss.

> **Dependency / scope.** This repoint only fixes losses **from the collector onward**;
> it relies on PR #178 being deployed (endpoint live, `SIGNED_TICKET_DURABLE_INGEST=1`
> on the pymthouse app) to actually write to OpenMeter. Events dropped **before**
> reaching Kafka (the go-livepeer in-process producer) are a separate producer-side
> follow-up (b); go-livepeer webhook #3963 was parked to keep go-livepeer vendor-neutral.

### Manual verification recipe

Pre-req: PR #178 deployed with `SIGNED_TICKET_DURABLE_INGEST=1` and `INGEST_SHARED_SECRET`
set on the pymthouse app; the collector configured with the four vars above.

1. **Lint / start check (no cluster needed):**
   ```bash
   docker run --rm -e KAFKA_BROKERS=x -e KAFKA_GATEWAY_TOPIC=t \
     -e OPENMETER_URL=http://om -e OPENMETER_INGEST_URL=http://om/events \
     -e OPENMETER_API_KEY=k -e ETH_USD_PRICE=3500 \
     -e PYMTHOUSE_INGEST_URL=https://pymthouse.com -e INGEST_SHARED_SECRET=s \
     -v "$PWD/deploy:/deploy:ro" --entrypoint benthos \
     ghcr.io/openmeterio/benthos-collector:latest lint /deploy/collector.yaml
   ```
2. **Baseline read:** `GET /api/v1/apps/{app}/usage?groupBy=user` → record `requestCount`.
3. **Enable** `COLLECTOR_DURABLE_INGEST=true` on the collector (start with
   `double_write`) and redeploy the stack.
4. **Drive N** generations against the preview chain, recording each `request_id`.
5. **Re-read** usage: `requestCount` delta should be **== N** (within idempotency),
   and `networkFeeUsdMicros` delta ≈ N × per-job fee.
6. **Duplicate test:** re-send a `request_id` already ingested → no extra count
   (server dedupe on `(clientId, requestId)`).
7. **Malformed test:** emit an event with empty `auth_id` → it appears in the
   collector logs as `openmeter-collector dead-letter: reason=empty_auth_id …`
   (dead-lettered, **not** silently dropped) and does not advance usage.
8. **Resilience:** with `double_write` on, the legacy sink remains a safety net while
   you compare counts; switch to `cutover` only after the durable path is trusted.

## Legacy self-hosted OpenMeter

The rest of this document describes the older self-hosted OpenMeter topology (`docker-compose.openmeter.railway.yml`) and is kept for future on-prem deployments.
For production, prefer the hosted Konnect + collector path above.

```
┌─────────────────┐     HTTPS      ┌──────────────────────────────┐
│  PymtHouse      │ ──────────────►│  Railway: pymthouse-openmeter │
│  (Vercel)       │  OPENMETER_URL │  openmeter (public)           │
└─────────────────┘                │  + sink-worker + balance      │
        │                          │  + postgres, kafka, CH, redis │
        │ SIGNER_INTERNAL_URL      └──────────────────────────────┘
        ▼
┌─────────────────┐
│  Railway: signer│  (existing railway.json — signer-dmz only)
│  (separate proj)│
└─────────────────┘
```

## 1. Create the Railway project

1. [Railway](https://railway.app) → **New Project** → **Empty Project** → name e.g. `pymthouse-openmeter`.
2. **Add services** → **Docker Compose** → upload or paste from repo root:
   - [`docker-compose.openmeter.railway.yml`](../docker-compose.openmeter.railway.yml)

Railway creates six services. Service names must stay as in the compose file.

When services are added individually (not via one-shot Compose import), private DNS uses **`{service-name}.railway.internal`** — see [`docker/openmeter/config.railway.yaml`](../docker/openmeter/config.railway.yaml). Deploy the API with `/entrypoint.sh openmeter` so the rendered config is loaded (not the binary default `127.0.0.1:29092` Kafka).

> Compose import is typically a **one-time** scaffold. For ongoing deploys, connect each service to this GitHub repo or redeploy images from the dashboard.

## 2. Volumes (required)

Attach a **Railway Volume** to each stateful service (Settings → Volumes):

| Service | Mount path |
|---------|------------|
| `openmeter-postgres` | `/var/lib/postgresql/data` |
| `openmeter-kafka` | `/var/lib/kafka/data` |
| `openmeter-clickhouse` | `/var/lib/clickhouse` |
| `openmeter-redis` | `/data` |

Without volumes, restarts lose metering data and entitlements.

## 3. Shared variables

On the **openmeter** project (or per-service), set:

| Variable | Where | Example |
|----------|--------|---------|
| `OPENMETER_POSTGRES_PASSWORD` | postgres + openmeter + both workers | `openssl rand -hex 24` |
| `OPENMETER_CLICKHOUSE_SECRET` | openmeter-clickhouse | `openssl rand -hex 24` |
| `OPENMETER_API_KEY` | optional; set on OM if you enable auth | random secret |

Use the **same** `OPENMETER_POSTGRES_PASSWORD` on `openmeter-postgres`, `openmeter`, `openmeter-sink-worker`, and `openmeter-balance-worker`.

## 4. Public URL for the API

1. Open the **openmeter** service (not the workers).
2. **Settings → Networking → Generate Domain**.
3. Railway sets `PORT`; the custom image listens on `0.0.0.0:$PORT` via [`deploy/openmeter/entrypoint.sh`](../deploy/openmeter/entrypoint.sh).
4. Note the URL, e.g. `https://openmeter-production-xxxx.up.railway.app`.

**Do not** expose postgres, kafka, clickhouse, or redis publicly.

## 5. Wait for healthy stack

First boot can take **5–10 minutes** (Kafka + ClickHouse healthchecks).

```bash
curl -sf "https://YOUR-OPENMETER.up.railway.app/api/v1/debug/metrics" && echo OK
```

If the API fails, check **openmeter** and **openmeter-kafka** logs (Kafka DNS errors usually mean kafka is not healthy yet).

## 6. Bootstrap meters and features

From your machine (or CI):

```bash
cd pymthouse
export OPENMETER_URL=https://YOUR-OPENMETER.up.railway.app
export OPENMETER_API_KEY=...   # if configured
npm run openmeter:railway:bootstrap
```

This runs [`scripts/openmeter-bootstrap.ts`](../scripts/openmeter-bootstrap.ts) after the health check.

## 7. Wire Vercel (PymtHouse)

In the **Vercel** project → Environment Variables:

| Variable | Value |
|----------|--------|
| `OPENMETER_URL` | `https://YOUR-OPENMETER.up.railway.app` (no trailing slash) |
| `OPENMETER_API_KEY` | Same as Railway, if used |
| `OPENMETER_TRIAL_FEATURE_KEY` | `network_spend` (default) |

Redeploy Vercel. Usage, balance, and allowances return **503** without `OPENMETER_URL`.

Dashboard / builder-sdk apps use PymtHouse BFF routes; they do not call OpenMeter directly.

## 8. Signer (`pymthouse` Railway service)

The **`pymthouse`** service runs the signer DMZ ([`deploy/pymthouse/railway.json`](../deploy/pymthouse/railway.json) → `docker/signer-dmz/Dockerfile`). Point the **Vercel** app at its public domain:

```env
SIGNER_INTERNAL_URL=https://your-pymthouse.up.railway.app
SIGNER_CLI_URL=https://your-pymthouse.up.railway.app/__signer_cli
```

Signed-ticket metering: signer → PymtHouse ingest → OpenMeter (async). The signer container does **not** need `OPENMETER_URL`.

### Turnkey bootstrap on Railway

Ephemeral keystore export activates when **all** of these are set on the **`pymthouse`** service:

| Variable | Secret? | Notes |
|----------|---------|--------|
| `TURNKEY_ORG_ID` | yes (CI) | Turnkey organization ID |
| `TURNKEY_API_PUBLIC_KEY` | yes | API key public half |
| `TURNKEY_API_PRIVATE_KEY` | yes | API key private half |
| `SIGNER_ETH_KEYSTORE_PASSWORD` | yes | Ephemeral `.eth-password` for livepeer startup |
| `TURNKEY_WALLET_NAME` | no | Default `livepeer-remote-signer` |
| `SIGNER_ETH_ADDR` | no | Optional pin to a specific wallet account |

Also applied by [`scripts/railway-apply-stack-env.sh`](../scripts/railway-apply-stack-env.sh): `NEXTAUTH_URL`, derived `OIDC_ISSUER` / `JWKS_URI`, `SIGNER_DMZ_ENABLE_CLI_LISTENER=0` (single Railway port), `ETH_RPC_URL`, `SIGNER_NETWORK`.

**GitHub Actions (production):** add the four Turnkey secrets to the repo; [`deploy-railway-production.yml`](../.github/workflows/deploy-railway-production.yml) passes them into `railway-apply-stack-env.sh`. Template: [`config/railway/production.env.example`](../config/railway/production.env.example).

**Manual:**

```bash
export RAILWAY_API_TOKEN=...
export RAILWAY_ENVIRONMENT=production
export OPENMETER_POSTGRES_PASSWORD=...
export NEXTAUTH_URL=https://pymthouse.com
export TURNKEY_ORG_ID=...
export TURNKEY_API_PUBLIC_KEY=...
export TURNKEY_API_PRIVATE_KEY=...
export SIGNER_ETH_KEYSTORE_PASSWORD=...
bash scripts/railway-apply-stack-env.sh
bash scripts/railway-deploy-stack.sh production
```

Turnkey org policy must allow non-interactive `EXPORT_WALLET_ACCOUNT` for the API key. Attach a **volume** at `/data` for livepeer datadir persistence (keystore is ephemeral and deleted after boot).

## Sizing (starting point)

| Service | Suggested plan |
|---------|----------------|
| `openmeter-clickhouse` | ≥ 2 GB RAM |
| `openmeter-kafka` | ≥ 1 GB RAM |
| `openmeter` | ≥ 512 MB RAM |
| Workers | ≥ 512 MB RAM each |

## GitHub deploy (optional)

For the three OpenMeter app images (`openmeter`, `openmeter-sink-worker`, `openmeter-balance-worker`):

- **Root directory:** repository root (build context must include `docker/openmeter/`).
- **Dockerfile:** `deploy/openmeter/Dockerfile`
- **Start commands:** `openmeter` | `openmeter-sink-worker` | `openmeter-balance-worker` (entrypoint adds `--config`).

See [`deploy/openmeter/railway.toml`](../deploy/openmeter/railway.toml) for API-only deploy hints.

## Preview clearinghouse stack (hosted Konnect)

Preview uses the **3-service clearinghouse** model (`docker-compose.clearinghouse.railway.yml`), not self-hosted OpenMeter:

| Service | Role |
|---------|------|
| `kafka` | Redpanda bus (`kafka.railway.internal:9092`) |
| `openmeter-collector` | Benthos: Kafka → Konnect CloudEvents ingest |
| `pymthouse` | Signer DMZ (`docker/signer-dmz/Dockerfile`) |

**One-time migration** from the legacy 8-service preview stack:

```bash
set -a && source .env.local && set +a
export NEXTAUTH_URL=https://staging.pymthouse.com
export WEBHOOK_SECRET=...   # must match Vercel staging
bash scripts/railway-migrate-preview-clearinghouse.sh
```

This deletes legacy OpenMeter services from the **preview environment only** (production is untouched), creates `kafka` + `openmeter-collector` if missing, applies env, and deploys.

**CI:** [`.github/workflows/deploy-railway-preview.yml`](../.github/workflows/deploy-railway-preview.yml) deploys the full clearinghouse stack on push to `main` (path-filtered to `deploy/**`, signer, and railway scripts) when `RAILWAY_PREVIEW_AUTO_DEPLOY=true`. Manual dispatch is also available.

Set Vercel **Preview** `OPENMETER_URL` to Konnect (`https://us.api.konghq.com/v3/openmeter`), not `openmeter-preview.up.railway.app`.

## Legacy self-hosted OpenMeter (preview/production reference stacks)

### One-time production setup

1. In Railway → **PymtHouse** → **production**, confirm all eight services appear (create missing ones via the same compose import as preview if needed).
2. Attach **volumes** on the four stateful services (same mount paths as preview).
3. Generate public domains on **`openmeter`** and **`pymthouse`** in production.
4. Set production secrets (use **distinct** passwords from preview). Template: [`config/railway/production.env.example`](../config/railway/production.env.example).

### CI deploy (main → staging / Railway preview)

Enable repository variable **`RAILWAY_PREVIEW_AUTO_DEPLOY=true`** (`bash scripts/set-github-preview-deploy-vars.sh`).

Successful deploys register the GitHub environment **`railway / preview`** (URL from `RAILWAY_PREVIEW_SIGNER_URL`).

Workflow: [`.github/workflows/deploy-railway-preview.yml`](../.github/workflows/deploy-railway-preview.yml) on push to `main` (path-filtered) or manual dispatch:

1. `scripts/railway-deploy-stack.sh preview` — redeploys kafka + collector + signer from the pushed commit

Preview env vars are **not** overwritten by CI unless `RAILWAY_PREVIEW_APPLY_ENV=true` or the manual `apply_env` dispatch input is set. Disable native GitHub autodeploy on preview `pymthouse` if you rely on this workflow, so pushes do not double-deploy.

**Required GitHub secret:** `RAILWAY_API_TOKEN` (same account token as production).

Manual staging deploy:

```bash
pnpm railway:preview:deploy
# or: bash scripts/railway-deploy-stack.sh preview
```

### CI deploy (v* tag → production)

Enable repository variable **`RAILWAY_PRODUCTION_AUTO_DEPLOY=true`** (`bash scripts/set-github-production-railway-vars.sh`).

Successful deploys register the GitHub environment **`railway / production`** (URL from `RAILWAY_PRODUCTION_SIGNER_URL`).

Workflow: [`.github/workflows/deploy-railway-production.yml`](../.github/workflows/deploy-railway-production.yml) on push to `v*` tag or manual dispatch:

1. `scripts/railway-apply-stack-env.sh` — applies env from GitHub secrets
2. `scripts/railway-deploy-stack.sh production` — redeploys infra + uploads OpenMeter + signer images

**Required GitHub secrets:** `RAILWAY_API_TOKEN` (Railway **Account → Tokens**, workspace-scoped), `OPENMETER_POSTGRES_PASSWORD` (production value). Optional: `RAILWAY_TOKEN` (project **Settings → Tokens**, production environment) instead of the account token.

**Recommended:** `OPENMETER_API_KEY`, `OPENMETER_URL` (production OpenMeter URL for bootstrap), `RAILWAY_PRODUCTION_DATABASE_URL`, `RAILWAY_PRODUCTION_AUTH_TOKEN_PEPPER`, `RAILWAY_PRODUCTION_NEXTAUTH_SECRET` for the signer service.

**Turnkey bootstrap (optional, all four together):** `TURNKEY_ORG_ID`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `SIGNER_ETH_KEYSTORE_PASSWORD`. Optional vars: `TURNKEY_WALLET_NAME`, `SIGNER_ETH_ADDR`.

**Optional repository variables:**

| Variable | Default | Applied to |
|----------|---------|------------|
| `RAILWAY_PRODUCTION_NEXTAUTH_URL` | `https://pymthouse.com` | `pymthouse` (`NEXTAUTH_URL` + derived `OIDC_*` / `JWKS_URI`) |
| `RAILWAY_PRODUCTION_OPENMETER_REDIS_ADDRESS` | `openmeter-redis-prod.railway.internal:6379` | `openmeter`, sink/balance workers |
| `RAILWAY_PRODUCTION_BOOTSTRAP_OPENMETER` | off | post-deploy bootstrap when `true` |
| `SIGNER_NETWORK` | `arbitrum-one-mainnet` | `pymthouse` |

Do not use `app.pymthouse.com` — production issuer and signer DMZ must match the Vercel app at **`https://pymthouse.com`**.

Manual deploy:

```bash
export RAILWAY_API_TOKEN=...   # or RAILWAY_TOKEN=... (project production token)
export OPENMETER_POSTGRES_PASSWORD=...
export NEXTAUTH_URL=https://pymthouse.com
bash scripts/railway-apply-stack-env.sh
bash scripts/railway-deploy-stack.sh production
```

Stack metadata: [`config/railway/stack.json`](../config/railway/stack.json).

## CI bootstrap

`.github/workflows/openmeter-railway-bootstrap.yml` — manual workflow with secret `OPENMETER_URL` (and optional `OPENMETER_API_KEY`).

## Local parity

| Environment | Compose file | API URL |
|-------------|--------------|---------|
| Local dev | `docker-compose.openmeter.yml` | `http://127.0.0.1:48888` |
| Railway | `docker-compose.openmeter.railway.yml` | `https://….up.railway.app` |

Local config: [`docker/openmeter/config.yaml`](../docker/openmeter/config.yaml).  
Railway config template: [`docker/openmeter/config.railway.yaml`](../docker/openmeter/config.railway.yaml).

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Vercel `fetch failed` | `OPENMETER_URL` set but Railway API down or wrong URL |
| 503 OpenMeter not configured | `OPENMETER_URL` missing on Vercel |
| Kafka resolve errors in openmeter logs | `openmeter-kafka` not healthy; wait or restart kafka |
| Balance always zero | `openmeter-balance-worker` not running; bootstrap not run |
| Stale usage after deploy | Missing volumes on ClickHouse/Kafka |

## Related docs

- [Vercel + Railway deployment](./vercel-deployment.md)
- [Builder API — usage & allowances](./builder-api.md)
- [Architecture — OpenMeter topology](../Architecture%20Diagram.md#5-openmeter--credit-authority--pre-configuration)
