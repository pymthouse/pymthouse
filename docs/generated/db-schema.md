# Generated Schema Guide

This is a hand-written summary of the current database model. It is not exhaustive SQL documentation.

## Identity

- `users`
- `sessions`
- `provider_admins`
- `admin_invites`
- `auth_audit_log`

## OIDC

- `oidc_signing_keys`
- `oidc_clients`
- `oidc_payloads`

## Developer Apps

- `developer_apps`
- `app_users`
- `app_allowed_domains`

## Plans And Discovery

- `discovery_profiles`
- `discovery_profile_bundles`
- `plans`
- `plan_capability_bundles`
- `subscriptions`
- `api_keys`

## Signer And Usage

- `signer_config`
- `end_users`
- `stream_sessions`
- `transactions`
- `usage_records`
- `usage_billing_events`
- `price_oracle_snapshots`

Source of truth for exact fields remains [`src/db/schema.ts`](../../src/db/schema.ts).
