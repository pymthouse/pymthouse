# Railway Prebuilt Image Deployment

Use Railway's prebuilt image deployment flow instead of repo-source Docker builds.

Recommended setup:

1. Build and push `ghcr.io/<org>/pymthouse-signer-dmz:<git-sha>` from CI or `infra/scripts/build-signer-dmz.sh`.
2. In Railway, create or update the service as an image-backed deployment.
3. Configure the service to pull the published image tag or digest.
4. Enable image auto-updates only if you intentionally promote mutable tags.

Environment should match the signer DMZ runtime expectations:

- `PORT`
- `CLI_PORT`
- `SIGNER_NETWORK`
- `SIGNER_PORT`
- `ETH_RPC_URL`
- `OIDC_ISSUER`
- `OIDC_AUDIENCE`
- `JWKS_URI`
- `JWKS_TLS_INSECURE` when required for local/self-signed JWKS

Do not use a repo-root `railway.json` Dockerfile build for production.
