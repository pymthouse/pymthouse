# pymthouse Full Stack Quick Start

This guide starts the full local stack:
- Next.js app (UI + API) on `http://localhost:3001`
- PostgreSQL database (set `DATABASE_URL`; Neon or local Postgres)
- Full **signer-dmz** (Apache + JWT + go-livepeer) via the repo root `docker-compose.yml` (same image path as production)

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

The local stack uses the full **signer-dmz** image from `docker/signer-dmz/Dockerfile` (same as
production: Apache, JWT verification, and go-livepeer in one process). The container
must be able to download the OIDC public key at start time, so the app in step 3
must be running *before* the first `docker compose up`. Default DMZ URL:
`http://127.0.0.1:8080` — match `SIGNER_INTERNAL_URL` and `SIGNER_CLI_URL` in `.env`.

If you do not use port `3001` for the app, set `OIDC_ISSUER`, `OIDC_AUDIENCE`, and
`JWKS_URI` in `.env` to match your `NEXTAUTH_URL` and a JWKS URL reachable from the
container (for example `http://host.docker.internal:<port>/api/v1/oidc/jwks`).

```bash
./scripts/build-local-signer.sh
docker compose up -d signer-dmz
```

The build script compiles go-livepeer from `../go-livepeer` via
`lpclearinghouse/scripts/build-remote-signer.sh`, then layers it into the DMZ image.
Re-run it after go-livepeer changes.

Check signer logs (optional):

```bash
docker compose logs -f signer-dmz
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
# Build / start signer (after go-livepeer changes: ./scripts/build-local-signer.sh)
docker compose up -d signer-dmz

# Stop signer
docker compose stop signer-dmz

# Stop and remove signer container
docker compose down

# Run linter
npm run lint
```

## Deployment to Production

### Vercel + Railway/Render

Pymthouse can be deployed to Vercel (for the Next.js app) with the Docker signer on Railway and **OpenMeter on a separate Railway project** (usage / trial credits). See [docs/openmeter-railway.md](docs/openmeter-railway.md).

**Quick Deploy (15 minutes):**
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for a quick checklist.

**Detailed Guide:**
See [docs/vercel-deployment.md](docs/vercel-deployment.md) for full step-by-step instructions including:
- Deploying the go-livepeer signer to Railway/Render/Fly.io
- Deploying OpenMeter to Railway ([openmeter-railway.md](docs/openmeter-railway.md))
- Deploying the Next.js app to Vercel
- Configuring environment variables
- Setting up PostgreSQL (Neon/Vercel Postgres)
- OAuth callback URLs
- Custom domains

**Files included:**
- `vercel.json` - Vercel configuration
- `docker/signer-dmz/` — go-livepeer signer Dockerfiles, Apache JWT DMZ, `docker-compose.yml`, and `scripts/jwks_to_pem.py` (see [docker/signer-dmz/README.md](docker/signer-dmz/README.md))
- `railway.json` - Railway configuration
- `render.yaml` - Render Blueprint

## Troubleshooting

- `Signer is not running` / DMZ **401** on `/api/signer/*`: Apache `iss` must match `getIssuer()` (your **`NEXTAUTH_URL`** + `/api/v1/oidc`). The compose stack passes **`NEXTAUTH_URL`** into the container so the entrypoint can set `OIDC_ISSUER` / `JWKS_URI`; keep it identical to the URL you use for the Next app (`localhost` vs `127.0.0.1` vs a LAN hostname must match). After changing `docker-compose.yml` or `entrypoint.sh`, rebuild: `docker compose up -d --build`.
- App can’t open DB: verify `DATABASE_URL` and that `npm run db:prepare` succeeds.
- OAuth buttons fail: set provider credentials in `.env` or use token login from `npm run bootstrap`.
- Repeating `JWT_SESSION_ERROR` / `JWEDecryptionFailed`:
  - Ensure one stable `NEXTAUTH_SECRET` value (watch `.env.local` overriding `.env`).
  - Clear `localhost` cookies (or open a private window), then sign in again.
