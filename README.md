# pymthouse Full Stack Quick Start

This guide starts the full local stack:
- Next.js app (UI + API) on `http://localhost:3001`
- PostgreSQL database (set `DATABASE_URL`; Neon or local Postgres)
- Full **signer-dmz** (Apache + JWT + go-livepeer) via `infra/dev/docker-compose.local.yml` for local clone-and-run development

## Fresh Clone: Copy-Paste Setup

For a fresh local setup from a new clone, use this exact sequence:

```bash
fnm use
npm install
cp .env.example .env.local
```

Set at least these values in `.env.local`:

```env
NEXTAUTH_URL=http://localhost:3001
NEXTAUTH_SECRET=change-me
AUTH_TOKEN_PEPPER=change-me

DATABASE_URL=postgresql://pymthouse:pymthouse@127.0.0.1:5432/pymthouse?sslmode=disable

SIGNER_INTERNAL_URL=http://127.0.0.1:8080
SIGNER_CLI_URL=http://127.0.0.1:8080/__signer_cli
OIDC_ISSUER=http://localhost:3001/api/v1/oidc
SIGNER_DMZ_JWKS_URL=http://host.docker.internal:3001/api/v1/oidc/jwks
JWKS_URI=http://host.docker.internal:3001/api/v1/oidc/jwks

SIGNER_NETWORK=arbitrum-one-mainnet
ETH_RPC_URL=http://nyc-router.eliteencoder.net:3517
HOST_DOCKER_INTERNAL_IP=<your host LAN IP if needed>
```

Then bring up the full stack:

```bash
bash ./infra/scripts/run-full-local-dev.sh
```

Verify it is up:

```bash
docker compose --env-file .env.local -f infra/dev/docker-compose.full.local.yml ps
curl http://localhost:3001/api/v1/health
curl http://127.0.0.1:8080/healthz
```

Open:
- App: `http://localhost:3001`
- Health: `http://localhost:3001/api/v1/health`

If you need an admin login token:

```bash
npm run bootstrap
```

To stop the full stack:

```bash
docker compose --env-file .env.local -f infra/dev/docker-compose.full.local.yml down
```

## Prerequisites

- Node.js + npm
- Docker + Docker Compose
- A PostgreSQL instance and `DATABASE_URL` connection string

## 1) Install dependencies

```bash
npm install
```

## 2) Configure environment

Create your local env file:

```bash
cp .env.example .env
```

If you also use `.env.local`, remember Next.js precedence: `.env.local` overrides `.env`.
Keep `NEXTAUTH_SECRET` consistent across files (or only set it in one place) to avoid
session cookie decrypt errors.

Minimum required for local startup:
- `NEXTAUTH_SECRET` (set to any long random string)
- `DATABASE_URL` (PostgreSQL connection string; migrations run on `npm run dev` / `npm run build`)
- `SIGNER_INTERNAL_URL` (default works with compose)
- `SIGNER_NETWORK` and `ETH_RPC_URL` (defaults work)

Generate a strong secret with:

```bash
openssl rand -base64 32
```

Optional (only if needed):
- Google/GitHub OAuth vars (for OAuth login)
- Turnkey Wallet Kit public IDs (`NEXT_PUBLIC_ORGANIZATION_ID`, `NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID`) for embedded wallet login

