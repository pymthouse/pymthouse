# Agent-First Restructure Plan

Status: completed
Owner: repository
Last updated: 2026-05-17

## Goal

Restructure the repository so agents and humans can reason about product domains, infrastructure boundaries, and operational constraints directly from the codebase.

## Final State

The repository now has:

- explicit domain modules under `src/domains/**`
- explicit infrastructure modules under `src/platform/**`
- small pure shared helpers under `src/shared/**`
- thin route/page adapters under `src/app/**`
- repo-wide enforcement that blocks legacy `src/lib` imports in production code
- repo-wide direct-DB boundary enforcement
- architecture docs that describe the final system layout instead of a migration target

## Major Completed Extractions

- `plans-discovery`
  - plans, discovery profiles, subscriptions, and discovery resolution live under domain repo/service/runtime layers
- `developer-apps`
  - app lifecycle, settings, domains, admins, users, credentials, keys, billing, usage, marketplace/admin flows live under domain layers
- `oidc-platform`
  - interaction handling, catch-all provider bridge, device flow, token exchange, provider bootstrap, consent/device views, account/payload/JWKS storage, and OIDC app policy now live under domain layers
- `signer-runtime`
  - signer proxying, DMZ forwarding, payment persistence, signer admin control, health, and status now live under domain layers
- `usage-billing`
  - billing runtime logic now lives under a dedicated domain service layer
- `identity-access` and `end-user-accounts`
  - admin auth, bearer/session auth, audit, invites, Turnkey-backed user/session handling, end-user billing/account flows now live under explicit domain layers

## Permanent Platform Homes Added

- `src/platform/auth/**`
- `src/platform/catalog/**`
- `src/platform/docs/**`
- `src/platform/livepeer/**`
- `src/platform/marketplace/**`
- `src/platform/oidc/**`
- `src/platform/ops/**`
- `src/platform/signer/**`

## Shared Utility Homes Added

- `src/shared/discovery/**`
- `src/shared/utils/**`

## Enforcement

- `scripts/check-compat-imports.js`
  - bans production imports from the legacy `src/lib/**` namespace
- `scripts/check-direct-db-imports.js`
  - bans direct DB imports in extracted route adapters and disallowed domain layers
- `eslint.config.mjs`
  - enforces critical route/domain import boundaries
- `npm run lint`
  - runs compatibility and DB boundary checks before ESLint

## Acceptance Result

The migration meets the production-ready completion bar:

1. meaningful business/runtime logic is no longer centered in `src/lib`
2. domain and platform boundaries are explicit in code structure
3. DB access is constrained to repo layers and platform infrastructure
4. production imports of compatibility wrappers are mechanically blocked
5. architecture docs reflect the final structure rather than an aspirational target
