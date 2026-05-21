# Observability And SLOs

This document defines the minimum production signals and service targets expected for the current architecture.

## Service Areas

- control plane
  - Next.js app, dashboard, API, OIDC issuer, app-management flows
- signer runtime
  - signer DMZ, Apache JWT gate, go-livepeer forwarding/proxy behavior
- billing and usage ledger
  - usage ingestion, billing event writes, reporting reads
- PostgreSQL
  - shared persistence for all domain and platform state

## Minimum Signals

### Control Plane

- request rate, error rate, and latency for:
  - `/api/v1/health`
  - `/api/v1/oidc/**`
  - `/api/v1/apps/**`
  - `/api/signer/**`
- OIDC token, authorization, and device-verification failure counts
- app-management save/submit/publish error counts
- process start, crash, and restart visibility

### Signer Runtime

- `/healthz` success rate and latency
- signer upstream connection failures
- JWT validation failures at the DMZ
- payment generation failure counts
- signer status-sync drift or repeated offline transitions

### Billing And Usage

- usage record write failures
- usage billing event write failures
- pricing/oracle fetch failures
- dashboard/reporting query failures
- reconciliation mismatch counts, if automated reconciliation is added

### PostgreSQL

- connection errors
- migration failures
- slow query visibility for high-risk reads and writes
- disk/storage alarms handled by the hosting provider

## Suggested SLOs

These are starting targets, not contractual guarantees.

### Control Plane API

- availability: 99.9% monthly for core authenticated API routes
- latency: 95th percentile under 500ms for ordinary dashboard/API reads

### OIDC Surface

- availability: 99.95% monthly for token, authorize, and JWKS endpoints
- latency: 95th percentile under 400ms for token and authorize request processing, excluding upstream provider dependencies

### Signer Runtime

- availability: 99.9% monthly for signer DMZ health and proxy routes
- latency: 95th percentile under 750ms for DMZ proxy acceptance, excluding upstream chain/RPC latency

### Billing And Usage

- durability target: no silent loss of accepted usage/billing writes
- freshness target: reporting delay under 5 minutes for ordinary usage visibility

## Alerting Priorities

Page immediately for:

- control plane health endpoint down
- OIDC token/authorize failure spike
- signer health endpoint down
- signer proxy 5xx spike
- migration failure during release
- database connectivity loss

Create ticket/non-paging alerts for:

- elevated dashboard/API error rate outside critical auth paths
- pricing/oracle fetch degradation
- increasing billing reconciliation drift
- repeated admin invite or bootstrap failures

## Instrumentation Guidance

- prefer per-surface structured logs with stable event names
- include domain IDs where safe:
  - app id
  - oidc client id
  - signer request type
  - transaction/session identifiers
- never log secrets, bearer tokens, private keys, or raw client secrets
- separate user-facing errors from operator-facing diagnostics

## Ownership Expectations

- `oidc-platform` owns OIDC availability and correctness
- `signer-runtime` owns signer DMZ availability, proxy behavior, and signer control health
- `usage-billing` plus `end-user-accounts` own billing correctness and reporting consistency
- `platform/ops` owns operator-facing reporting surfaces and health aggregation
