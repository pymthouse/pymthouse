# Devcontainer Setup

This devcontainer provides a consistent development environment for the PymtHouse control plane.

## Quick Start

1. Open this repo in VS Code with the Dev Containers extension
2. Click "Reopen in Container" when prompted
3. Wait for `postCreateCommand` to complete (installs deps, runs migrations, seeds OIDC keys)
4. Run `npm run dev` to start the Next.js dev server

The control plane will be available at http://localhost:3001.

## Running the Signer DMZ

The signer runs separately on the host (or in its own container). From the repo root:

```bash
# Start signer-dmz pointing to your local control plane
JWKS_URI=http://host.docker.internal:3001/api/v1/oidc/jwks \
  docker compose -f docker/signer-dmz/docker-compose.yml up --build
```

The signer DMZ will be available at http://localhost:8080.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Host Machine                                        │
│                                                     │
│  ┌─────────────────────┐   ┌────────────────────┐  │
│  │ Devcontainer        │   │ signer-dmz         │  │
│  │ ┌─────────────────┐ │   │ (docker-compose)   │  │
│  │ │ Next.js :3001   │◄┼───┼─ JWKS fetch        │  │
│  │ └────────┬────────┘ │   │                    │  │
│  │          │          │   │ gateway :8080      │  │
│  │ ┌────────▼────────┐ │   │   └─► signer :8081 │  │
│  │ │ Postgres :5432  │ │   └────────────────────┘  │
│  │ └─────────────────┘ │                           │
│  └─────────────────────┘                           │
└─────────────────────────────────────────────────────┘
```

The devcontainer reaches the signer via `host.docker.internal:8080`.
The signer fetches JWKS from the control plane via `host.docker.internal:3001`.
