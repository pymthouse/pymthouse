<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md

## Cursor Cloud specific instructions

pymthouse is a single **Next.js 16 app that serves both the UI and the API** on `http://localhost:3001`. It is a control plane for a Livepeer remote-signer clearinghouse: OIDC issuer, developer/app "Builder", signer proxy, and usage/billing surface. See `README.md` for the full quick-start; the notes below only cover non-obvious, cloud-specific gotchas.

### Services

| Service | Scope | How to run | Notes |
| --- | --- | --- | --- |
| Next.js app (UI + API) | MUST-RUN | `npm run dev` (port 3001; `predev` runs migrations) | The product. Lint `npm run lint`, tests `npm test`, build `npm run build`. |
| PostgreSQL | MUST-RUN | Local cluster (see below) | `DATABASE_URL` in `.env`. Migrations run automatically on `predev`. |
| signer-dmz (Apache JWT + go-livepeer) | OPTIONAL | `docker compose up -d signer-dmz` | Not run in this env: needs Docker + a go-livepeer image/binary + Arbitrum RPC. App loads, logs in, and manages apps/tokens without it; health just reports `signer: stopped`. |
| OpenMeter / Clearinghouse stacks | OPTIONAL | `docker compose -f docker-compose.openmeter.yml up -d` etc. | Metering/billing only; need Docker + Kafka + ClickHouse. Not required for core control-plane actions. |

### Node version (important)

- `npm test` runs `node --import ./src/test-env.ts --import tsx ...`, which relies on Node's native TypeScript type-stripping (default in **Node >= 22.18**) to load `src/test-env.ts`. The harness's default `/exec-daemon/node` is 22.14.0, which lacks this and makes every test file fail with `ERR_UNKNOWN_FILE_EXTENSION ".ts"`.
- Setup installs Node 22 via `nvm` (`nvm alias default 22`) and appends a PATH prepend to `~/.bashrc` so `node` resolves to the nvm version (>= 22.18) in new shells. If tests suddenly fail with the `.ts` extension error, check `node --version` is >= 22.18 and that the nvm bin is ahead of `/exec-daemon` on `PATH`.

### Local Postgres

- Postgres 16 is installed locally (not Docker). Start it with `sudo pg_ctlcluster 16 main start` if it is not already running (`pg_isready`). Dev DB: `postgresql://postgres:postgres@127.0.0.1:5432/pymthouse` (already in `.env`).

### First-login flow (control-plane "hello world")

1. `npm run oidc:seed` — one-time; creates the OIDC signing key so `/api/v1/oidc/jwks` works. **This script does its work then hangs without exiting** (it never closes the Postgres pool). Run it with a timeout, e.g. `timeout 60 npm run oidc:seed`; seeing `[oidc:seed] Done.` means success even though the process is then killed by the timeout. The same "prints result then hangs" behavior applies to some other one-off `scripts/*.ts` (e.g. `bootstrap`).
2. `timeout 60 npm run bootstrap [email]` — mints a 1-year `pmth_...` admin bearer token and creates the platform default app.
3. Log in by pasting the `pmth_...` token at `http://localhost:3001/login` (no OAuth/Turnkey needed locally). API calls can use `Authorization: Bearer pmth_...`.

### Env notes

- `.env` is gitignored; it is created during setup. Required minimum: `NEXTAUTH_SECRET`, `AUTH_TOKEN_PEPPER` (both >= 32 chars), `DATABASE_URL`.
- OAuth (Google/GitHub), Turnkey, Stripe, and OpenMeter vars are all optional for local dev — token login replaces OAuth.
