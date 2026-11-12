# Deprecate `discovery-service` in favor of the builder-engine discovery

**Status:** In progress — code done (Phases 0–2), ops steps (Phases 3–4) remaining
**Created:** 2026-11-12
**Updated:** 2026-11-12
**Owner:** elite
**Scope:** Railway `discovery-service` project + PymtHouse web app

## Why

- The standalone `discovery-service` (Railway project `discovery-service`, service `discovery-service`, domain `discovery-service-production-8955.up.railway.app`) is a separate Go service that aggregates orchestrator leaderboards and serves `/v1/discovery/*` endpoints.
- The builder-engine (`livepeer-builder-core`) now ships its own discovery source: `HttpDiscoverySource` reads livepeer/node's `livepeer-discovery` contract at `LPB_DISCOVERY_URL`. The engine's `DiscoveryService` maintains a cached snapshot of runners grouped by app.
- The builder-engine's `discovery` service on Railway (domain `discovery-production-70c1.up.railway.app`) already exposes the discovery contract used by the engine.
- PymtHouse still hard-codes the legacy URL in `src/lib/mcp/config.ts` and uses it in `mcp/session.ts` (`discoveryFetch`) and `mcp/hosted-server.ts` (`/v1/discovery/query`, `/v1/discovery/freshness`).

## Goals

1. Stop calling the legacy `discovery-service` (8955) from PymtHouse.
2. Point PymtHouse at the builder-engine discovery at `https://discovery-production-70c1.up.railway.app`.
3. Keep the `livepeer/node` `livepeer-discovery` contract as the wire format the engine reads (per `livepeer-builder-core/docs/contracts/discovery.md`).
4. Gracefully deprecate and finally remove the Railway `discovery-service` project.

## Non-goals

