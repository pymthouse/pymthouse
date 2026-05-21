# Containerized Deployment Guide

This guide covers the fully containerized production topology:

- **Control plane** → prebuilt image from `infra/docker/control-plane/Dockerfile`
- **Signer DMZ** → prebuilt image from `infra/docker/signer-dmz/Dockerfile`
- **Database** → managed PostgreSQL such as Neon, Supabase, or RDS

Production deployments must use prebuilt images only. Do not build from repository source during deploy.

## Supported Topology

- `ghcr.io/<org>/pymthouse-control-plane:<git-sha-or-release-tag>`
- `ghcr.io/<org>/pymthouse-signer-dmz:<git-sha-or-release-tag>`
- optional `ghcr.io/<org>/pymthouse-signer:<git-sha-or-release-tag>`

## 1. Build Images

```bash
./infra/scripts/build-images.sh
```

Or build the control plane only:

```bash
./infra/scripts/build-control-plane.sh
```

## 2. Push Images

Push the tagged images to your registry from CI or from your release environment.

Recommended tags:

- immutable git SHA tags
- optional release tags
- digests for final production pinning when your platform supports them

Avoid mutable production tags such as `latest`.

## 3. Run Database Migrations

Run migrations from the exact control-plane image that will be deployed:

```bash
IMAGE_NAME=ghcr.io/<org>/pymthouse-control-plane \
IMAGE_TAG=<git-sha-or-release-tag> \
DATABASE_URL='postgresql://...' \
./infra/scripts/run-db-migrations.sh
```

This keeps schema rollout explicit and avoids startup-time migration coupling.

## 4. Deploy the Control Plane

The control plane container expects:

- `PORT=3001`
- `HOSTNAME=0.0.0.0`
- `DATABASE_URL`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `AUTH_TOKEN_PEPPER`
- signer integration vars such as `SIGNER_INTERNAL_URL` and `SIGNER_CLI_URL`

Platform examples:

- Render web service example:
  - `infra/deploy/render.control-plane.image.yaml`
- Railway prebuilt-image guidance:
  - `infra/deploy/railway.control-plane.prebuilt-image.md`

## 5. Deploy the Signer

Deploy the signer from the DMZ image and point the control plane at it with:

- `SIGNER_INTERNAL_URL`
- `SIGNER_CLI_URL`

See:

- `docs/signer-deployment-options.md`
- `infra/deploy/render.image.yaml`
- `infra/deploy/railway.prebuilt-image.md`

## 6. Health and Readiness

Control plane:

- container port: `3001`
- health endpoint: `GET /api/v1/health`
- the Docker image includes a container `HEALTHCHECK`

Signer:

- use the signer/DMZ health behavior documented in `docs/signer-deployment-options.md`

Recommended rollout pattern:

1. push images
2. run migrations
3. deploy web services
4. wait for health checks to pass before promoting traffic

## 7. Local Image Smoke Test

You can run the built control-plane image locally:

```bash
DATABASE_URL='postgresql://...' \
NEXTAUTH_URL='http://localhost:3001' \
NEXTAUTH_SECRET='replace-me' \
AUTH_TOKEN_PEPPER='replace-me' \
./infra/scripts/run-control-plane.sh
```

Then verify:

```bash
curl http://localhost:3001/api/v1/health
```
