# Builder API: OpenAPI self-documentation + route convergence

## Goal

Make the **Builder API** (`/api/v1/apps/{clientId}/...` and the credential-exchange
surface) self-documenting via a single OpenAPI 3.1 spec that is **derived from the same
schemas used for runtime validation** — one source of truth, no hand-drift. Use the
generated spec as the lever to (a) finish the RFC-compliant exchange convergence
(option B from the root-cause discussion) and (b) retire overlapping / overly-complex
routes.

Non-goal: re-documenting the OIDC issuer endpoints. `oidc-provider` v9 already publishes
`/.well-known/openid-configuration`; the OpenAPI doc links to it rather than duplicating
device/`token`/JWKS semantics.

## Why now (context)

- 68 hand-written Next.js route handlers under `src/app/api/v1/**`, **zero** machine-readable
  contract and **no zod** — every route validates ad hoc (`String(body.scope || "sign:job")`,
  manual `startsWith` guards). This is exactly what let a `pmth_cs_` client secret slip past
  the `pmth_` API-key guard.
- Two parallel signer-exchange endpoints with different request/response shapes
  (`/api/v1/apps/{id}/auth/api-key/token` vs the dashboard BFF `/api/pymthouse/keys/exchange`),
  both terminating in the same RFC 8693 exchange. A typed contract makes the duplication
  obvious and safe to collapse.

## Tooling decision

Adopt **zod (v4) + `zod-openapi`** (or `@asteasolutions/zod-to-openapi`) so request/response
schemas are authored once and produce both:

1. runtime parse/validation inside each route handler, and
2. OpenAPI `components.schemas` + operation definitions.

Serve the artifacts from the app itself:

- `GET /api/v1/openapi.json` — generated spec (built at module load from the registry).
- `GET /api/v1/docs` — Scalar API Reference (single static page, no build step) rendering the spec.

Rationale for zod over a hand-written YAML spec: with 68 routes and no existing validation
layer, a hand-maintained spec will drift immediately. Co-locating schema + validation is the
only way the doc stays true, and it pays down the missing-validation debt at the same time.

## Workstreams

### 1. Foundation (no behavior change)
- Add deps: `zod`, `zod-openapi`, `@scalar/nextjs-api-reference` (or serve Scalar via CDN script).
- Create `src/lib/openapi/registry.ts`: a shared `OpenAPIRegistry`-style singleton, plus a
  `defineRoute()` helper that registers `{ method, path, request, responses, security, tags }`
  and returns the zod schemas for the handler to use.
- Create `src/lib/openapi/document.ts`: builds the OpenAPI 3.1 doc (info, servers from
  `PYMTHOUSE_ISSUER_URL`, securitySchemes: `m2mBasic` (HTTP basic), `bearerApiKey`,
  `bearerUserJwt`).
- Add `src/app/api/v1/openapi.json/route.ts` and `src/app/api/v1/docs/route.ts`.
- Verify: `GET /api/v1/openapi.json` returns a valid (empty-ish) 3.1 doc; Scalar renders.

### 2. Schema-ify the credential & exchange surface first (highest value)
Convert these routes to `defineRoute()` + zod, because they are the source of the original
bug and the convergence target:
- `apps/[id]/auth/api-key/token` — document that it accepts **only** `pmth_` API keys; add an
  explicit zod refinement / guard rejecting `pmth_cs_` with `invalid_request` ("client secret —
  use Basic M2M auth"). Surfaces the RFC 6749 vs 8693 role separation in the schema description.
- `apps/[id]/users/[externalUserId]/token` (programmatic user JWT mint).
- `tokens/route.ts` and `oidc/[...oidc]` `/token` (link out; do not re-model OIDC internals).
- `auth/validate`.

### 3. Convergence (option B) — unify on one exchange contract
Using the now-typed schemas, collapse the duplicate signer-exchange paths:
- Define **one** canonical signer-session response envelope (`SignerSession`:
  `access_token`, `expires_in`, `scope`, optional `signer_url`, balances) in
  `components.schemas` and have **both** the pymthouse direct route and the SDK/dashboard BFF
  emit it (delete the second normalization shape in `builder-sdk` `device-exchange.ts` /
  `api-key-exchange.ts`).
- Standardize the actual token-for-token step on RFC 8693
  (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`) at the OIDC `/token` endpoint;
  the api-key route and the M2M `client_credentials` route differ only in how the
  `subject_token` is minted. Document both as two `subject_token` acquisition strategies feeding
  one exchange.
- Mark the dashboard BFF `/api/pymthouse/keys/exchange` as a thin pass-through (it already calls
  `createApiKeyExchangeHandler`); ensure its response equals the canonical envelope.
- Cross-repo: update `@pymthouse/builder-sdk` and the python `auth_exchange.py` to consume the
  single envelope. (builder-sdk + livepeer-gateway are separate repos — coordinate version bump.)

### 4. Roll schemas across the remaining Builder API
Batch the rest of `apps/[id]/*` (users, keys, usage, allowances, billing, discovery-profiles,
domains, settings, plans). Each handler swaps manual parsing for `schema.parse()`.

### 5. Use the spec to retire overlap (self-documentation payoff)
Concrete consolidation candidates the spec will make explicit:
- `apps/[id]/usage/balance` vs `apps/[id]/usage/me/balance` — same resource, two auth contexts.
- `apps/[id]/keys` vs `apps/[id]/users/[externalUserId]/keys` vs `apps/[id]/credentials` —
  overlapping credential surfaces.
- `apps/[id]/users/[externalUserId]/token` vs `apps/[id]/auth/api-key/token` — both mint user
  JWTs from different credentials.
- `ingest/events` (documented alias of `internal/ingest/signed-ticket`).
For each: document both, pick the canonical one in the spec, deprecate the other with an
`x-deprecated`/`deprecated: true` flag and a sunset note, then remove after consumers migrate.

### 6. CI guardrail
- `scripts/check-openapi.ts`: fail the build if any `src/app/api/v1/**/route.ts` (excluding
  `oidc`, `internal`, UI-only) is not registered in the OpenAPI registry. Keeps the doc complete
  as routes are added.
- Snapshot-test the generated `openapi.json` so contract changes are visible in PR diffs.

## Verification per step
- Spec validates against OpenAPI 3.1 (`@redocly/cli lint` or `swagger-parser validate`).
- Scalar page renders and "Try it" works against a running `next dev -p 3001`.
- `npm test` green; schema refinements covered (esp. the `pmth_cs_` rejection — add a test
  asserting `400 invalid_request`, not the old misleading `401 invalid_client`).
- Convergence: a single SDK call path produces a signer JWT from both an `pmth_` API key and an
  `m2m_`+secret credential, both returning the identical `SignerSession` envelope.

## Sequencing & risk
- Steps 1–2 are additive and low-risk (ship independently).
- Step 3 changes a cross-repo contract → version-bump `@pymthouse/builder-sdk`, update
  `livepeer-gateway` `auth_exchange.py`, keep both envelope readers until consumers cut over,
  then delete the old shape.
- Steps 4–6 are mechanical once the registry exists.

## Docs
Update `docs/builder-api.md` and the Mintlify `integration/` pages when the canonical envelope
and deprecations land (per repo rule: contract changes update docs in the same PR).
