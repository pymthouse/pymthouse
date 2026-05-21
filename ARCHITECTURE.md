# Architecture

This document is the high-level system-of-record for the live repository structure. It is meant to answer four questions:

1. what the major runtime components are
2. how requests and data move through them
3. how code is organized to reflect those flows
4. what rules keep the structure from drifting

## System Summary

Pymthouse is a control plane that sits between:

- platform operators and provider admins
- developer applications and their end users
- a hosted OIDC issuer
- a shared Livepeer signer/DMZ runtime
- a usage, billing, plans, and subscription ledger

At runtime, the single Next.js control plane owns API, dashboard, OIDC, app management, and operational reporting. It persists state in PostgreSQL and coordinates with a separately deployed signer stack.

## Runtime Context

```mermaid
flowchart LR
    ProviderAdmin[Provider Admin]
    PlatformAdmin[Platform Admin]
    EndUser[End User / Device]
    App[Developer App]
    CP[Next.js Control Plane]
    OIDC[Hosted OIDC Provider]
    PG[(PostgreSQL)]
    Signer[Signer DMZ + go-livepeer]
    External[OAuth / Turnkey / RPC / Pricing]

    ProviderAdmin --> CP
    PlatformAdmin --> CP
    EndUser --> App
    App --> CP
    CP --> OIDC
    CP --> PG
    CP --> Signer
    OIDC --> PG
    Signer --> CP
    CP --> External
    OIDC --> External
    Signer --> External
```

![Runtime context diagram](docs/architecture-diagrams/01-runtime-context.svg)

## Repository Shape

```text
src/
├── app/                         # Next.js pages and route adapters only
├── domains/                     # Product/runtime domains
│   ├── developer-apps/
│   ├── end-user-accounts/
│   ├── identity-access/
│   ├── oidc-platform/
│   ├── plans-discovery/
│   ├── signer-runtime/
│   └── usage-billing/
├── platform/                    # Infra, protocol, operational, framework helpers
│   ├── auth/
│   ├── catalog/
│   ├── docs/
│   ├── livepeer/
│   ├── marketplace/
│   ├── oidc/
│   ├── ops/
│   └── signer/
└── shared/                      # Small pure helpers and shared types
    ├── discovery/
    └── utils/
```

## Code Organization

```mermaid
flowchart TD
    AppLayer[src/app<br>pages + route adapters]
    DomainRuntime[src/domains/*/runtime]
    DomainService[src/domains/*/service]
    DomainRepo[src/domains/*/repo]
    Platform[src/platform/**]
    Shared[src/shared/**]
    DB[(PostgreSQL)]
    External[External systems]

    AppLayer --> DomainRuntime
    AppLayer --> Platform
    DomainRuntime --> DomainService
    DomainRuntime --> DomainRepo
    DomainRuntime --> Platform
    DomainService --> Shared
    DomainRepo --> DB
    Platform --> DB
    Platform --> External
    DomainRuntime --> External
```

![Code organization diagram](docs/architecture-diagrams/02-code-organization.svg)

## Domain Map

| Domain | Responsibility | Typical Tables / State |
| --- | --- | --- |
| `identity-access` | dashboard auth, bearer/session auth, invites, audit, Turnkey-backed user/session flows | `users`, `sessions`, `provider_admins`, `admin_invites`, `auth_audit_log` |
| `oidc-platform` | hosted OIDC provider, client policy, consent/interaction handling, device flow, token exchange, signing keys, payload storage | `oidc_clients`, `oidc_payloads`, `oidc_signing_keys` |
| `developer-apps` | developer app lifecycle, admins, users, credentials, domains, branding, marketplace state, review flows | `developer_apps`, `app_users`, `app_allowed_domains`, app-linked OIDC client state |
| `plans-discovery` | plans, discovery profiles, subscriptions, discovery policy resolution | `plans`, `discovery_profiles`, `discovery_profile_bundles`, `subscriptions`, `api_keys` |
| `signer-runtime` | signer config, DMZ-facing proxying, admin control, status/health, payment recording | `signer_config`, signer runtime state, session-linked payment writes |
| `usage-billing` | usage/billing rules, fee normalization, owner/platform charge calculations | `usage_records`, `usage_billing_events`, price snapshots |
| `end-user-accounts` | end-user balances, transactions, billing-facing account reads | `end_users`, `transactions`, `stream_sessions` |

