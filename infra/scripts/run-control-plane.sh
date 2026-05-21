#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/pymthouse/pymthouse-control-plane}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"
CONTAINER_NAME="${CONTAINER_NAME:-pymthouse-control-plane}"
PORT="${PORT:-3001}"

docker run \
  --rm \
  --name "$CONTAINER_NAME" \
  -p "$PORT:3001" \
  -e PORT=3001 \
  -e HOSTNAME=0.0.0.0 \
  "${DATABASE_URL:+-e DATABASE_URL=$DATABASE_URL}" \
  "${NEXTAUTH_URL:+-e NEXTAUTH_URL=$NEXTAUTH_URL}" \
  "${NEXTAUTH_SECRET:+-e NEXTAUTH_SECRET=$NEXTAUTH_SECRET}" \
  "${AUTH_TOKEN_PEPPER:+-e AUTH_TOKEN_PEPPER=$AUTH_TOKEN_PEPPER}" \
  "${SIGNER_INTERNAL_URL:+-e SIGNER_INTERNAL_URL=$SIGNER_INTERNAL_URL}" \
  "${SIGNER_CLI_URL:+-e SIGNER_CLI_URL=$SIGNER_CLI_URL}" \
  "${OIDC_ISSUER:+-e OIDC_ISSUER=$OIDC_ISSUER}" \
  "${OIDC_AUDIENCE:+-e OIDC_AUDIENCE=$OIDC_AUDIENCE}" \
  "${JWKS_URI:+-e JWKS_URI=$JWKS_URI}" \
  "$IMAGE_NAME:$IMAGE_TAG"
