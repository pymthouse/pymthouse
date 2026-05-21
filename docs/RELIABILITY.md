# Reliability

Current reliability strengths:

- CI runs lint, tests, CodeQL, and Snyk workflows.
- The codebase includes targeted tests for OIDC, pricing, auth, and usage logic.
- Signer integration includes explicit health and DMZ probing logic.
- production image build, migrate, and deploy steps are now separated in `infra/scripts/**` and `infra/deploy/**`.
- control-plane and signer deployment docs now define health/readiness expectations explicitly.
- hermetic local test validation now exists through `npm run test:local`, which starts a disposable PostgreSQL container, prepares schema, seeds OIDC keys, and runs the test suite.
- a full local Docker development stack now exists through `infra/dev/docker-compose.full.local.yml` and `./infra/scripts/run-full-local-dev.sh`.

Current reliability gaps:

- plain `npm test` still expects Postgres to be reachable unless `npm run test:local` is used
- CI/CD image publish and promotion flow is not yet fully codified in-repo

Current reliability priorities:

- make the broader local app stack more one-command and worktree-safe, not just the test path
- add structured checks for startup, migrations, and dependency readiness
- exercise and iterate on the new runbooks for signer failure, OIDC failure, billing reconciliation, and migration recovery