## Domain Relationships

```mermaid
flowchart LR
    Identity[identity-access]
    OIDC[oidc-platform]
    Apps[developer-apps]
    Plans[plans-discovery]
    Signer[signer-runtime]
    Billing[usage-billing]
    EndUsers[end-user-accounts]
    Ops[platform/ops]

    Identity --> Apps
    Identity --> OIDC
    Apps --> OIDC
    Apps --> Plans
    Apps --> EndUsers
    Apps --> Billing
    OIDC --> Apps
    OIDC --> Identity
    OIDC --> EndUsers
    Signer --> Billing
    Signer --> EndUsers
    Signer --> Apps
    Plans --> Apps
    Billing --> EndUsers
    Ops --> Apps
    Ops --> EndUsers
    Ops --> Signer
    Ops --> Billing
```

![Domain relationships diagram](docs/architecture-diagrams/03-domain-relationships.svg)

## Layering Rules

Within a domain, dependency direction is:

`types -> repo -> service -> runtime -> ui`

Definitions:

- `types`: domain contracts, type aliases, enums
- `repo`: direct DB access and persistence mapping
- `service`: pure or near-pure business rules
- `runtime`: framework/integration orchestration
- `ui`: React view-model and rendering helpers

```mermaid
flowchart LR
    Types[types]
    Repo[repo]
    Service[service]
    Runtime[runtime]
    UI[ui]

    Types --> Repo
    Repo --> Service
    Service --> Runtime
    Runtime --> UI
```

![Layering rules diagram](docs/architecture-diagrams/04-layering-rules.svg)

The diagram above is directional, not mandatory by folder count. A domain may omit `types` or `ui` when the slice does not need them.

## Boundary Rules

- `src/app/**` stays thin. Pages and routes translate HTTP/UI concerns into domain or platform calls.
- Direct `@/db/*` imports are allowed only in `src/domains/**/repo/**` and `src/platform/**`.
- The legacy `@/lib/*` namespace is retired. Production code should import permanent homes under `domains`, `platform`, or `shared`.
- OIDC protocol/framework helpers belong in `src/platform/oidc/**`; OIDC business/runtime behavior belongs in `src/domains/oidc-platform/**`.
- Cross-cutting operational/reporting helpers belong in `src/platform/ops/**`.

## Major Runtime Surfaces

### 1. Control Plane App Surface

- dashboard pages under `src/app/dashboard`, `src/app/apps`, `src/app/admin`, `src/app/signer`
- public and marketplace pages under `src/app/page.tsx`, `src/app/marketplace`, `src/app/solutions`
- API route adapters under `src/app/api/**` and `src/app/api/v1/**`

### 2. Hosted OIDC Surface

- issuer metadata under `.well-known`
- interaction and consent pages under `src/app/oidc/**`
- catch-all issuer routes under `src/app/api/v1/oidc/**`
- device verification and third-party login initiation under `src/app/api/v1/oidc/device/**` and `src/app/oidc/device/**`

### 3. Signer Surface

- signer admin/control routes under `src/app/api/v1/signer/**`
- signer-facing proxy routes under `src/app/api/signer/**`
- signer admin/operator page under `src/app/signer/page.tsx`

## End-to-End Request Path

```mermaid
sequenceDiagram
    participant Browser
    participant Route as src/app route/page
    participant Runtime as domain runtime
    participant Service as domain service
    participant Repo as domain repo / platform repo
    participant DB as PostgreSQL
    participant Ext as signer / oauth / rpc

    Browser->>Route: HTTP request or page navigation
    Route->>Runtime: parsed inputs + session context
    Runtime->>Service: apply domain rules
    Runtime->>Repo: load or persist state
    Repo->>DB: SQL / Drizzle operations
    Runtime->>Ext: optional external integration
    Runtime-->>Route: domain result
    Route-->>Browser: JSON / HTML / redirect
```

