# Agent Map

This repository is a Next.js control plane for Pymthouse. Treat this file as a map, not the full manual.

## Start Here

- Read [ARCHITECTURE.md](ARCHITECTURE.md) for the domain map, layering rules, and target structure.
- Read [docs/PRODUCT_SENSE.md](docs/PRODUCT_SENSE.md) for the product model and core concepts.
- Read [docs/PLANS.md](docs/PLANS.md) before starting substantial work.
- Read [docs/QUALITY_SCORE.md](docs/QUALITY_SCORE.md) to understand current weak spots.
- Read [docs/RELIABILITY.md](docs/RELIABILITY.md) and [docs/SECURITY.md](docs/SECURITY.md) before touching auth, OIDC, signer, or billing code.

## Current Product Surface

- Provider dashboard for creating and managing developer apps.
- OIDC issuer embedded in the app for interactive login, device flow, client credentials, and token exchange.
- Builder API for app-scoped user provisioning and user token issuance.
- Marketplace and app review workflow.
- Shared remote signer control plane and JWT-gated signer proxy.
- Usage, billing, plans, subscriptions, and discovery-profile management.

## Current Domain Map

- `identity-access`: platform users, sessions, NextAuth, provider admin membership, audit log.
- `oidc-platform`: OIDC clients, keys, provider adapter, issuer routes, device flow, token exchange.
- `developer-apps`: app metadata, branding, domains, marketplace, app team membership.
- `plans-discovery`: plans, capability bundles, discovery profiles, subscriptions, API keys.
- `signer-runtime`: signer config, DMZ JWT issuance, signer proxying, CLI integration.
- `usage-billing`: stream sessions, transactions, usage records, billing events, price oracle.

## Working Rules

- Keep `src/app/**` routes thin. Prefer parsing input at the boundary, then delegate into domain runtime/service code.
- Do not reintroduce the legacy `src/lib` namespace. New runtime code belongs under `src/domains/**`, `src/platform/**`, or `src/shared/**`.
- Prefer domain-local types and helpers over shared catch-all modules.
- Update repository docs when you change core behavior, domain boundaries, or operator workflows.
- For substantial work, add or update an execution plan under `docs/exec-plans/`.

## Validation

- `npm run lint`
- `npm test`

Note: `npm test` currently expects a reachable Postgres instance unless run in CI. See [docs/RELIABILITY.md](docs/RELIABILITY.md).
