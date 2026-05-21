# Signer Incident Runbook

Use this runbook when signer health, signer proxying, payment generation, or signer admin/control operations fail.

## Symptoms

- `/api/signer/**` requests fail or return unexpected auth errors
- signer admin page shows offline/degraded signer state
- signer DMZ `/healthz` fails
- payment generation or signing calls spike in 5xx responses

## Primary Checks

1. Check control-plane health:
   - `GET /api/v1/health`
2. Check signer DMZ health:
   - `GET /healthz` on the signer runtime
3. Inspect signer runtime logs for:
   - JWT validation failures
   - upstream go-livepeer process failures
   - RPC/network errors
   - payment forwarding failures
4. Verify control-plane environment:
   - `SIGNER_INTERNAL_URL`
   - `SIGNER_CLI_URL`
   - OIDC/JWKS alignment if JWT validation is failing

## Likely Failure Areas

- signer container/process crash
- JWKS/issuer mismatch between control plane and signer DMZ
- upstream RPC/network outage
- release/config drift between control plane and signer
- DB write failures for session/usage/payment persistence

## Immediate Mitigation

- restore signer health endpoint availability first
- if the signer image changed recently, roll back to the prior known-good digest
- if auth failures are caused by issuer/JWKS mismatch, restore environment parity before retrying traffic
- if upstream RPC is degraded, fail traffic safely or switch to a healthy RPC endpoint if operationally supported

## Recovery Validation

- `/healthz` returns healthy
- a known-good signer proxy request succeeds
- payment generation succeeds on a test request
- control-plane signer status page reports healthy state

## Follow-up

- note whether the incident came from:
  - signer image regression
  - control-plane/signer config mismatch
  - upstream RPC dependency
  - persistence failure
