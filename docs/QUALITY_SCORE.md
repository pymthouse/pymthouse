# Quality Score

This scorecard reflects the current post-restructure repository state rather than the original baseline.

## Domain Quality

| Domain | Score | Notes |
| --- | --- | --- |
| Identity and access | B+ | Admin auth, bearer/session auth, invites, audit, and Turnkey-backed user/session flows now live in explicit domain and platform layers. |
| OIDC platform | B+ | Core provider runtime, token exchange, device flow, branding, client registration, and key handling are structurally separated and documented. |
| Developer apps | A- | App lifecycle, settings, credentials, keys, users, billing, usage, and marketplace/admin surfaces are now domain-backed. |
| Plans and discovery | B+ | Plans, discovery profiles, subscriptions, and discovery resolution are separated cleanly, though deeper integration coverage could still improve confidence. |
| Signer runtime | B+ | Signer admin, proxying, DMZ routing, health, status, and payment recording are explicit seams rather than monolithic helpers. |
| Usage and billing | B | Usage and billing rules now have a dedicated domain home, but reporting and operational reconciliation are still spread across domain and platform code. |

## Architectural Quality

| Layer | Score | Notes |
| --- | --- | --- |
| Documentation as system of record | B | Architecture, deployment, and product docs now describe the live structure, though operator runbooks and observability docs are still lighter than ideal. |
| Domain boundaries | A- | The codebase is organized around domains, platform infrastructure, and shared helpers with explicit layering rules. |
| Mechanical enforcement | B+ | Repo-wide legacy import checks, DB-boundary checks, and ESLint boundary rules are in place. |
| Testability | B | There is substantial unit and route coverage, but truly hermetic local test orchestration still depends on external Postgres availability. |
| Route thinness | A- | Most major API surfaces now act as adapters rather than owning business logic directly. |

## Current Priorities

- keep the architecture docs aligned with the live code structure
- deepen targeted tests for the most security- and billing-sensitive seams
- tighten CI/CD image build and deployment automation
- add stronger operator-facing runbooks for recovery, health, and observability
