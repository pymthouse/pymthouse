# OIDC Incident Runbook

Use this runbook when logins, token issuance, consent, device verification, or JWKS-backed validation are failing.

## Symptoms

- `/api/v1/oidc/**` returns 5xx or repeated 4xx spikes
- login/consent/device pages fail to load
- downstream services reject access tokens or JWKS validation
- device approval and token exchange failures increase sharply

## Primary Checks

1. Check control-plane health:
   - `GET /api/v1/health`
2. Check JWKS availability:
   - `GET /api/v1/oidc/jwks`
3. Check OIDC metadata:
   - `GET /.well-known/openid-configuration`
4. Inspect control-plane logs for:
   - provider bootstrap failures
   - signing-key lookup failures
   - payload storage errors
   - token exchange failures

## Likely Failure Areas

- signing key/JWKS issues
- database connectivity or payload persistence failure
- issuer/origin mismatch
- malformed client registration or app policy state
- third-party initiate-login validation issues

## Immediate Mitigation

- restore control-plane availability first
- verify the current image and environment are the intended release
- if the issue began during release, consider rolling back to the previous known-good image
- if signing keys or OIDC seed data are missing in a fresh environment, run:
  - `npm run oidc:seed`
  - or the equivalent image-backed release step

## Recovery Validation

- OIDC metadata loads successfully
- JWKS endpoint responds
- a test authorization flow completes
- a token request succeeds
- device verification and token exchange succeed if used in production

## Follow-up

- record whether the failure was:
  - release-induced
  - data/migration-induced
  - dependency-induced
  - configuration-induced
- update this runbook if the real incident revealed a missing decision step
