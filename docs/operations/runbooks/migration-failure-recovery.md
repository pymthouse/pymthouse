# Migration Failure Recovery

Use this runbook when release-time schema migration fails or when a deployment is partially applied.

## Symptoms

- release migrator job exits non-zero
- control-plane startup fails immediately after release
- routes fail due to missing columns/tables or incompatible schema

## Primary Checks

1. Confirm which image digest/tag was intended for the release.
2. Inspect migration job logs.
3. Identify whether failure happened:
   - before any schema change
   - during schema change
   - after schema change but before app rollout completion

## Immediate Response

- stop further rollout until migration state is understood
- do not continue deploying new images on top of unknown schema state
- determine whether rollback is safe for the application image

## Safe Recovery Pattern

1. Inspect current schema and Drizzle migration journal state.
2. Compare with the migration files bundled in the release image.
3. If the migration did not apply, fix the root cause and rerun the migrator from the same intended image.
4. If the schema partially changed, repair forward rather than guessing at manual rollback unless a tested rollback plan exists.
5. Deploy the control-plane image only after migration success is confirmed.

## Validation

- `npm run db:prepare` or image-backed migration step succeeds
- control-plane health endpoint passes
- a representative read and write path succeeds

## Follow-up

- document whether the failure was caused by:
  - migration ordering
  - environment/config mismatch
  - database permissions/connectivity
  - unsafe schema change assumptions
