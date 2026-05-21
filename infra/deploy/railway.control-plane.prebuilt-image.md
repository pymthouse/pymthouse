# Railway Control Plane Prebuilt Image

Deploy the control plane to Railway from a prebuilt image only.

Recommended flow:

1. Build and push `ghcr.io/<org>/pymthouse-control-plane:<git-sha>` from CI or `./infra/scripts/build-control-plane.sh`.
2. Run database migrations from that exact image before switching production traffic.
3. Configure Railway to deploy the published image instead of building from repository source.

## Railway Setup

1. Create a new Railway project and choose an image-backed service.
2. Point the service at your pushed control-plane image tag or digest.
3. Set runtime environment variables:
   - `NODE_ENV=production`
   - `PORT=3001`
   - `HOSTNAME=0.0.0.0`
   - `DATABASE_URL`
   - `NEXTAUTH_URL`
   - `NEXTAUTH_SECRET`
   - `AUTH_TOKEN_PEPPER`
   - `SIGNER_INTERNAL_URL`
   - `SIGNER_CLI_URL`
4. Configure Railway health checks to use `/api/v1/health`.
5. Do not configure Railway to build from the repo or from a Dockerfile path for production.

## Migrations

Run migrations from the same image that will serve production traffic:

```bash
IMAGE_NAME=ghcr.io/<org>/pymthouse-control-plane \
IMAGE_TAG=<git-sha-or-release-tag> \
DATABASE_URL='postgresql://...' \
./infra/scripts/run-db-migrations.sh
```

## Operational Notes

- The container exposes port `3001`.
- Readiness should be based on `GET /api/v1/health`.
- Keep migrations separate from app startup so deployment rollback and schema rollout remain explicit.
