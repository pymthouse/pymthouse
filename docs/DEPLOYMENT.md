# Deployment Topologies

Pymthouse supports two production deployment topologies.

## 1. Vercel Control Plane + Separate Signer

Use this when you want the Next.js app on Vercel and the signer deployed separately.

- control plane: Vercel
- signer: Railway, Render, Fly.io, or another container host
- database: Neon, Supabase, RDS, or Vercel Postgres

Primary guide:

- [vercel-deployment.md](./vercel-deployment.md)

## 2. Fully Containerized Deployment

Use this when both the control plane and signer should run as prebuilt images.

- control plane image: `infra/docker/control-plane/Dockerfile`
- signer image: `infra/docker/signer-dmz/Dockerfile`
- production deploy inputs: `infra/deploy/`

Primary guide:

- [container-deployment.md](./container-deployment.md)

## Production Rules

- Production deploys must use prebuilt images only.
- Local compose files under `infra/dev/` are for clone-and-run development only.
- Production deploy descriptors must not build from repository source.
- Database migrations should run as a separate release step from the exact image being deployed.

## Signer Deployment References

- [signer-deployment-options.md](./signer-deployment-options.md)
- [../infra/deploy/render.image.yaml](../infra/deploy/render.image.yaml)
- [../infra/deploy/railway.prebuilt-image.md](../infra/deploy/railway.prebuilt-image.md)

## Control Plane Deployment References

- [container-deployment.md](./container-deployment.md)
- [../infra/deploy/control-plane.prebuilt-image.md](../infra/deploy/control-plane.prebuilt-image.md)
- [../infra/deploy/render.control-plane.image.yaml](../infra/deploy/render.control-plane.image.yaml)
- [../infra/deploy/railway.control-plane.prebuilt-image.md](../infra/deploy/railway.control-plane.prebuilt-image.md)

## Operations References

- [COMPLETION_STATUS.md](./COMPLETION_STATUS.md)
- [operations/README.md](./operations/README.md)
- [operations/observability-and-slos.md](./operations/observability-and-slos.md)