- Replacing the livepeer/node `livepeer-discovery` process itself (that is the engine's source).
- Changing the wire contract — the engine's `HttpDiscoverySource` already consumes node's schema.
- Migrating PymtHouse's discovery **plans / profiles** DB tables (those are app-scoped policy, not a transport).

## Current state (observed on Railway)

| Project | Service | Domain |
| --- | --- | --- |
| `discovery-service` | `discovery-service` | `discovery-service-production-8955.up.railway.app` |
| `builder-engine` | `discovery` | `discovery-production-70c1.up.railway.app` |

PymtHouse production variables (service `pymthouse`, project `PymtHouse`) currently have no `DISCOVERY_SERVICE_URL` or `DISCOVERY_URL` set, so the code falls back to the hard-coded legacy URL.

## Plan

### Phase 0 — Baseline & contract check (read-only)

1. Confirm the builder-engine `discovery` service is healthy:
   - `GET https://discovery-production-70c1.up.railway.app/discovery` returns a JSON array of orchestrator entries (node `livepeer-discovery` schema: `address`, `runners[]` with `url`, `app`, `mode`, `observed_at`, `capacity`, `price_info`, ...).
   - Verify the array is non-empty and the runners include the apps PymtHouse serves.
2. Confirm the legacy service still answers `GET /v1/discovery/query` and `/v1/discovery/freshness` (so we can run a canary comparison).
3. Record baseline response sizes, latency, and runner counts from both endpoints so we can diff after the cutover.

### Phase 1 — Introduce a configurable discovery base URL in PymtHouse

1. Replace the hard-coded fallback in `src/lib/mcp/config.ts` so the default becomes `https://discovery-production-70c1.up.railway.app` (no trailing slash). Keep `DISCOVERY_SERVICE_URL` and `DISCOVERY_URL` env overrides.
   - New default: builder-engine discovery domain, **not** the legacy 8955 domain.
   - The base URL is used by `discoveryFetch` (mcp/session.ts) and by `readDiscoveryServiceUrl` (mcp/config.ts).
2. Update `src/lib/mcp/config.test.ts` expectations to the new default.
3. Set `DISCOVERY_SERVICE_URL` (or `DISCOVERY_URL`) on the PymtHouse production service to `https://discovery-production-70c1.up.railway.app` so the override is explicit, not a code default.

### Phase 2 — Align MCP discovery calls with the node contract

The builder-engine discovery (70c1) serves the **node `livepeer-discovery`** document at `/discovery` (a JSON array). The legacy service served `/v1/discovery/query` (POST with `capabilities`, `serviceTypes`, `topN`, `sortBy`) and `/v1/discovery/freshness`.

Two sub-options, pick one:

**Option A — Keep PymtHouse calling `/v1/discovery/*` on the new host**
- Requires the builder-engine `discovery` service to also expose `/v1/discovery/query` and `/v1/discovery/freshness` (i.e. the engine's HTTP service must add these routes or a thin compatibility shim).
- Lower risk for MCP tools that already POST structured queries.

**Option B — Switch PymtHouse to the node contract (`GET /discovery`)**
- Rewrite `discoveryFetch` call sites in `mcp/session.ts` and `mcp/hosted-server.ts` to `GET {base}/discovery` (node array) and do the capability filtering / topN / sorting **client-side** in PymtHouse.
- This matches what `livepeer-builder-core` itself does (`HttpDiscoverySource` reads the node array and the engine does the selection).
- Remove the legacy `POST /v1/discovery/query` dependency.

Recommend **Option B** for architectural cleanliness (core rule: "build code cleanly, modularly, and with proper architecture"). The capability allowlist filtering already exists in `src/lib/mcp/capability-allow.ts`; extend it to rank/sort the node array by `capacity_available` desc, `price_info.price` asc, etc.

Steps:
1. In `src/lib/mcp/session.ts::discoveryFetch`, change the paths used by MCP tools:
   - `query_orchestrators` → `GET {base}/discovery` (node array).
   - `get_discovery_freshness` → derived from the array's `observed_at` stamps (max stamp = freshest).
2. In `src/lib/mcp/hosted-server.ts`:
   - `query_orchestrators` tool: fetch `GET /discovery`, filter by `filterAllowedCapabilities`, apply `topN` / `sortBy` client-side.
   - `get_discovery_freshness`: compute max `observed_at` across the array and report age.
3. Update `src/lib/mcp/session.ts::attachSdkToken` so the SDK token's `discovery` field points to the builder-engine discovery URL (the engine's own discovery endpoint, not the legacy query endpoint).
4. Add a small helper `src/lib/mcp/discovery-query.ts` that takes the raw node array + `capabilities` + `topN` + `sortBy` and returns the ranked result. Keep it pure (no I/O) so it's unit-testable.
5. Add/adjust tests:
   - `src/lib/mcp/config.test.ts` (new default).
   - New `src/lib/mcp/discovery-query.test.ts` for the client-side filter/rank logic.

### Phase 3 — Canary & validation on Railway

1. Deploy PymtHouse with `DISCOVERY_SERVICE_URL=https://discovery-production-70c1.up.railway.app` in **preview** environment first.
2. Run the MCP tools against preview:
   - `livepeer_mcp_info` shows the new `discovery_service_url`.
   - `query_orchestrators` returns non-empty results.
   - `get_discovery_freshness` reports a fresh `observed_at`.
3. Compare with legacy: run the same queries against the legacy 8955 service and diff the runner sets (same apps, same capabilities, same price ranges within tolerance).
4. After preview passes, set the production `DISCOVERY_SERVICE_URL` variable on the `pymthouse` service and redeploy.
5. Verify production: hit the MCP endpoint with a real API key and confirm responses match the canary.

### Phase 4 — Decommission the legacy `discovery-service`

**Only after Phase 3 validation passes in production:**

1. Announce deprecation to any remaining consumers (search `deployments/`, `livepeer-python-gateway/`, `pymthouse/` for `discovery-service-production-8955` references; update them).
2. On Railway:
   - Scale the `discovery-service` production environment to 0 replicas (or delete the service).
   - Keep the `discovery-service` **project** for a grace period (e.g. 30 days) in case of rollback, then delete the project.
3. Remove the legacy domain from any DNS / CNAME / gateway configs in `deployments/`.
4. Archive the `pymthouse/discovery-service` repo (or mark it deprecated in README).

## Files to touch (pymthouse)

- `src/lib/mcp/config.ts` — new default URL.
- `src/lib/mcp/config.test.ts` — update expectations.
- `src/lib/mcp/session.ts` — `discoveryFetch` paths; `attachSdkToken` discovery field.
- `src/lib/mcp/hosted-server.ts` — `query_orchestrators` and `get_discovery_freshness` rewritten to use the node contract.
- `src/lib/mcp/discovery-query.ts` (new) — pure filter/rank helper.
- `src/lib/mcp/discovery-query.test.ts` (new) — unit tests.
- `docs/builder-api.md` — update `discovery_url` default in the SignerSession section.

## Files to touch (other repos)

- Search `livepeer-python-gateway` and `deployments` for any hard-coded `discovery-service-production-8955` and update to the 70c1 domain.

## Rollback

- Phase 1/2: revert the code and unset `DISCOVERY_SERVICE_URL` (falls back to the old hard-coded value until the new default ships).
- Phase 4: if the legacy service was scaled to 0, scale it back up; if the project was deleted, restore the repo + redeploy.

## Risks

- **Wire-format mismatch.** The builder-engine discovery serves the node `livepeer-discovery` array, not the legacy `/v1/discovery/*` API. If we choose Option A (keep POST query), the engine's HTTP service would need new routes — that's an engine change (separate repo, cross-cutting). Option B keeps the change inside PymtHouse.
- **Capability filtering.** The legacy service returned pre-filtered ranked results; PymtHouse must now do filtering client-side. The existing `filterAllowedCapabilities` handles allowlist; add `topN` / `sortBy` logic.
- **Freshness semantics.** Legacy `/v1/discovery/freshness` had a specific shape; the node array has `observed_at` per runner, so "freshness" becomes a derived value (max stamp).
- **SDK token discovery field.** `attachSdkToken` currently builds `{legacy}/v1/discovery/raw?serviceType=live-runner`. Switch to `{engine-discovery}/discovery` and verify the livepeer-python-sdk accepts the node array.

## Acceptance criteria

- [x] PymtHouse code has no reference to `discovery-service-production-8955.up.railway.app`.
- [x] Code + tests for the cutover: `src/lib/mcp/config.ts` default is the 70c1 base URL; `discovery-query.ts` does client-side filter/rank; `hosted-server.ts` / `session.ts` use `GET /discovery`.
- [ ] `DISCOVERY_SERVICE_URL` set on production `pymthouse` service to the 70c1 domain (Phase 3 ops step).
- [ ] MCP tools (`query_orchestrators`, `get_discovery_freshness`, `livepeer_mcp_info`) return correct data from the new source (verified in Phase 3 canary).
- [ ] `livepeer-python-sdk` tokens minted by PymtHouse carry the new discovery URL and the SDK can fetch the node array (verified in Phase 3 canary).
- [ ] No other repo (`deployments`, `livepeer-python-gateway`) references the legacy domain. Confirmed: neither repo references the 8955 domain.
- [ ] Legacy `discovery-service` Railway service scaled to 0 (or deleted) after 30-day grace (Phase 4 ops step).

## Timeline

- Phase 0: 0.5 day (read-only checks).
- Phase 1: 0.5 day (config + tests).
- Phase 2: 1–2 days (MCP tool rewrites + new helper + tests).
- Phase 3: 0.5 day (canary on preview, then production cutover).
- Phase 4: 1 day (decommission, 30-day grace, then delete).

Total: ~4–5 working days of active work + 30-day grace.

## Out-of-scope follow-ups (separate tickets)

- If the engine's HTTP service needs `/v1/discovery/query` compatibility routes (Option A), that's a `livepeer-builder-core` change (separate PR).
- Migrating PymtHouse's `discovery_profiles` / `plan_capability_bundles` DB tables is independent of the transport cutover.
