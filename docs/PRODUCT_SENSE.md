# Product Sense

Pymthouse is not just a generic dashboard. The core product model is:

- a hosted OIDC issuer
- a provider app control plane
- a marketplace/review surface
- a shared Livepeer signer gateway
- a usage and billing ledger for app-scoped AI/media workloads

Core concepts:

- `developer app`: the main provider-managed integration unit
- `public app client`: interactive/device-facing OIDC client
- `m2m client`: confidential sibling used for Builder API and token exchange flows
- `app user` / `end user`: provider-scoped user identities used for token issuance and billing attribution
- `discovery profile`: reusable orchestrator-selection policy
- `plan`: pricing and usage policy for a developer app
- `usage billing event`: canonical priced event for a signer-backed request

Product constraints already visible in code:

- `client_id` is a first-class external identifier
- app ownership and provider-admin roles are distinct from platform admin roles
- the signer is shared infrastructure, not per-app infrastructure
- billing relies on explicit pipeline/model constraints and signed-ticket evidence
