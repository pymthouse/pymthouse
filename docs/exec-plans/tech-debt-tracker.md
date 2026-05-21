# Tech Debt Tracker

## Architectural Debt

- some non-app frontend surfaces still fetch and reshape data directly in page components instead of using explicit domain UI/view-model seams
- signer routing/payment/provider runtime complexity remains concentrated in `src/domains/signer-runtime/**`.
- `src/domains/oidc-platform/runtime/provider-instance.ts` and `src/app/api/v1/oidc/[...oidc]/route.ts` remain security-critical aggregation points.

## Documentation Debt

- no domain-level deep-dive design docs yet for OIDC, signer runtime, or billing
- no doc validation in CI

## Reliability Debt

- full image publish/promote CI is not yet codified in-repo
- local developer bootstrap for the entire app + signer stack still requires multiple commands even though hermetic local test validation now exists
