# OpenMeter on Railway (PymtHouse + Vercel)

Self-hosted OpenMeter runs in a **dedicated Railway project**, separate from the [remote signer](vercel-deployment.md#option-a-railway-with-nixpacks-recommended---easiest). PymtHouse on **Vercel** calls it over HTTPS via `OPENMETER_URL`.

## Architecture

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

## 8. Signer (unchanged)

Keep the signer on its **own** Railway service ([`railway.json`](../railway.json) → `docker/signer-dmz/Dockerfile`):

```env
SIGNER_INTERNAL_URL=https://your-signer.up.railway.app
SIGNER_CLI_URL=https://your-signer.up.railway.app/__signer_cli
```

Signed-ticket metering: signer → PymtHouse ingest → OpenMeter (async). The signer container does **not** need `OPENMETER_URL`.

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

## Preview vs production (same stack)

The **PymtHouse** Railway project uses two environments with the **same eight services**:

| Service | Role |
|---------|------|
| `openmeter-postgres`, `openmeter-redis`, `openmeter-kafka`, `openmeter-clickhouse` | Stateful infra (private) |
| `openmeter` | Public OpenMeter API |
| `openmeter-sink-worker`, `openmeter-balance-worker` | Workers |
| `pymthouse` | Remote signer DMZ (`docker/signer-dmz/Dockerfile`) |

**Preview** is the reference stack (`openmeter-preview.up.railway.app`, `pymthouse-preview.up.railway.app`).

**Production** must have the same services deployed in the `production` environment (not only `pymthouse`). Service definitions are shared at the project level; each environment needs its own deploy, volumes, domains, and secrets.

### One-time production setup

1. In Railway → **PymtHouse** → **production**, confirm all eight services appear (create missing ones via the same compose import as preview if needed).
2. Attach **volumes** on the four stateful services (same mount paths as preview).
3. Generate public domains on **`openmeter`** and **`pymthouse`** in production.
4. Set production secrets (use **distinct** passwords from preview). Template: [`config/railway/production.env.example`](../config/railway/production.env.example).

### CI deploy (main → production)

Enable repository variable **`RAILWAY_PRODUCTION_AUTO_DEPLOY=true`**.

Workflow: [`.github/workflows/deploy-railway-production.yml`](../.github/workflows/deploy-railway-production.yml) on push to `main`:

1. `scripts/railway-apply-stack-env.sh` — applies env from GitHub secrets
2. `scripts/railway-deploy-stack.sh production` — redeploys infra + uploads OpenMeter + signer images

**Required GitHub secrets:** `RAILWAY_TOKEN`, `OPENMETER_POSTGRES_PASSWORD` (production value).

**Recommended:** `OPENMETER_API_KEY`, `OPENMETER_URL` (production OpenMeter URL for bootstrap), `RAILWAY_PRODUCTION_DATABASE_URL`, `RAILWAY_PRODUCTION_AUTH_TOKEN_PEPPER`, `RAILWAY_PRODUCTION_NEXTAUTH_SECRET` for the signer service.

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
export RAILWAY_TOKEN=...
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
