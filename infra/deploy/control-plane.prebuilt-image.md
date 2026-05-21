# Control Plane Prebuilt Image Deployment

Deploy the Next.js control plane from a prebuilt image only.

Recommended flow:

1. Build and push `ghcr.io/<org>/pymthouse-control-plane:<git-sha>` from CI or `infra/scripts/build-control-plane.sh`.
2. Run database migrations as a separate release step or one-off job with the same image.
3. Deploy the published image to your platform.

Runtime expectations:

- Container listens on `PORT` (default `3001`)
- `HOSTNAME` should be `0.0.0.0`
- `DATABASE_URL` must be present at runtime
- `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, and `AUTH_TOKEN_PEPPER` must be present at runtime
- Signer integration vars such as `SIGNER_INTERNAL_URL` and `SIGNER_CLI_URL` must be set for signer-backed flows

The image is built with `SKIP_DB_PREPARE=1`, so image builds do not require a live database.

## Operational Scripts

- Build image:
  - `./infra/scripts/build-control-plane.sh`
- Run app locally from a built image:
  - `./infra/scripts/run-control-plane.sh`
- Run DB migrations from the built image:
  - `./infra/scripts/run-db-migrations.sh`

## Release Pattern

Recommended production sequence:

1. Build and push the control-plane image.
2. Run `node scripts/db-migrate.ts` as a one-off job using that exact image.
3. Deploy the same image tag or digest to the long-running web service.

This keeps schema changes explicit and avoids coupling application startup to migration execution.

## Render Example

For image-backed Render deployments:

- Web service example:
  - `infra/deploy/render.control-plane.image.yaml`
- Migration job example:
  - `infra/deploy/render.control-plane.migrator.yaml`

## Railway Example

For image-backed Railway deployments:

- `infra/deploy/railway.control-plane.prebuilt-image.md`

## Health and Readiness

- Container port: `3001`
- Container healthcheck: baked into `infra/docker/control-plane/Dockerfile`
- Service health endpoint: `GET /api/v1/health`

Production platforms should use the health endpoint as readiness/liveness input instead of coupling readiness to migration execution or startup logs.
