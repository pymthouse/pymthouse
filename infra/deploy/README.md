# Production Deploy Policy

Production deployments must use prebuilt container images only.

Rules:

- Do not build production images from this repository during deploy.
- Dev compose files under `infra/dev/` are local-only and may use `build:`.
- Dockerfiles under `infra/docker/` are build inputs for local workflows or CI image pipelines.
- Production deploy descriptors under `infra/deploy/` must reference immutable image tags or digests.

Recommended flow:

1. Build images with `infra/scripts/build-images.sh` or CI.
2. Push images to your registry.
3. Deploy using prebuilt image references from `infra/deploy/`.

Suggested image names:

- `ghcr.io/<org>/pymthouse-control-plane:<git-sha>`
- `ghcr.io/<org>/pymthouse-signer-dmz:<git-sha>`
- `ghcr.io/<org>/pymthouse-signer:<git-sha>`

Prefer digests in production when your platform supports them.

Recommended release sequence:

1. Build and push images.
2. Run one-off migration jobs from the target application image where needed.
3. Deploy long-running services from the exact same image tags or digests.

Available examples and guides:

- Render signer service:
  - `infra/deploy/render.image.yaml`
- Render control-plane web service:
  - `infra/deploy/render.control-plane.image.yaml`
- Render control-plane migration job:
  - `infra/deploy/render.control-plane.migrator.yaml`
- Railway signer service:
  - `infra/deploy/railway.prebuilt-image.md`
- Railway control-plane service:
  - `infra/deploy/railway.control-plane.prebuilt-image.md`