![End-to-end request path diagram](docs/architecture-diagrams/05-end-to-end-request-path.svg)

## Authentication and OIDC Flow

The hosted issuer supports:

- interactive authorization code login
- device flow
- client credentials and programmatic tokens
- token exchange for device and gateway flows

```mermaid
sequenceDiagram
    participant User
    participant Client as Developer App Client
    participant CP as Control Plane
    participant OIDC as oidc-platform
    participant ID as identity-access
    participant DB as PostgreSQL

    User->>Client: starts login or device flow
    Client->>CP: /api/v1/oidc/*
    CP->>OIDC: route adapter delegates
    OIDC->>ID: resolve session / admin / app access as needed
    OIDC->>DB: load clients, payloads, keys, custom domain data
    OIDC-->>Client: auth page, device verification, token, or redirect
    Client-->>User: signed-in experience
```

![Authentication and OIDC flow diagram](docs/architecture-diagrams/06-authentication-and-oidc-flow.svg)

## Developer App Lifecycle Flow

```mermaid
flowchart TD
    Draft[Draft app]
    Submit[Submitted]
    Review[In review]
    Approved[Approved]
    Rejected[Rejected]
    Publish[Published marketplace state]
    Revise[Revert to draft / revise]

    Draft --> Submit
    Submit --> Review
    Review --> Approved
    Review --> Rejected
    Approved --> Publish
    Rejected --> Revise
    Revise --> Draft
```

![Developer app lifecycle diagram](docs/architecture-diagrams/07-developer-app-lifecycle-flow.svg)

This lifecycle is implemented primarily in `src/domains/developer-apps/**` and surfaced through provider/admin app routes and dashboard pages.

## Signer and Billing Flow

```mermaid
sequenceDiagram
    participant App as Developer App / Gateway
    participant CP as Control Plane
    participant Signer as Signer DMZ
    participant SRuntime as signer-runtime
    participant Billing as usage-billing
    participant EndUsers as end-user-accounts
    participant DB as PostgreSQL

    App->>CP: /api/signer/* request
    CP->>SRuntime: authorize + route request
    SRuntime->>Signer: forward signed / gated request
    Signer-->>SRuntime: payment or signing response
    SRuntime->>Billing: compute usage/billing facts
    Billing->>EndUsers: attribute cost / balances
    EndUsers->>DB: persist transactions, sessions, usage
    SRuntime-->>App: signer response
```

![Signer and billing flow diagram](docs/architecture-diagrams/08-signer-and-billing-flow.svg)

## Plans, Discovery, and Subscription Flow

```mermaid
sequenceDiagram
    participant Admin as Provider Admin
    participant CP as Control Plane
    participant Plans as plans-discovery
    participant Apps as developer-apps
    participant DB as PostgreSQL

    Admin->>CP: manage plans / profiles / subscriptions
    CP->>Plans: validate and resolve policy changes
    Plans->>Apps: load app ownership / access context
    Plans->>DB: persist plans, profiles, subscriptions
    Plans-->>CP: resolved discovery or billing-facing state
```

![Plans discovery and subscription flow diagram](docs/architecture-diagrams/09-plans-discovery-and-subscription-flow.svg)

## Data Ownership Overview