`npm run oidc:seed` in step 3 is only required the first time (or if keys were removed);
see also [## OIDC seed and client registration](#oidc-seed-and-client-registration) below.

## 3) Start the app

Migrations run on `predev` (`npm run db:prepare`). On a new database, create the
OIDC signing key once (before step 4, which needs `GET /api/v1/oidc/jwks`):

```bash
npm run oidc:seed
```

Then start the app:

```bash
npm run dev
```

Open:
- Dashboard: `http://localhost:3001`
- Login: `http://localhost:3001/login`
- Health: `http://localhost:3001/api/v1/health`

## 4) Start the signer (signer-dmz)

The local stack uses the full **signer-dmz** image from `infra/docker/signer-dmz/Dockerfile`
(same runtime image shape as production: Apache, JWT verification, and go-livepeer in one process). The container
must be able to download the OIDC public key at start time, so the app in step 3
must be running *before* the first `docker compose up`. Default DMZ URL:
`http://127.0.0.1:8080` — match `SIGNER_INTERNAL_URL` and `SIGNER_CLI_URL` in `.env`.

If you do not use port `3001` for the app, set `OIDC_ISSUER`, `OIDC_AUDIENCE`, and
`JWKS_URI` in `.env` to match your `NEXTAUTH_URL` and a JWKS URL reachable from the
container (for example `http://host.docker.internal:<port>/api/v1/oidc/jwks`).

```bash
docker compose -f infra/dev/docker-compose.local.yml up -d --build
```

Check signer logs (optional):

```bash
docker compose -f infra/dev/docker-compose.local.yml logs -f signer-dmz
```

## 5) Create an admin token (first login)

In another terminal:

```bash
DATABASE_URL='postgresql://...' npm run bootstrap
```

This creates an admin user and prints a `pmth_...` bearer token. The token is valid for 1 year.

Optionally specify an email for the admin user:

```bash
DATABASE_URL='postgresql://...' npm run bootstrap admin@example.com
```

If an admin already exists, the script issues a new token for the existing admin instead of creating a new user.

**Using the token:**

- **Web login**: Paste the token into the login page at `http://localhost:3001/login`
- **API requests**: Use the `Authorization` header:

```bash
curl -H "Authorization: Bearer pmth_..." http://localhost:3001/api/v1/signers
```

Once logged in, you can issue additional remote-signer tokens from the admin dashboard.

## OIDC seed and client registration

After migrations, initialize OIDC signing keys:

```bash
npm run oidc:seed
```

Then register application clients through the dashboard/API and rotate secrets per app from the credentials endpoint (`/api/v1/apps/{clientId}/credentials`). See [docs/builder-api.md](docs/builder-api.md) for OIDC, Builder, and Usage API integration.

## Common commands

```bash
# Start signer
docker compose -f infra/dev/docker-compose.local.yml up -d --build

# Start the full local stack (db + control plane + signer)
./infra/scripts/run-full-local-dev.sh

# Stop signer
docker compose -f infra/dev/docker-compose.local.yml stop signer-dmz

# Stop and remove signer container
docker compose -f infra/dev/docker-compose.local.yml down

# Run linter
npm run lint

# Run tests against a disposable local PostgreSQL container
npm run test:local
```

## Full Local Docker Dev

If you want the entire development stack under one compose file instead of running
`next dev` on the host, use:

```bash
./infra/scripts/run-full-local-dev.sh
```

This starts:

- PostgreSQL on `127.0.0.1:5432`
- the control plane on `http://localhost:3001`
- signer-dmz on `http://127.0.0.1:8080`

To inspect or stop it:

```bash
docker compose --env-file .env.local -f infra/dev/docker-compose.full.local.yml ps
docker compose --env-file .env.local -f infra/dev/docker-compose.full.local.yml logs -f
docker compose --env-file .env.local -f infra/dev/docker-compose.full.local.yml down
```

## Deployment to Production

### Vercel or Containerized App + Signer

Pymthouse can be deployed either:
- with the Next.js app on Vercel and the signer on Railway/Render/Fly.io, or
- with both the control plane and signer as prebuilt container images.

**Quick Deploy (15 minutes):**
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for a quick checklist.

**Architecture Overview:**
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full repository architecture map, runtime flows, and deployment topology diagrams.

**Refactor Completion Status:**
See [docs/COMPLETION_STATUS.md](docs/COMPLETION_STATUS.md) for what is structurally complete and what remains operational follow-up.

**Topology Guides:**
- [docs/vercel-deployment.md](docs/vercel-deployment.md) for the Vercel control-plane topology
- [docs/container-deployment.md](docs/container-deployment.md) for the fully containerized topology

**Files included:**
- `vercel.json` - Vercel configuration
- `infra/docker/control-plane/` - Next.js control-plane Dockerfile
- `infra/docker/signer-dmz/` — go-livepeer signer Dockerfiles, Apache JWT DMZ assets, and JWKS helper
- `infra/dev/` - local-only compose files that may build inline from the repo
- `infra/scripts/` - image build scripts
- `infra/deploy/` - production deploy inputs and prebuilt-image guidance

For containerized production:
- build the control-plane image with `./infra/scripts/build-control-plane.sh`
- run DB migrations with `./infra/scripts/run-db-migrations.sh`
- run the container locally with `./infra/scripts/run-control-plane.sh`
- use `/api/v1/health` for control-plane readiness/liveness checks

## Troubleshooting

- `Signer is not running` / DMZ **401** on `/api/signer/*`: Apache `iss` must match `getIssuer()` (your **`NEXTAUTH_URL`** + `/api/v1/oidc`). The local compose stack passes **`NEXTAUTH_URL`** into the container so the entrypoint can set `OIDC_ISSUER` / `JWKS_URI`; keep it identical to the URL you use for the Next app (`localhost` vs `127.0.0.1` vs a LAN hostname must match). After changing `infra/dev/docker-compose.local.yml` or `infra/docker/signer-dmz/entrypoint.sh`, rebuild: `docker compose -f infra/dev/docker-compose.local.yml up -d --build`.
- App can’t open DB: verify `DATABASE_URL` and that `npm run db:prepare` succeeds.
- OAuth buttons fail: set provider credentials in `.env` or use token login from `npm run bootstrap`.
- Repeating `JWT_SESSION_ERROR` / `JWEDecryptionFailed`:
  - Ensure one stable `NEXTAUTH_SECRET` value (watch `.env.local` overriding `.env`).
  - Clear `localhost` cookies (or open a private window), then sign in again.
