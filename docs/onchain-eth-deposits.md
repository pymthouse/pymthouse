# On-chain ETH deposits (shared signer)

PymtHouse credits OpenMeter allowance when users send **Arbitrum ETH** to the **shared company signer** address. There is no per-user deposit address and no EVM memo field — attribution uses the **payer (`tx.from`)** address mapped to a known `walletAddress` on `users` or `end_users`.

## Flow

1. User sends ETH on Arbitrum from their Turnkey login wallet to the shared signer.
2. Turnkey emits `BALANCE_FINALIZED_UPDATES` (`operation: deposit`, `caip2: eip155:42161`).
3. `POST /api/v1/webhooks/turnkey/balances` verifies the ed25519 signature (JWKS or env keys).
4. Handler resolves `tx.from` via `eth_getTransactionByHash` on Arbitrum RPC.
5. `from` → `users.walletAddress` or `end_users.walletAddress` (lowercase, unique partial indexes).
6. ETH → USD micros via `getEthUsdOracle()`; price is pinned on `signer_deposit_events.eth_usd_price`.
7. `grantAllowanceUsdMicros({ source: "onchain_deposit" })` credits OpenMeter.
8. Unresolved payers → `signer_deposit_events` with `status=unmatched` (HTTP 200, no credit).

## Login / wallet mapping

Every login path must record a unique wallet address:

| Path | Wallet capture |
|------|----------------|
| Turnkey native | `findOrCreateDeveloperUser` on sign-in |
| GitHub / Google | OAuth → `/setup/wallet` → `POST /api/v1/account/link-wallet` |
| App end users (direct) | `findOrCreateEndUser` / `findOrCreateAppEndUser` with Turnkey JWT |
| Platform app (M2M) | `POST /api/v1/apps/{clientId}/users/{externalUserId}/wallet` with end-user `turnkeySessionJwt` |

`turnkeySubOrgId` (`organization_id` JWT claim) is stored on `users` and `end_users` for audit; deposit attribution uses `walletAddress` only.

Developers without an app-scoped `end_users` row are credited via their first owned app using `externalUserId = user:{users.id}` (same convention as RFC 8693 token exchange).

## Webhook registration

```bash
npm run turnkey:register-balance-webhook
# or: npx tsx scripts/register-turnkey-balance-webhook.ts
```

Register **BALANCE_FINALIZED_UPDATES** in Turnkey for the shared signer ETH address pointing at:

`{NEXTAUTH_URL}/api/v1/webhooks/turnkey/balances`

## Environment

| Variable | Purpose |
|----------|---------|
| `NEXTAUTH_URL` | Public base URL for webhook endpoint |
| `ARBITRUM_RPC_URL` | RPC for `eth_getTransactionByHash` (defaults to Arbitrum public RPC) |
| `TURNKEY_WEBHOOK_KEY_ID` / `TURNKEY_WEBHOOK_PUBLIC_KEY` | Optional static verification keys (else JWKS) |
| `ETH_USD_PRICE` | Oracle fallback when live/cache unavailable |
| `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` | Server-side wallet attestation via `getWalletAccounts` |
| `INGEST_SHARED_SECRET` | Auth for internal `GET /api/v1/internal/deposits/resolve?from=0x...` (clearinghouse) |

## Internal resolve (clearinghouse)

`GET /api/v1/internal/deposits/resolve?from=0x...` with `Authorization: Bearer ${INGEST_SHARED_SECRET}` returns `{ clientId, externalUserId, appId, kind, endUserId?, turnkeyOrgId? }` or 404. Uses the same resolver as the deposit webhook.

## Operations

- **Idempotency:** `x-turnkey-event-id` (preferred) or message `idempotencyKey` → `signer_deposit_events.idempotency_key` UNIQUE.
- **Retries:** Transient RPC/OpenMeter failures return 5xx; Turnkey retries safely.
- **Permanent errors:** Invalid amount etc. → `status=error`, HTTP 200 with note.

M2M users without a recorded `walletAddress` cannot be attributed from on-chain deposits; they continue using existing billing paths.