```mermaid
flowchart TB
    subgraph Identity
        Users[users]
        Sessions[sessions]
        Invites[admin_invites]
        Audit[auth_audit_log]
    end

    subgraph OIDC
        Clients[oidc_clients]
        Payloads[oidc_payloads]
        Keys[oidc_signing_keys]
    end

    subgraph Apps
        DevApps[developer_apps]
        AppUsers[app_users]
        Domains[app_allowed_domains]
    end

    subgraph Plans
        Profiles[discovery_profiles]
        PlansTbl[plans]
        Subs[subscriptions]
    end

    subgraph SignerAndLedger
        SignerCfg[signer_config]
        EndUsersTbl[end_users]
        Streams[stream_sessions]
        Tx[transactions]
        Usage[usage_records]
        BillingEvents[usage_billing_events]
        Prices[price_oracle_snapshots]
    end

    Users --> DevApps
    DevApps --> Clients
    DevApps --> AppUsers
    DevApps --> Profiles
    DevApps --> PlansTbl
    DevApps --> EndUsersTbl
    Sessions --> EndUsersTbl
    EndUsersTbl --> Streams
    Streams --> Tx
    Tx --> Usage
    Usage --> BillingEvents
    Prices --> BillingEvents
    SignerCfg --> Streams
```

![Data ownership overview diagram](docs/architecture-diagrams/10-data-ownership-overview.svg)

The exact field definitions remain in [src/db/schema.ts](src/db/schema.ts).

## Deployment Topologies

Two production topologies are supported.

### Vercel Control Plane Topology

```mermaid
flowchart LR
    User[Browser / App]
    Vercel[Vercel-hosted control plane]
    Signer[Signer DMZ on Railway / Render / Fly]
    DB[(Managed PostgreSQL)]

    User --> Vercel
    Vercel --> DB
    Vercel --> Signer
```

![Vercel control plane topology diagram](docs/architecture-diagrams/11-vercel-control-plane-topology.svg)

See [docs/vercel-deployment.md](docs/vercel-deployment.md).

### Fully Containerized Topology

```mermaid
flowchart LR
    User[Browser / App]
    CP[Control-plane image]
    Signer[Signer DMZ image]
    DB[(Managed PostgreSQL)]
    Registry[Container Registry]

    Registry --> CP
    Registry --> Signer
    User --> CP
    CP --> DB
    CP --> Signer
    Signer --> DB
```

![Fully containerized topology diagram](docs/architecture-diagrams/12-fully-containerized-topology.svg)

See [docs/container-deployment.md](docs/container-deployment.md) and `infra/deploy/**`.

## Infra Layout

```text
infra/
├── dev/        # local-only compose files; inline builds allowed
├── docker/     # Dockerfiles and build assets
├── scripts/    # supported image build/run/migrate entrypoints
└── deploy/     # production prebuilt-image examples and guides
```

Recommended release sequence:

```mermaid
flowchart LR
    Build[Build image]
    Push[Push immutable tag or digest]
    Migrate[Run DB migrations from same image]
    Deploy[Deploy long-running service]
    Health[Wait for health checks]

    Build --> Push --> Migrate --> Deploy --> Health
```

![Infra release flow diagram](docs/architecture-diagrams/13-infra-layout.svg)

## Mechanical Enforcement

- `scripts/check-compat-imports.js` blocks new production imports from the retired legacy `@/lib/*` namespace.
- `scripts/check-direct-db-imports.js` blocks direct DB imports in extracted route adapters and disallowed domain layers.
- `eslint.config.mjs` enforces route/domain import boundaries on the critical migrated surfaces.
- `npm run lint` runs the repo-level architecture checks before ESLint.

## Current Truths and Non-Goals

- This is still a single Next.js control-plane application, not a microservice fleet.
- Domain separation is primarily a code-organization and reasoning boundary, not a network boundary.
- `src/platform/**` is allowed to contain DB-backed infrastructure code when that code is clearly protocol, framework, or operational infrastructure.
- `src/shared/**` is intentionally small and should stay pure or close to pure.

## Key Files To Read Next

- [AGENTS.md](AGENTS.md)
- [docs/PRODUCT_SENSE.md](docs/PRODUCT_SENSE.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/container-deployment.md](docs/container-deployment.md)
- [docs/vercel-deployment.md](docs/vercel-deployment.md)
- [src/db/schema.ts](src/db/schema.ts)
