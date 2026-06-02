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

Railway creates six services. Service names must stay as in the compose file (they are DNS names on the private network).

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
